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

async function getCustomFieldMap(
  locationId: string,
  token: string
): Promise<{ fieldMap: Map<string, string>; availableNames: string[] }> {
  const res = await fetch(
    `${GHL_API}/locations/${locationId}/customFields?model=contact`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch custom fields (${res.status}): ${text}`);
  }

  const data = await res.json();
  const fieldMap = new Map<string, string>();
  const availableNames: string[] = [];
  for (const field of data.customFields || []) {
    fieldMap.set(field.name.toLowerCase(), field.id);
    availableNames.push(field.name);
  }
  console.log(
    `[update-contact] Found ${fieldMap.size} custom fields for location ${locationId}: ${availableNames.join(", ")}`
  );
  return { fieldMap, availableNames };
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
    const { locationId, contactId, customFields } = body;

    if (
      !locationId ||
      !contactId ||
      !customFields ||
      typeof customFields !== "object" ||
      Object.keys(customFields).length === 0
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
          required: {
            locationId: "string",
            contactId: "string",
            customFields: '{ "Field Name": "value", ... }',
          },
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(
      `[update-contact] location=${locationId} contact=${contactId} fields=${Object.keys(customFields).join(",")}`
    );

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get location-scoped token
    let token = await getLocationToken(locationId, supabase);

    // Resolve field names to IDs and update contact
    // Wrapped in a function so we can retry on 401
    async function resolveAndUpdate(locationToken: string) {
      const { fieldMap, availableNames } = await getCustomFieldMap(locationId, locationToken);

      const resolved: Array<{ id: string; field_value: string }> = [];
      const updated: Record<string, string> = {};
      const warnings: string[] = [];

      for (const [name, value] of Object.entries(customFields)) {
        const fieldId = fieldMap.get(name.toLowerCase());
        if (fieldId) {
          resolved.push({ id: fieldId, field_value: value as string });
          updated[name] = value as string;
        } else {
          warnings.push(name);
        }
      }

      if (resolved.length === 0) {
        return new Response(
          JSON.stringify({
            error: "No matching custom fields found",
            notFound: warnings,
            availableFields: availableNames,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const ghlRes = await updateContactCustomFields(contactId, resolved, locationToken);
      return { ghlRes, updated, warnings, availableNames };
    }

    let result = await resolveAndUpdate(token);

    // If we got a Response back directly, it's an error
    if (result instanceof Response) return result;

    // If 401, retry once with fresh token
    if (result.ghlRes.status === 401) {
      console.log("[update-contact] Token rejected (401), retrying with fresh token...");
      const freshToken = await getLocationToken(locationId, supabase);
      result = await resolveAndUpdate(freshToken);
      if (result instanceof Response) return result;
    }

    const ghlBody = await result.ghlRes.text();
    console.log(`[update-contact] GHL response (${result.ghlRes.status}):`, ghlBody);

    if (!result.ghlRes.ok) {
      console.error(`[update-contact] GHL API error (${result.ghlRes.status}):`, ghlBody);
      throw new Error(`GHL API error (${result.ghlRes.status}): ${ghlBody}`);
    }

    console.log(`[update-contact] Fields updated: ${Object.keys(result.updated).join(", ")}`);

    let ghlParsed;
    try { ghlParsed = JSON.parse(ghlBody); } catch { ghlParsed = ghlBody; }

    const response: Record<string, unknown> = {
      success: true,
      updated: result.updated,
      ghlResponse: ghlParsed,
    };
    if (result.warnings.length > 0) {
      response.warnings = result.warnings;
      response.availableFields = result.availableNames;
    }

    return new Response(
      JSON.stringify(response),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[update-contact] Error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
