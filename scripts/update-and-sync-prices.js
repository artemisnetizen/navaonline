const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { fetchGoldSilverRate, validateRate } = require('./fetch-rate');
const { loadPricingData, computeUpdates, applyUpdatesToShopify } = require('./sync-shopify-prices');

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

  // 1. Fetch rates
  let rate;
  try {
    rate = await fetchGoldSilverRate(process.env.GOLDAPI_KEY);
  } catch (err) {
    console.error(`\nFatal: rate fetch failed: ${err.message}`);
    process.exit(1);
  }
  summary.rate = { goldRatePerGram: rate.goldRatePerGram, silverRatePerGram: rate.silverRatePerGram };
  console.log(`\nFetched rates: gold=${rate.goldRatePerGram} INR/g, silver=${rate.silverRatePerGram} INR/g`);

  // 2. Validate
  const validation = validateRate(rate.goldRatePerGram, rate.silverRatePerGram);
  summary.validation = validation;
  if (!validation.valid) {
    console.error(`\nFatal: rate validation failed: ${validation.reason}`);
    process.exit(1);
  }
  console.log('Validation: OK');

  // 3. Write pricing-data.json
  const pricingData = loadPricingData(PRICING_DATA_PATH);
  pricingData.gold_rate_per_g = rate.goldRatePerGram;
  pricingData.silver_rate_per_g = rate.silverRatePerGram;
  fs.writeFileSync(PRICING_DATA_PATH, JSON.stringify(pricingData, null, 2) + '\n');
  console.log(`\nWrote gold_rate_per_g=${rate.goldRatePerGram}, silver_rate_per_g=${rate.silverRatePerGram} to ${PRICING_DATA_PATH}`);

  // 4. Commit and push
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

  // 5. Sync to Shopify, reusing the existing push-triggered workflow's functions
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
