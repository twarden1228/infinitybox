const { kv } = require("@vercel/kv");

// Keys:
//   agency:{companyId}         → { accessToken, refreshToken, expiresAt }
//   location:{locationId}      → { accessToken, refreshToken, expiresAt, companyId }

async function getAgencyToken(companyId) {
  return kv.get(`agency:${companyId}`);
}

async function setAgencyToken(companyId, tokenData) {
  // Store with no TTL — we manage refresh ourselves
  await kv.set(`agency:${companyId}`, tokenData);
}

async function getLocationToken(locationId) {
  return kv.get(`location:${locationId}`);
}

async function setLocationToken(locationId, tokenData) {
  // Cache location tokens for slightly less than their actual expiry
  const ttl = tokenData.expiresIn ? tokenData.expiresIn - 300 : 82800; // default ~23h
  await kv.set(`location:${locationId}`, tokenData, { ex: ttl });
}

async function deleteAgencyToken(companyId) {
  await kv.del(`agency:${companyId}`);
}

async function deleteLocationToken(locationId) {
  await kv.del(`location:${locationId}`);
}

module.exports = {
  getAgencyToken,
  setAgencyToken,
  getLocationToken,
  setLocationToken,
  deleteAgencyToken,
  deleteLocationToken,
};
