'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize, addEta, hasUsage, classify, planName, parseCodexAuth, parsePastedSession, tokenExpiry, redact,
} = require('../src/usage');

const H = 3600e3, D = 24 * H;
const NOW = Date.parse('2026-11-22T12:00:00Z');
const S = NOW / 1000;
const byKey = (st, k) => st.windows.find(w => w.key === k);

// Shape follows the Codex client's RateLimitStatusPayload. Replace with a real (redacted) response once captured.
const sample = require('./fixtures/usage-schema-sample.json');

test('5-hour and weekly windows are classified by length, not by slot', () => {
  const st = normalize({ raw: sample }, 'web', NOW);
  assert.equal(st.status, 'ok');
  assert.equal(st.plan, 'Plus');
  const five = byKey(st, 'five_hour'), week = byKey(st, 'seven_day');
  assert.equal(five.pct, 42);
  assert.equal(week.pct, 17);
  assert.equal(five.durationMs, 5 * H);
  assert.equal(week.durationMs, 7 * D);
  assert.ok(five.primary && week.primary);
  assert.equal(st.weeklyOnly, false);
  assert.equal(five.resetsAt, new Date(sample.rate_limit.primary_window.reset_at * 1000).toISOString());
});

// Real Plus response captured on 2026-11-22 (ids and email replaced)
const real = require('./fixtures/usage-plus-real.json');

test('real Plus response: 5-hour not started yet, weekly running', () => {
  const now = Date.parse('2026-11-22T08:24:25Z');
  const st = normalize({ raw: real }, 'web', now);
  assert.equal(st.plan, 'Plus');
  assert.deepEqual(st.windows.map(w => w.key), ['five_hour', 'seven_day']);
  const five = byKey(st, 'five_hour'), week = byKey(st, 'seven_day');
  // 0% and reset_after_seconds == full window → the clock hasn't started: no countdown
  assert.equal(five.idle, true);
  assert.equal(five.resetsAt, null);
  // weekly is also 0% but already counting down
  assert.equal(week.idle, false);
  assert.equal(week.resetsAt, new Date(real.rate_limit.secondary_window.reset_at * 1000).toISOString());
  assert.equal(st.weeklyOnly, false);
  // has_credits false → no credits row; code review limit null → no row
  assert.equal(st.credits, null);
  assert.equal(st.windows.some(w => w.key.startsWith('code_review')), false);
  assert.equal(hasUsage(real), true);
});

test('usage-limit resets: available count from the real response, hidden when none', () => {
  const { resetsOf } = require('../src/usage');
  const st = normalize({ raw: real }, 'web', NOW);
  assert.deepEqual(st.resets, { available: 3, applicable: 0 });
  assert.equal(resetsOf({ rate_limit_reset_credits: { available_count: 0 } }), null);
  assert.equal(resetsOf({ rate_limit_reset_credits: null }), null);
  assert.equal(resetsOf({}), null);
  assert.deepEqual(resetsOf({ rate_limit_reset_credits: { available_count: 2 } }), { available: 2, applicable: null });
});

test('real response: not blocked, every model available', () => {
  const st = normalize({ raw: real }, 'web', NOW);
  assert.equal(st.blocked, null);
  assert.deepEqual(st.modelsUnavailable, []);
  assert.equal(st.windows.some(w => w.kind === 'spend'), false); // individual_limit is null
});

test('blocked reason: reached type, plain flags, spend control', () => {
  const { blockedOf } = require('../src/usage');
  assert.equal(blockedOf({ rate_limit_reached_type: { type: 'workspace_member_credits_depleted' } }), 'workspace_member_credits_depleted');
  assert.equal(blockedOf({ rate_limit_reached_type: { type: 'something_new' } }), 'rate_limit_reached');
  assert.equal(blockedOf({ rate_limit: { allowed: false, limit_reached: true } }), 'rate_limit_reached');
  assert.equal(blockedOf({ rate_limit: { allowed: true, limit_reached: false }, spend_control: { reached: true } }), 'spend');
  assert.equal(blockedOf({ rate_limit: { allowed: true, limit_reached: false }, rate_limit_reached_type: null }), null);
});

test('monthly credit limit (Business) becomes a row with "X of Y credits used"', () => {
  const raw = {
    ...real,
    spend_control: {
      reached: false,
      individual_limit: { limit: '25000', used: '8000', remaining: '17000', used_percent: 32, remaining_percent: 68, reset_after_seconds: 3600, reset_at: S + 3600 },
    },
  };
  const st = normalize({ raw }, 'web', NOW);
  const sp = st.windows.find(w => w.kind === 'spend');
  assert.equal(sp.pct, 32);
  assert.equal(sp.labelKey, 'label.spendLimit');
  assert.deepEqual(sp.detailVars, { used: 8000, limit: 25000 });
  assert.equal(sp.resetsAt, new Date((S + 3600) * 1000).toISOString());
  assert.equal(st.windows[st.windows.length - 1].kind, 'spend'); // listed last
  assert.equal(sp.primary, false); // never drives the tray or notifications
});

test('unavailable models and model names', () => {
  const { prettyModel } = require('../src/usage');
  const raw = {
    ...real,
    model_usage: {
      'gpt-6-astra': { available: true, available_at: null },
      'gpt-5.1-codex-max': { available: false, available_at: S + 600 },
      'o-mini': { available: false, available_at: '2026-11-22T13:00:00Z' },
    },
  };
  const st = normalize({ raw }, 'web', NOW);
  assert.deepEqual(st.modelsUnavailable, [
    { slug: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', availableAt: new Date((S + 600) * 1000).toISOString() },
    { slug: 'o-mini', name: 'O Mini', availableAt: '2026-11-22T13:00:00.000Z' },
  ]);
  assert.equal(prettyModel('gpt-6-astra'), 'GPT-6 Astra');
});

test('reset credit details: soonest expiry of the available ones', () => {
  const { parseResetCredits } = require('../src/usage');
  const r = parseResetCredits({
    available_count: 2,
    credits: [
      { id: 'a', reset_type: 'full', status: 'available', granted_at: '2026-11-01T00:00:00Z', expires_at: '2026-12-27T08:59:00Z' },
      { id: 'b', reset_type: 'full', status: 'used', granted_at: '2026-10-01T00:00:00Z', expires_at: '2026-11-25T00:00:00Z' },
      { id: 'c', reset_type: 'full', status: 'available', granted_at: '2026-11-02T00:00:00Z', expires_at: '2026-12-18T09:39:00+00:00' },
    ],
  });
  assert.equal(r.available, 2);
  assert.equal(r.nextExpiry, '2026-12-18T09:39:00.000Z');
  assert.equal(r.expiries.length, 2);
  assert.equal(parseResetCredits(null), null);
  assert.deepEqual(parseResetCredits({ available_count: 1, credits: null }), { available: 1, nextExpiry: null, expiries: [] });
});

test('code review limit becomes a secondary row', () => {
  const raw = {
    ...real,
    code_review_rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 1000, reset_at: S + 1000 },
      secondary_window: null,
    },
  };
  const st = normalize({ raw }, 'web', NOW);
  const cr = byKey(st, 'code_review:seven_day');
  assert.equal(cr.labelKey, 'label.codeReview');
  assert.equal(cr.spanKey, 'label.seven_day');
  assert.equal(cr.primary, false);
  assert.equal(cr.pct, 12);
});

test('weekly-only: a weekly window in the primary slot is still weekly', () => {
  const raw = {
    plan_type: 'pro',
    rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 30, limit_window_seconds: 604800, reset_after_seconds: 3 * 86400, reset_at: S + 3 * 86400 },
      secondary_window: null,
    },
  };
  const st = normalize({ raw }, 'web', NOW);
  assert.equal(st.windows.length, 1);
  assert.equal(st.windows[0].key, 'seven_day');
  assert.equal(st.weeklyOnly, true);
  assert.equal(byKey(st, 'five_hour'), undefined);
});

test('odd window lengths get their own key and a length label', () => {
  const raw = { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 3600, reset_at: S + 600 } } };
  const st = normalize({ raw }, 'web', NOW);
  assert.equal(st.windows[0].key, 'win:3600');
  assert.equal(st.windows[0].labelKey, 'label.hours');
  assert.deepEqual(st.windows[0].labelVars, { n: 1 });
  assert.equal(st.windows[0].primary, false);
});

test('missing window length falls back to slot position', () => {
  assert.equal(classify(null, 'primary').key, 'five_hour');
  assert.equal(classify(undefined, 'secondary').key, 'seven_day');
  assert.equal(classify(18000).key, 'five_hour');
  assert.equal(classify(604800).key, 'seven_day');
});

test('additional rate limits become secondary rows', () => {
  const st = normalize({ raw: sample }, 'web', NOW);
  const extra = st.windows.filter(w => w.kind === 'extra');
  assert.equal(extra.length, 1);
  assert.equal(extra[0].labelVars.name, 'Codex Other');
  assert.equal(extra[0].primary, false);
  // primary windows come first
  assert.equal(st.windows[st.windows.length - 1].kind, 'extra');
});

test('reset time falls back to reset_after_seconds', () => {
  const raw = { rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 600 } } };
  const st = normalize({ raw }, 'web', NOW);
  assert.equal(st.windows[0].resetsAt, new Date(NOW + 600e3).toISOString());
});

test('hasUsage / empty responses', () => {
  assert.equal(hasUsage(sample), true);
  assert.equal(hasUsage({ plan_type: 'free', rate_limit: null }), false);
  assert.equal(hasUsage(null), false);
  assert.equal(normalize({ raw: { rate_limit: null } }, 'web', NOW).windows.length, 0);
});

test('credits and plan names', () => {
  const st = normalize({ raw: sample }, 'web', NOW);
  assert.deepEqual(st.credits, { unlimited: false, balance: 9.99 });
  assert.equal(planName('prolite'), 'Pro Lite');
  assert.equal(planName('enterprise_cbp_usage_based'), 'Enterprise Cbp Usage Based');
  assert.equal(planName(''), '');
});

test('limit reached flag is carried to windows', () => {
  const raw = { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: S + 60 } } };
  const st = normalize({ raw }, 'web', NOW);
  assert.equal(st.windows[0].limitReached, true);
  addEta(st, null, NOW);
  assert.deepEqual(st.windows[0].eta, { exhausted: true });
});

test('ETA from average pace', () => {
  // 5-hour window, 2.5 h elapsed, 60% used → runs out after another ~1.67 h, before reset
  const raw = { rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 18000, reset_at: S + 2.5 * 3600 } } };
  const st = normalize({ raw }, 'web', NOW);
  addEta(st, null, NOW);
  const e = st.windows[0].eta;
  assert.equal(e.basis, 'average');
  assert.equal(e.beforeReset, true);
  assert.ok(Math.abs(e.at - (NOW + (40 / 60) * 2.5 * H)) < 1000);
});

// ---------------------------------------------------------------- Codex CLI auth.json
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `eyJhbGciOiJub25lIn0.${b64(payload)}.sig`;

test('parseCodexAuth reads tokens and id_token claims', () => {
  const exp = Math.floor(NOW / 1000) + 3600;
  const auth = {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acc-1' } }),
      access_token: jwt({ exp }),
      refresh_token: 'rt',
      account_id: 'acc-1',
    },
    last_refresh: '2026-11-20T00:00:00Z',
  };
  const r = parseCodexAuth(JSON.stringify(auth));
  assert.equal(r.accountId, 'acc-1');
  assert.equal(r.email, 'me@example.com');
  assert.equal(r.plan, 'Plus');
  assert.equal(r.expiresAt, exp * 1000);
  assert.equal(tokenExpiry('not-a-jwt'), null);
});

test('parseCodexAuth errors', () => {
  assert.throws(() => parseCodexAuth('{oops'), e => e === 'badFormat');
  assert.throws(() => parseCodexAuth({ OPENAI_API_KEY: 'sk-x', tokens: null }), e => e === 'apiKeyOnly');
  assert.throws(() => parseCodexAuth({}), e => e === 'noTokens');
});

test('parsePastedSession accepts the /api/auth/session JSON or a bare token', () => {
  const exp = Math.floor(NOW / 1000) + 86400;
  const token = jwt({
    exp,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acc-9' },
    'https://api.openai.com/profile': { email: 'p@example.com' },
  });
  const page = JSON.stringify({ user: { email: 'u@example.com' }, account: { id: 'acc-1', planType: 'plus' }, accessToken: token, expires: '2027-01-01' });
  const a = parsePastedSession(`  ${page}\n`, NOW);
  assert.equal(a.token, token);
  assert.equal(a.accountId, 'acc-1');
  assert.equal(a.email, 'u@example.com');
  assert.equal(a.plan, 'Plus');
  assert.equal(a.expiresAt, exp * 1000);
  // Chrome JSON viewer: Ctrl+A also copies the "Pretty-print" checkbox label
  assert.equal(parsePastedSession(`美化排版\n${page}`, NOW).accountId, 'acc-1');
  const b = parsePastedSession(`Bearer ${token}`, NOW);
  assert.equal(b.accountId, 'acc-9');
  assert.equal(b.email, 'p@example.com');
  assert.equal(b.plan, 'Pro');
});

test('expiryReminder: 2 days before, or a quarter of a short lifetime', () => {
  const { expiryReminder } = require('../src/usage');
  const s = Math.floor(NOW / 1000);
  // 10-day token: remind in the last 2 days
  assert.equal(expiryReminder(jwt({ iat: s - 7 * 86400, exp: s + 3 * 86400 }), NOW).remind, false);
  assert.equal(expiryReminder(jwt({ iat: s - 9 * 86400, exp: s + 86400 }), NOW).remind, true);
  // 1-day token just pasted: lead is 6 h, so no reminder yet; 5 h left → remind
  assert.equal(expiryReminder(jwt({ iat: s - 3600, exp: s + 23 * 3600 }), NOW).remind, false);
  assert.equal(expiryReminder(jwt({ iat: s - 19 * 3600, exp: s + 5 * 3600 }), NOW).remind, true);
  // no iat: 1 day lead
  assert.equal(expiryReminder(jwt({ exp: s + 12 * 3600 }), NOW).remind, true);
  assert.equal(expiryReminder(jwt({ exp: s + 30 * 3600 }), NOW).remind, false);
  // already expired / no exp / not a JWT
  assert.equal(expiryReminder(jwt({ exp: s - 10 }), NOW).remind, false);
  assert.equal(expiryReminder(jwt({}), NOW), null);
  assert.equal(expiryReminder('nope', NOW), null);
  assert.equal(expiryReminder(jwt({ exp: s + 3600 }), NOW).expiresAt, (s + 3600) * 1000);
});

test('parsePastedSession errors', () => {
  assert.throws(() => parsePastedSession('', NOW), e => e === 'badPaste');
  assert.throws(() => parsePastedSession('{}', NOW), e => e === 'badPaste');
  assert.throws(() => parsePastedSession('{"user":{}', NOW), e => e === 'badPaste');
  assert.throws(() => parsePastedSession('hello', NOW), e => e === 'badPaste');
  const old = jwt({ exp: Math.floor(NOW / 1000) - 10 });
  assert.throws(() => parsePastedSession(old, NOW), e => e === 'expired');
});

test('parseAccountsCheck: list and map shapes', () => {
  const { parseAccountsCheck } = require('../src/usage');
  const list = parseAccountsCheck({
    accounts: [
      { id: 'a1', name: null, plan_type: 'plus', structure: 'personal' },
      { id: 'a2', name: 'Acme', plan_type: 'team', structure: 'workspace' },
      { id: 'a3', name: 'Old', is_deactivated: true },
    ],
    default_account_id: 'a2',
  });
  assert.deepEqual(list, [
    { id: 'a1', name: 'Personal', plan: 'Plus', isDefault: false },
    { id: 'a2', name: 'Acme', plan: 'Team', isDefault: true },
  ]);
  const map = parseAccountsCheck({
    accounts: {
      x: { account: { account_id: 'x', name: 'X Corp', plan_type: 'business' } },
      y: { account: { account_id: 'y', plan_type: 'plus', structure: 'personal' } },
    },
    account_ordering: ['y', 'x'],
  });
  assert.deepEqual(map.map(a => [a.id, a.name, a.plan]), [['y', 'Personal', 'Plus'], ['x', 'X Corp', 'Business']]);
  assert.deepEqual(parseAccountsCheck(null), []);
});

test('account names: custom name, email, masked email', () => {
  const { maskEmail, accountName } = require('../src/usage');
  assert.equal(maskEmail('someone@example.com'), 's***@example.com');
  assert.equal(maskEmail('a@b.co'), 'a***@b.co');
  assert.equal(maskEmail('nobody'), 'n***');
  assert.equal(maskEmail(''), '');
  assert.equal(accountName('me@example.com', '  公司  '), '公司');
  assert.equal(accountName('me@example.com', ''), 'me@example.com');
  assert.equal(accountName('me@example.com', '', true), 'm***@example.com');
  assert.equal(accountName('me@example.com', 'Work', true), 'Work'); // a custom name is never masked
  assert.equal(accountName('', ''), '');
});

test('redact removes secrets before writing debug files', () => {
  const r = redact({
    accessToken: 'abc', user: { email: 'someone@example.com', id: 'user-1234567890' },
    nested: [{ sessionToken: 'x' }], expires: '2026-12-01', note: jwt({ a: 1 }),
  });
  assert.equal(r.accessToken, '[redacted 3 chars]');
  assert.equal(r.user.email, 's***@example.com');
  assert.equal(r.user.id, 'user…(15)');
  assert.equal(r.nested[0].sessionToken, '[redacted 1 chars]');
  assert.equal(r.expires, '2026-12-01');
  assert.match(r.note, /^\[redacted jwt/);
  assert.doesNotMatch(JSON.stringify(r), /someone@|abc"/);
});
