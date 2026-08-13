const TROY_OUNCE_IN_GRAMS = 31.1034768;

const GOLD_URL = 'https://www.goldapi.io/api/XAU/INR';
const SILVER_URL = 'https://www.goldapi.io/api/XAG/INR';

async function fetchRaw(url, apiKey) {
  const res = await fetch(url, {
    headers: { 'x-access-token': apiKey }
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`Request to ${url} failed: ${res.status} ${res.statusText} - ${bodyText}`);
  }
  return JSON.parse(bodyText);
}

/* ── fetchGoldSilverRate — the only piece that talks to goldapi.io ── */
async function fetchGoldSilverRate(apiKey) {
  const rawGoldResponse = await fetchRaw(GOLD_URL, apiKey);
  console.log('Raw gold response (XAU/INR):', JSON.stringify(rawGoldResponse));

  const rawSilverResponse = await fetchRaw(SILVER_URL, apiKey);
  console.log('Raw silver response (XAG/INR):', JSON.stringify(rawSilverResponse));

  // Every karat field is price_gram_24k scaled by karat/24 — Nava sells
  // 9kt only, and the API doesn't expose price_gram_9k directly.
  const goldRatePerGram = rawGoldResponse.price_gram_24k * (9 / 24);

  // Not confirmed ahead of time whether XAG/INR exposes a direct per-gram
  // field (goldapi.io sometimes mirrors gold's price_gram_24k naming for
  // fine/.999 silver, sometimes not) — check the actual response instead
  // of assuming either way.
  let silverRatePerGram;
  const directGramField = ['price_gram', 'price_gram_24k'].find(
    f => typeof rawSilverResponse[f] === 'number' && Number.isFinite(rawSilverResponse[f])
  );
  if (directGramField) {
    silverRatePerGram = rawSilverResponse[directGramField];
  } else {
    silverRatePerGram = rawSilverResponse.price / TROY_OUNCE_IN_GRAMS;
  }

  return { goldRatePerGram, silverRatePerGram, rawGoldResponse, rawSilverResponse };
}

/* ── validateRate — static absolute bounds only, no day-over-day comparison ── */
function validateRate(goldRatePerGram, silverRatePerGram) {
  if (typeof goldRatePerGram !== 'number' || !Number.isFinite(goldRatePerGram)) {
    return { valid: false, reason: `goldRatePerGram is not a finite number: ${goldRatePerGram}` };
  }
  if (typeof silverRatePerGram !== 'number' || !Number.isFinite(silverRatePerGram)) {
    return { valid: false, reason: `silverRatePerGram is not a finite number: ${silverRatePerGram}` };
  }
  if (goldRatePerGram < 1000 || goldRatePerGram > 25000) {
    return { valid: false, reason: `goldRatePerGram ${goldRatePerGram} is outside the expected range [1000, 25000]` };
  }
  if (silverRatePerGram < 50 || silverRatePerGram > 15000) {
    return { valid: false, reason: `silverRatePerGram ${silverRatePerGram} is outside the expected range [50, 15000]` };
  }
  return { valid: true };
}

module.exports = { fetchGoldSilverRate, validateRate };
