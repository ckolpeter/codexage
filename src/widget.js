'use strict';
const $ = (id) => document.getElementById(id);

let state = { status: 'loading' };
let opts = { compact: false };
let LANG = 'en';
let DICT = {};

function t(key, vars = {}) {
  const s = DICT[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}
/** "5-hour", "Weekly", "1-hour", or "<extra limit name> · 5-hour" */
function labelOf(w) {
  const main = w.labelKey ? t(w.labelKey, w.labelVars || {}) : String(w.key || '').replace(/_/g, ' ');
  return w.spanKey ? `${main} · ${t(w.spanKey, w.spanVars || {})}` : main;
}
function msgOf(s) { return s.msgKey ? t(s.msgKey, s.msgVars) : (s.message || ''); }

function color(p) {
  if (p >= 90) return 'var(--bad)';
  if (p >= 70) return 'var(--warn)';
  return 'var(--ok)';
}

function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? t('w.dur.dh', { d, h }) : h ? t('w.dur.hm', { h, m: mm }) : t('w.dur.m', { m: mm });
}

function fmtLeft(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return '';
  if (ms <= 0) return t('w.soon');
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  const when = at.toLocaleString(LANG, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return t('w.resetIn', { left: fmtDur(ms), when });
}

/** Run-out prediction line under a usage bar */
function etaHtml(w) {
  const e = w.eta;
  if (!e) return '';
  if (e.exhausted) return `<div class="eta bad">${esc(t('w.exhausted'))}</div>`;
  const tip = esc(t(e.basis === 'recent' ? 'w.etaRecent' : 'w.etaAverage'));
  if (e.beforeReset && e.at) {
    const left = e.at - Date.now();
    if (left <= 0) return `<div class="eta bad">${esc(t('w.exhausted'))}</div>`;
    return `<div class="eta warn" title="${tip}">${esc(t('w.etaRunOut', { left: fmtDur(left) }))}</div>`;
  }
  return `<div class="eta ok" title="${tip}">${esc(t('w.etaSafe'))}</div>`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function rowHtml(w) {
  const p = Math.round(w.pct);
  let pace = '';
  if (w.durationMs && w.resetsAt) {
    const elapsed = 1 - (new Date(w.resetsAt).getTime() - Date.now()) / w.durationMs;
    if (elapsed > 0 && elapsed < 1) {
      pace = `<div class="pace" style="left:${(elapsed * 100).toFixed(1)}%" title="${esc(t('w.pace', { pct: Math.round(elapsed * 100) }))}"></div>`;
    }
  }
  return `<div class="row ${w.primary ? '' : 'secondary'} ${w.limitReached ? 'reached' : ''}">
    <div class="line"><span class="label">${esc(labelOf(w))}</span><span class="pct">${p}%</span></div>
    <div class="bar"><div class="fill" style="width:${w.pct}%;background:${color(w.pct)}"></div>${pace}</div>
    <div class="reset">${esc(w.idle ? t('w.idle') : [detailOf(w), fmtLeft(w.resetsAt)].filter(Boolean).join(' · '))}</div>
    ${etaHtml(w)}
  </div>`;
}

function creditsHtml(c) {
  const v = c.unlimited ? t('w.creditsUnlimited') : c.balance != null
    ? new Intl.NumberFormat(LANG, { maximumFractionDigits: 2 }).format(c.balance) : '–';
  return `<div class="row secondary"><div class="line"><span class="label">${esc(t('label.credits'))}</span><span class="pct money">${esc(v)}</span></div></div>`;
}

/** Extra accounts: compact block per account with its 5-hour and weekly bars */
function othersHtml(others) {
  return others.map((o, i) => {
    const name = o.email || t('a.unnamed', { n: i + 2 });
    let body;
    if (o.status === 'ok') {
      body = o.windows.map(w => {
        const p = Math.round(w.pct);
        return `<div class="mrow"><span class="mlabel">${esc(labelOf(w))}</span>
          <div class="bar mbar"><div class="fill" style="width:${w.pct}%;background:${color(w.pct)}"></div></div>
          <span class="mpct">${p}%</span></div>`;
      }).join('');
    } else if (o.status === 'auth') {
      body = `<div class="mmsg">${esc(msgOf(o))} <a href="#" class="mlogin" data-part="${esc(o.partition)}">${esc(t('w.pasteBtn'))}</a></div>`;
    } else {
      body = `<div class="mmsg">${esc(msgOf(o))}</div>`;
    }
    if (o.signInExpiresAt) body += expiringHtml(o.signInExpiresAt, o.partition);
    return `<div class="acct"><div class="aname">${esc(name)}${o.plan ? ` <span class="aplan">${esc(o.plan)}</span>` : ''}</div>${body}</div>`;
  }).join('');
}

const fmtNum = (n) => { try { return new Intl.NumberFormat(LANG).format(n); } catch { return String(n); } };
/** Extra line under a bar, e.g. "8,000 of 25,000 credits used" */
function detailOf(w) {
  if (!w.detailKey) return '';
  const v = {};
  for (const [k, x] of Object.entries(w.detailVars || {})) v[k] = typeof x === 'number' ? fmtNum(x) : x;
  return t(w.detailKey, v);
}
/** Short date-time; time only when it's today */
function fmtWhen(iso) {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(LANG, today
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Usage-limit resets the user can spend in Codex CLI (/usage), with the soonest expiry below */
function resetsHtml(r) {
  const next = r.nextExpiry ? `<div class="reset">${esc(t('w.resetsNext', { time: fmtWhen(r.nextExpiry) }))}</div>` : '';
  return `<div class="row secondary" title="${esc(t('w.resetsTip'))}"><div class="line"><span class="label">${esc(t('label.resets'))}</span><span class="pct money">${esc(String(r.available))}</span></div>${next}</div>`;
}

/** Why usage is blocked (top of the card), plus the way out when there is one */
function blockedHtml(data) {
  const known = ['rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
    'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached', 'spend'];
  const type = known.includes(data.blocked) ? data.blocked : 'rate_limit_reached';
  let html = `<div class="note badnote">⛔ ${esc(t(`w.blocked.${type}`))}</div>`;
  if (type === 'rate_limit_reached' && data.resets?.available > 0) {
    html += `<div class="note">${esc(t('w.useReset', { n: data.resets.available }))}</div>`;
  }
  return html;
}

/** Models that can't be used right now, and when they come back */
function modelsHtml(list) {
  return list.map(m => `<div class="note">${esc(m.availableAt
    ? t('w.modelUnavailable', { model: m.name, time: fmtWhen(m.availableAt) })
    : t('w.modelUnavailableNoTime', { model: m.name }))}</div>`).join('');
}

/** Pasted sign-in about to expire: warning + link to paste a fresh one */
function expiringHtml(at, part) {
  const left = fmtDur(Math.max(60e3, at - Date.now()));
  return `<div class="note warnnote">${esc(t('w.expiring', { left }))} <a href="#" class="repaste"${part ? ` data-part="${esc(part)}"` : ''}>${esc(t('w.repaste'))}</a></div>`;
}

function render() {
  const card = $('card');
  document.body.classList.toggle('light', opts.theme === 'light');
  document.body.classList.toggle('ghost', !!opts.clickThrough);
  card.classList.toggle('compact', !!opts.compact);
  $('btnRefresh').innerHTML = state.refreshing ? '<span class="spin">⟳</span>' : '⟳';
  $('footErr').textContent = '';

  let data = state.status === 'ok' ? state : (state.status === 'error' ? state.prev : null);
  if (state.refreshing && !data && state.windows) data = state;

  if (data && data.windows) {
    $('plan').textContent = data.plan || '';
    let ws = data.windows;
    if (opts.compact) ws = ws.filter(w => w.primary);
    let html = ws.map(rowHtml).join('');
    // Blocked: say why first (also in compact mode)
    if (data.blocked) html = blockedHtml(data) + html;
    if (state.others && state.others.length && state.email) html = `<div class="aname">${esc(state.email)}</div>` + html;
    if (!opts.compact && data.modelsUnavailable?.length) html += modelsHtml(data.modelsUnavailable);
    if (!opts.compact && data.credits) html += creditsHtml(data.credits);
    if (!opts.compact && data.resets) html += resetsHtml(data.resets);
    // Shown even in compact mode: the widget stops working once it expires
    if (data.signInExpiresAt) html += expiringHtml(data.signInExpiresAt);
    if (!opts.compact && data.weeklyOnly) html += `<div class="note">${esc(t('w.weeklyOnly'))}</div>`;
    $('content').innerHTML = html;
    $('updated').textContent = data.fetchedAt
      ? t('w.updatedAt', { time: new Date(data.fetchedAt).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' }) })
      : '';
    if (state.status === 'error') {
      const left = state.retryAt ? Math.max(1, Math.round((state.retryAt - Date.now()) / 1000)) : null;
      $('footErr').textContent = state.msgKey === 'err.offline' ? t('w.offline')
        : left ? t('w.retrying', { s: left }) : t('w.updateFailed');
    }
    $('footErr').title = msgOf(state);
  } else if (state.status === 'auth') {
    $('plan').textContent = '';
    const isWeb = state.source !== 'cli';
    $('content').innerHTML = `<div class="msg"><b>${esc(t('w.needLogin'))}</b><br>${esc(msgOf(state))}</div>
      ${isWeb
        ? `<button class="action" id="btnLogin">${esc(t('w.loginBtn'))}</button>
           <button class="action alt" id="btnPaste" title="${esc(t('w.pasteTip'))}">${esc(t('w.pasteBtn'))}</button>`
        : `<button class="action" id="btnUseWeb">${esc(t('w.useWeb'))}</button>`}`;
    $('updated').textContent = '';
    $('btnLogin')?.addEventListener('click', () => window.api.login());
    $('btnPaste')?.addEventListener('click', () => window.api.paste.open());
    $('btnUseWeb')?.addEventListener('click', () => window.api.useSource('web'));
  } else if (state.status === 'error') {
    $('plan').textContent = state.plan || '';
    $('content').innerHTML = `<div class="msg"><b>${esc(t('w.cantFetch'))}</b><br>${esc(msgOf(state))}</div>`
      + (state.reportable ? `<button class="action" id="btnReport">${esc(t('w.report'))}</button>` : '');
    $('btnReport')?.addEventListener('click', () => window.api.openIssue());
  } else {
    $('content').innerHTML = `<div class="msg">${esc(t('w.loading'))}</div>`;
  }
  if (state.others && state.others.length) {
    $('content').insertAdjacentHTML('beforeend', othersHtml(state.others));
    $('content').querySelectorAll('.mlogin').forEach(a => a.addEventListener('click', (e) => {
      e.preventDefault(); window.api.accounts.paste(a.dataset.part);
    }));
  }
  $('content').querySelectorAll('.repaste').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    if (a.dataset.part) window.api.accounts.paste(a.dataset.part); else window.api.paste.open();
  }));
  requestAnimationFrame(() => window.api.resize(document.body.scrollHeight));
}

function applyStaticI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

$('btnRefresh').addEventListener('click', () => window.api.refresh());
$('btnSettings').addEventListener('click', () => window.api.openSettings());
$('btnHistory').addEventListener('click', () => window.api.openHistory());
$('btnHide').addEventListener('click', () => window.api.hide());
document.addEventListener('contextmenu', (e) => { e.preventDefault(); window.api.contextMenu(); });
$('content').addEventListener('dblclick', () => window.api.toggleCompact());

(async () => {
  ({ lang: LANG, dict: DICT } = await window.api.i18n());
  applyStaticI18n();
  window.api.onUsage((s, o) => { state = s; opts = o || opts; render(); });
  const { state: s, opts: o } = await window.api.getState();
  state = s; opts = o; render();
  setInterval(render, 30000); // countdown + pace marker
})();
