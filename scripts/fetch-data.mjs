// Fetch OpenRouter usage + pricing, compute daily USD spend per model,
// merge into data/history.json and write public/data.js for the page.
//
// Usage: node scripts/fetch-data.mjs [--limit N]
//   --limit N  only fetch the N biggest models (dev runs; history is not saved)

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  daySpend, isCompleteDay, aggregate, changePct, topNWithOthers, tvd,
  addDays, dateRange, weekStart, IN, OUT,
} from './spend.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_FILE = join(ROOT, 'data', 'history.json');
const OUTPUT_FILE = join(ROOT, 'public', 'data.js');
const API = 'https://openrouter.ai/api/frontend/v1/public';
const CONCURRENCY = 4;
const MAX_HISTORY_DAYS = 400;
const CHART_TOP_N = 8; // 8 categorical colors + "Others"
const LEADERBOARD_ROWS = 100;

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : null;

// ---------------------------------------------------------------- HTTP

async function getJSON(path, params = {}) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'spend-leaderboard/0.1' },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { fatal: true });
      if (attempt >= 4) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (e) {
      if (e.fatal || attempt >= 4) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      if (++done % 50 === 0 || done === items.length) process.stdout.write(`  ${done}/${items.length}\n`);
    }
  }));
  return results;
}

// ---------------------------------------------------------------- Fetch

console.log('Fetching catalog and 30-day leaderboard…');
const [catalogRes, monthRes, spendShareRes] = await Promise.all([
  getJSON('/catalog/catalog/models'),
  getJSON('/stats/rankings/models', { view: 'month' }),
  getJSON('/stats/rankings/models', { view: 'month', metric: 'spend' }).catch(() => null),
]);

// Catalog: metadata + list pricing per (permaslug, variant).
const catalog = new Map();
for (const m of catalogRes.data) {
  const variant = m.endpoint?.variant ?? 'standard';
  catalog.set(`${m.permaslug}|${variant}`, m);
  if (!catalog.has(`${m.permaslug}|*`)) catalog.set(`${m.permaslug}|*`, m);
}

// Paid variants with non-BYOK traffic in the last 30 days, biggest first.
let targets = monthRes.data
  .filter((r) => r.variant !== 'free')
  .filter((r) => r.total_prompt_tokens - r.total_byok_prompt_tokens + r.total_completion_tokens - r.total_byok_completion_tokens > 0)
  .sort((a, b) => b.rankingMetricValue - a.rankingMetricValue);
if (LIMIT) targets = targets.slice(0, LIMIT);

console.log(`Fetching daily activity + effective pricing for ${targets.length} model variants…`);
const now = new Date();
const fetched = await pool(targets, CONCURRENCY, async (t) => {
  const params = { permaslug: t.model_permaslug, variant: t.variant };
  const [activity, eff] = await Promise.all([
    getJSON('/stats/model-activity', params).catch((e) => (console.warn(`  ! activity ${t.variant_permaslug}: ${e.message}`), null)),
    getJSON('/stats/effective-pricing', { ...params, range: '1m' }).catch(() => null),
  ]);
  return { t, rows: activity?.data?.analytics ?? null, eff: eff?.data ?? null };
});

// ---------------------------------------------------------------- Compute

const history = await loadHistory();
const fresh = {}; // date -> key -> tuple
let failed = 0;
const sourceCount = { effective: 0, list: 0, none: 0 };

for (const { t, rows, eff } of fetched) {
  const key = t.variant_permaslug;
  if (!rows) { failed++; continue; }

  const meta = catalog.get(`${t.model_permaslug}|${t.variant}`) ?? catalog.get(`${t.model_permaslug}|*`);
  const lp = catalog.get(`${t.model_permaslug}|${t.variant}`)?.endpoint?.pricing;
  const list = lp ? {
    prompt: Number(lp.prompt) || 0,
    completion: Number(lp.completion) || 0,
    cacheRead: lp.input_cache_read != null ? Number(lp.input_cache_read) : undefined,
  } : null;
  const effective = eff ? { in: eff.weightedInputPrice / 1e6, out: eff.weightedOutputPrice / 1e6 } : null;

  let source = 'none';
  for (const r of rows) {
    const date = r.date.slice(0, 10);
    if (!isCompleteDay(date, now)) continue;
    const s = daySpend(r, { eff: effective, list });
    source = s.source;
    if (s.inUsd + s.outUsd < 0.005 && s.promptTok + s.completionTok === 0) continue;
    (fresh[date] ??= {})[key] = [
      round2(s.inUsd), round2(s.outUsd), Math.round(s.promptTok), Math.round(s.completionTok), Math.round(s.cachedTok),
    ];
  }
  sourceCount[source]++;

  history.models[key] = {
    name: meta?.short_name ?? meta?.name ?? t.model_permaslug,
    author: meta?.author_display_name ?? meta?.author ?? t.model_permaslug.split('/')[0],
    slug: meta?.slug ?? t.model_permaslug,
    variant: t.variant,
    priceSource: source,
    effIn: eff ? eff.weightedInputPrice : null,   // $/M tokens
    effOut: eff ? eff.weightedOutputPrice : null, // $/M tokens
    cacheHit: eff ? eff.weightedCacheHitRate : null,
  };
}

// Merge: days in this fetch replace stored days. The oldest fetched day is only
// used if history doesn't have it yet (it may sit at the edge of OpenRouter's window).
const freshDates = Object.keys(fresh).sort();
for (const date of freshDates) {
  if (date === freshDates[0] && history.days[date]) continue;
  history.days[date] = fresh[date];
}
const allDates = Object.keys(history.days).sort();
for (const d of allDates.slice(0, Math.max(0, allDates.length - MAX_HISTORY_DAYS))) delete history.days[d];
history.updatedAt = now.toISOString();

if (failed) console.warn(`Warning: ${failed} model(s) failed to fetch; their spend is missing for this run.`);
console.log(`Price source: ${sourceCount.effective} effective, ${sourceCount.list} list fallback, ${sourceCount.none} unpriced`);

if (LIMIT) {
  console.log(`--limit run: not saving ${rel(HISTORY_FILE)}`);
} else {
  await writeAtomic(HISTORY_FILE, JSON.stringify(history));
  console.log(`Saved ${rel(HISTORY_FILE)} (${Object.keys(history.days).length} days)`);
}

const out = buildOutput(history);
await writeAtomic(OUTPUT_FILE, `// Generated by scripts/fetch-data.mjs — do not edit.\nwindow.SPEND_DATA = ${JSON.stringify(out)};\n`);
console.log(`Wrote ${rel(OUTPUT_FILE)}`);

// ---------------------------------------------------------------- Sanity check

const month = out.leaderboard.month;
console.log(`\n30-day spend (${month.start} → ${month.end}): ${usd(month.total)} across ${month.modelCount} models`);
if (spendShareRes?.data) {
  const ours = new Map([...aggregate(history.days, dateRange(month.start, month.end))].map(([k, v]) => [k, v.usd]));
  const theirs = new Map(spendShareRes.data.map((r) => [r.variant_permaslug, r.rankingMetricValue]));
  if (LIMIT) for (const k of theirs.keys()) if (!ours.has(k)) theirs.delete(k);
  const d = tvd(ours, theirs);
  console.log(`Distance from OpenRouter's own spend shares (TVD, 0 = identical): ${d.toFixed(3)}${d > 0.1 ? '  ⚠ higher than expected' : '  ✓'}`);
  const oursTotal = [...ours.values()].reduce((a, b) => a + b, 0);
  const theirsTotal = [...theirs.values()].reduce((a, b) => a + b, 0);
  console.log('  model                                         ours   OpenRouter');
  for (const r of month.rows.slice(0, 8)) {
    console.log(`  ${r.key.slice(0, 44).padEnd(44)} ${pct(r.usd / oursTotal)}   ${pct((theirs.get(r.key) ?? 0) / theirsTotal)}`);
  }
}

// ---------------------------------------------------------------- Output for the page

function buildOutput(h) {
  const dates = Object.keys(h.days).sort();
  const last = dates.at(-1);
  const has = (d) => !!h.days[d];

  const period = (id, length) => {
    const start = addDays(last, -(length - 1));
    const cur = aggregate(h.days, dateRange(start, last));
    const prevDates = dateRange(addDays(start, -length), addDays(start, -1));
    const prevCovered = prevDates.every(has);
    const prev = prevCovered ? aggregate(h.days, prevDates) : null;
    const total = sum([...cur.values()].map((v) => v.usd));
    const rows = [...cur.entries()]
      .filter(([, v]) => v.usd >= 0.01)
      .sort((a, b) => b[1].usd - a[1].usd)
      .map(([key, v]) => row(key, v, total, prev ? changePct(v.usd, prev.get(key)?.usd ?? 0) : null, prev ? (prev.get(key)?.usd ?? 0) : null));
    return { id, start, end: last, days: length, total, modelCount: rows.length, hasChange: prevCovered, rows };
  };

  const day = period('day', 1);
  const week = period('week', 7);
  const month = period('month', 30);

  // Trending: biggest week-over-week growth among models with a meaningful share.
  const trending = {
    ...week,
    id: 'trending',
    rows: week.hasChange
      ? week.rows.filter((r) => r.share >= 0.001 && r.prevUsd !== null)
          .sort((a, b) => (b.change ?? Infinity) - (a.change ?? Infinity))
      : [],
  };
  for (const p of [day, week, month, trending]) p.rows = p.rows.slice(0, LEADERBOARD_ROWS).map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    updatedAt: h.updatedAt,
    chart: buildChart(h, dates),
    leaderboard: { day, week, month, trending },
  };
}

function row(key, v, total, change, prevUsd) {
  const m = history.models[key] ?? {};
  return {
    key,
    name: m.name ?? key,
    author: m.author ?? key.split('/')[0],
    slug: m.slug ?? key.split(':')[0],
    variant: m.variant ?? 'standard',
    usd: round2(v.usd),
    inUsd: round2(v.inUsd),
    outUsd: round2(v.outUsd),
    promptTok: v.promptTok,
    completionTok: v.completionTok,
    cacheHit: v.promptTok > 0 ? v.cachedTok / v.promptTok : null,
    share: total > 0 ? v.usd / total : 0,
    change,
    prevUsd,
    priceSource: m.priceSource ?? 'none',
  };
}

function buildChart(h, dates) {
  const chartDates = dates.slice(-365);
  const weekly = chartDates.length > 70;
  const bucketOf = weekly ? weekStart : (d) => d;
  const labels = [...new Set(chartDates.map(bucketOf))];
  const idx = new Map(labels.map((l, i) => [l, i]));
  const bucketDays = labels.map(() => 0);
  for (const d of chartDates) bucketDays[idx.get(bucketOf(d))]++;

  const perModel = new Map(); // key -> values[]
  for (const d of chartDates) {
    const i = idx.get(bucketOf(d));
    for (const [key, t] of Object.entries(h.days[d])) {
      let arr = perModel.get(key);
      if (!arr) perModel.set(key, (arr = labels.map(() => 0)));
      arr[i] += t[IN] + t[OUT];
    }
  }
  const totals = new Map([...perModel].map(([k, v]) => [k, sum(v)]));
  const { top, others } = topNWithOthers(totals, CHART_TOP_N);
  const othersValues = labels.map((_, i) => sum([...perModel].filter(([k]) => !top.includes(k)).map(([, v]) => v[i])));

  return {
    granularity: weekly ? 'week' : 'day',
    labels,
    bucketDays,
    total: sum([...totals.values()]),
    series: top.map((key) => ({
      key,
      name: h.models[key]?.name ?? key,
      author: h.models[key]?.author ?? key.split('/')[0],
      slug: h.models[key]?.slug ?? key.split(':')[0],
      total: round2(totals.get(key)),
      values: perModel.get(key).map(round2),
    })),
    others: { total: round2(others), values: othersValues.map(round2) },
  };
}

// ---------------------------------------------------------------- Helpers

async function loadHistory() {
  try {
    const h = JSON.parse(await readFile(HISTORY_FILE, 'utf8'));
    return { version: 1, models: {}, days: {}, ...h };
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return { version: 1, updatedAt: null, models: {}, days: {} };
  }
}

async function writeAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.tmp', text);
  await rename(file + '.tmp', file);
}

function round2(x) { return Math.round(x * 100) / 100; }
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function usd(x) { return '$' + Math.round(x).toLocaleString('en-US'); }
function pct(x) { return (100 * x).toFixed(2).padStart(6) + '%'; }
function rel(p) { return p.slice(ROOT.length + 1); }
