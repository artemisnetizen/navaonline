/*
 * Prototype (vara.html only, manual trigger — see
 * .github/workflows/bake-html-fallback-manual.yml): bakes computed price
 * plus the raw weight/rate inputs and per-size data straight into a
 * product page's `variants` object literal, so the page's pricing UI
 * doesn't need to fetch pricing-data.json. Reads whatever
 * pricing-data.json is already on disk/committed — never fetches new
 * rates, never calls Shopify.
 */

const fs = require('fs');
const path = require('path');
const { computeMetalTotal, computePriceFromMetalTotal, loadPricingData } = require('./sync-shopify-prices');

function bareIdFromGid(gid) {
  if (!gid) return null;
  const m = String(gid).match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

function jsVal(v) {
  return (v === null || v === undefined) ? 'null' : v;
}

/* Finds the index of the `}` that closes the object literal starting
   just before `startIndex` (i.e. we're already one level inside it).
   Tracks brace depth while skipping over string literals so braces
   inside story/provenance text can't desync the count. */
function findObjectEnd(text, startIndex) {
  let depth = 0;
  let i = startIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') {
      if (depth === 0) return i;
      depth--; i++; continue;
    }
    i++;
  }
  return -1;
}

/* Extracts a flat `sizes: ["a", "b", ...]` array literal's string
   items from a block of HTML text, in the HTML's own written order. */
function extractSizesArray(blockText) {
  const m = blockText.match(/sizes:\s*\[([^\]]*)\]/);
  if (!m) return null;
  const items = [];
  const re = /"([^"]*)"/g;
  let mm;
  while ((mm = re.exec(m[1])) !== null) items.push(mm[1]);
  return items;
}

function bakeHtmlFallback(pricingData, targetFiles, htmlDir) {
  const goldRate = pricingData.gold_rate_per_g;
  const silverRate = pricingData.silver_rate_per_g;
  const targetSet = new Set(targetFiles);
  const updatedFiles = [];
  const warnings = [];

  const recordsByFile = new Map();
  for (const [key, record] of Object.entries(pricingData)) {
    if (key === 'gold_rate_per_g' || key === 'silver_rate_per_g' || key === 'warnings') continue;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (!targetSet.has(record.source_file)) continue;
    if (!recordsByFile.has(record.source_file)) recordsByFile.set(record.source_file, []);
    recordsByFile.get(record.source_file).push(record);
  }

  for (const fileName of targetFiles) {
    const records = recordsByFile.get(fileName) || [];
    const filePath = path.join(htmlDir, fileName);

    let html;
    try {
      html = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      warnings.push({ key: fileName, reason: `could not read file: ${err.message}` });
      continue;
    }

    let changed = false;

    for (const record of records) {
      const labelKey = `${record.source_file}/${record.variant_key}`;
      const bareId = bareIdFromGid(record.is_sized ? record.legacy_shopify_variant_gid : record.shopify_variant_gid);

      if (!bareId) {
        warnings.push({
          key: labelKey,
          reason: `no numeric id on ${record.is_sized ? 'legacy_shopify_variant_gid' : 'shopify_variant_gid'}`
        });
        continue;
      }

      const blockPattern = new RegExp(
        `(shopifyVariantId:\\s*${bareId}\\b[\\s\\S]*?showSizes:\\s*(?:true|false))`
      );
      const match = html.match(blockPattern);
      if (!match) {
        warnings.push({ key: labelKey, reason: `block not found for bareId ${bareId} (source_file=${record.source_file}, variant_key=${record.variant_key})` });
        continue;
      }

      const blockText = match[1];
      const blockStart = match.index;
      const afterShowSizes = blockStart + blockText.length;

      const closeBraceIndex = findObjectEnd(html, afterShowSizes);
      if (closeBraceIndex === -1) {
        warnings.push({ key: labelKey, reason: 'could not locate closing brace of the variant object' });
        continue;
      }

      const showSizesLineMatch = blockText.match(/^([ \t]*)showSizes:\s*(?:true|false)\s*$/m);
      const baseIndent = showSizesLineMatch ? showSizesLineMatch[1] : '    ';
      const closingIndent = baseIndent.length >= 2 ? baseIndent.slice(0, -2) : '';

      let fieldLines;
      let priceStr;

      if (!record.is_sized) {
        if (record.making_charge == null) {
          warnings.push({ key: labelKey, reason: 'making_charge is null' });
          continue;
        }
        const metalTotal = computeMetalTotal(
          record.metal, goldRate, silverRate,
          record.weight_g, record.gold_weight_g, record.silver_weight_g
        );
        if (metalTotal === null) {
          warnings.push({ key: labelKey, reason: 'missing weight or rate data needed to compute metal_total' });
          continue;
        }
        const computedPrice = computePriceFromMetalTotal(metalTotal, record.making_charge);
        priceStr = `₹ ${computedPrice.toLocaleString('en-IN')}`;

        const rawWeightG = record.metal === 'gold_9k_silver' ? null : record.weight_g;
        const rawGoldWeightG = record.metal === 'gold_9k_silver' ? record.gold_weight_g : null;
        const rawSilverWeightG = record.metal === 'gold_9k_silver' ? record.silver_weight_g : null;

        fieldLines = [
          `${baseIndent}rawWeightG: ${jsVal(rawWeightG)}`,
          `${baseIndent}rawGoldWeightG: ${jsVal(rawGoldWeightG)}`,
          `${baseIndent}rawSilverWeightG: ${jsVal(rawSilverWeightG)}`,
          `${baseIndent}rawMakingCharge: ${jsVal(record.making_charge)}`,
          `${baseIndent}metal: "${record.metal}"`
        ];
      } else {
        const sizesArr = extractSizesArray(blockText);
        if (!sizesArr || sizesArr.length === 0) {
          warnings.push({ key: labelKey, reason: 'could not parse sizes: [...] array from the HTML block' });
          continue;
        }
        const nonCustomSizes = sizesArr.filter(s => s !== 'Custom');
        const defaultSize = nonCustomSizes[2] || nonCustomSizes[nonCustomSizes.length - 1] || null;
        if (!defaultSize) {
          warnings.push({ key: labelKey, reason: 'no non-Custom size available to pick a default size from' });
          continue;
        }
        const sizeEntry = record.sizes ? record.sizes[defaultSize] : null;
        if (!sizeEntry) {
          warnings.push({ key: labelKey, reason: `default size "${defaultSize}" not found in record.sizes` });
          continue;
        }
        if (record.making_charge == null) {
          warnings.push({ key: labelKey, reason: 'making_charge is null' });
          continue;
        }
        const metalTotal = computeMetalTotal(
          record.metal, goldRate, silverRate,
          sizeEntry.weight_g, sizeEntry.gold_weight_g, sizeEntry.silver_weight_g
        );
        if (metalTotal === null) {
          warnings.push({ key: labelKey, reason: `missing weight or rate data for default size "${defaultSize}"` });
          continue;
        }
        const computedPrice = computePriceFromMetalTotal(metalTotal, record.making_charge);
        priceStr = `₹ ${computedPrice.toLocaleString('en-IN')}`;

        const nestedIndent = baseIndent + '  ';
        const sizeLines = Object.entries(record.sizes || {}).map(([size, entry]) => {
          const bare = bareIdFromGid(entry.shopify_variant_gid);
          return `${nestedIndent}"${size}": { weight_g: ${jsVal(entry.weight_g)}, gold_weight_g: ${jsVal(entry.gold_weight_g)}, silver_weight_g: ${jsVal(entry.silver_weight_g)}, shopify_variant_gid: ${jsVal(bare)} }`;
        });

        fieldLines = [
          `${baseIndent}defaultSize: "${defaultSize}"`,
          `${baseIndent}rawMakingCharge: ${jsVal(record.making_charge)}`,
          `${baseIndent}metal: "${record.metal}"`,
          `${baseIndent}sizeVariantGids: {\n${sizeLines.join(',\n')}\n${baseIndent}}`
        ];
      }

      const pricePattern = new RegExp(
        `price:\\s*"[^"]*"(?=\\s*,\\s*shopifyVariantId:\\s*${bareId}\\b)`
      );
      if (!pricePattern.test(html)) {
        warnings.push({ key: labelKey, reason: `could not find price: field preceding shopifyVariantId ${bareId}` });
        continue;
      }

      // Replace everything between the end of "showSizes: true/false" and
      // the object's own closing "}" (whether empty on a first run, or
      // already holding a previous run's baked fields) so re-running is
      // idempotent instead of appending a second copy.
      const newTail = ',\n' + fieldLines.join(',\n') + '\n' + closingIndent;
      let newHtml = html.slice(0, afterShowSizes) + newTail + html.slice(closeBraceIndex);
      newHtml = newHtml.replace(pricePattern, `price: "${priceStr}"`);

      if (newHtml !== html) {
        html = newHtml;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(filePath, html, 'utf8');
      updatedFiles.push(fileName);
    }
  }

  return { updatedFiles, warnings };
}

module.exports = { bakeHtmlFallback };

if (require.main === module) {
  const targetFiles = process.argv.slice(2);
  if (targetFiles.length === 0) {
    console.error('Usage: node scripts/bake-html-fallback.js <file.html> [file2.html ...]');
    process.exit(1);
  }
  const pricingData = loadPricingData(path.join(__dirname, '..', 'pricing-data.json'));
  const result = bakeHtmlFallback(pricingData, targetFiles, path.join(__dirname, '..'));
  console.log(`\nUpdated: ${result.updatedFiles.length}, warnings: ${result.warnings.length}`);
  result.warnings.forEach(w => console.log(`  - ${w.key}: ${w.reason}`));
}
