const ghl = require("../lib/ghl");

module.exports = async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Authenticate the request with API secret
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { locationId, contactId, tags } = req.body || {};

  if (!locationId || !contactId || !tags || !Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({
      error: "Missing required fields",
      required: { locationId: "string", contactId: "string", tags: "string[]" },
    });
  }

  try {
    const result = await ghl.addTagsToContact(locationId, contactId, tags);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("Add tag error:", err);
    res.status(500).json({ error: "Failed to add tag", details: err.message });
  }
};
