// Pure spend math. No I/O here so it can be unit-tested.
//
// All prices passed in are USD per token (not per million).

const DAY_MS = 86_400_000;

/**
 * Spend for one model variant on one day.
 *
 * @param {object} row   Activity row from OpenRouter's model-activity endpoint.
 * @param {object} price { eff: {in, out} | null, list: {prompt, completion, cacheRead} | null }
 * @returns {{inUsd:number, outUsd:number, promptTok:number, completionTok:number, cachedTok:number, source:string}}
 *
 * BYOK traffic is excluded: those users pay their provider directly, not OpenRouter.
 *
 * Preferred: OpenRouter's measured effective prices. `eff.in` is a blended price per
 * prompt token (cached + uncached) that already reflects cache-read discounts,
 * cache-write premiums and the actual provider mix.
 *
 * Fallback (no effective price available): itemized list price
 *   (uncached prompt × prompt price) + (cached prompt × cache-read price) + (completion × completion price)
 * scaled to the non-BYOK share of traffic.
 */
export function daySpend(row, { eff = null, list = null } = {}) {
  const P = num(row.total_prompt_tokens);
  const C = num(row.total_completion_tokens);
  const K = Math.min(num(row.total_native_tokens_cached), P);
  const BP = Math.min(num(row.total_byok_prompt_tokens), P);
  const BC = Math.min(num(row.total_byok_completion_tokens), C);

  const promptTok = P - BP;
  const completionTok = C - BC;
  const nonByokShare = P > 0 ? promptTok / P : 0;
  // Cached tokens aren't split by BYOK, so assume the same cache rate for both.
  const cachedTok = K * nonByokShare;

  let inUsd = 0;
  let outUsd = 0;
  let source = 'none';

  if (hasEffective(eff)) {
    inUsd = promptTok * eff.in;
    outUsd = completionTok * eff.out;
    source = 'effective';
  } else if (list) {
    const cacheRead = list.cacheRead ?? list.prompt;
    inUsd = ((P - K) * list.prompt + K * cacheRead) * nonByokShare;
    outUsd = completionTok * list.completion;
    source = 'list';
  }

  return { inUsd, outUsd, promptTok, completionTok, cachedTok, source };
}

export function hasEffective(eff) {
  return !!eff && Number.isFinite(eff.in) && Number.isFinite(eff.out) && (eff.in > 0 || eff.out > 0);
}

/** Only complete UTC days, strictly before today. */
export function isCompleteDay(date, now = new Date()) {
  return date < now.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive list of dates from `start` to `end` (YYYY-MM-DD). */
export function dateRange(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Monday (UTC) of the week containing `date`. */
export function weekStart(date) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

// A day entry in history is a compact tuple:
//   [inUsd, outUsd, promptTok, completionTok, cachedTok]
export const IN = 0, OUT = 1, PTOK = 2, CTOK = 3, KTOK = 4;

/**
 * Sum per-model spend over a list of dates.
 * @param {Record<string, Record<string, number[]>>} days  history.days
 * @returns {Map<string, {inUsd, outUsd, usd, promptTok, completionTok, cachedTok}>}
 */
export function aggregate(days, dates) {
  const totals = new Map();
  for (const date of dates) {
    const day = days[date];
    if (!day) continue;
    for (const [key, t] of Object.entries(day)) {
      let a = totals.get(key);
      if (!a) totals.set(key, (a = { inUsd: 0, outUsd: 0, usd: 0, promptTok: 0, completionTok: 0, cachedTok: 0 }));
      a.inUsd += t[IN];
      a.outUsd += t[OUT];
      a.usd += t[IN] + t[OUT];
      a.promptTok += t[PTOK];
      a.completionTok += t[CTOK];
      a.cachedTok += t[KTOK];
    }
  }
  return totals;
}

/** Percent change, or null when there's no baseline. */
export function changePct(current, previous) {
  if (!(previous > 0)) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Pick the top `n` keys by total and fold everything else into "Others".
 * @param {Map<string, number>} totals
 */
export function topNWithOthers(totals, n) {
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, n).map(([k]) => k);
  const others = sorted.slice(n).reduce((s, [, v]) => s + v, 0);
  return { top, others };
}

/** Total variation distance between two share distributions (0 = identical, 1 = disjoint). */
export function tvd(a, b) {
  const norm = (m) => {
    const s = [...m.values()].reduce((x, y) => x + y, 0) || 1;
    return new Map([...m].map(([k, v]) => [k, v / s]));
  };
  const na = norm(a), nb = norm(b);
  const keys = new Set([...na.keys(), ...nb.keys()]);
  let d = 0;
  for (const k of keys) d += Math.abs((na.get(k) ?? 0) - (nb.get(k) ?? 0));
  return d / 2;
}

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
