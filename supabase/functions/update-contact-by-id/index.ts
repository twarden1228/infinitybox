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

async function updateContactCustomFields(
  contactId: string,
  customFields: Array<{ id: string; field_value: string }>,
  token: string
): Promise<Response> {
  return fetch(`${GHL_API}/contacts/${contactId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({ customFields }),
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

  const apiKey = req.headers.get("x-api-key");
  if (!apiKey || apiKey !== Deno.env.get("API_SECRET")) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const { locationId, contactId, customFieldsById } = body;

    if (
      !locationId ||
      !contactId ||
      !customFieldsById ||
      !Array.isArray(customFieldsById) ||
      customFieldsById.length === 0
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: {
            locationId: "string",
            contactId: "string",
            customFieldsById: '[{ "id": "field_id", "field_value": "value" }, ...]',
          },
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(
      `[update-contact-by-id] location=${locationId} contact=${contactId} fields=${customFieldsById.length}`
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let token = await getLocationToken(locationId, supabase);

    let ghlRes = await updateContactCustomFields(contactId, customFieldsById, token);

    // Retry once with fresh token on 401
    if (ghlRes.status === 401) {
      console.log("[update-contact-by-id] Token rejected (401), retrying with fresh token...");
      token = await getLocationToken(locationId, supabase);
      ghlRes = await updateContactCustomFields(contactId, customFieldsById, token);
    }

    const ghlBody = await ghlRes.text();
    console.log(`[update-contact-by-id] GHL response (${ghlRes.status}):`, ghlBody);

    if (!ghlRes.ok) {
      console.error(`[update-contact-by-id] GHL API error (${ghlRes.status}):`, ghlBody);
      throw new Error(`GHL API error (${ghlRes.status}): ${ghlBody}`);
    }

    let ghlParsed;
    try { ghlParsed = JSON.parse(ghlBody); } catch { ghlParsed = ghlBody; }

    return new Response(
      JSON.stringify({ success: true, ghlResponse: ghlParsed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[update-contact-by-id] Error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
