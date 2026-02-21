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

function mapDataType(dataType: string): string {
  switch (dataType) {
    case "LARGE_TEXT":
      return "textarea";
    case "DATE":
      return "date";
    case "SINGLE_OPTIONS":
    case "MULTIPLE_OPTIONS":
      return "select";
    case "NUMERICAL":
    case "PHONE":
    case "MONETORY":
    case "TEXT":
    default:
      return "text";
  }
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
    const { locationId } = body;

    if (!locationId) {
      return new Response(
        JSON.stringify({ error: "Missing required field: locationId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[get-form-fields] Fetching custom fields for location=${locationId}`);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const token = await getLocationToken(locationId, supabase);

    // Fetch all contact custom fields
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
    const allFields = data.customFields || [];

    // Find the "Policy Info" folder ID
    // GHL custom fields in folders have a parentId pointing to the folder object
    // First, find folder objects (they appear in the customFields array with dataType "OBJECT" or similar)
    // Then filter fields whose parentId matches
    let policyInfoFolderId: string | null = null;
    for (const field of allFields) {
      if (field.name === "Policy Info" && (field.dataType === "OBJECT" || field.isFolder)) {
        policyInfoFolderId = field.id;
        break;
      }
    }

    // If no folder found, try matching by group property
    const filteredFields = [];
    for (const field of allFields) {
      // Skip folder/group objects themselves
      if (field.dataType === "OBJECT" || field.isFolder) continue;

      // Match by parentId (folder ID) or by group name
      if (
        (policyInfoFolderId && field.parentId === policyInfoFolderId) ||
        (field.group && field.group === "Policy Info")
      ) {
        filteredFields.push({
          id: field.id,
          name: field.name,
          dataType: mapDataType(field.dataType),
          placeholder: field.placeholder || "",
          options: field.options || [],
        });
      }
    }

    console.log(
      `[get-form-fields] Found ${filteredFields.length} fields in "Policy Info" folder (total fields: ${allFields.length})`
    );

    return new Response(
      JSON.stringify({ fields: filteredFields }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[get-form-fields] Error:", (err as Error).message);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
