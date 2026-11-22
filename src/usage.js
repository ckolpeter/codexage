'use strict';
/**
 * Pure functions that turn the ChatGPT backend `GET /backend-api/wham/usage` response
 * into what the widget shows. No Electron imports, so they can be unit-tested with plain Node.
 *
 * Response shape (from the open-source Codex client, codex-backend-openapi-models):
 *   plan_type: "free" | "go" | "plus" | "pro" | "prolite" | "team" | ...
 *   rate_limit: { allowed, limit_reached, primary_window, secondary_window }   (may be null)
 *     window: { used_percent, limit_window_seconds, reset_after_seconds, reset_at (unix s) }
 *   additional_rate_limits: [{ limit_name, metered_feature, rate_limit: {...same} }]
 *   credits: { has_credits, unlimited, balance }
 *   rate_limit_reached_type: { type: "rate_limit_reached" | "workspace_member_credits_depleted" | ... }
 *
 * "primary" is NOT always the 5-hour window: Codex itself labels windows by their length,
 * and OpenAI has at times run with only a weekly window. So we classify by limit_window_seconds.
 */

const HOUR = 3600e3, DAY = 24 * HOUR;
const pctOf = (x) => { const u = Number(x); return Number.isFinite(u) ? Math.max(0, Math.min(100, u)) : 0; };
const pretty = (s) => String(s).replace(/[_-]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const PLAN_NAMES = {
  free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Edu', education: 'Edu', guest: 'Guest',
};
/** "prolite" → "Pro Lite", unknown values are prettified */
function planName(p) {
  if (!p) return '';
  const k = String(p).toLowerCase();
  return PLAN_NAMES[k] || pretty(k);
}

/**
 * What a window of this length is.
 *   ~5 h   → five_hour (session)
 *   ~7 d   → seven_day (weekly)
 *   other  → its own key, labelled by its length
 */
function classify(seconds, fallback) {
  const s = Number(seconds);
  if (Number.isFinite(s) && s > 0) {
    if (Math.abs(s - 5 * 3600) <= 1800) return { key: 'five_hour', kind: 'session' };
    if (Math.abs(s - 7 * 86400) <= 86400) return { key: 'seven_day', kind: 'weekly' };
    return { key: `win:${Math.round(s)}`, kind: 'other' };
  }
  // No length given: fall back to position (primary = 5-hour, secondary = weekly)
  return fallback === 'secondary' ? { key: 'seven_day', kind: 'weekly' } : { key: 'five_hour', kind: 'session' };
}

/** Human length for odd windows: 1 h, 90 min, 30 d … as i18n vars */
function durationVars(seconds) {
  const s = Number(seconds) || 0;
  if (s >= 86400 && s % 86400 === 0) return { labelKey: 'label.days', labelVars: { n: s / 86400 } };
  if (s >= 3600 && s % 3600 === 0) return { labelKey: 'label.hours', labelVars: { n: s / 3600 } };
  return { labelKey: 'label.minutes', labelVars: { n: Math.round(s / 60) } };
}

/** Reset time as ISO string: prefer the absolute reset_at, else now + reset_after_seconds */
function resetOf(w, now) {
  const at = Number(w.reset_at);
  if (Number.isFinite(at) && at > 0) return new Date(at * 1000).toISOString();
  const after = Number(w.reset_after_seconds);
  if (Number.isFinite(after) && after > 0) return new Date(now + after * 1000).toISOString();
  return null;
}

function isWindow(w) { return isObj(w) && ('used_percent' in w || 'limit_window_seconds' in w); }

/**
 * Windows inside one rate_limit object (primary_window / secondary_window).
 * Main limits: { primary: true }. Extra limits: { prefix, labelKey, labelVars } for the row name.
 */
function windowsOf(rl, now, { primary, prefix = '', labelKey = 'label.named', labelVars } = {}) {
  const out = [];
  if (!isObj(rl)) return out;
  for (const slot of ['primary', 'secondary']) {
    const w = rl[`${slot}_window`];
    if (!isWindow(w)) continue;
    const secs = Number(w.limit_window_seconds) || null;
    const c = classify(secs, slot);
    const pct = pctOf(w.used_percent);
    const after = Number(w.reset_after_seconds);
    // Unused window that hasn't started its clock yet: the server reports reset = now + full length
    // on every call, so a countdown would be meaningless. The clock starts with the first use.
    const idle = pct === 0 && !!secs && Number.isFinite(after) && after >= secs - 60;
    const base = {
      pct,
      idle,
      resetsAt: idle ? null : resetOf(w, now),
      durationMs: secs ? secs * 1000 : (c.key === 'five_hour' ? 5 * HOUR : c.key === 'seven_day' ? 7 * DAY : null),
      windowSeconds: secs,
      limitReached: !!rl.limit_reached || rl.allowed === false,
    };
    if (primary) {
      out.push({
        ...base, key: c.key, kind: c.kind, primary: c.kind !== 'other',
        ...(c.kind === 'other' ? durationVars(secs) : { labelKey: `label.${c.key}` }),
      });
    } else {
      // Extra limits (e.g. code review, a separate model or feature): "<name> · 5-hour"
      const span = c.kind === 'other' ? durationVars(secs) : { labelKey: `label.${c.key}` };
      out.push({
        ...base, key: `${prefix}:${c.key}`, kind: 'extra', primary: false,
        labelKey, labelVars, spanKey: span.labelKey, spanVars: span.labelVars,
      });
    }
  }
  // Two windows of the same class (should not happen): keep keys unique
  const seen = new Map();
  for (const w of out) {
    const n = seen.get(w.key) || 0;
    seen.set(w.key, n + 1);
    if (n) w.key = `${w.key}#${n + 1}`;
  }
  return out;
}

/** Does this usage response contain at least one usage window? */
function hasUsage(raw) {
  if (!isObj(raw)) return false;
  const any = (rl) => isObj(rl) && (isWindow(rl.primary_window) || isWindow(rl.secondary_window));
  if (any(raw.rate_limit) || any(raw.code_review_rate_limit)) return true;
  return Array.isArray(raw.additional_rate_limits) && raw.additional_rate_limits.some(a => any(a?.rate_limit));
}

const KIND_ORDER = { session: 0, weekly: 1, other: 2, extra: 3, spend: 4 };

/**
 * Usage-limit resets the user can spend (Codex CLI: /usage). Each one resets the weekly and
 * 5-hour limits together. Only `available_count` is used by the Codex client; the meaning of
 * `applicable_available_count` isn't documented, so it's kept but not shown.
 */
function resetsOf(raw) {
  const r = raw?.rate_limit_reset_credits;
  if (!isObj(r)) return null;
  const n = Number(r.available_count);
  if (!Number.isFinite(n) || n <= 0) return null;
  const a = Number(r.applicable_available_count);
  return { available: Math.floor(n), applicable: Number.isFinite(a) ? Math.floor(a) : null };
}

/** Unix seconds / ms / ISO string → ISO string, or null */
function isoOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "gpt-6-astra" → "GPT-6 Astra", "gpt-5.1-codex-max" → "GPT-5.1 Codex Max" */
function prettyModel(slug) {
  const parts = String(slug || '').split('-').filter(Boolean);
  if (!parts.length) return '';
  if (/^gpt$/i.test(parts[0]) && parts[1] && /^[\d.]+[a-z]?$/i.test(parts[1])) {
    return [`GPT-${parts[1]}`, ...parts.slice(2).map(p => p[0].toUpperCase() + p.slice(1))].join(' ');
  }
  return parts.map(p => p[0].toUpperCase() + p.slice(1)).join(' ');
}

/** Models the server says can't be used right now (model_usage[slug].available === false) */
function modelsUnavailableOf(raw) {
  const mu = raw?.model_usage;
  if (!isObj(mu)) return [];
  return Object.entries(mu)
    .filter(([, v]) => isObj(v) && v.available === false)
    .map(([slug, v]) => ({ slug, name: prettyModel(slug), availableAt: isoOf(v.available_at) }));
}

/**
 * Business / Enterprise per-person monthly credit limit (spend_control.individual_limit),
 * shown by Codex as "Monthly credit limit · X of Y credits used". Returned as a window-like row.
 */
function spendLimitOf(raw, now) {
  const il = raw?.spend_control?.individual_limit;
  if (!isObj(il)) return null;
  const used = Number(il.used), limit = Number(il.limit);
  const pct = Number.isFinite(Number(il.remaining_percent)) ? 100 - Number(il.remaining_percent) : Number(il.used_percent);
  return {
    key: 'spend', kind: 'spend', primary: false,
    labelKey: 'label.spendLimit',
    pct: pctOf(pct),
    resetsAt: resetOf(il, now),
    durationMs: null,
    detailKey: Number.isFinite(used) && Number.isFinite(limit) ? 'w.spendDetail' : null,
    detailVars: { used: Number.isFinite(used) ? used : 0, limit: Number.isFinite(limit) ? limit : 0 },
    limitReached: !!raw.spend_control.reached,
  };
}

/**
 * Why usage is blocked, if it is: the server's rate_limit_reached_type, else the plain
 * limit_reached / allowed flags, else the spend-control flag. null when nothing is blocked.
 */
const BLOCK_TYPES = new Set(['rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
  'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached']);
function blockedOf(raw) {
  const t = raw?.rate_limit_reached_type?.type;
  if (t) return BLOCK_TYPES.has(t) ? t : 'rate_limit_reached';
  const rl = raw?.rate_limit;
  if (isObj(rl) && (rl.limit_reached === true || rl.allowed === false)) return 'rate_limit_reached';
  if (raw?.spend_control?.reached === true) return 'spend';
  return null;
}

/**
 * GET /backend-api/wham/rate-limit-reset-credits → { available, nextExpiry, expiries }.
 * credits: [{ id, reset_type, status: 'available'|…, granted_at, expires_at (RFC 3339) }].
 */
function parseResetCredits(raw) {
  if (!isObj(raw)) return null;
  const list = Array.isArray(raw.credits) ? raw.credits : [];
  const expiries = list
    .filter(c => isObj(c) && (c.status == null || String(c.status).toLowerCase() === 'available'))
    .map(c => isoOf(c.expires_at))
    .filter(Boolean)
    .sort();
  const n = Number(raw.available_count);
  return { available: Number.isFinite(n) ? n : expiries.length, nextExpiry: expiries[0] || null, expiries };
}

function creditsOf(raw) {
  const c = raw?.credits;
  if (!isObj(c)) return null;
  if (!c.has_credits && !c.unlimited) return null;
  const n = c.balance == null ? null : Number(c.balance);
  return { unlimited: !!c.unlimited, balance: Number.isFinite(n) ? n : null };
}

/**
 * @param {{raw, plan?, email?, accountName?}} data
 * @returns state for the widget: { status:'ok', windows, credits, plan, ... }
 */
function normalize({ raw, plan, email, accountName } = {}, source = 'web', now = Date.now()) {
  const windows = windowsOf(raw?.rate_limit, now, { primary: true });
  // Code review has its own limit (null when not applicable)
  windows.push(...windowsOf(raw?.code_review_rate_limit, now, { primary: false, prefix: 'code_review', labelKey: 'label.codeReview' }));
  if (Array.isArray(raw?.additional_rate_limits)) {
    raw.additional_rate_limits.forEach((a, i) => {
      if (!isObj(a)) return;
      const id = String(a.limit_name || a.metered_feature || `extra_${i}`);
      windows.push(...windowsOf(a.rate_limit, now, { primary: false, prefix: `extra:${id}`, labelVars: { name: pretty(id) } }));
    });
  }
  const spend = spendLimitOf(raw, now);
  if (spend) windows.push(spend);
  windows.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));

  const reached = raw?.rate_limit_reached_type;
  return {
    status: 'ok',
    windows,
    weeklyOnly: windows.some(w => w.key === 'seven_day') && !windows.some(w => w.key === 'five_hour'),
    credits: creditsOf(raw),
    resets: resetsOf(raw),
    reachedType: isObj(reached) && reached.type ? String(reached.type) : null,
    blocked: blockedOf(raw),
    modelsUnavailable: modelsUnavailableOf(raw),
    plan: planName(raw?.plan_type) || plan || '',
    email: email || '',
    accountName: accountName || '',
    source,
    fetchedAt: now,
  };
}

// ---------------------------------------------------------------- run-out prediction
/**
 * For each primary window, estimate when it runs out at the current pace.
 * Pace = the last hour of local history if available, otherwise the average since the window began.
 * Adds w.eta = { at, beforeReset, basis } or { exhausted: true }.
 */
function addEta(state, history = null, now = Date.now()) {
  for (const w of state.windows) {
    if (!w.primary) continue;
    if (w.pct >= 100) { w.eta = { exhausted: true }; continue; }
    if (!w.resetsAt || w.pct <= 0) continue;
    const reset = new Date(w.resetsAt).getTime();
    if (!Number.isFinite(reset) || reset <= now) continue;
    let rate = history?.recentRate?.(w.key === 'five_hour' ? 'f' : 'w', w.resetsAt, now) ?? null;
    let basis = 'recent';
    if (rate == null && w.durationMs) {
      const elapsed = w.durationMs - (reset - now);
      if (elapsed > 10 * 60e3) { rate = w.pct / elapsed; basis = 'average'; }
    }
    if (rate == null) continue;
    if (rate <= 0) { w.eta = { at: null, beforeReset: false, basis }; continue; }
    const at = now + (100 - w.pct) / rate;
    w.eta = { at, beforeReset: at < reset, basis };
  }
}

// ---------------------------------------------------------------- tokens
/** Decode a JWT payload without verifying it (we only read claims we were handed ourselves) */
function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

/** Expiry of a JWT access token in ms, or null if it has none / isn't a JWT */
function tokenExpiry(token) {
  const p = jwtPayload(token);
  return p && Number.isFinite(p.exp) ? p.exp * 1000 : null;
}

const DAY_MS = 24 * 3600e3;
/**
 * Should we remind the user that a (pasted) sign-in is about to expire?
 * Lead time: 2 days, or a quarter of the token's lifetime if that's shorter (so a short-lived
 * token doesn't nag right after pasting). Without an issue time, 1 day.
 * Returns { expiresAt, remind } or null when the token has no expiry.
 */
function expiryReminder(token, now = Date.now()) {
  const p = jwtPayload(token);
  if (!p || !Number.isFinite(p.exp)) return null;
  const exp = p.exp * 1000;
  const lifetime = Number.isFinite(p.iat) ? exp - p.iat * 1000 : null;
  const lead = lifetime && lifetime > 0 ? Math.min(2 * DAY_MS, lifetime / 4) : DAY_MS;
  return { expiresAt: exp, remind: exp > now && exp - now <= lead };
}

/**
 * Codex CLI auth.json → what we need. Throws a string code on problems:
 *   'badFormat' | 'apiKeyOnly' | 'noTokens'
 */
function parseCodexAuth(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw 'badFormat'; }
  if (!isObj(j)) throw 'badFormat';
  const tk = j.tokens;
  if (!isObj(tk) || !tk.access_token) {
    if (j.OPENAI_API_KEY) throw 'apiKeyOnly';
    throw 'noTokens';
  }
  // id_token is stored either as the raw JWT string or as { raw_jwt, email, ... }
  const idRaw = typeof tk.id_token === 'string' ? tk.id_token : tk.id_token?.raw_jwt;
  const claims = jwtPayload(idRaw) || {};
  const authClaims = claims['https://api.openai.com/auth'] || {};
  const profile = claims['https://api.openai.com/profile'] || {};
  return {
    token: tk.access_token,
    accountId: tk.account_id || authClaims.chatgpt_account_id || tk.id_token?.chatgpt_account_id || null,
    email: claims.email || profile.email || tk.id_token?.email || '',
    plan: planName(authClaims.chatgpt_plan_type || tk.id_token?.chatgpt_plan_type),
    expiresAt: tokenExpiry(tk.access_token),
  };
}

/**
 * What the user pasted as a sign-in fallback (when the in-app sign-in is blocked, e.g. Google):
 *   - the whole JSON page from https://chatgpt.com/api/auth/session, or
 *   - just the access token (eyJ…), optionally prefixed with "Bearer ".
 * Returns { token, expiresAt, accountId, email, plan }. Throws 'badPaste' | 'expired'.
 */
function parsePastedSession(text, now = Date.now()) {
  let s = String(text || '').trim().replace(/^bearer\s+/i, '');
  // Ctrl+A on Chrome's JSON viewer also copies its "Pretty-print" label: keep only the {...} part
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a > 0 && b > a) s = s.slice(a, b + 1);
  let token = null, json = null;
  if (s.startsWith('{')) {
    try { json = JSON.parse(s); } catch { throw 'badPaste'; }
    token = json?.accessToken || json?.access_token || null;
  } else if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s)) {
    token = s;
  }
  if (!token || !jwtPayload(token)) throw 'badPaste';
  const claims = jwtPayload(token);
  const authClaims = claims['https://api.openai.com/auth'] || {};
  const profile = claims['https://api.openai.com/profile'] || {};
  const expiresAt = tokenExpiry(token);
  if (expiresAt && expiresAt <= now) throw 'expired';
  return {
    token,
    expiresAt,
    accountId: json?.account?.id || authClaims.chatgpt_account_id || null,
    email: json?.user?.email || profile.email || '',
    plan: planName(json?.account?.planType || authClaims.chatgpt_plan_type),
  };
}

/**
 * GET /backend-api/wham/accounts/check → workspaces the user can pick.
 * `accounts` is either a list of { id, name, plan_type, is_deactivated } or a map keyed by id of
 * { account: { account_id, name, plan_type, is_deactivated } } ordered by `account_ordering`.
 */
function parseAccountsCheck(raw) {
  if (!isObj(raw)) return [];
  let list = [];
  if (Array.isArray(raw.accounts)) {
    list = raw.accounts.map(a => ({ id: a?.id, name: a?.name, plan: a?.plan_type, off: a?.is_deactivated, structure: a?.structure }));
  } else if (isObj(raw.accounts)) {
    const order = Array.isArray(raw.account_ordering) && raw.account_ordering.length
      ? raw.account_ordering : Object.keys(raw.accounts);
    list = order.map(id => raw.accounts[id]).filter(isObj).map(e => {
      const a = e.account || {};
      return { id: a.account_id, name: a.name, plan: a.plan_type, off: a.is_deactivated, structure: a.structure };
    });
  }
  return list
    .filter(a => a.id && !a.off)
    .map(a => ({
      id: String(a.id),
      name: a.name ? String(a.name) : (a.structure === 'personal' ? 'Personal' : ''),
      plan: planName(a.plan),
      isDefault: a.id === raw.default_account_id,
    }));
}

// ---------------------------------------------------------------- debug redaction
const SECRET_KEY = /token|secret|password|cookie|authorization|session_?key|api_?key|jwt/i;
/** Deep copy with secrets removed and emails / ids masked, for files in ./debug */
function redact(v, key = '') {
  if (Array.isArray(v)) return v.map(x => redact(x, key));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  if (typeof v !== 'string') return v;
  if (SECRET_KEY.test(key)) return `[redacted ${v.length} chars]`;
  if (/^eyJ[\w-]+\.[\w-]+\./.test(v)) return `[redacted jwt ${v.length} chars]`;
  if (/@/.test(v) && /email/i.test(key || 'email')) return v.replace(/^(.).*(@.*)$/, '$1***$2');
  if (/(^|_)id$|^id$/i.test(key) && v.length > 8) return `${v.slice(0, 4)}…(${v.length})`;
  return v;
}

module.exports = {
  normalize, addEta, hasUsage, classify, planName, pctOf,
  jwtPayload, tokenExpiry, expiryReminder, resetsOf, parseResetCredits, blockedOf, spendLimitOf,
  modelsUnavailableOf, prettyModel, isoOf, parseCodexAuth, parsePastedSession, parseAccountsCheck, redact,
};
