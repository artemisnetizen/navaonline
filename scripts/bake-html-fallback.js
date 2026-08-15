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

function roundRate(v) {
  return Math.round(v * 100) / 100;
}

/* Inserts (or, on re-runs, updates in place) the page-level
   TODAY_GOLD_RATE_PER_G / TODAY_SILVER_RATE_PER_G consts that
   computePriceForSize() needs alongside the per-variant weight/making-charge
   fields already baked above. Anchored on `const variants = {`, which
   appears exactly once per product page. */
function bakeRateConsts(html, goldRate, silverRate, fileName, warnings) {
  const goldLine = `const TODAY_GOLD_RATE_PER_G = ${roundRate(goldRate)};`;
  const silverLine = `const TODAY_SILVER_RATE_PER_G = ${roundRate(silverRate)};`;

  const existingGoldPattern = /const TODAY_GOLD_RATE_PER_G\s*=\s*[\d.]+\s*;/;
  const existingSilverPattern = /const TODAY_SILVER_RATE_PER_G\s*=\s*[\d.]+\s*;/;

  if (existingGoldPattern.test(html)) {
    return html
      .replace(existingGoldPattern, goldLine)
      .replace(existingSilverPattern, silverLine);
  }

  const anchorPattern = /const variants = \{/;
  if (!anchorPattern.test(html)) {
    warnings.push({ key: fileName, reason: 'no "const variants = {" anchor found; skipped inserting rate consts' });
    return html;
  }

  return html.replace(anchorPattern, `${goldLine}\n${silverLine}\n\nconst variants = {`);
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

/* Mirrors buildMetalProvenance()'s field selection (see e.g. vara.html's
   inline script): only the weight-related keys, never `Material` — that's
   left untouched wherever this is spliced back into an existing
   `provenance: {...}` block. */
function buildProvenanceFields(metal, weightG, goldWeightG, silverWeightG) {
  const fmt = (n) => (n != null ? `${n} grams` : '—');
  if (metal === 'gold_9k_silver') {
    return { 'Gold Weight': fmt(goldWeightG), 'Silver Weight': fmt(silverWeightG) };
  }
  return { 'Weight': fmt(weightG) };
}

/* Re-splices weightFields (from buildProvenanceFields) into an existing
   `provenance: {...}` block's text, replacing only the Weight/Gold
   Weight/Silver Weight line(s) and leaving Material/Ready in/anything
   else untouched, in their original order and position. Returns null
   (caller should warn + skip) if the block's lines don't parse as plain
   `"Key": "value"` pairs, since that means this block has some shape we
   haven't seen in any sampled file and it's not safe to guess. */
function rebuildProvenanceBlock(fullText, weightFields) {
  const wrapperMatch = fullText.match(/^provenance:\s*\{([\s\S]*)\}$/);
  if (!wrapperMatch) return null;
  const inner = wrapperMatch[1];

  const lineRe = /^(\s*)"([^"]+)":\s*"([^"]*)"\s*(,)?\s*$/;
  const parsed = [];
  for (const line of inner.split('\n')) {
    if (line.trim() === '') continue;
    const lm = line.match(lineRe);
    if (!lm) return null;
    parsed.push({ indent: lm[1], key: lm[2], value: lm[3] });
  }
  if (parsed.length === 0) return null;

  const weightKeys = new Set(['Weight', 'Gold Weight', 'Silver Weight']);
  const firstWeightIdx = parsed.findIndex(p => weightKeys.has(p.key));
  const materialIdx = parsed.findIndex(p => p.key === 'Material');
  const kept = parsed.filter(p => !weightKeys.has(p.key));

  let insertIdx;
  if (firstWeightIdx !== -1) {
    insertIdx = parsed.slice(0, firstWeightIdx).filter(p => !weightKeys.has(p.key)).length;
  } else if (materialIdx !== -1) {
    insertIdx = parsed.slice(0, materialIdx + 1).filter(p => !weightKeys.has(p.key)).length;
  } else {
    insertIdx = kept.length;
  }

  const indent = parsed[0].indent;
  const newEntries = Object.entries(weightFields).map(([key, value]) => ({ indent, key, value }));
  const finalEntries = [...kept.slice(0, insertIdx), ...newEntries, ...kept.slice(insertIdx)];

  const closeIndentMatch = inner.match(/\n([ \t]*)$/);
  const closeIndent = closeIndentMatch ? closeIndentMatch[1] : '';

  const lines = finalEntries.map((e, i) => {
    const comma = i < finalEntries.length - 1 ? ',' : '';
    return `${e.indent}"${e.key}": "${e.value}"${comma}`;
  });

  return `provenance: {\n${lines.join('\n')}\n${closeIndent}}`;
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
      let provenanceWeightG;
      let provenanceGoldWeightG;
      let provenanceSilverWeightG;

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
        provenanceWeightG = rawWeightG;
        provenanceGoldWeightG = rawGoldWeightG;
        provenanceSilverWeightG = rawSilverWeightG;

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
        provenanceWeightG = sizeEntry.weight_g;
        provenanceGoldWeightG = sizeEntry.gold_weight_g;
        provenanceSilverWeightG = sizeEntry.silver_weight_g;

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

      // Recompute provenance's weight-related line(s) to match whichever
      // weight data actually drove priceStr above (defaultSize's own
      // sizeEntry for sized records, record.weight_g/etc otherwise), so
      // the provenance row can't silently disagree with the baked price
      // the way it did on vara.html's bangle.
      let newBlockText = blockText;
      const provMatch = blockText.match(/provenance:\s*\{[\s\S]*?\}/);
      if (!provMatch) {
        warnings.push({ key: labelKey, reason: 'provenance: {...} block not found within variant block; skipped provenance sync' });
      } else {
        const weightFields = buildProvenanceFields(
          record.metal, provenanceWeightG, provenanceGoldWeightG, provenanceSilverWeightG
        );
        const rebuilt = rebuildProvenanceBlock(provMatch[0], weightFields);
        if (rebuilt === null) {
          warnings.push({ key: labelKey, reason: 'provenance: {...} block did not match expected "Key": "value" line format; skipped provenance sync for this record' });
        } else {
          newBlockText = blockText.slice(0, provMatch.index) + rebuilt + blockText.slice(provMatch.index + provMatch[0].length);
        }
      }

      // Replace everything from the start of the variant block through the
      // object's own closing "}" (whether empty on a first run, or already
      // holding a previous run's baked fields) so re-running is idempotent
      // instead of appending a second copy.
      const newTail = ',\n' + fieldLines.join(',\n') + '\n' + closingIndent;
      let newHtml = html.slice(0, blockStart) + newBlockText + newTail + html.slice(closeBraceIndex);
      newHtml = newHtml.replace(pricePattern, `price: "${priceStr}"`);

      if (newHtml !== html) {
        html = newHtml;
        changed = true;
      }
    }

    const beforeRateBake = html;
    html = bakeRateConsts(html, goldRate, silverRate, fileName, warnings);
    if (html !== beforeRateBake) changed = true;

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
