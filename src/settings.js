'use strict';
const $ = (id) => document.getElementById(id);
const S = window.api.settings;
let DICT = {};
const t = (k, v = {}) => (DICT[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? `{${x}}`);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CHECKS = ['alwaysOnTop', 'compact', 'notify', 'notifyReset', 'openAtLogin', 'autoUpdate', 'clickThrough', 'quietEnabled', 'hideOnFullscreen', 'snapEdges', 'maskEmail'];

async function applyI18n() {
  const { lang, dict } = await window.api.i18n();
  DICT = dict;
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.body.classList.add('ready');
}

let wsLoadedFor = null; // which source the workspace list was loaded for

async function load() {
  const info = await S.get();
  const c = info.config;

  const langSel = $('language');
  langSel.innerHTML = `<option value="auto">${esc(t('menu.langAuto'))}</option>`
    + info.languages.map(l => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join('');
  langSel.value = c.language || 'auto';

  document.querySelectorAll('input[name=source]').forEach(r => { r.checked = r.value === c.source; });
  $('interval').value = c.intervalSec;
  $('opacity').value = c.opacity;
  $('trayMetric').value = c.trayMetric || 'five_hour';
  $('theme').value = c.theme || 'dark';
  $('thresholds').value = (c.notifyThresholds || [80, 95]).join(', ');
  $('quietStart').value = c.quietStart || '23:00';
  $('quietEnd').value = c.quietEnd || '08:00';
  $('scale').value = c.scale || 1;
  $('scaleVal').textContent = Math.round((c.scale || 1) * 100) + '%';
  $('hotkey').value = c.hotkey || '';
  $('hotkeyHint').innerHTML = c.hotkey && !info.hotkeyOk
    ? `<span class="bad">${esc(t('s.hotkeyFail'))}</span>` : esc(t('s.hotkeyHint'));
  for (const k of CHECKS) $(k).checked = !!c[k];
  $('mainLabel').value = c.mainLabelEmail && c.mainEmail && c.mainLabelEmail !== c.mainEmail ? '' : (c.mainLabel || '');
  $('mainLabel').placeholder = c.mainEmail || t('s.accountLabelEmpty');
  $('fsRow').style.display = info.fullscreenSupported ? '' : 'none';

  const web = c.source !== 'cli';
  $('webBox').style.display = web ? '' : 'none';
  if (web) {
    $('srcHint').textContent = t('s.hintWeb');
    $('sessStatus').innerHTML = info.signIn === 'cookie'
      ? `<span class="ok">${esc(t('s.loggedIn'))}</span>`
      : info.signIn === 'pasted'
        ? `<span class="ok">${esc(t('s.pastedIn'))}</span>${info.pastedUntil ? ' · ' + esc(t('p.until', { time: info.pastedUntil })) : ''}`
        : `<span class="bad">${esc(t('s.loggedOut'))}</span>`;
  } else {
    $('srcHint').textContent = t(info.hasCodexCli ? 's.hintCli' : 's.hintCliMissing', { path: info.codexAuthPath });
  }
  const signedIn = web ? !!info.signIn : info.hasCodexCli;
  if (signedIn && wsLoadedFor !== c.source) loadWorkspaces(c.workspaceId, c.source);
  if (!signedIn) { $('workspace').length = 1; $('wsHint').textContent = ''; wsLoadedFor = null; }
  $('foot').textContent = `Codexage v${info.version} · ${info.platform}`;
  loadAccounts();
}

async function loadWorkspaces(current, source) {
  wsLoadedFor = source;
  const sel = $('workspace');
  const list = await S.listWorkspaces();
  sel.length = 1;
  if (!Array.isArray(list)) { $('wsHint').textContent = list?.error ? t('s.workspaceFail', { msg: list.error }) : ''; return; }
  $('wsHint').textContent = list.length > 1 ? '' : t('s.workspaceOne');
  for (const w of list) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = `${w.name || w.id.slice(0, 8)}${w.plan ? ' (' + w.plan + ')' : ''}`;
    if (w.id === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadAccounts() {
  const list = await window.api.accounts.list();
  const box = $('acctList');
  box.textContent = '';
  list.forEach((a, i) => {
    const row = document.createElement('div'); row.className = 'acctRow';
    // Editable name; the email (or "Account N") shows as the placeholder
    const nm = document.createElement('input'); nm.className = 'nm'; nm.type = 'text'; nm.maxLength = 40;
    nm.value = a.label || ''; nm.placeholder = a.email || t('a.unnamed', { n: i + 2 }); nm.title = t('s.accountLabelHint');
    nm.addEventListener('change', () => window.api.accounts.setLabel(a.partition, nm.value));
    const st = document.createElement('span'); st.className = 'st';
    st.textContent = t(a.signedIn ? 'a.signedIn' : 'a.signedOut');
    const btn = (key, fn) => { const b = document.createElement('button'); b.textContent = t(key); b.addEventListener('click', fn); return b; };
    row.append(
      nm, st,
      btn('s.login', () => window.api.accounts.login(a.partition)),
      btn('a.paste', () => window.api.accounts.paste(a.partition)),
      btn('a.remove', async () => { await window.api.accounts.remove(a.partition); loadAccounts(); }),
    );
    box.appendChild(row);
  });
}

const set = (patch) => S.set(patch);

$('language').addEventListener('change', e => set({ language: e.target.value })); // main reloads this window
document.querySelectorAll('input[name=source]').forEach(r =>
  r.addEventListener('change', async () => { await set({ source: r.value }); wsLoadedFor = null; load(); }));
$('interval').addEventListener('change', e => set({ intervalSec: Number(e.target.value) }));
$('opacity').addEventListener('input', e => set({ opacity: Number(e.target.value) }));
for (const k of CHECKS) $(k).addEventListener('change', e => set({ [k]: e.target.checked }));
$('thresholds').addEventListener('change', async e => {
  const list = e.target.value.split(/[,，\s]+/).map(Number).filter(n => n >= 1 && n <= 100);
  const c = await set({ notifyThresholds: list });
  e.target.value = c.notifyThresholds.join(', ');
});
$('quietStart').addEventListener('change', e => set({ quietStart: e.target.value }));
$('quietEnd').addEventListener('change', e => set({ quietEnd: e.target.value }));
$('theme').addEventListener('change', e => set({ theme: e.target.value }));
$('scale').addEventListener('input', e => { $('scaleVal').textContent = Math.round(e.target.value * 100) + '%'; });
$('scale').addEventListener('change', e => set({ scale: Number(e.target.value) }));
$('hotkey').addEventListener('change', async e => { await set({ hotkey: e.target.value.trim() }); load(); });
$('trayMetric').addEventListener('change', e => set({ trayMetric: e.target.value }));
$('mainLabel').addEventListener('change', e => set({ mainLabel: e.target.value }));
$('workspace').addEventListener('change', e => set({ workspaceId: e.target.value || null }));
$('acctAdd').addEventListener('click', () => window.api.accounts.add());
$('acctAddPaste').addEventListener('click', async () => { await window.api.accounts.addByPaste(); loadAccounts(); });
$('login').addEventListener('click', () => S.login());
$('paste').addEventListener('click', () => window.api.paste.open());
$('logout').addEventListener('click', () => { S.logout(); wsLoadedFor = null; setTimeout(load, 500); });
window.addEventListener('focus', load);

applyI18n().then(load);
