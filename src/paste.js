'use strict';
const $ = (id) => document.getElementById(id);
// Which account this window signs in (main account when absent)
const PART = new URLSearchParams(location.search).get('part') || undefined;
let DICT = {};
const t = (k, v = {}) => (DICT[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? `{${x}}`);

(async () => {
  const { lang, dict } = await window.api.i18n();
  DICT = dict;
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.title = t('win.paste');
  $('text').placeholder = t('p.placeholder');
  checkClipboard();
})();

/** Offer the session page the user just copied (checked on open and whenever the window gets focus) */
let busy = false;
async function checkClipboard() {
  if (busy) return;
  const c = await window.api.paste.clipboard();
  const box = $('clip');
  box.hidden = !c;
  if (!c) return;
  box.classList.toggle('bad', !!c.expired);
  $('clipUse').hidden = !!c.expired;
  $('clipText').textContent = c.expired ? t('p.clipExpired') : t('p.clipFound', { email: c.email + (c.plan ? ` (${c.plan})` : '') });
}
window.addEventListener('focus', checkClipboard);

async function apply(run) {
  const res = $('result');
  busy = true;
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  res.className = ''; res.textContent = t('p.checking');
  try {
    const r = await run();
    res.className = r.ok ? 'ok' : 'bad';
    res.textContent = r.message;
    if (r.ok) $('text').value = ''; // don't leave the token sitting in the window
  } catch (e) {
    res.className = 'bad'; res.textContent = String(e.message || e);
  } finally {
    document.querySelectorAll('button').forEach(b => { b.disabled = false; });
    busy = false;
    checkClipboard();
  }
}

$('openPage').addEventListener('click', (e) => { e.preventDefault(); window.api.paste.openSessionPage(); });
$('apply').addEventListener('click', () => apply(() => window.api.paste.apply($('text').value, PART)));
$('clipUse').addEventListener('click', () => apply(() => window.api.paste.applyClipboard(PART)));
