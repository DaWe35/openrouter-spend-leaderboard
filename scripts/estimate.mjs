// 1-year spend *estimate*, built from OpenRouter's weekly token chart
// (top 9 models per week + "Others", tokens include BYOK). No I/O here.
//
// Per named model, a $/token rate (spend and tokens both include BYOK):
//   measured  — our last-30-day spend ÷ its last-30-day tokens. Captures its real
//               cache rate and input/output mix.
//   effective — retired models: OpenRouter's 1-year effective prices, blended with
//               the platform-wide output share (and BYOK share, when BYOK is left out).
//   list      — no effective price: list prices with the platform-wide cache rate.
//   free      — ":free" variants cost nothing.
// "Others" gets one rate, calibrated on weeks where we have measured spend.

/** $ per token from measured spend. */
export function measuredRate(usd, tokens) {
  return tokens > 0 ? usd / tokens : null;
}

/** $ per token from per-token input/output prices and platform-wide mix. */
// byokShare: the fraction of tokens to leave out (0 when BYOK is included).
export function blendedRate({ inPrice, outPrice }, { outFrac, byokShare = 0 }) {
  return (1 - byokShare) * ((1 - outFrac) * inPrice + outFrac * outPrice);
}

/** List price with an assumed cache rate on the input side. */
export function listRate({ prompt, completion, cacheRead }, g) {
  const cr = cacheRead ?? prompt;
  const inPrice = (1 - g.cacheRate) * prompt + g.cacheRate * cr;
  return blendedRate({ inPrice, outPrice: completion }, g);
}

/** Estimated spend for each named model in one chart row ({x, ys}). Unknown rates count as 0. */
export function namedSpend(row, rates) {
  const out = {};
  for (const [key, tok] of Object.entries(row.ys)) {
    if (key === 'Others') continue;
    out[key] = tok * (rates.get(key)?.rate ?? 0);
  }
  return out;
}

/**
 * Calibrate the "Others" $/token on weeks with measured totals.
 * @param rows      chart rows
 * @param rates     Map key -> {rate}
 * @param actual    Map week -> measured total USD (complete weeks only)
 * @returns {{rate, weeks: [{week, rate, holdoutErrPct}]}}
 */
export function calibrateOthers(rows, rates, actual) {
  const weeks = [];
  for (const row of rows) {
    const act = actual.get(row.x);
    const othersTok = row.ys.Others ?? 0;
    if (act == null || othersTok <= 0) continue;
    const named = sum(Object.values(namedSpend(row, rates)));
    weeks.push({ week: row.x, actual: act, named, othersTok, rate: Math.max(0, (act - named) / othersTok) });
  }
  const pooled = (ws) => {
    const t = sum(ws.map((w) => w.othersTok));
    return t > 0 ? Math.max(0, sum(ws.map((w) => w.actual - w.named)) / t) : null;
  };
  const rate = pooled(weeks);
  // Leave-one-out: predict each week's total with a rate fitted on the other weeks.
  for (const w of weeks) {
    const r = pooled(weeks.filter((o) => o !== w));
    w.holdoutErrPct = r == null ? null : ((w.named + r * w.othersTok - w.actual) / w.actual) * 100;
  }
  return { rate, weeks };
}

/** Per-week estimate: {week, models: {key: usd}, others: usd}. */
export function estimateWeeks(rows, rates, othersRate) {
  return rows.map((row) => ({
    week: row.x,
    models: namedSpend(row, rates),
    others: (row.ys.Others ?? 0) * (othersRate ?? 0),
  }));
}

function sum(a) { return a.reduce((x, y) => x + y, 0); }
