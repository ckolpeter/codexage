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
  assert.equal(csv[0], 'time_local,time_utc,five_hour_pct,five_hour_resets_at,weekly_pct,weekly_resets_at,account');
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

test('history: kept per account', () => {
  const { History } = require('../src/history');
  const h = new History(path.join(os.tmpdir(), `codexage-hist3-${process.pid}.json`)); h.clear();
  const now = Date.now();
  const st = (f) => ({ windows: [{ key: 'five_hour', pct: f, resetsAt: 'R1' }] });
  h.add(st(5), now - 30 * 60e3);               // from before history was per account
  h.claimUnlabeled('me@example.com');           // → belongs to the main account
  h.add(st(10), now - 20 * 60e3, 'me@example.com');
  h.add(st(70), now - 20 * 60e3 + 1000, 'work@example.com'); // another account: not merged with the main sample
  h.add(st(20), now, 'me@example.com');
  h.add(st(90), now + 1000, 'work@example.com');
  assert.deepEqual(h.series('f', now - 3600e3, 'me@example.com').map(p => p.v), [5, 10, 20]);
  assert.deepEqual(h.series('f', now - 3600e3, 'work@example.com').map(p => p.v), [70, 90]);
  assert.deepEqual(h.series('f', now - 3600e3), []);
  assert.deepEqual(h.accounts().map(a => a.key), ['work@example.com', 'me@example.com']);
  // pace uses only that account's samples: main +10% / 20 min, work +20% / 20 min
  const perMin = (acct) => h.recentRate('f', 'R1', now + 1000, acct) * 60e3;
  assert.ok(Math.abs(perMin('me@example.com') - 0.5) < 0.01);
  assert.ok(Math.abs(perMin('work@example.com') - 1) < 0.01);
  const csv = h.toCSV().trim().split('\r\n');
  assert.equal(csv.length, 6);
  assert.match(csv[1], /,me@example\.com$/);
  assert.match(csv[2], /,me@example\.com$/);
  assert.match(csv[3], /,work@example\.com$/);
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
