const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;

const OUTLIER_THRESHOLD = 0.10; // 10% deviation from mean
const GOLD_MIN_SOURCES = 2; // of 4
const SILVER_MIN_SOURCES = 2; // of 3

const PAGE_URLS = {
  ibja: 'https://www.ibjarates.com/',
  mia: 'https://www.miabytanishq.com/en_IN/gold-rate-today',
  thangamayil: 'https://www.thangamayil.com/scheme/index/rateshistory/',
  bullions: 'https://bullions.co.in/'
};

/* ── page fetch ── */
async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return bodyText;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllPages() {
  const entries = Object.entries(PAGE_URLS);
  const results = {};
  await Promise.all(
    entries.map(async ([key, url]) => {
      try {
        results[key] = { html: await fetchHtml(url), error: null };
      } catch (err) {
        results[key] = { html: null, error: err.message };
      }
    })
  );
  return results;
}

/* ── parsing helpers ── */
function parseNumber(str) {
  if (typeof str !== 'string') return null;
  const n = parseFloat(str.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function matchNumber(html, regex) {
  const m = html.match(regex);
  if (!m) return null;
  return parseNumber(m[1]);
}

/* ── per-source extractors ──
   Verified against live markup on 2026-08-14; regexes may need updating if
   these sites change their page structure. */

// IBJA top-of-page live block: id="GoldRatesCompare999">15307</span> (already per gram)
function extractIbjaGold(html) {
  return matchNumber(html, /id="GoldRatesCompare999"[^>]*>\s*([\d,]+(?:\.\d+)?)/);
}

// IBJA historical AM/PM table, "Silver 999" column, most recent row (per 1kg)
function extractIbjaSilver(html) {
  const amStart = html.indexOf('id="tab-am"');
  const amEnd = html.indexOf('id="tab-pm"');
  const amSection = amStart !== -1 ? html.slice(amStart, amEnd !== -1 ? amEnd : undefined) : html;
  const perKg = matchNumber(amSection, /data-label="Silver 999">\s*([\d,]+(?:\.\d+)?)/);
  return perKg === null ? null : perKg / 1000;
}

// Mia by Tanishq visible block: "24K Gold Rate (10 Gram)" ... ratehead">₹ 1,54,470
function extractMiaGold(html) {
  const perTenGrams = matchNumber(
    html,
    /24K Gold Rate<\/span>[\s\S]{0,300}?ratehead">\s*(?:<[^>]+>\s*)*₹?\s*([\d,]+(?:\.\d+)?)/
  );
  return perTenGrams === null ? null : perTenGrams / 10;
}

// Thangamayil: "GOLD RATE 24k (1gm): ₹15,289"
function extractThangamayilGold(html) {
  return matchNumber(html, /GOLD RATE 24k\s*\(1gm\)[^₹]*₹\s*([\d,]+(?:\.\d+)?)/i);
}

// Thangamayil: "SILVER RATE (1gm): ₹255"
function extractThangamayilSilver(html) {
  return matchNumber(html, /SILVER RATE\s*\(1gm\)[^₹]*₹\s*([\d,]+(?:\.\d+)?)/i);
}

// Bullions.co.in: "Gold 24 Karat (Rs ₹)" table row, first numeric column (1 Gram)
function extractBullionsGold(html) {
  return matchNumber(
    html,
    /Gold 24 Karat\s*<small>\(Rs\s*&#x20B9;\)<\/small><\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?)/i
  );
}

// Bullions.co.in: "Silver 999 Fine (Rs ₹)" table row, first numeric column (1 Gram)
function extractBullionsSilver(html) {
  return matchNumber(
    html,
    /Silver 999 Fine\s*<small>\(Rs\s*&#x20B9;\)<\/small><\/td>\s*<td[^>]*>\s*([\d,]+(?:\.\d+)?)/i
  );
}

/* ── build a per-source result from a fetched page + its extractor ── */
function buildSourceResult(name, pageResult, extractFn) {
  if (pageResult.error) {
    return { name, status: 'fetch-failed', value: null, detail: pageResult.error };
  }
  let value;
  try {
    value = extractFn(pageResult.html);
  } catch (err) {
    return { name, status: 'parse-failed', value: null, detail: err.message };
  }
  if (value === null || !Number.isFinite(value)) {
    return { name, status: 'parse-failed', value: null, detail: 'expected pattern not found in page' };
  }
  return { name, status: 'ok', value, detail: null };
}

/* ── outlier rejection + averaging, shared by gold and silver ──
   1. Sources that failed to fetch/parse are "unavailable" — excluded, not
      counted as outliers.
   2. Mean of successfully-fetched values.
   3. Any value >10% from that mean is excluded as an outlier; mean is
      recomputed from the remaining values.
   4. Valid only if at least minSources remain after outlier exclusion. */
function averageWithOutlierRejection(sourceResults, minSources) {
  const ok = sourceResults.filter(s => s.status === 'ok');

  if (ok.length === 0) {
    return {
      average: null,
      valid: false,
      annotated: sourceResults.map(s => ({ ...s, included: false, exclusionReason: s.status }))
    };
  }

  const initialMean = ok.reduce((sum, s) => sum + s.value, 0) / ok.length;
  const inliers = ok.filter(s => Math.abs(s.value - initialMean) / initialMean <= OUTLIER_THRESHOLD);
  const outlierNames = new Set(ok.filter(s => !inliers.includes(s)).map(s => s.name));

  const valid = inliers.length >= minSources;
  const average = valid ? inliers.reduce((sum, s) => sum + s.value, 0) / inliers.length : null;

  const annotated = sourceResults.map(s => {
    if (s.status !== 'ok') {
      return { ...s, included: false, exclusionReason: s.status };
    }
    if (outlierNames.has(s.name)) {
      return { ...s, included: false, exclusionReason: 'outlier' };
    }
    return { ...s, included: true, exclusionReason: null };
  });

  return { average, valid, annotated };
}

function logSourceSummary(label, result) {
  console.log(`\n${label} sources:`);
  result.annotated.forEach(s => {
    const status = s.included ? 'INCLUDED' : `EXCLUDED (${s.exclusionReason})`;
    const rawValue = s.value === null ? 'n/a' : s.value;
    const detail = s.detail ? ` — ${s.detail}` : '';
    console.log(`  - ${s.name}: raw=${rawValue} [${status}]${detail}`);
  });
  console.log(`  => ${result.valid ? `average=${result.average}` : 'INVALID (fewer than minimum sources remained)'}`);
}

/* ── fetchGoldSilverRate — multi-source domestic average, no GoldAPI ── */
async function fetchGoldSilverRate() {
  const pages = await fetchAllPages();

  const goldSourceResults = [
    buildSourceResult('IBJA', pages.ibja, extractIbjaGold),
    buildSourceResult('Mia by Tanishq', pages.mia, extractMiaGold),
    buildSourceResult('Thangamayil', pages.thangamayil, extractThangamayilGold),
    buildSourceResult('Bullions.co.in', pages.bullions, extractBullionsGold)
  ];
  const silverSourceResults = [
    buildSourceResult('IBJA', pages.ibja, extractIbjaSilver),
    buildSourceResult('Thangamayil', pages.thangamayil, extractThangamayilSilver),
    buildSourceResult('Bullions.co.in', pages.bullions, extractBullionsSilver)
  ];

  const gold = averageWithOutlierRejection(goldSourceResults, GOLD_MIN_SOURCES);
  const silver = averageWithOutlierRejection(silverSourceResults, SILVER_MIN_SOURCES);

  logSourceSummary('Gold 24K (₹/g)', gold);
  logSourceSummary('Silver 999 (₹/g)', silver);

  const goldRatePerGram = gold.valid ? gold.average * (9 / 24) : null;
  const silverRatePerGram = silver.valid ? silver.average * (925 / 999) : null;

  return {
    goldRatePerGram,
    silverRatePerGram,
    gold24kAverage: gold.average,
    silver999Average: silver.average,
    goldSources: gold.annotated,
    silverSources: silver.annotated
  };
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

if (require.main === module) {
  (async () => {
    console.log('Running multi-source gold/silver rate fetch (dry run — no files are written by this module)...');
    const rate = await fetchGoldSilverRate();

    console.log('\n=== Converted rates ===');
    if (rate.goldSources.filter(s => s.included).length >= GOLD_MIN_SOURCES) {
      console.log(
        `Gold 24K average: ${rate.gold24kAverage} => 9K rate_9k = ${rate.goldRatePerGram} INR/g`
      );
    } else {
      console.log(`Gold: SKIPPED this run — fewer than ${GOLD_MIN_SOURCES} valid sources after outlier exclusion`);
    }
    if (rate.silverSources.filter(s => s.included).length >= SILVER_MIN_SOURCES) {
      console.log(
        `Silver 999 average: ${rate.silver999Average} => 925 rate_925 = ${rate.silverRatePerGram} INR/g`
      );
    } else {
      console.log(`Silver: SKIPPED this run — fewer than ${SILVER_MIN_SOURCES} valid sources after outlier exclusion`);
    }
  })().catch(err => {
    console.error(`\nFatal: ${err.message}`);
    process.exit(1);
  });
}
