const store = require("./store");

const GHL_API = "https://services.leadconnectorhq.com";

// Exchange authorization code for agency tokens
async function exchangeCode(code) {
  const res = await fetch(`${GHL_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

// Refresh an expired token
async function refreshToken(refreshTokenValue) {
  const res = await fetch(`${GHL_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json();
}

// Exchange agency token for a location-scoped token
async function getLocationToken(companyId, locationId) {
  const res = await fetch(`${GHL_API}/oauth/locationToken`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Version: "2021-07-28",
    },
    body: new URLSearchParams({
      companyId,
      locationId,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Location token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

// Get a valid access token for a location, refreshing if needed
async function getValidLocationToken(locationId) {
  // 1. Check if we have a cached location token
  let locToken = await store.getLocationToken(locationId);
  if (locToken && locToken.accessToken && Date.now() < locToken.expiresAt) {
    return locToken.accessToken;
  }

  // 2. We need the agency token to exchange for a location token
  //    Try to find which company this location belongs to
  let companyId = locToken && locToken.companyId;

  if (!companyId) {
    // If we don't know the company, we can't proceed
    // The companyId should have been stored during OAuth callback
    throw new Error(`No company mapping found for location ${locationId}`);
  }

  // 3. Get agency token, refresh if expired
  let agencyData = await store.getAgencyToken(companyId);
  if (!agencyData) {
    throw new Error(`No agency token found for company ${companyId}`);
  }

  if (Date.now() >= agencyData.expiresAt) {
    const refreshed = await refreshToken(agencyData.refreshToken);
    agencyData = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
    };
    await store.setAgencyToken(companyId, agencyData);
  }

  // 4. Exchange agency token for location token
  const locResult = await getLocationToken(companyId, locationId);
  const newLocToken = {
    accessToken: locResult.access_token,
    refreshToken: locResult.refresh_token || agencyData.refreshToken,
    expiresAt: Date.now() + (locResult.expires_in || 86400) * 1000,
    expiresIn: locResult.expires_in || 86400,
    companyId,
  };
  await store.setLocationToken(locationId, newLocToken);

  return newLocToken.accessToken;
}

// Add tags to a contact
async function addTagsToContact(locationId, contactId, tags) {
  const token = await getValidLocationToken(locationId);

  // First fetch the contact to get existing tags
  const getRes = await fetch(
    `${GHL_API}/contacts/${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: "2021-07-28",
      },
    }
  );

  if (!getRes.ok) {
    const text = await getRes.text();
    throw new Error(`Failed to fetch contact (${getRes.status}): ${text}`);
  }

  const contactData = await getRes.json();
  const contact = contactData.contact || contactData;
  const existingTags = contact.tags || [];

  // Merge tags, avoiding duplicates (case-insensitive)
  const existingLower = existingTags.map((t) => t.toLowerCase().trim());
  const newTags = [...existingTags];
  const added = [];

  for (const tag of tags) {
    if (!existingLower.includes(tag.toLowerCase().trim())) {
      newTags.push(tag);
      added.push(tag);
    }
  }

  if (added.length === 0) {
    return { added: [], message: "All tags already exist on contact" };
  }

  // Update contact with new tags
  const putRes = await fetch(
    `${GHL_API}/contacts/${contactId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      body: JSON.stringify({ tags: newTags }),
    }
  );

  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`Failed to update contact tags (${putRes.status}): ${text}`);
  }

  return { added, message: `Added ${added.length} tag(s)` };
}

module.exports = {
  exchangeCode,
  refreshToken,
  getLocationToken,
  getValidLocationToken,
  addTagsToContact,
};
