const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

// ---------------------------------------------------------------------------
// Config & validation
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const GHL_API = "https://services.leadconnectorhq.com";

const REQUIRED_ENV = [
  "GHL_AGENCY_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "API_SECRET",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`FATAL: Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Supabase client (service role key bypasses RLS)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------------
// In-memory cache for location tokens (avoids re-exchanging on every request)
// ---------------------------------------------------------------------------
const tokenCache = new Map(); // locationId → { token, expiresAt }
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // cache for 23 hours (tokens last 24h)

function getCachedToken(locationId) {
  const entry = tokenCache.get(locationId);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.token;
  }
  tokenCache.delete(locationId);
  return null;
}

function setCachedToken(locationId, token) {
  tokenCache.set(locationId, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Api-Key"],
  })
);

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// POST /webhooks/ghl/app-install — receives LocationCreate webhook from GHL
// ---------------------------------------------------------------------------
app.post("/webhooks/ghl/app-install", async (req, res) => {
  try {
    const { locationId, companyId } = req.body;

    if (!locationId || !companyId) {
      console.warn("[webhook] Missing fields:", JSON.stringify(req.body));
      return res.status(400).json({ error: "Missing locationId or companyId" });
    }

    console.log(
      `[webhook] App installed — location=${locationId} company=${companyId}`
    );

    // Upsert: insert new or update existing on re-install
    const { error } = await supabase.from("locations").upsert(
      {
        location_id: locationId,
        company_id: companyId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_id" }
    );

    if (error) {
      console.error("[webhook] Supabase upsert error:", error);
      return res.status(500).json({ error: "Database error" });
    }

    console.log(`[webhook] Location stored: ${locationId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("[webhook] Error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Auth middleware — validates X-Api-Key header
// ---------------------------------------------------------------------------
function requireApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Exchange agency token → location token via GHL OAuth
// ---------------------------------------------------------------------------
async function getLocationToken(locationId) {
  // Check cache first
  const cached = getCachedToken(locationId);
  if (cached) {
    console.log(`[token] Cache hit for location ${locationId}`);
    return cached;
  }

  // Look up companyId from Supabase
  const { data, error } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", locationId)
    .single();

  if (error || !data) {
    throw new Error(
      `Location ${locationId} not found in database. ` +
        "Has the app been installed in this sub-account?"
    );
  }

  const companyId = data.company_id;
  console.log(
    `[token] Exchanging agency token for location=${locationId} company=${companyId}`
  );

  // Exchange agency token for location-scoped token
  const res = await fetch(`${GHL_API}/oauth/locationToken`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Version: "2021-07-28",
      Authorization: `Bearer ${process.env.GHL_AGENCY_TOKEN}`,
    },
    body: new URLSearchParams({ companyId, locationId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const tokenData = await res.json();
  const token = tokenData.access_token;

  // Cache the token
  setCachedToken(locationId, token);
  console.log(`[token] Got location token for ${locationId}`);

  return token;
}

// ---------------------------------------------------------------------------
// POST /api/add-tag — called by injection script to add tags to a contact
// ---------------------------------------------------------------------------
app.post("/api/add-tag", requireApiKey, async (req, res) => {
  try {
    const { locationId, contactId } = req.body;

    // Accept both { tags: ["a","b"] } and { tag: "a" } formats
    let tags = req.body.tags;
    if (!tags && req.body.tag) {
      tags = [req.body.tag];
    }

    if (
      !locationId ||
      !contactId ||
      !tags ||
      !Array.isArray(tags) ||
      tags.length === 0
    ) {
      return res.status(400).json({
        error: "Missing required fields",
        required: {
          locationId: "string",
          contactId: "string",
          tags: "string[] (or tag: string)",
        },
      });
    }

    console.log(
      `[add-tag] location=${locationId} contact=${contactId} tags=${tags.join(",")}`
    );

    // Get location-scoped token
    const token = await getLocationToken(locationId);

    // Call GHL API to add tags
    const ghlRes = await fetch(`${GHL_API}/contacts/${contactId}/tags`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify({ tags }),
    });

    if (!ghlRes.ok) {
      const text = await ghlRes.text();
      console.error(`[add-tag] GHL API error (${ghlRes.status}):`, text);

      // If token expired, clear cache and try once more
      if (ghlRes.status === 401) {
        console.log("[add-tag] Token expired, clearing cache and retrying...");
        tokenCache.delete(locationId);
        const freshToken = await getLocationToken(locationId);

        const retryRes = await fetch(
          `${GHL_API}/contacts/${contactId}/tags`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${freshToken}`,
              "Content-Type": "application/json",
              Version: "2021-07-28",
            },
            body: JSON.stringify({ tags }),
          }
        );

        if (!retryRes.ok) {
          const retryText = await retryRes.text();
          throw new Error(`GHL API error after retry (${retryRes.status}): ${retryText}`);
        }

        const retryResult = await retryRes.json();
        console.log(`[add-tag] Tags added on retry: ${tags.join(", ")}`);
        return res.json({ success: true, added: tags, tags: retryResult.tags });
      }

      throw new Error(`GHL API error (${ghlRes.status}): ${text}`);
    }

    const result = await ghlRes.json();
    console.log(`[add-tag] Tags added: ${tags.join(", ")}`);
    res.json({ success: true, added: tags, tags: result.tags });
  } catch (err) {
    console.error("[add-tag] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`InfinityBox backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
