const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ---- Configuration (set via environment variables) ----
const PORT = process.env.PORT || 3000;
const GHL_AGENCY_TOKEN = process.env.GHL_AGENCY_TOKEN; // Agency-level Private Integration token
const GHL_COMPANY_ID = process.env.GHL_COMPANY_ID; // Agency company ID
const API_SECRET_KEY = process.env.API_SECRET_KEY; // Secret key clients must send in x-api-key header

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// ---- Location token cache ----
// Maps locationId -> { token, expiresAt }
const tokenCache = new Map();
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours (tokens last ~24h)

// ---- Helpers ----

function authenticate(req, res) {
  if (!API_SECRET_KEY) return true; // no key configured = open (dev only)
  const key = req.headers["x-api-key"];
  if (key !== API_SECRET_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function getLocationToken(locationId) {
  // Check cache first
  const cached = tokenCache.get(locationId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  // Exchange agency token for location-scoped token
  const resp = await fetch(GHL_BASE + "/oauth/locationToken", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Version: GHL_API_VERSION,
      Authorization: "Bearer " + GHL_AGENCY_TOKEN,
    },
    body: "companyId=" + encodeURIComponent(GHL_COMPANY_ID) + "&locationId=" + encodeURIComponent(locationId),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error("Failed to get location token (status " + resp.status + "): " + text);
  }

  const data = await resp.json();
  const token = data.access_token;

  // Cache it
  tokenCache.set(locationId, {
    token: token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  return token;
}

async function ghlRequest(method, path, locationToken, body) {
  const options = {
    method: method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + locationToken,
      Version: GHL_API_VERSION,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const resp = await fetch(GHL_BASE + path, options);
  const text = await resp.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { raw: text };
  }

  return { status: resp.status, ok: resp.ok, data: json };
}

// ---- Routes ----

// Health check
app.get("/", function (req, res) {
  res.json({ status: "ok", service: "ghl-buttons-api" });
});

// POST /api/add-tag
// Body: { contactId, locationId, tagName }
app.post("/api/add-tag", async function (req, res) {
  if (!authenticate(req, res)) return;

  const { contactId, locationId, tagName } = req.body;
  if (!contactId || !locationId || !tagName) {
    return res.status(400).json({ error: "Missing required fields: contactId, locationId, tagName" });
  }

  try {
    const token = await getLocationToken(locationId);
    const result = await ghlRequest("POST", "/contacts/" + contactId + "/tags", token, {
      tags: [tagName],
    });

    if (result.ok) {
      console.log("[add-tag] Success: contact=" + contactId + " tag=" + tagName + " location=" + locationId);
      res.json({ success: true, data: result.data });
    } else {
      console.log("[add-tag] GHL error: status=" + result.status, result.data);
      res.status(result.status).json({ success: false, error: result.data });
    }
  } catch (err) {
    console.error("[add-tag] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/update-field
// Body: { contactId, locationId, fieldName, value }
app.post("/api/update-field", async function (req, res) {
  if (!authenticate(req, res)) return;

  const { contactId, locationId, fieldName, value } = req.body;
  if (!contactId || !locationId || !fieldName || value === undefined) {
    return res.status(400).json({ error: "Missing required fields: contactId, locationId, fieldName, value" });
  }

  try {
    const token = await getLocationToken(locationId);
    const result = await ghlRequest("PUT", "/contacts/" + contactId, token, {
      customFields: [{ key: fieldName, field_value: String(value) }],
    });

    if (result.ok) {
      console.log("[update-field] Success: contact=" + contactId + " field=" + fieldName + " location=" + locationId);
      res.json({ success: true, data: result.data });
    } else {
      console.log("[update-field] GHL error: status=" + result.status, result.data);
      res.status(result.status).json({ success: false, error: result.data });
    }
  } catch (err) {
    console.error("[update-field] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/form-submission
// Body: { contactId, locationId, tags: [...], customFields: { fieldName: value, ... } }
app.post("/api/form-submission", async function (req, res) {
  if (!authenticate(req, res)) return;

  const { contactId, locationId, tags, customFields } = req.body;
  if (!contactId || !locationId) {
    return res.status(400).json({ error: "Missing required fields: contactId, locationId" });
  }

  try {
    const token = await getLocationToken(locationId);
    const results = { tags: null, fields: null };

    // Add tags if any
    if (tags && tags.length > 0) {
      results.tags = await ghlRequest("POST", "/contacts/" + contactId + "/tags", token, {
        tags: tags,
      });
    }

    // Update custom fields if any
    if (customFields && Object.keys(customFields).length > 0) {
      const cfArray = Object.entries(customFields).map(function (entry) {
        return { key: entry[0], field_value: String(entry[1]) };
      });
      results.fields = await ghlRequest("PUT", "/contacts/" + contactId, token, {
        customFields: cfArray,
      });
    }

    const allOk = (!results.tags || results.tags.ok) && (!results.fields || results.fields.ok);

    if (allOk) {
      console.log("[form-submission] Success: contact=" + contactId + " location=" + locationId +
        " tags=" + (tags ? tags.length : 0) + " fields=" + (customFields ? Object.keys(customFields).length : 0));
      res.json({ success: true, results: results });
    } else {
      console.log("[form-submission] Partial failure:", JSON.stringify(results));
      res.status(207).json({ success: false, results: results });
    }
  } catch (err) {
    console.error("[form-submission] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Start ----
app.listen(PORT, function () {
  console.log("ghl-buttons-api listening on port " + PORT);
  if (!GHL_AGENCY_TOKEN) console.warn("WARNING: GHL_AGENCY_TOKEN not set");
  if (!GHL_COMPANY_ID) console.warn("WARNING: GHL_COMPANY_ID not set");
  if (!API_SECRET_KEY) console.warn("WARNING: API_SECRET_KEY not set (auth disabled)");
});
