const ghl = require("../../lib/ghl");
const store = require("../../lib/store");

module.exports = async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  try {
    const tokenData = await ghl.exchangeCode(code);

    // tokenData from GHL includes:
    // access_token, refresh_token, expires_in, token_type,
    // locationId (if location-level), companyId, userId
    const companyId = tokenData.companyId;
    const locationId = tokenData.locationId;

    if (!companyId) {
      return res.status(400).json({ error: "No companyId in token response" });
    }

    // Store agency-level token
    await store.setAgencyToken(companyId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    });

    // If this was a location-level install, also store the location mapping
    if (locationId) {
      await store.setLocationToken(locationId, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
        expiresIn: tokenData.expires_in,
        companyId,
      });
    }

    // Show success page
    res.setHeader("Content-Type", "text/html");
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head><title>InfinityBox - Connected</title></head>
      <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f8fafc;">
        <div style="text-align: center; padding: 2rem; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <h1 style="color: #10b981; font-size: 1.5rem;">Connected Successfully</h1>
          <p style="color: #64748b;">InfinityBox is now connected to your GoHighLevel account.</p>
          <p style="color: #94a3b8; font-size: 0.875rem;">Company ID: ${companyId}</p>
          ${locationId ? `<p style="color: #94a3b8; font-size: 0.875rem;">Location ID: ${locationId}</p>` : ""}
          <p style="color: #64748b; margin-top: 1rem;">You can close this window.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).json({ error: "OAuth token exchange failed", details: err.message });
  }
};
