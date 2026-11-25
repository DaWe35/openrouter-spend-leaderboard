/* global Chart */
(function () {
  const data = window.SPEND_DATA;
  const $ = (id) => document.getElementById(id);
  if (!data) {
    document.querySelector('main').insertAdjacentHTML('beforeend',
      '<p class="empty">No data yet. Run <code>npm run fetch</code> first.</p>');
    return;
  }

  // ---------------------------------------------------------------- formatting

  function usd(x, digits) {
    if (x == null) return '–';
    if (x === 0) return '$0';
    const abs = Math.abs(x);
    const d = digits ?? (abs >= 100 ? 1 : 2);
    if (abs >= 1e9) return '$' + (x / 1e9).toFixed(d) + 'B';
    if (abs >= 1e6) return '$' + (x / 1e6).toFixed(d) + 'M';
    if (abs >= 1e3) return '$' + (x / 1e3).toFixed(d) + 'K';
    return '$' + x.toFixed(abs >= 1 ? 0 : 2);
  }
  function tokens(x) {
    if (x >= 1e12) return (x / 1e12).toFixed(2) + 'T';
    if (x >= 1e9) return (x / 1e9).toFixed(1) + 'B';
    if (x >= 1e6) return (x / 1e6).toFixed(1) + 'M';
    if (x >= 1e3) return (x / 1e3).toFixed(1) + 'K';
    return String(Math.round(x));
  }
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const fmtDate = (d, opts) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
  const short = (d) => fmtDate(d, { month: 'short', day: 'numeric' });
  const long = (d) => fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const modelUrl = (slug) => 'https://openrouter.ai/' + slug.split('/').map(encodeURIComponent).join('/');
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  $('updated').textContent = data.updatedAt ? 'Updated ' + new Date(data.updatedAt).toLocaleString() + '.' : '';

  // ---------------------------------------------------------------- tooltip

  const tip = $('tooltip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(x + 14, window.innerWidth - r.width - 8);
    const top = y + r.height + 14 > window.innerHeight ? y - r.height - 14 : y + 14;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------------------------------------------------------------- chart

  const c = data.chart;
  const weekly = c.granularity === 'week';
  const unit = weekly ? 'week' : 'day';
  $('chart-sub').textContent = `Spend per ${unit} by model, ${long(c.labels[0])} – ${long(c.labels.at(-1))} (UTC)`;
  $('chart-total').textContent = usd(c.total);
  $('chart-total-label').textContent = `total over ${c.bucketDays.reduce((a, b) => a + b, 0)} days`;

  const series = [
    ...c.series.map((s, i) => ({ ...s, colorVar: `--s${i + 1}` })),
    { key: 'Others', name: 'Others', author: `${Math.max(0, data.leaderboard.month.modelCount - c.series.length)}+ other models`, total: c.others.total, values: c.others.values, colorVar: '--others' },
  ];

  let chart;
  function drawChart() {
    const surface = cssVar('--surface');
    const datasets = series.map((s) => ({
      label: s.name,
      data: s.values,
      backgroundColor: cssVar(s.colorVar),
      hoverBackgroundColor: cssVar(s.colorVar),
      borderColor: surface,
      borderWidth: { top: 2, bottom: 0, left: 0, right: 0 },
      borderSkipped: false,
      borderRadius: 0,
      stack: 'spend',
    }));
    // Round only the outer data-end of each bar (the top-most non-zero segment).
    datasets.forEach((ds, di) => {
      ds.borderRadius = (ctx) => {
        const i = ctx.dataIndex;
        const isTop = datasets.slice(di + 1).every((d) => !d.data[i]);
        return isTop ? { topLeft: 4, topRight: 4 } : 0;
      };
    });

    const textColor = cssVar('--text-2');
    const grid = cssVar('--grid');
    if (chart) chart.destroy();
    chart = new Chart($('chart'), {
      type: 'bar',
      data: { labels: c.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        datasets: { bar: { categoryPercentage: 0.86, barPercentage: 0.92 } },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            border: { color: grid },
            ticks: { color: textColor, maxRotation: 0, autoSkip: true, autoSkipPadding: 16, callback: (v) => short(c.labels[v]) },
          },
          y: {
            stacked: true,
            grid: { color: grid },
            border: { display: false },
            ticks: { color: textColor, callback: (v) => usd(v, 0), maxTicksLimit: 6 },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false, external: chartTooltip },
        },
      },
    });
  }

  function chartTooltip({ chart: ch, tooltip: t }) {
    if (!t.opacity || !t.dataPoints?.length) return hideTip();
    const i = t.dataPoints[0].dataIndex;
    const label = c.labels[i];
    const days = c.bucketDays[i];
    const title = weekly
      ? `Week of ${long(label)}${days < 7 ? ` (${days} day${days > 1 ? 's' : ''})` : ''}`
      : fmtDate(label, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const rows = series
      .map((s) => ({ s, v: s.values[i] }))
      .filter((r) => r.v > 0)
      .sort((a, b) => (a.s.key === 'Others') - (b.s.key === 'Others') || b.v - a.v);
    const total = rows.reduce((a, r) => a + r.v, 0);
    const html = `<div class="t-title">${esc(title)}</div>` +
      rows.map(({ s, v }) => `<div class="t-row"><span class="swatch" style="background:var(${s.colorVar})"></span><span>${esc(s.name)}</span><span>${usd(v)}</span></div>`).join('') +
      `<div class="t-row kv t-total"><span>Total</span><span>${usd(total)}</span></div>`;
    const rect = ch.canvas.getBoundingClientRect();
    showTip(html, rect.left + t.caretX, rect.top + t.caretY);
  }
  $('chart').addEventListener('mouseleave', hideTip);

  function drawLegend() {
    $('legend').innerHTML = series.map((s, i) => {
      const name = s.key === 'Others'
        ? `<span class="name" title="${esc(s.author)}">Others</span>`
        : `<a class="name" href="${modelUrl(s.slug)}" target="_blank" rel="noopener" title="${esc(s.name)} by ${esc(s.author)}">${esc(s.name)}</a>`;
      return `<li><span class="rank">${s.key === 'Others' ? '' : i + 1}</span><span class="swatch" style="background:var(${s.colorVar})"></span>${name}<span class="val">${usd(s.total)}<span class="share">${pct(s.total / c.total)}</span></span></li>`;
    }).join('');
  }

  // ---------------------------------------------------------------- leaderboard

  const PAGE = 20;
  let period = 'week';
  let shown = PAGE;
  try { period = localStorage.getItem('lb-period') || period; } catch { /* storage unavailable */ }

  function changeCell(r) {
    if (r.change == null) {
      return r.prevUsd === 0 ? '<span class="chg flat">new</span>' : '<span class="chg flat">–</span>';
    }
    const v = r.change;
    if (Math.abs(v) < 0.5) return '<span class="chg flat">0%</span>';
    const cls = v > 0 ? 'up' : 'down';
    const arrow = v > 0 ? '▲' : '▼';
    const txt = Math.abs(v) >= 1000 ? Math.round(v / 100) / 10 + 'K%' : Math.round(Math.abs(v)) + '%';
    return `<span class="chg ${cls}">${arrow} ${v > 0 ? '+' : '−'}${txt.replace('-', '')}</span>`;
  }

  function rowTip(r) {
    const tok = r.promptTok + r.completionTok;
    const kv = (k, v) => `<div class="t-row kv"><span>${k}</span><span>${v}</span></div>`;
    return `<div class="t-title">${esc(r.name)}</div>` +
      kv('Input spend', usd(r.inUsd)) +
      kv('Output spend', usd(r.outUsd)) +
      kv('Input tokens', tokens(r.promptTok)) +
      kv('Output tokens', tokens(r.completionTok)) +
      kv('Cache hit rate', r.cacheHit == null ? '–' : pct(r.cacheHit)) +
      kv('Avg $ / M tokens', tok ? '$' + (r.usd / tok * 1e6).toFixed(3) : '–') +
      (r.prevUsd != null ? kv('Previous period', usd(r.prevUsd)) : '') +
      kv('Price source', r.priceSource === 'effective' ? 'measured effective price' : r.priceSource === 'list' ? 'list price (fallback)' : 'unpriced');
  }

  function drawLeaderboard() {
    const p = data.leaderboard[period];
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.period === period)));
    const range = p.start === p.end ? long(p.end) : `${short(p.start)} – ${long(p.end)}`;
    const desc = period === 'trending' ? 'Biggest week-over-week spend growth' : `${usd(p.total)} total across ${p.modelCount} models`;
    $('lb-sub').textContent = `${desc} · ${range} (UTC)`;

    const list = $('lb-list');
    if (!p.rows.length) {
      list.innerHTML = `<li class="empty">${period === 'trending' ? 'Trending needs two weeks of history. Run the fetch again after more data accumulates.' : 'No data for this period.'}</li>`;
      $('lb-more').hidden = true;
      return;
    }
    const rows = p.rows.slice(0, shown);
    list.innerHTML = rows.map((r, i) => `
      <li data-i="${i}">
        <span class="rank">${r.rank}.</span>
        <span class="model">
          <a class="name" href="${modelUrl(r.slug)}" target="_blank" rel="noopener">${esc(r.name)}${r.variant !== 'standard' ? `<span class="tag">${esc(r.variant)}</span>` : ''}</a>
          <span class="by">by ${esc(r.author)}</span>
        </span>
        <span class="val">${usd(r.usd)}<span class="share">${pct(r.share)}</span></span>
        ${changeCell(r)}
      </li>`).join('');
    list.querySelectorAll('li[data-i]').forEach((li) => {
      const r = rows[Number(li.dataset.i)];
      li.addEventListener('mousemove', (e) => showTip(rowTip(r), e.clientX, e.clientY));
      li.addEventListener('mouseleave', hideTip);
    });
    $('lb-more').hidden = shown >= p.rows.length;
  }

  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-period]');
    if (!b) return;
    period = b.dataset.period;
    shown = PAGE;
    try { localStorage.setItem('lb-period', period); } catch { /* ignore */ }
    drawLeaderboard();
  });
  $('lb-more').addEventListener('click', () => { shown += PAGE * 2; drawLeaderboard(); });

  // ---------------------------------------------------------------- boot

  if (!data.leaderboard[period]) period = 'week';
  drawChart();
  drawLegend();
  drawLeaderboard();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawChart);
})();
