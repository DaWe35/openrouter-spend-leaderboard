/* global Chart */
(function () {
  const ALL = window.SPEND_DATA;
  const $ = (id) => document.getElementById(id);
  if (!ALL) {
    document.querySelector('main').insertAdjacentHTML('beforeend',
      '<p class="empty">No data yet. Run <code>npm run fetch</code> first.</p>');
    return;
  }

  // data.js holds two views: with BYOK usage (the default) and without. Older files have one.
  const hasByokToggle = !!ALL.byok;
  let includeByok = true;
  try { includeByok = localStorage.getItem('include-byok') !== '0'; } catch { /* storage unavailable */ }
  const pick = () => (hasByokToggle ? ALL[includeByok ? 'byok' : 'noByok'] : ALL);
  let data = pick();

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
  function fmtSigned(x) { return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1); }

  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;

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

  // ---------------------------------------------------------------- charts

  // Series color: a categorical slot (--s1..--s8 / --others), optionally shaded lighter (+) or darker (−).
  function color(s) {
    if (s.hex) return s.hex;
    const base = cssVar(s.colorVar);
    return s.shade ? mix(base, s.shade > 0 ? '#ffffff' : '#000000', Math.abs(s.shade)) : base;
  }
  function mix(hex, to, t) {
    const a = parseInt(hex.slice(1), 16), b = parseInt(to.slice(1), 16);
    return '#' + [16, 8, 0].map((sh) => Math.round(((a >> sh) & 255) * (1 - t) + ((b >> sh) & 255) * t).toString(16).padStart(2, '0')).join('');
  }

  // A stacked-bar spend chart with legend. `measured` (optional) overlays dots.
  // `percent()` (optional) switches to 100%-stacked bars; tooltips then also show shares.
  function stackedChart({ canvasId, legendId, labels, series, measured, title, note, legendLimit = Infinity, itemLabel = 'models', percent = () => false }) {
    let chart;
    let legendOpen = false;
    const barTotals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
    function draw() {
      drawLegend();
      const surface = cssVar('--bg');
      const pctMode = percent();
      const datasets = series.map((s) => ({
        type: 'bar',
        label: s.name,
        data: pctMode ? s.values.map((v, i) => (barTotals[i] > 0 ? (v / barTotals[i]) * 100 : 0)) : s.values,
        backgroundColor: color(s),
        hoverBackgroundColor: color(s),
        borderWidth: 0,
        stack: 'spend',
        order: 2,
      }));
      if (measured) {
        datasets.push({
          type: 'line',
          label: 'Measured total',
          data: measured,
          stack: 'measured',
          showLine: false,
          pointRadius: 5,
          pointHoverRadius: 6,
          pointBackgroundColor: cssVar('--text'),
          pointBorderColor: surface,
          pointBorderWidth: 2,
          order: 1,
        });
      }

      const textColor = cssVar('--text-2');
      if (chart) chart.destroy();
      Chart.getChart($(canvasId))?.destroy(); // chart from the other BYOK view on this canvas
      chart = new Chart($(canvasId), {
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: 'index', intersect: false },
          datasets: { bar: { categoryPercentage: 0.78, barPercentage: 1 } },
          scales: {
            x: {
              stacked: true,
              grid: { display: false },
              border: { display: false },
              ticks: { color: textColor, maxRotation: 0, autoSkip: true, autoSkipPadding: 40, padding: 8, callback: (v) => short(labels[v]) },
            },
            y: {
              stacked: true,
              max: pctMode ? 100 : undefined,
              grid: { display: false },
              border: { display: false },
              ticks: { color: textColor, padding: 8, callback: (v) => (pctMode ? v + '%' : usd(v, 0)), maxTicksLimit: 6 },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false, external: tooltip },
          },
        },
      });
    }

    function tooltip({ chart: ch, tooltip: t }) {
      if (!t.opacity || !t.dataPoints?.length) return hideTip();
      const i = t.dataPoints[0].dataIndex;
      const rows = series
        .map((s) => ({ s, v: s.values[i] }))
        .filter((r) => r.v > 0)
        .sort((a, b) => (a.s.key === 'Others') - (b.s.key === 'Others') || b.v - a.v);
      const total = rows.reduce((a, r) => a + r.v, 0);
      const kv = (k, v, cls = '') => `<div class="t-row kv ${cls}"><span>${k}</span><span>${v}</span></div>`;
      let html = `<div class="t-title">${esc(title(i))}</div>` +
        rows.map(({ s, v }) => `<div class="t-row"><span class="swatch" style="background:${color(s)}"></span><span>${esc(s.name)}</span><span>${percent() ? `${pct(v / total)} · ` : ''}${usd(v)}</span></div>`).join('') +
        kv(measured ? 'Estimated total' : 'Total', usd(total), 't-total');
      if (measured?.[i] != null) {
        const diff = ((total - measured[i]) / measured[i]) * 100;
        html += kv('Measured total', usd(measured[i])) + kv('Estimate vs measured', (diff >= 0 ? '+' : '−') + Math.abs(diff).toFixed(1) + '%');
      }
      if (note?.(i)) html += `<div class="t-row kv"><span class="muted">${esc(note(i))}</span><span></span></div>`;
      const rect = ch.canvas.getBoundingClientRect();
      showTip(html, rect.left + t.caretX, rect.top + t.caretY);
    }
    $(canvasId).onmouseleave = hideTip;

    function drawLegend() {
      const grand = series.reduce((a, s) => a + s.total, 0);
      const named = series.filter((s) => s.key !== 'Others' && s.total > 0).sort((a, b) => b.total - a.total);
      const others = series.filter((s) => s.key === 'Others');
      const visible = legendOpen ? named : named.slice(0, legendLimit);
      const item = (s, i) => {
        const name = s.key === 'Others'
          ? `<span class="name" title="${esc(s.author)}">Others</span>`
          : `<a class="name" href="${modelUrl(s.slug)}" target="_blank" rel="noopener" title="${esc(s.title ?? s.name + ' by ' + s.author)}">${esc(s.name)}</a>`;
        return `<li><span class="rank">${s.key === 'Others' ? '' : i + 1}</span><span class="swatch" style="background:${color(s)}"></span>${name}<span class="val">${usd(s.total)}<span class="share">${pct(s.total / grand)}</span></span></li>`;
      };
      const hidden = named.length - visible.length;
      $(legendId).innerHTML = visible.map(item).join('') + others.map(item).join('') +
        (measured ? '<li><span class="rank"></span><span class="dot"></span><span class="name">Measured total (actual spend)</span><span class="val"></span></li>' : '') +
        (named.length > legendLimit
          ? `<li class="legend-toggle"><button type="button">${legendOpen ? 'Show fewer' : `Show all ${named.length} ${itemLabel} (+${hidden})`}</button></li>`
          : '');
      $(legendId).querySelector('.legend-toggle button')?.addEventListener('click', () => { legendOpen = !legendOpen; drawLegend(); });
    }

    draw();
    return draw;
  }

  // Both charts color like openrouter.ai's Top Models chart: series in order of first appearance
  // (each bar's top 9, then "Others"), color = palette[index % 20] with "Others" included,
  // stacked in that order (first = bottom).
  const OR_PALETTE = ['#0088fe', '#00c49f', '#ffbb28', '#ff8042', '#ff6347', '#4682b4', '#9acd32', '#da70d6', '#40e0d0', '#ff69b4',
    '#daa520', '#7b68ee', '#f08080', '#6b8e23', '#db7093', '#3cb371', '#bdb76b', '#800080', '#ff4500', '#2e8b57'];
  // Colors are assigned in OpenRouter's order; then "Others" is moved first so it always
  // sits at the bottom of every bar.
  const withColors = (series) => {
    const colored = series.map((s, i) => ({ ...s, hex: OR_PALETTE[i % OR_PALETTE.length] }));
    return [...colored.filter((s) => s.key === 'Others'), ...colored.filter((s) => s.key !== 'Others')];
  };

  // For bars with up to 20 models + Others: "Others" keeps OpenRouter's pink, named models
  // use the other 19 OpenRouter colors plus a few extras (models rotate in and out of the
  // top 20, so 20 colors aren't enough). Each model starts from its index color (like
  // openrouter.ai) but skips colors already used by a model it shares a bar with.
  const OTHERS_HEX = '#ff69b4';
  const NAMED_PALETTE = [...OR_PALETTE.filter((h) => h !== OTHERS_HEX),
    '#a0522d', '#4169e1', '#c71585', '#008b8b', '#cd853f', '#9932cc', '#e9967a', '#00bfff'];
  const withDistinctColors = (series) => {
    const named = series.filter((s) => s.key !== 'Others');
    const assigned = new Map();
    named.forEach((s, i) => {
      const taken = new Set(named
        .filter((o) => assigned.has(o.key) && o.values.some((v, j) => v > 0 && s.values[j] > 0))
        .map((o) => assigned.get(o.key)));
      let idx = i % NAMED_PALETTE.length;
      for (let n = 0; n < NAMED_PALETTE.length && taken.has(idx); n++) idx = (idx + 1) % NAMED_PALETTE.length;
      assigned.set(s.key, idx);
    });
    return [
      ...series.filter((s) => s.key === 'Others').map((s) => ({ ...s, hex: OTHERS_HEX })),
      ...named.map((s) => ({ ...s, hex: NAMED_PALETTE[assigned.get(s.key)] })),
    ];
  };

  // Redraw function per canvas, used when the color scheme changes.
  const redraw = {};

  // ---- Chart 1: measured spend (last ~30 days, grows with history)
  function renderTopModels() {
    const c = data.chart;
    const weekly = c.granularity === 'week';
    $('chart-sub').textContent = `Spend per ${weekly ? 'week' : 'day'} by model`;
    $('chart-total').textContent = usd(c.total);
    $('chart-total-label').textContent = `total over ${c.bucketDays.reduce((a, b) => a + b, 0)} days`;
    redraw.chart = stackedChart({
      canvasId: 'chart',
      legendId: 'legend',
      labels: c.labels,
      series: withDistinctColors(c.series),
      legendLimit: 20,
      title: (i) => {
        const label = c.labels[i];
        const days = c.bucketDays[i];
        return weekly
          ? `Week of ${long(label)}${days < 7 ? ` (${days} day${days > 1 ? 's' : ''})` : ''}`
          : fmtDate(label, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      },
    });
  }

  // ---- Chart 2: 1-year estimate from OpenRouter's weekly token chart
  // "30 days | 1 year (est.)" switch. The estimate chart is only built when it's shown.
  let view = '30d';
  try { view = localStorage.getItem('top-models-view') === '1y' ? '1y' : '30d'; } catch { /* storage unavailable */ }
  let estBuilt = false;

  function renderEstimateText() {
    const e = data.estimate;
    const fullWeeks = e.partial.filter((p) => !p).length;
    $('est-sub').textContent = 'Rough estimate of spend per week. Dots mark weeks with measured spend. Method below the chart.';
    $('est-total').textContent = usd(e.total);
    $('est-total-label').textContent = `estimated over ${fullWeeks} weeks${e.partial.some(Boolean) ? ' + current week' : ''}`;

    const errs = e.calibration.map((w) => w.holdoutErrPct).filter((x) => x != null);
    const errRange = errs.length ? ` (leave-one-out error ${fmtSigned(Math.min(...errs))}% to ${fmtSigned(Math.max(...errs))}%)` : '';
    const s = e.rateSources;
    $('est-method').textContent =
      `How this is estimated: OpenRouter publishes a year of weekly token totals for each week's top 9 models plus "Others" (BYOK included). ` +
      `Each named model's tokens are multiplied by its own $/token: ${s.measured ?? 0} of ${e.namedModels} use their measured spend ÷ tokens over the last 30 days ` +
      `(this captures each model's cache use, input/output mix${includeByok ? '' : ' and BYOK share'})` +
      (s.effective ? `, ${s.effective} use OpenRouter's 1-year effective price` : '') +
      (s.list ? `, ${s.list} use list prices` : '') +
      `, ${s.free ?? 0} are free variants and ${s.unpriced ?? 0} have no price data (mostly free stealth/preview models), counted as $0. ` +
      `"Others" tokens are priced at $${e.othersRatePerM.toFixed(3)}/M, calibrated on ${e.calibration.length} week(s) with measured spend${errRange}. ` +
      (!includeByok && e.globals?.byokShare
        ? `Without BYOK, effective and list prices are scaled down by the platform-wide BYOK share (${pct(e.globals.byokShare)} of tokens). `
        : '') +
      `Older weeks are less certain: prices, cache use and the model mix change over time, and today's rates are applied to the whole year.`;
  }

  function buildEstimateChart() {
    const e = data.estimate;
    const sourceLabel = { measured: 'last 30 days measured $/token', effective: '1-year effective price', list: 'list price', free: 'free', unpriced: 'no price data', calibrated: 'calibrated on measured weeks' };
    const estSeries = withColors(e.series).map((s) => ({
      ...s,
      title: `${s.name}${s.key === 'Others' ? '' : ' by ' + s.author} · priced at $${s.ratePerM.toFixed(3)}/M tokens (${sourceLabel[s.rateSource] ?? s.rateSource})`,
    }));
    redraw['est-chart'] = stackedChart({
      canvasId: 'est-chart',
      legendId: 'est-legend',
      labels: e.labels,
      series: estSeries,
      legendLimit: 20,
      measured: e.measured.some((m) => m != null) ? e.measured : null,
      title: (i) => `Week of ${long(e.labels[i])}${e.partial[i] ? ' (in progress)' : ''}`,
      note: (i) => (e.partial[i] ? 'Partial week, includes today' : null),
    });
  }

  function setView(v) {
    view = data.estimate ? v : '30d';
    const year = view === '1y';
    $('view-30d').hidden = year;
    $('view-1y').hidden = !year;
    $('chart-hero').hidden = year;
    $('est-hero').hidden = !year;
    $('chart-sub').hidden = year;
    $('est-sub').hidden = !year;
    $('est-badge').hidden = !year;
    document.querySelectorAll('#range-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
    if (year && !estBuilt) {
      estBuilt = true;
      buildEstimateChart();
    }
    hideTip();
    try { localStorage.setItem('top-models-view', view); } catch { /* storage unavailable */ }
  }
  $('range-tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  function renderEstimate() {
    estBuilt = false;
    delete redraw['est-chart'];
    $('range-tabs').hidden = !data.estimate;
    if (data.estimate) renderEstimateText();
    setView(view);
  }

  // ---- Market share by model author (Absolute | Percentage), colored like openrouter.ai
  let msMode = 'pct';
  try { msMode = localStorage.getItem('market-share-mode') === 'abs' ? 'abs' : 'pct'; } catch { /* storage unavailable */ }
  const syncMsTabs = () => document.querySelectorAll('#ms-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === msMode)));
  $('ms-tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (!b || b.dataset.mode === msMode) return;
    msMode = b.dataset.mode;
    try { localStorage.setItem('market-share-mode', msMode); } catch { /* ignore */ }
    syncMsTabs();
    hideTip();
    redraw['ms-chart']?.();
  });

  function renderMarketShare() {
    const ms = data.marketShare;
    $('market-share').hidden = !ms;
    if (!ms) return;
    const msWeekly = ms.granularity === 'week';
    $('ms-sub').textContent = `Share of spend by model author per ${msWeekly ? 'week' : 'day'}`;
    syncMsTabs();
    redraw['ms-chart'] = stackedChart({
      canvasId: 'ms-chart',
      legendId: 'ms-legend',
      labels: ms.labels,
      series: withColors(ms.series),
      itemLabel: 'authors',
      percent: () => msMode === 'pct',
      title: (i) => (msWeekly
        ? `Week of ${long(ms.labels[i])}`
        : fmtDate(ms.labels[i], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
    });
  }

  // ---------------------------------------------------------------- leaderboard

  const COLLAPSED = 20;
  const PAGE = 20;
  let period = 'week';
  let shown = COLLAPSED;
  try { period = localStorage.getItem('lb-period') || period; } catch { /* storage unavailable */ }

  function changeCell(r) {
    if (r.change == null) {
      return r.prevUsd === 0 ? '<span class="chg flat">new</span>' : '<span class="chg flat">–</span>';
    }
    const v = r.change;
    if (Math.abs(v) < 0.5) return '<span class="chg flat">0%</span>';
    const cls = v > 0 ? 'up' : 'down';
    const arrow = v > 0 ? '↑' : '↓';
    const txt = Math.abs(v) > 999 ? '>999%' : Math.round(Math.abs(v)) + '%';
    return `<span class="chg ${cls}">${arrow}${txt}</span>`;
  }

  function rowTip(r) {
    const tok = r.promptTok + r.completionTok;
    const kv = (k, v) => `<div class="t-row kv"><span>${k}</span><span>${v}</span></div>`;
    return `<div class="t-title">${esc(r.name)}</div>` +
      kv('Input spend', usd(r.inUsd)) +
      kv('Output spend', usd(r.outUsd)) +
      (r.byokUsd != null ? kv('of which BYOK', usd(r.byokUsd) + (r.usd > 0 ? ` (${pct(r.byokUsd / r.usd)})` : '')) : '') +
      kv('Input tokens', tokens(r.promptTok)) +
      kv('Output tokens', tokens(r.completionTok)) +
      kv('Cache hit rate', r.cacheHit == null ? '–' : pct(r.cacheHit)) +
      kv('Avg $ / M tokens', tok ? '$' + (r.usd / tok * 1e6).toFixed(3) : '–') +
      (r.prevUsd != null ? kv('Previous period', usd(r.prevUsd)) : '') +
      kv('Price source', r.priceSource === 'effective' ? 'measured effective price' : r.priceSource === 'list' ? 'list price (fallback)' : 'unpriced');
  }

  function drawLeaderboard() {
    const p = data.leaderboard[period];
    $('lb-period').value = period;
    const desc = period === 'trending' ? 'Biggest week-over-week spend growth' : `${usd(p.total)} total across ${p.modelCount} models`;
    $('lb-sub').textContent = desc;

    const list = $('lb-list');
    if (!p.rows.length) {
      list.innerHTML = `<li class="empty">${period === 'trending' ? 'Trending needs two weeks of history. Run the fetch again after more data accumulates.' : 'No data for this period.'}</li>`;
      $('lb-more').hidden = true;
      return;
    }
    const rows = p.rows.slice(0, shown);
    // Two columns filled top-to-bottom (1–10 left, 11–20 right), like openrouter.ai.
    list.style.gridTemplateRows = `repeat(${Math.ceil(rows.length / 2)}, auto)`;
    list.innerHTML = rows.map((r, i) => `
      <li data-i="${i}">
        <span class="rank">${r.rank}.</span>
        <span class="avatar" aria-hidden="true">${esc(String(r.author).charAt(0))}</span>
        <span class="model">
          <a class="name" href="${modelUrl(r.slug)}" target="_blank" rel="noopener">${esc(r.name)}${r.variant !== 'standard' ? `<span class="tag">${esc(r.variant)}</span>` : ''}</a>
          <span class="by">by <span>${esc(r.author)}</span></span>
        </span>
        <span class="stats">
          <span class="val">${usd(r.usd)}<span class="share">${pct(r.share)}</span></span>
          ${changeCell(r)}
        </span>
      </li>`).join('');
    list.querySelectorAll('li[data-i]').forEach((li) => {
      const r = rows[Number(li.dataset.i)];
      li.addEventListener('mousemove', (e) => showTip(rowTip(r), e.clientX, e.clientY));
      li.addEventListener('mouseleave', hideTip);
    });
    $('lb-more').hidden = shown >= p.rows.length;
  }

  $('lb-period').addEventListener('change', (e) => {
    period = e.target.value;
    shown = COLLAPSED;
    try { localStorage.setItem('lb-period', period); } catch { /* ignore */ }
    drawLeaderboard();
  });
  $('lb-more').addEventListener('click', () => { shown += PAGE; drawLeaderboard(); });

  // ---------------------------------------------------------------- boot

  function renderAll() {
    hideTip();
    renderTopModels();
    renderEstimate();
    renderMarketShare();
    if (!data.leaderboard[period]) period = 'week';
    drawLeaderboard();
  }

  const byokBox = $('include-byok');
  if (hasByokToggle) {
    byokBox.checked = includeByok;
    byokBox.addEventListener('change', () => {
      includeByok = byokBox.checked;
      try { localStorage.setItem('include-byok', includeByok ? '1' : '0'); } catch { /* ignore */ }
      data = pick();
      renderAll();
    });
  } else {
    byokBox.closest('label').hidden = true;
  }

  renderAll();
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => Object.values(redraw).forEach((f) => f()));
})();
