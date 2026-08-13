/*
 * FUTURE EXTENSION (not yet built): an automated daily rate-fetch will
 * call IBJA's Rates API (primary) / GoldAPI.io (fallback), write the
 * fetched gold_rate_per_g/silver_rate_per_g into pricing-data.json,
 * commit + push that change, THEN call loadPricingData() →
 * computeUpdates() → applyUpdatesToShopify() from within that SAME
 * workflow run — GitHub Actions won't let a bot's own commit re-trigger
 * this push-based workflow, so the fetch-and-sync logic must live in one
 * combined scheduled workflow, not two chained ones. This file's three
 * exported functions are designed to be reused as-is by that future
 * workflow without modification.
 */

const fs = require('fs');
const path = require('path');

// Matches nava-cart.js (Storefront API) — same store, Admin API instead.
const SHOPIFY_DOMAIN = 'nava-online-2-2.myshopify.com';
const ADMIN_API_VERSION = '2026-04';
const ADMIN_ENDPOINT = `https://${SHOPIFY_DOMAIN}/admin/api/${ADMIN_API_VERSION}/graphql.json`;

/* ── 1. loadPricingData — pure file I/O, no computation ── */
function loadPricingData(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/* Mirrors computePriceForSize() in every product page exactly, including
   rounding each component (gold_value, silver_value, gst) before summing,
   not after. */
function computeMetalTotal(metal, goldRate, silverRate, weightG, goldWeightG, silverWeightG) {
  if (metal === 'gold_9k_silver') {
    if (goldRate == null || silverRate == null || goldWeightG == null || silverWeightG == null) {
      return null;
    }
    const goldValue = Math.round(goldWeightG * goldRate);
    const silverValue = Math.round(silverWeightG * silverRate);
    return goldValue + silverValue;
  }
  if (goldRate == null || weightG == null) return null;
  return Math.round(weightG * goldRate);
}

function computePriceFromMetalTotal(metalTotal, makingCharge) {
  const gst = Math.round(0.03 * (metalTotal + makingCharge));
  return metalTotal + makingCharge + gst;
}

function skuLabelFor(record, sizeKey) {
  const base = `${record.design_name} ${record.label}`;
  return sizeKey ? `${base} (Size ${sizeKey})` : base;
}

/* ── 2. computeUpdates — PURE function, no network calls ── */
function computeUpdates(pricingData) {
  const goldRate = pricingData.gold_rate_per_g;
  const silverRate = pricingData.silver_rate_per_g;
  const updates = [];
  const skipped = [];

  for (const [key, record] of Object.entries(pricingData)) {
    if (key === 'gold_rate_per_g' || key === 'silver_rate_per_g' || key === 'warnings') continue;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;

    if (!record.is_sized) {
      const skuLabel = skuLabelFor(record, null);

      if (record.making_charge === null) {
        skipped.push({ key, skuLabel, reason: 'making_charge is null' });
        continue;
      }

      const metalTotal = computeMetalTotal(
        record.metal, goldRate, silverRate,
        record.weight_g, record.gold_weight_g, record.silver_weight_g
      );
      if (metalTotal === null) {
        skipped.push({ key, skuLabel, reason: 'missing weight or rate data needed to compute metal_total' });
        continue;
      }

      const computedPrice = computePriceFromMetalTotal(metalTotal, record.making_charge);
      updates.push({ variantGid: record.shopify_variant_gid, computedPrice, skuLabel });
      continue;
    }

    // Sized record: one making_charge, flat across all sizes of the SKU.
    for (const [sizeKey, sizeEntry] of Object.entries(record.sizes || {})) {
      const skuLabel = skuLabelFor(record, sizeKey);

      if (sizeEntry.shopify_variant_gid === null) {
        skipped.push({ key, skuLabel, reason: 'shopify_variant_gid is null (Custom or unassigned size)' });
        continue;
      }
      if (record.making_charge === null) {
        skipped.push({ key, skuLabel, reason: 'making_charge is null' });
        continue;
      }

      const metalTotal = computeMetalTotal(
        record.metal, goldRate, silverRate,
        sizeEntry.weight_g, sizeEntry.gold_weight_g, sizeEntry.silver_weight_g
      );
      if (metalTotal === null) {
        skipped.push({ key, skuLabel, reason: 'missing weight or rate data needed to compute metal_total' });
        continue;
      }

      const computedPrice = computePriceFromMetalTotal(metalTotal, record.making_charge);
      updates.push({ variantGid: sizeEntry.shopify_variant_gid, computedPrice, skuLabel });
    }
  }

  return { updates, skipped };
}

/* Custom apps created after 2026-01-01 no longer issue a static Admin API
   token — the client credentials grant must be exchanged for a fresh
   access token (valid 24h) at the start of every run. */
async function getAccessToken(shopDomain, clientId, clientSecret) {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`getAccessToken failed: ${res.status} ${res.statusText} - ${bodyText}`);
  }
  const { access_token } = JSON.parse(bodyText);
  return access_token;
}

/* ── 3. applyUpdatesToShopify — the only piece that talks to Shopify ── */
async function adminGraphQL(query, variables, accessToken) {
  const res = await fetch(ADMIN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map(e => e.message).join('; '));
  }
  return json.data;
}

const VARIANT_LOOKUP_QUERY = `
  query GetVariantForSync($id: ID!) {
    productVariant(id: $id) {
      id
      price
      product { id }
    }
  }
`;

const BULK_UPDATE_MUTATION = `
  mutation SyncPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price }
      userErrors { field message }
    }
  }
`;

async function applyUpdatesToShopify(updates) {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must both be set');
  }
  const accessToken = await getAccessToken(SHOPIFY_DOMAIN, clientId, clientSecret);

  const succeeded = [];
  const failed = [];

  // Look up current price + parent product id for every update first —
  // productVariantsBulkUpdate needs the product id, and logging old→new
  // needs the price as it stood before this run.
  const byProduct = new Map(); // productId -> [{ update, variantId, oldPrice }]

  for (const update of updates) {
    try {
      const data = await adminGraphQL(VARIANT_LOOKUP_QUERY, { id: update.variantGid }, accessToken);
      const variant = data.productVariant;
      if (!variant) {
        failed.push({ ...update, error: 'variant not found' });
        continue;
      }
      const productId = variant.product.id;
      if (!byProduct.has(productId)) byProduct.set(productId, []);
      byProduct.get(productId).push({ update, variantId: variant.id, oldPrice: variant.price });
    } catch (err) {
      failed.push({ ...update, error: err.message });
    }
  }

  // One productVariantsBulkUpdate call per product, not per variant.
  for (const [productId, entries] of byProduct.entries()) {
    const variantsInput = entries.map(e => ({
      id: e.variantId,
      price: String(e.update.computedPrice)
    }));

    try {
      const data = await adminGraphQL(
        BULK_UPDATE_MUTATION,
        { productId, variants: variantsInput },
        accessToken
      );
      const result = data.productVariantsBulkUpdate;

      if (result.userErrors && result.userErrors.length > 0) {
        // Bulk mutation failed for this product's whole batch — Shopify
        // doesn't tell us which specific variant(s) triggered it, so
        // attribute the failure to every variant in the batch.
        const message = result.userErrors.map(e => `${e.field}: ${e.message}`).join('; ');
        entries.forEach(e => failed.push({ ...e.update, error: message }));
        continue;
      }

      entries.forEach(e => {
        console.log(`${e.update.skuLabel} (${e.update.variantGid}): ${e.oldPrice} -> ${e.update.computedPrice}`);
        succeeded.push({ ...e.update, oldPrice: e.oldPrice, newPrice: e.update.computedPrice });
      });
    } catch (err) {
      entries.forEach(e => failed.push({ ...e.update, error: err.message }));
    }
  }

  return { succeeded, failed };
}

module.exports = { loadPricingData, computeUpdates, applyUpdatesToShopify, getAccessToken };

if (require.main === module) {
  (async () => {
    try {
      const pricingDataPath = path.join(__dirname, '..', 'pricing-data.json');
      const pricingData = loadPricingData(pricingDataPath);
      const { updates, skipped } = computeUpdates(pricingData);

      console.log(`\nSkipped (${skipped.length}):`);
      skipped.forEach(s => console.log(`  - ${s.skuLabel}: ${s.reason}`));

      console.log(`\nApplying ${updates.length} update(s) to Shopify...`);
      const { succeeded, failed } = await applyUpdatesToShopify(updates);

      if (failed.length > 0) {
        console.log(`\nFailed (${failed.length}):`);
        failed.forEach(f => console.log(`  - ${f.skuLabel} (${f.variantGid}): ${f.error}`));
      }

      console.log(`\nSummary: ${succeeded.length} succeeded, ${failed.length} failed, ${skipped.length} skipped`);

      if (failed.length > 0) process.exit(1);
    } catch (err) {
      console.error(`\nFatal: ${err.message}`);
      process.exit(1);
    }
  })();
}
