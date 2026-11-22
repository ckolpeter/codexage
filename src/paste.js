'use strict';
const $ = (id) => document.getElementById(id);
// Which account this window signs in (main account when absent)
const PART = new URLSearchParams(location.search).get('part') || undefined;
let DICT = {};
const t = (k) => DICT[k] ?? k;

(async () => {
  const { lang, dict } = await window.api.i18n();
  DICT = dict;
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.title = t('win.paste');
  $('text').placeholder = t('p.placeholder');
})();

$('openPage').addEventListener('click', (e) => { e.preventDefault(); window.api.paste.openSessionPage(); });

$('apply').addEventListener('click', async () => {
  const text = $('text').value;
  const btn = $('apply'), res = $('result');
  btn.disabled = true;
  res.className = ''; res.textContent = t('p.checking');
  try {
    const r = await window.api.paste.apply(text, PART);
    res.className = r.ok ? 'ok' : 'bad';
    res.textContent = r.message;
    if (r.ok) $('text').value = ''; // don't leave the token sitting in the window
  } catch (e) {
    res.className = 'bad'; res.textContent = String(e.message || e);
  } finally { btn.disabled = false; }
});
