const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { fetchGoldSilverRate, validateRate } = require('./fetch-rate');
const { loadPricingData, computeUpdates, computeTodayPrices, applyUpdatesToShopify } = require('./sync-shopify-prices');

const PRICING_DATA_PATH = path.join(__dirname, '..', 'pricing-data.json');

function git(args) {
  return execFileSync('git', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const summary = {
    rate: null,
    validation: null,
    commit: null,
    sync: null
  };

  // 1. Load existing data first so an insufficient-sources metal can fall
  // back to yesterday's rate instead of writing an invented value.
  const pricingData = loadPricingData(PRICING_DATA_PATH);
  const previousGoldRate = pricingData.gold_rate_per_g;
  const previousSilverRate = pricingData.silver_rate_per_g;

  // 2. Fetch rates (multi-source domestic average; gold and silver are each
  // either a fresh average or null if fewer than the minimum sources
  // survived outlier exclusion for that metal)
  let rate;
  try {
    rate = await fetchGoldSilverRate();
  } catch (err) {
    console.error(`\nFatal: rate fetch failed: ${err.message}`);
    process.exit(1);
  }

  const goldUpdated = rate.goldRatePerGram !== null;
  const silverUpdated = rate.silverRatePerGram !== null;
  const goldRatePerGram = goldUpdated ? rate.goldRatePerGram : previousGoldRate;
  const silverRatePerGram = silverUpdated ? rate.silverRatePerGram : previousSilverRate;

  summary.rate = { goldRatePerGram, silverRatePerGram, goldUpdated, silverUpdated };
  console.log(
    goldUpdated
      ? `\nGold rate updated: ${goldRatePerGram} INR/g`
      : `\nGold rate NOT updated (fewer than minimum valid sources this run) — keeping previous rate ${previousGoldRate} INR/g`
  );
  console.log(
    silverUpdated
      ? `Silver rate updated: ${silverRatePerGram} INR/g`
      : `Silver rate NOT updated (fewer than minimum valid sources this run) — keeping previous rate ${previousSilverRate} INR/g`
  );

  // 3. Validate the final values (fresh or carried over) — same static
  // bounds check as before, now the last safety net after acquisition.
  const validation = validateRate(goldRatePerGram, silverRatePerGram);
  summary.validation = validation;
  if (!validation.valid) {
    console.error(`\nFatal: rate validation failed: ${validation.reason}`);
    process.exit(1);
  }
  console.log('Validation: OK');

  // 4. Compute today_price_inr for every record (same math as the Shopify
  // sync below, just written into the data file instead of pushed live) —
  // rates must be set on pricingData first since computeTodayPrices reads
  // gold_rate_per_g/silver_rate_per_g off it, same as computeUpdates does.
  pricingData.gold_rate_per_g = goldRatePerGram;
  pricingData.silver_rate_per_g = silverRatePerGram;
  computeTodayPrices(pricingData);

  // 5. Write pricing-data.json
  fs.writeFileSync(PRICING_DATA_PATH, JSON.stringify(pricingData, null, 2) + '\n');
  console.log(`\nWrote gold_rate_per_g=${goldRatePerGram}, silver_rate_per_g=${silverRatePerGram} to ${PRICING_DATA_PATH}`);

  // 6. Commit and push
  try {
    git(['config', 'user.name', 'Nava Pricing Bot']);
    git(['config', 'user.email', 'nava-pricing-bot@users.noreply.github.com']);
    git(['add', 'pricing-data.json']);
    git(['commit', '-m', `Auto-update gold/silver rates: ${todayIso()}`]);
    git(['push']);
    summary.commit = 'succeeded';
    console.log('\nCommit + push: succeeded');
  } catch (err) {
    summary.commit = `failed: ${err.message}`;
    console.error(`\nFatal: commit/push failed (nothing changed, or a push conflict): ${err.message}`);
    console.log('\n=== Final summary ===');
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  // 7. Sync to Shopify, reusing the existing push-triggered workflow's functions
  const freshPricingData = loadPricingData(PRICING_DATA_PATH);
  const { updates, skipped } = computeUpdates(freshPricingData);

  console.log(`\nSkipped (${skipped.length}):`);
  skipped.forEach(s => console.log(`  - ${s.skuLabel}: ${s.reason}`));

  console.log(`\nApplying ${updates.length} update(s) to Shopify...`);
  let succeeded = [];
  let failed = [];
  try {
    ({ succeeded, failed } = await applyUpdatesToShopify(updates));
    if (failed.length > 0) {
      console.log(`\nFailed (${failed.length}):`);
      failed.forEach(f => console.log(`  - ${f.skuLabel} (${f.variantGid}): ${f.error}`));
    }
    summary.sync = { succeeded: succeeded.length, failed: failed.length, skipped: skipped.length };
  } catch (err) {
    console.error(`\nShopify sync failed: ${err.message}`);
    summary.sync = `failed: ${err.message}`;
  }

  console.log('\n=== Final summary ===');
  console.log(JSON.stringify(summary, null, 2));

  if (summary.sync === null || typeof summary.sync === 'string' || summary.sync.failed > 0) {
    process.exit(1);
  }
}

main();
