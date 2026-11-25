import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daySpend, isCompleteDay, aggregate, changePct, topNWithOthers, tvd, weekStart, dateRange,
} from './spend.mjs';

const M = 1e6;
const row = (o) => ({
  total_prompt_tokens: 0, total_completion_tokens: 0, total_native_tokens_cached: 0,
  total_byok_prompt_tokens: 0, total_byok_completion_tokens: 0, ...o,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('effective price: tokens × measured $/token', () => {
  const r = daySpend(row({ total_prompt_tokens: 10 * M, total_completion_tokens: 1 * M }),
    { eff: { in: 0.7 / M, out: 20 / M } });
  close(r.inUsd, 7);
  close(r.outUsd, 20);
  assert.equal(r.source, 'effective');
});

test('BYOK prompt and completion tokens are excluded', () => {
  const r = daySpend(row({
    total_prompt_tokens: 10 * M, total_completion_tokens: 2 * M,
    total_byok_prompt_tokens: 4 * M, total_byok_completion_tokens: 1 * M,
  }), { eff: { in: 1 / M, out: 10 / M } });
  close(r.inUsd, 6);   // (10M - 4M) × $1/M
  close(r.outUsd, 10); // (2M - 1M) × $10/M
  close(r.promptTok, 6 * M);
  close(r.completionTok, 1 * M);
});

test('list-price fallback prices cached tokens at the cache-read rate', () => {
  // 10M prompt (8M cached), 1M completion; $4/M in, $0.4/M cache read, $20/M out
  const r = daySpend(row({
    total_prompt_tokens: 10 * M, total_native_tokens_cached: 8 * M, total_completion_tokens: 1 * M,
  }), { eff: null, list: { prompt: 4 / M, cacheRead: 0.4 / M, completion: 20 / M } });
  close(r.inUsd, 2 * 4 + 8 * 0.4); // 11.2
  close(r.outUsd, 20);
  assert.equal(r.source, 'list');
});

test('list-price fallback scales to the non-BYOK share', () => {
  const r = daySpend(row({
    total_prompt_tokens: 10 * M, total_native_tokens_cached: 5 * M,
    total_byok_prompt_tokens: 5 * M, total_completion_tokens: 2 * M, total_byok_completion_tokens: 1 * M,
  }), { list: { prompt: 2 / M, cacheRead: 0.2 / M, completion: 10 / M } });
  close(r.inUsd, (5 * 2 + 5 * 0.2) * 0.5); // 5.5
  close(r.outUsd, 10);
  close(r.cachedTok, 2.5 * M);
});

test('zero effective price falls back to list; free models cost nothing', () => {
  const r1 = daySpend(row({ total_prompt_tokens: M }), { eff: { in: 0, out: 0 }, list: { prompt: 1 / M, completion: 1 / M } });
  assert.equal(r1.source, 'list');
  close(r1.inUsd, 1);
  const r2 = daySpend(row({ total_prompt_tokens: M, total_completion_tokens: M }), { eff: null, list: { prompt: 0, completion: 0 } });
  close(r2.inUsd + r2.outUsd, 0);
});

test('cached never exceeds prompt; bad inputs count as zero', () => {
  const r = daySpend(row({ total_prompt_tokens: M, total_native_tokens_cached: 5 * M, total_completion_tokens: 'x' }),
    { list: { prompt: 1 / M, cacheRead: 0.1 / M, completion: 1 / M } });
  close(r.inUsd, 0.1);
  close(r.outUsd, 0);
});

test('only complete UTC days count', () => {
  const now = new Date('2026-11-25T09:30:00Z');
  assert.equal(isCompleteDay('2026-11-24', now), true);
  assert.equal(isCompleteDay('2026-11-25', now), false);
});

test('aggregate, change, top-N', () => {
  const days = {
    '2026-11-01': { a: [1, 2, 10, 5, 3], b: [0.5, 0.5, 1, 1, 0] },
    '2026-11-02': { a: [1, 1, 10, 5, 3] },
  };
  const t = aggregate(days, ['2026-11-01', '2026-11-02', '2026-11-03']);
  close(t.get('a').usd, 5);
  close(t.get('a').cachedTok, 6);
  close(t.get('b').usd, 1);
  assert.equal(changePct(150, 100), 50);
  assert.equal(changePct(5, 0), null);
  const { top, others } = topNWithOthers(new Map([['a', 5], ['b', 1], ['c', 3]]), 2);
  assert.deepEqual(top, ['a', 'c']);
  assert.equal(others, 1);
});

test('tvd and calendar helpers', () => {
  assert.equal(tvd(new Map([['a', 1]]), new Map([['a', 7]])), 0);
  assert.equal(tvd(new Map([['a', 1]]), new Map([['b', 1]])), 1);
  assert.equal(weekStart('2026-11-25'), '2026-11-23'); // Wed → Mon
  assert.equal(weekStart('2026-11-23'), '2026-11-23');
  assert.equal(weekStart('2026-11-29'), '2026-11-23'); // Sun → Mon
  assert.deepEqual(dateRange('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
});

// ---------------------------------------------------------------- 1-year estimate
import { measuredRate, blendedRate, listRate, calibrateOthers, estimateWeeks } from './estimate.mjs';

test('estimate rates', () => {
  close(measuredRate(100, 1e6), 1e-4);
  assert.equal(measuredRate(5, 0), null);
  const g = { outFrac: 0.1, byokShare: 0.5, cacheRate: 0.8 };
  // 0.5 × (0.9 × $1/M + 0.1 × $10/M) = $0.95/M
  close(blendedRate({ inPrice: 1 / M, outPrice: 10 / M }, g) * M, 0.95);
  // input: 0.2 × $5 + 0.8 × $0.5 = $1.4/M → 0.5 × (0.9 × 1.4 + 0.1 × 20) = $1.63/M
  close(listRate({ prompt: 5 / M, cacheRead: 0.5 / M, completion: 20 / M }, g) * M, 1.63);
});

test('others calibration and weekly estimate', () => {
  const rows = [
    { x: 'w1', ys: { a: 100, Others: 50 } },
    { x: 'w2', ys: { a: 200, Others: 100 } },
    { x: 'w3', ys: { a: 10, b: 10, Others: 10 } },
  ];
  const rates = new Map([['a', { rate: 1 }]]); // b unknown → 0
  const actual = new Map([['w1', 200], ['w2', 400]]); // others rate = 2 in both weeks
  const cal = calibrateOthers(rows, rates, actual);
  close(cal.rate, 2);
  assert.equal(cal.weeks.length, 2);
  close(cal.weeks[0].holdoutErrPct, 0);
  const est = estimateWeeks(rows, rates, cal.rate);
  close(est[2].models.a, 10);
  close(est[2].models.b, 0);
  close(est[2].others, 20);
});
