'use strict';
// End-to-end smoke test: the real src/main.js against a fake Electron (no GUI needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const FIX = (name) => path.join(__dirname, 'fixtures', name);

function run(env = {}) {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'smoke-runner.js')], {
    env: { ...process.env, FIXTURE: FIX('usage-schema-sample.json'), ...env },
    encoding: 'utf8', timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'], // keep the app's expected error logs out of the test output
  });
  return JSON.parse(out.slice(out.lastIndexOf('@@RESULT@@') + '@@RESULT@@'.length));
}
const usageReqs = (r) => r.reqs.filter(q => q.path === '/backend-api/wham/usage');

test('startup → sign-in cookie → session token → usage → widget, tray, settings', () => {
  const r = run();
  assert.equal(r.state.status, 'ok');
  assert.deepEqual(r.state.windows.filter(w => w.primary).map(w => [w.key, w.pct]), [['five_hour', 42], ['seven_day', 17]]);
  assert.equal(r.state.plan, 'Plus');
  assert.equal(r.signIn, 'cookie');
  // bearer token from /api/auth/session, workspace header from the session's account
  const u = usageReqs(r)[0];
  assert.equal(u.auth, 'bearer');
  assert.equal(u.account, 'acc-1');
  assert.ok(r.reqs.findIndex(q => q.path === '/api/auth/session') < r.reqs.indexOf(r.reqs.find(q => q.path === '/backend-api/wham/usage')));
  assert.match(r.tooltip, /42%/);
  assert.match(r.tooltip, /17%/);
  if (r.platform === 'darwin') assert.match(r.trayTitle, /42%/);
  else assert.equal(r.trayImage, true);
  assert.equal(r.languages, 10);
  assert.deepEqual(r.thresholds, [50, 95]);
  assert.equal(r.loginWindows, 0);
});

test('real Plus response: 5-hour not started yet', () => {
  const r = run({ FIXTURE: FIX('usage-plus-real.json') });
  const five = r.state.windows.find(w => w.key === 'five_hour');
  assert.equal(five.idle, true);
  assert.equal(five.resetsAt, null);
  assert.equal(r.state.windows.find(w => w.key === 'seven_day').idle, false);
});

test('tray number on each platform (simulated)', () => {
  const mac = run({ SIM_PLATFORM: 'darwin' });
  assert.equal(mac.platform, 'darwin');
  assert.equal(mac.trayTitle.trim(), '42%');
  assert.equal(mac.trayImage, false);
  const win = run({ SIM_PLATFORM: 'win32' });
  assert.equal(win.trayImage, true);
  assert.equal(win.trayTitle, '');
});

test('weekly-only: tray falls back to the weekly number, notification fires', () => {
  const r = run({ FIXTURE: FIX('usage-weekly-only.json'), SIM_PLATFORM: 'darwin' });
  assert.equal(r.state.weeklyOnly, true);
  assert.deepEqual(r.state.windows.map(w => w.key), ['seven_day']);
  assert.equal(r.trayTitle.trim(), '85%');
  assert.match(r.tooltip, /-/);
  assert.equal(r.notes.length, 1); // 85% crossed the 80% threshold once
});

test('not signed in → auth state and the sign-in window opens', () => {
  const r = run({ SIGNIN: 'none' });
  assert.equal(r.state.status, 'auth');
  assert.equal(r.state.msgKey, 'err.notLoggedIn');
  assert.equal(r.loginWindows, 1);
  assert.equal(usageReqs(r).length, 0);
});

test('pasted session: stored encrypted, then used as the bearer token', () => {
  const r = run({ SIGNIN: 'none', PASTE: 'valid' });
  assert.equal(r.paste.ok, true);
  assert.equal(r.state.status, 'ok');
  assert.equal(r.signIn, 'pasted');
  const u = usageReqs(r).pop();
  assert.equal(u.auth, 'bearer');
  assert.equal(u.account, 'acc-p');
  assert.match(r.pastedStored, /^ENC:/);
  assert.doesNotMatch(r.pastedStored, /pasted@example|"token"|accessToken/); // nothing in plain text
});

test('pasted garbage is refused without touching the stored session', () => {
  const r = run({ SIGNIN: 'none', PASTE: 'hello' });
  assert.equal(r.paste.ok, false);
  assert.equal(r.pastedStored, null);
});

test('Codex CLI credentials: bearer from auth.json, no cookies', () => {
  const r = run({ SIGNIN: 'none', CLI_AUTH: 'valid', PRECONFIG: JSON.stringify({ source: 'cli' }) });
  assert.equal(r.state.status, 'ok');
  const u = usageReqs(r)[0];
  assert.equal(u.part, null); // net.fetch, not a browser session
  assert.equal(u.account, 'acc-cli');
  assert.match(u.ua, /^codexage\//);
  assert.equal(r.state.plan, 'Plus'); // plan_type from the response wins over the token claim
});

test('Codex CLI problems become sign-in messages', () => {
  const cfg = JSON.stringify({ source: 'cli' });
  assert.equal(run({ SIGNIN: 'none', PRECONFIG: cfg }).state.msgKey, 'err.cliNoCreds');
  assert.equal(run({ SIGNIN: 'none', CLI_AUTH: 'expired', PRECONFIG: cfg }).state.msgKey, 'err.cliExpired');
  assert.equal(run({ SIGNIN: 'none', CLI_AUTH: 'apikey', PRECONFIG: cfg }).state.msgKey, 'err.cliApiKey');
});

test('workspace picked in settings overrides the account header', () => {
  const r = run({ PRECONFIG: JSON.stringify({ workspaceId: 'ws-9' }), WORKSPACES: '1' });
  assert.equal(usageReqs(r)[0].account, 'ws-9');
  assert.deepEqual(r.workspaces.map(w => [w.id, w.name, w.plan]), [['acc-1', 'Personal', 'Plus'], ['ws-9', 'Acme', 'Team']]);
});

test('offline → offline message with a scheduled retry', () => {
  const r = run({ OFFLINE: '1' });
  assert.equal(r.state.status, 'error');
  assert.equal(r.state.msgKey, 'err.offline');
  assert.ok(r.state.retryAt);
});

test('network failure → network error, retry, not reportable', () => {
  const r = run({ NETFAIL: '1' });
  assert.equal(r.state.msgKey, 'err.network');
  assert.ok(r.state.retryAt);
  assert.equal(r.state.reportable, false);
});

test('server error → http error with retry', () => {
  const r = run({ USAGE_STATUS: '503' });
  assert.equal(r.state.status, 'error');
  assert.equal(r.state.msgKey, 'err.http');
  assert.equal(r.state.msgVars.status, 503);
  assert.equal(r.state.reportable, false);
});

test('extra accounts are fetched alongside the main one', () => {
  const r = run({ PRECONFIG: JSON.stringify({ accounts: [{ partition: 'persist:chatgpt-acct-x', email: '' }] }) });
  assert.deepEqual(r.state.others.map(o => [o.email, o.status]), [['work@example.com', 'ok']]);
  assert.equal(r.state.email, 'me@example.com');
  assert.equal(usageReqs(r).find(q => q.part === 'persist:chatgpt-acct-x').account, 'acc-2');
});
