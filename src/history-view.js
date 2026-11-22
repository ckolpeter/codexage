'use strict';
/* Usage history window (renderer). Two single-series line charts, one y-scale each (0–100%). */
const $ = (id) => document.getElementById(id);
let DICT = {}, LANG = 'en';
const t = (k, v = {}) => (DICT[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? `{${x}}`);
const NS = 'http://www.w3.org/2000/svg';
const GAP_MS = 15 * 60e3; // break the line when the app wasn't running
const H = 3600e3, D = 24 * H;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function fmtTime(ts, withDay) {
  return new Date(ts).toLocaleString(LANG, withDay
    ? { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
}

/**
 * Line chart: x = time [from, to], y = 0–100%.
 * Crosshair snaps to the nearest sample; the tooltip shows value (strong) then time.
 */
function lineChart(box, points, from, to, opts) {
  const plot = box.querySelector('.plot');
  const tip = box.querySelector('.tip');
  plot.textContent = '';
  if (points.length < 2) {
    const d = document.createElement('div');
    d.className = 'empty'; d.textContent = t('h.empty');
    plot.appendChild(d);
    return;
  }
  const W = plot.clientWidth || 520, HH = 150;
  const m = { l: 34, r: 8, t: 6, b: 20 };
  const iw = W - m.l - m.r, ih = HH - m.t - m.b;
  const x = (ts) => m.l + (ts - from) / (to - from) * iw;
  const y = (v) => m.t + (1 - v / 100) * ih;
  const svg = el('svg', { viewBox: `0 0 ${W} ${HH}`, height: HH, role: 'img', 'aria-label': opts.title });

  // Recessive grid + y labels
  for (const v of [0, 50, 100]) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    const tx = el('text', { x: m.l - 6, y: y(v) + 3.5, 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10 }, svg);
    tx.textContent = v + '%';
  }
  // X ticks
  for (const tk of opts.ticks) {
    if (tk < from || tk > to) continue;
    const tx = el('text', { x: x(tk), y: HH - 5, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10 }, svg);
    tx.textContent = opts.tickLabel(tk);
  }

  // Line, broken at gaps
  let d = '', prev = null;
  for (const p of points) {
    d += (prev && p.t - prev.t <= GAP_MS ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1);
    prev = p;
  }
  el('path', { d, fill: 'none', stroke: 'var(--line)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);

  // Last value: marker + direct label
  const last = points[points.length - 1];
  el('circle', { cx: x(last.t), cy: y(last.v), r: 4, fill: 'var(--line)', stroke: 'var(--card)', 'stroke-width': 2 }, svg);

  // Hover layer
  const hair = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--fg2)', 'stroke-width': 1, 'stroke-dasharray': '2 3', visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 4, fill: 'var(--line)', stroke: 'var(--card)', 'stroke-width': 2, visibility: 'hidden' }, svg);
  const hit = el('rect', { x: m.l, y: 0, width: iw, height: HH, fill: 'transparent', tabindex: 0 }, svg);

  const show = (p) => {
    const px = x(p.t), py = y(p.v);
    hair.setAttribute('x1', px); hair.setAttribute('x2', px); hair.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('visibility', 'visible');
    tip.textContent = '';
    const v = document.createElement('div'); v.className = 'tv'; v.textContent = Math.round(p.v) + '%';
    const k = document.createElement('div'); k.className = 'tk'; k.textContent = fmtTime(p.t, opts.withDay);
    tip.append(v, k);
    tip.style.display = 'block';
    const scale = plot.clientWidth / W;
    const left = 12 + px * scale;
    tip.style.left = Math.min(left + 10, box.clientWidth - tip.offsetWidth - 6) + 'px';
    tip.style.top = (28 + py * scale - 10) + 'px';
  };
  const hide = () => { hair.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; };
  const nearest = (ts) => points.reduce((a, b) => (Math.abs(b.t - ts) < Math.abs(a.t - ts) ? b : a));
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const sx = (e.clientX - r.left) / r.width * W;
    show(nearest(from + (sx - m.l) / iw * (to - from)));
  });
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(last));
  hit.addEventListener('blur', hide);

  plot.appendChild(svg);
}

function stat(value, label) {
  const s = document.createElement('div'); s.className = 'stat';
  const v = document.createElement('div'); v.className = 'v'; v.textContent = value;
  const k = document.createElement('div'); k.className = 'k'; k.textContent = label;
  s.append(v, k);
  return s;
}

let selected; // account key shown (undefined = main account)

/** Account picker, only when history has more than one account */
function renderAccounts(list, sel) {
  $('acctRow').hidden = list.length < 2;
  const box = $('acct');
  const sig = JSON.stringify(list);
  if (box.dataset.sig !== sig) {
    box.textContent = '';
    for (const a of list) {
      const o = document.createElement('option');
      o.value = a.key; o.textContent = a.name;
      box.appendChild(o);
    }
    box.dataset.sig = sig;
  }
  box.value = sel;
}

async function render() {
  const data = await window.api.history.get(selected);
  selected = data.selected;
  renderAccounts(data.accounts || [], data.selected);
  const now = data.now;
  const five = data.five, week = data.week;

  // Headline numbers
  const stats = $('stats'); stats.textContent = '';
  const peak5 = five.length ? Math.max(...five.map(p => p.v)) : null;
  const cur7 = week.length ? week[week.length - 1].v : null;
  // How many times the 5-hour limit was nearly maxed (≥ 90%) in the last 7 days (count distinct windows)
  const near = new Set(data.fiveWeek.filter(p => p.v >= 90).map(p => p.r)).size;
  stats.append(
    stat(peak5 == null ? '–' : Math.round(peak5) + '%', t('h.peak5')),
    stat(cur7 == null ? '–' : Math.round(cur7) + '%', t('h.cur7')),
    stat(String(near), t('h.near')),
  );

  // 5-hour usage over the last 24 hours; ticks every 6 hours
  const from24 = now - D;
  const t6 = []; { const s = new Date(from24); s.setMinutes(0, 0, 0); for (let ts = s.getTime(); ts <= now; ts += H) if (new Date(ts).getHours() % 6 === 0) t6.push(ts); }
  lineChart($('c5'), five, from24, now, { title: t('h.five'), ticks: t6, tickLabel: (ts) => fmtTime(ts, false), withDay: false });

  // Weekly usage over the last 7 days; one tick per day
  const from7 = now - 7 * D;
  const td = []; { const s = new Date(from7); s.setHours(24, 0, 0, 0); for (let ts = s.getTime(); ts <= now; ts += D) td.push(ts); }
  lineChart($('c7'), week, from7, now, {
    title: t('h.week'), ticks: td, withDay: true,
    tickLabel: (ts) => new Date(ts).toLocaleDateString(LANG, { month: 'numeric', day: 'numeric' }),
  });
}

(async () => {
  ({ lang: LANG, dict: DICT } = await window.api.i18n());
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
  document.title = t('h.title');
  document.body.classList.add('ready');
  await render();
  $('acct').addEventListener('change', (e) => { selected = e.target.value; render(); });
  $('export').addEventListener('click', () => window.api.history.exportCSV());
  $('clear').addEventListener('click', async () => {
    if (confirm(t('h.clearConfirm'))) { await window.api.history.clear(); render(); }
  });
  window.addEventListener('resize', render);
  setInterval(render, 60e3);
})();
