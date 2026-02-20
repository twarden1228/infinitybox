import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GHL_API = "https://services.leadconnectorhq.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
};

async function getLocationToken(
  locationId: string,
  supabase: ReturnType<typeof createClient>
): Promise<string> {
  const { data, error } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", locationId)
    .single();

  if (error || !data) {
    throw new Error(
      `Location ${locationId} not found. Has the app been installed in this sub-account?`
    );
  }

  const companyId = data.company_id;
  console.log(
    `[token] Exchanging agency token for location=${locationId} company=${companyId}`
  );

  const res = await fetch(`${GHL_API}/oauth/locationToken`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Version: "2021-07-28",
      Authorization: `Bearer ${Deno.env.get("GHL_AGENCY_TOKEN")}`,
    },
    body: new URLSearchParams({ companyId, locationId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const tokenData = await res.json();
  console.log(`[token] Got location token for ${locationId}`);
  return tokenData.access_token;
}

async function addTagsViaGHL(
  contactId: string,
  tags: string[],
  locationToken: string
): Promise<Response> {
  return fetch(`${GHL_API}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${locationToken}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({ tags }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Validate API key
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || apiKey !== Deno.env.get("API_SECRET")) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const { locationId, contactId } = body;

    // Accept both { tags: ["a","b"] } and { tag: "a" } formats
    let tags: string[] | undefined = body.tags;
    if (!tags && body.tag) {
      tags = [body.tag];
    }

    if (
      !locationId ||
      !contactId ||
      !tags ||
      !Array.isArray(tags) ||
      tags.length === 0
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: {
            locationId: "string",
            contactId: "string",
            tags: "string[] (or tag: string)",
          },
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(
      `[add-tag] location=${locationId} contact=${contactId} tags=${tags.join(",")}`
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get location-scoped token (fresh each time — no persistent cache in edge functions)
    const token = await getLocationToken(locationId, supabase);

    // Call GHL API to add tags
    let ghlRes = await addTagsViaGHL(contactId, tags, token);

    // If 401, retry once with a fresh token
    if (ghlRes.status === 401) {
      console.log("[add-tag] Token rejected (401), retrying with fresh token...");
      const freshToken = await getLocationToken(locationId, supabase);
      ghlRes = await addTagsViaGHL(contactId, tags, freshToken);
    }

    if (!ghlRes.ok) {
      const text = await ghlRes.text();
      console.error(`[add-tag] GHL API error (${ghlRes.status}):`, text);
      throw new Error(`GHL API error (${ghlRes.status}): ${text}`);
    }

    const result = await ghlRes.json();
    console.log(`[add-tag] Tags added: ${tags.join(", ")}`);

    return new Response(
      JSON.stringify({ success: true, added: tags, tags: result.tags }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[add-tag] Error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
