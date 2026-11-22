'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('history: samples, CSV export, pruning', () => {
  const { History } = require('../src/history');
  const file = path.join(os.tmpdir(), `codexage-hist-${process.pid}.json`);
  const h = new History(file); h.clear();
  const now = Date.now();
  const st = (f, w) => ({ windows: [{ key: 'five_hour', pct: f, resetsAt: 'R1' }, { key: 'seven_day', pct: w, resetsAt: 'W1' }] });
  h.add(st(10, 5), now - 9 * 24 * 3600e3); // older than 8 days → pruned
  h.add(st(12, 6), now - 120e3);
  h.add(st(13, 6), now - 100e3);           // within 50s of the last → replaces it
  h.add(st(15, 7), now);
  assert.equal(h.samples.length, 2);
  assert.deepEqual(h.series('f', now - 3600e3).map(p => p.v), [13, 15]);
  const csv = h.toCSV().trim().split('\r\n');
  assert.equal(csv[0], 'time_local,time_utc,five_hour_pct,five_hour_resets_at,weekly_pct,weekly_resets_at');
  assert.equal(csv.length, 3);
});

test('history: weekly-only states are recorded too', () => {
  const { History } = require('../src/history');
  const h = new History(path.join(os.tmpdir(), `codexage-hist2-${process.pid}.json`)); h.clear();
  h.add({ windows: [{ key: 'seven_day', pct: 30, resetsAt: 'W1' }] }, Date.now());
  assert.equal(h.samples.length, 1);
  assert.equal(h.samples[0].f, null);
  assert.equal(h.samples[0].w, 30);
});

test('version comparison', () => {
  const { newer } = require('../src/version');
  assert.equal(newer('v0.2.0', '0.1.0'), true);
  assert.equal(newer('0.1.0', '0.1.0'), false);
  assert.equal(newer('0.1.9', '0.2.0'), false);
  assert.equal(newer('1.0.0', '0.99.99'), true);
});

const LOCALE_DIR = path.join(__dirname, '..', 'src', 'locales');
const en = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, 'en.json'), 'utf8'));

test('locales: 10 languages with the same keys and placeholders as English', () => {
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  const files = fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith('.json'));
  assert.deepEqual(files.map(f => f.replace('.json', '')).sort(),
    ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN', 'zh-TW']);
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf8'));
    assert.deepEqual(Object.keys(d).sort(), Object.keys(en).sort(), `${f}: keys differ from en.json`);
    for (const k of Object.keys(en)) assert.equal(ph(d[k]), ph(en[k]), `${f} ${k}: placeholders differ`);
  }
});

test('every i18n key used in src/ exists in en.json', () => {
  const src = fs.readdirSync(path.join(__dirname, '..', 'src'))
    .filter(f => /\.(js|html)$/.test(f))
    .map(f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  const used = new Set([...src.matchAll(/['"`]((?:err|label|s|w|p|h|a|menu|notify|tray|win|msg)\.[a-zA-Z][a-zA-Z._]*)['"`]/g)]
    .map(m => m[1]).filter(k => !/\.(png|js|html|json)$/.test(k)));
  // keys built at runtime from window keys and blocked reasons
  for (const k of ['label.five_hour', 'label.seven_day']) used.add(k);
  for (const b of ['rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
    'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached', 'spend']) used.add(`w.blocked.${b}`);
  const missing = [...used].filter(k => !(k in en));
  assert.deepEqual(missing, []);
});
