'use strict';
/**
 * Codexage — main process
 *
 * Data source: GET https://chatgpt.com/backend-api/wham/usage (Authorization: Bearer <access token>),
 * the endpoint the open-source Codex client uses for its rate-limit display. It is not a public API
 * and may change at any time.
 *
 * Where the access token comes from:
 *   web : sign in to chatgpt.com inside the app and read the token from /api/auth/session,
 *         or (when the in-app sign-in is blocked, e.g. Google) a session pasted from the user's browser
 *   cli : read the Codex CLI credentials in $CODEX_HOME/auth.json (read-only, never refreshed by us,
 *         because refresh tokens rotate and refreshing here would sign the CLI out)
 */
const {
  app, BrowserWindow, Tray, Menu, ipcMain, session, nativeImage, dialog,
  Notification, screen, powerMonitor, shell, globalShortcut, nativeTheme, net, safeStorage, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { History } = require('./history');
const { Updater } = require('./updater');
const { FullscreenWatcher } = require('./fullscreen');
const usage = require('./usage');
const { hasUsage, parseCodexAuth, parsePastedSession, parseAccountsCheck, tokenExpiry, expiryReminder, jwtPayload, redact, planName } = usage;

const IS_MAC = process.platform === 'darwin';
const PARTITION = 'persist:chatgpt';
const ACCT_PREFIX = 'persist:chatgpt-acct-';
const CHATGPT = 'https://chatgpt.com';
const USAGE_PATH = '/backend-api/wham/usage';
const ACCOUNTS_PATH = '/backend-api/wham/accounts/check';
const RESET_CREDITS_PATH = '/backend-api/wham/rate-limit-reset-credits';
const USAGE_PAGE = CHATGPT + '/codex/settings/usage';
const SESSION_PAGE = CHATGPT + '/api/auth/session';
const SESSION_COOKIE = '__Secure-next-auth.session-token'; // may be split into .0 / .1 chunks
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const CHROME_UA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

if (!app.requestSingleInstanceLock()) {
  console.log('Codexage is already running (check the system tray). Quit it from the tray menu first.');
  app.quit(); process.exit(0);
}
// Transparent windows on Linux need this switch
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');

// ---------------------------------------------------------------- config
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  source: 'web',          // 'web' | 'cli'
  language: 'auto',       // 'auto' | locale code from src/locales
  intervalSec: 120,
  opacity: 0.95,
  alwaysOnTop: true,
  compact: false,
  notify: true,
  notifyReset: true,      // notify when the 5-hour / weekly limit resets
  notifyThresholds: [80, 95], // usage % that trigger a notification (the highest one plays a sound)
  quietEnabled: false,    // no notifications during quiet hours
  quietStart: '23:00',
  quietEnd: '08:00',
  trayMetric: 'five_hour', // 'five_hour' | 'seven_day' | 'max' | 'off'  (five_hour falls back to weekly)
  trayAllAccounts: false,  // tray number = the highest among every signed-in account
  openAtLogin: false,
  autoUpdate: true,
  hotkey: 'CommandOrControl+Alt+X', // show / hide the widget ('' = off)
  clickThrough: false,    // widget ignores the mouse (toggle from the tray or Ctrl+Alt+Shift+X)
  theme: 'dark',          // 'dark' | 'light' | 'system'
  scale: 1,               // widget size 0.8 – 1.5
  hideOnFullscreen: false, // hide while another app is full screen (Windows; macOS uses full-screen Spaces)
  snapEdges: true,        // snap to screen edges when dragged close
  bounds: null,
  workspaceId: null,      // ChatGPT workspace for the main account (null = the one in use)
  accounts: [],           // extra ChatGPT accounts: [{ partition, email, label }]
  mainEmail: '',          // the main account's email (learned from the sign-in)
  mainLabel: '',          // custom name for the main account ('' = show the email)
  mainLabelEmail: '',     // the email mainLabel was given for (a different sign-in doesn't inherit it)
  maskEmail: false,       // show emails as s***@example.com (screen sharing)
};
let config = { ...DEFAULTS };
function loadConfig() {
  try { config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) }; }
  catch { config = { ...DEFAULTS }; }
  if (!['web', 'cli'].includes(config.source)) config.source = 'web';
}
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2)); } catch (e) { console.error(e); }
  }, 300);
}

// ---------------------------------------------------------------- i18n
// Every *.json in src/locales is a language. To add one, copy en.json and translate it.
const LOCALE_DIR = path.join(__dirname, 'locales');
const LOCALES = {};
for (const f of fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith('.json'))) {
  LOCALES[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, f), 'utf8'));
}
const FALLBACK = 'en';
let lang = FALLBACK;

function resolveLang(pref) {
  const codes = Object.keys(LOCALES);
  const candidates = pref && pref !== 'auto'
    ? [pref]
    : [...(app.getPreferredSystemLanguages?.() || []), app.getLocale()];
  for (const c of candidates) {
    if (!c) continue;
    const exact = codes.find(x => x.toLowerCase() === c.toLowerCase());
    if (exact) return exact;
    // zh-Hant / zh-HK / zh-MO → zh-TW; other Chinese → zh-CN
    if (/^zh[-_](hant|tw|hk|mo)/i.test(c) && LOCALES['zh-TW']) return 'zh-TW';
    if (/^zh/i.test(c) && LOCALES['zh-CN']) return 'zh-CN';
    if (/^zh/i.test(c) && LOCALES['zh-TW']) return 'zh-TW';
    if (/^pt/i.test(c) && LOCALES['pt-BR']) return 'pt-BR';
    const base = c.split(/[-_]/)[0].toLowerCase();
    const byBase = codes.find(x => x.split('-')[0].toLowerCase() === base);
    if (byBase) return byBase;
  }
  return FALLBACK;
}

function t(key, vars = {}) {
  const s = LOCALES[lang]?.[key] ?? LOCALES[FALLBACK]?.[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

function setLanguage(pref) {
  config.language = pref; saveConfig();
  lang = resolveLang(pref);
  for (const w of [widget, settingsWin, historyWin, pasteWin]) if (w && !w.isDestroyed()) w.webContents.reload();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(t('win.settings'));
  updateTray();
}

// ---------------------------------------------------------------- state
let widget = null, tray = null, settingsWin = null, historyWin = null, pasteWin = null;
const loginWins = new Map();   // partition → login window
const fetcherWins = new Map(); // partition → hidden chatgpt.com page used as a fetch fallback
const tokenCache = new Map();  // partition → { token, expiresAt, accountId, email, plan }
let pollTimer = null, resetTimer = null, retryTimer = null;
let failCount = 0;      // consecutive non-auth failures, for retry backoff
let refreshing = null;  // in-flight refresh, so overlapping triggers share one request
let history = null;
let updater = null;
let hotkeyOk = true;
let hiddenForFullscreen = false;
const fullscreen = new FullscreenWatcher((isFs) => {
  if (!widget || widget.isDestroyed()) return;
  if (isFs && widget.isVisible()) { hiddenForFullscreen = true; widget.hide(); }
  else if (!isFs && hiddenForFullscreen) { hiddenForFullscreen = false; widget.showInactive(); }
  updateTray();
});
let lastState = { status: 'loading' };
const notified = new Set();

function ses(part = PARTITION) { return session.fromPartition(part); }
function isAccountPart(part) { return part === PARTITION || (config.accounts || []).some(a => a.partition === part); }

/** Errors carry an i18n key so the UI can re-translate when the language changes */
class AppError extends Error {
  constructor(key, vars = {}) { super(key); this.key = key; this.vars = vars; }
}
class AuthError extends AppError {}

/** Network-level failures (no response at all) as opposed to HTTP errors */
function isNetworkError(e) {
  const m = String(e?.message || e || '');
  return e?.name === 'TypeError' || /fetch failed|net::ERR_|ENOTFOUND|ECONNRE|ETIMEDOUT|EAI_AGAIN|network/i.test(m);
}

// ---------------------------------------------------------------- debug
// When running from source (npm start), save raw responses to ./debug/ so the parser can be checked
// against real data. Tokens/cookies are removed and emails/ids masked (see usage.redact). Gitignored.
const DEBUG_DIR = path.join(__dirname, '..', 'debug');
function dumpDebug(name, data) {
  if (app.isPackaged || process.env.CODEXAGE_TEST) return;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, name), JSON.stringify(redact(data), null, 2));
  } catch (e) { console.error('[debug]', e); }
}
/** A short, safe summary of a non-JSON body (e.g. a Cloudflare challenge page) */
function bodySnippet(text) {
  const s = String(text || '');
  const title = /<title>([^<]*)<\/title>/i.exec(s)?.[1];
  return title ? `HTML page: ${title.trim()}` : s.slice(0, 300);
}

// ---------------------------------------------------------------- pasted sign-in (fallback)
// When the in-app sign-in is blocked (Google refuses embedded browsers), the user can paste
// https://chatgpt.com/api/auth/session from their own browser. Stored encrypted with the OS (safeStorage),
// one entry per account partition.
const PASTED_FILE = () => path.join(app.getPath('userData'), 'pasted-sessions.bin');
let pastedMap = null;
function pastedAll() {
  if (pastedMap) return pastedMap;
  pastedMap = {};
  if (!safeStorage.isEncryptionAvailable()) return pastedMap;
  try { pastedMap = JSON.parse(safeStorage.decryptString(fs.readFileSync(PASTED_FILE()))) || {}; } catch { /* none yet */ }
  // v0.1 dev builds kept a single pasted session for the main account
  const old = path.join(app.getPath('userData'), 'pasted-session.bin');
  try {
    if (fs.existsSync(old)) {
      if (!pastedMap[PARTITION]) pastedMap[PARTITION] = JSON.parse(safeStorage.decryptString(fs.readFileSync(old)));
      fs.unlinkSync(old);
      writePasted();
    }
  } catch { /* unreadable: ignore */ }
  return pastedMap;
}
/** Persist; returns false when it can only be kept in memory (no OS encryption available) */
function writePasted() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (!Object.keys(pastedMap).length) { try { fs.unlinkSync(PASTED_FILE()); } catch { /* not there */ } return true; }
  fs.writeFileSync(PASTED_FILE(), safeStorage.encryptString(JSON.stringify(pastedMap)));
  return true;
}
function getPasted(part) { return pastedAll()[part] || null; }
function setPasted(part, info) {
  const m = pastedAll();
  if (info) m[part] = info; else delete m[part];
  return writePasted();
}

// ---------------------------------------------------------------- fetch: chatgpt.com (web)
async function sessionCookie(part = PARTITION) {
  const list = await ses(part).cookies.get({ url: CHATGPT });
  const parts = list.filter(c => c.name === SESSION_COOKIE || c.name.startsWith(SESSION_COOKIE + '.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  return parts.length ? parts.map(c => c.value).join('') : null;
}
async function isSignedIn(part) { return !!(await sessionCookie(part)) || !!getPasted(part); }

/**
 * GET a chatgpt.com JSON endpoint with the partition's cookies.
 * Try session.fetch first; if Cloudflare answers with a challenge page, fetch same-origin inside a hidden page.
 * Returns { status, json, via } and records every attempt in `log` for the debug files.
 */
async function webGetJson(pathname, { headers = {}, part = PARTITION, log = [] } = {}) {
  const url = CHATGPT + pathname;
  try {
    const r = await ses(part).fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json', ...headers },
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    log.push({ path: pathname, via: 'session', status: r.status, json: json !== undefined, body: json === undefined ? bodySnippet(text) : undefined });
    if (json !== undefined) return { status: r.status, json, via: 'session' };
    // Not JSON (usually a Cloudflare challenge) → try inside a real page
  } catch (e) {
    log.push({ path: pathname, via: 'session', error: e.message });
    if (isNetworkError(e)) throw e; // no connection: the in-page fetch would fail too
  }
  const res = await pageFetch(url, headers, part);
  let json; try { json = JSON.parse(res.body); } catch { json = undefined; }
  log.push({ path: pathname, via: 'page', status: res.status, json: json !== undefined, body: json === undefined ? bodySnippet(res.body) : undefined });
  if (res.status === 0) throw new TypeError(`fetch failed: ${res.body}`);
  if (json === undefined) throw new AppError('err.http', { host: 'chatgpt.com', status: res.status });
  return { status: res.status, json, via: 'page' };
}

async function ensureFetcherWin(part) {
  const existing = fetcherWins.get(part);
  if (existing && !existing.isDestroyed()) return existing;
  const w = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: { partition: part, contextIsolation: true, sandbox: true },
  });
  fetcherWins.set(part, w);
  await w.loadURL(CHATGPT + '/robots.txt').catch(() => {});
  return w;
}

function destroyFetcher(part) {
  const w = fetcherWins.get(part);
  if (w && !w.isDestroyed()) w.destroy();
  fetcherWins.delete(part);
}

async function pageFetch(url, headers, part) {
  const w = await ensureFetcherWin(part);
  return w.webContents.executeJavaScript(
    `fetch(${JSON.stringify(url)}, {credentials:'include', headers:${JSON.stringify({ accept: 'application/json', ...headers })}})
       .then(async r => ({ status: r.status, body: await r.text() }))
       .catch(e => ({ status: 0, body: String(e) }))`,
    true,
  );
}

/**
 * Access token for a partition: from /api/auth/session when signed in (cached until shortly before
 * it expires), otherwise from a pasted session.
 */
async function getWebToken(part = PARTITION, { force = false, log = [] } = {}) {
  const cached = tokenCache.get(part);
  if (!force && cached && (!cached.expiresAt || cached.expiresAt - Date.now() > 60e3)) return cached;
  if (!(await sessionCookie(part))) {
    const p = getPasted(part);
    if (!p) throw new AuthError('err.notLoggedIn');
    if (p.expiresAt && p.expiresAt - Date.now() < 60e3) throw new AuthError('err.pastedExpired');
    return { ...p, pasted: true };
  }
  const { status, json } = await webGetJson('/api/auth/session', { part, log });
  if (part === PARTITION) {
    dumpDebug('auth-session.json', { fetchedAt: new Date().toISOString(), status, keys: Object.keys(json || {}), session: json });
  }
  if (status === 401 || !json?.accessToken) {
    tokenCache.delete(part);
    throw new AuthError(json && Object.keys(json).length === 0 ? 'err.sessionExpired' : 'err.notLoggedIn');
  }
  const claims = jwtPayload(json.accessToken) || {};
  const authClaims = claims['https://api.openai.com/auth'] || {};
  const info = {
    token: json.accessToken,
    expiresAt: tokenExpiry(json.accessToken),
    accountId: json.account?.id || authClaims.chatgpt_account_id || null,
    email: json.user?.email || '',
    plan: planName(json.account?.planType || authClaims.chatgpt_plan_type),
  };
  tokenCache.set(part, info);
  return info;
}

/** Bearer + workspace headers. The main account can be pinned to a workspace in Settings. */
function bearerHeaders(tok, part = PARTITION) {
  const h = { authorization: `Bearer ${tok.token}` };
  const acct = (part === PARTITION && config.workspaceId) || tok.accountId;
  if (acct) h['chatgpt-account-id'] = acct;
  return h;
}

async function fetchWebUsage(part = PARTITION) {
  const log = [];
  const debug = part === PARTITION ? dumpDebug : () => {};
  try {
    let tok = await getWebToken(part, { log });
    let r = await webGetJson(USAGE_PATH, { headers: bearerHeaders(tok, part), part, log });
    if (r.status === 401 && tok.pasted) {
      debug('wham-usage.json', { fetchedAt: new Date().toISOString(), source: 'pasted', status: r.status, via: r.via, raw: r.json });
      throw new AuthError('err.pastedInvalid');
    }
    if (r.status === 401) {
      // Cached token went stale: get a fresh one once
      tok = await getWebToken(part, { force: true, log });
      r = await webGetJson(USAGE_PATH, { headers: bearerHeaders(tok, part), part, log });
    }
    debug('wham-usage.json', { fetchedAt: new Date().toISOString(), source: tok.pasted ? 'pasted' : 'web', status: r.status, via: r.via, hasUsage: hasUsage(r.json), raw: r.json });
    if (r.status === 401) { tokenCache.delete(part); throw new AuthError('err.sessionExpired'); }
    if (r.status < 200 || r.status >= 300) throw new AppError('err.http', { host: 'chatgpt.com', status: r.status });
    return { raw: r.json, plan: tok.plan, email: tok.email || r.json?.email || '', pastedToken: tok.pasted ? tok.token : null };
  } finally {
    debug('fetch-log.json', { at: new Date().toISOString(), log });
  }
}

// ---------------------------------------------------------------- fetch: Codex CLI credentials
function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function codexAuthFile() { return path.join(codexHome(), 'auth.json'); }

function readCodexAuth() {
  const file = codexAuthFile();
  if (!fs.existsSync(file)) throw new AuthError('err.cliNoCreds', { path: file });
  try { return parseCodexAuth(fs.readFileSync(file, 'utf8')); }
  catch (code) {
    if (code === 'apiKeyOnly') throw new AuthError('err.cliApiKey');
    if (code === 'noTokens') throw new AuthError('err.cliNoTokens');
    throw new AuthError('err.cliBadFormat');
  }
}

/** GET a chatgpt.com endpoint with a bare bearer token (no cookies) */
async function bearerGetJson(pathname, headers) {
  const r = await net.fetch(CHATGPT + pathname, {
    headers: { ...headers, accept: 'application/json', 'user-agent': `codexage/${app.getVersion()}` },
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, ok: r.ok, json, body: json === undefined ? bodySnippet(text) : undefined };
}

async function fetchCliUsage() {
  const a = readCodexAuth();
  if (a.expiresAt && Date.now() > a.expiresAt) throw new AuthError('err.cliExpired');
  const r = await bearerGetJson(USAGE_PATH, bearerHeaders(a));
  dumpDebug('wham-usage-cli.json', {
    fetchedAt: new Date().toISOString(), source: 'cli', status: r.status,
    hasUsage: r.json ? hasUsage(r.json) : false, raw: r.json, body: r.body,
  });
  if (r.status === 401) throw new AuthError('err.cliInvalid');
  if (!r.ok || r.json === undefined) throw new AppError('err.http', { host: 'chatgpt.com', status: r.status });
  return { raw: r.json, plan: a.plan, email: a.email || r.json?.email || '' };
}

/**
 * GET another chatgpt.com endpoint as the main account, with whatever sign-in the current source uses.
 * workspace: also send the chatgpt-account-id header (not wanted when listing workspaces).
 */
async function mainGetJson(pathname, { workspace = true } = {}) {
  if (config.source === 'cli') {
    const a = readCodexAuth();
    const res = await bearerGetJson(pathname, workspace ? bearerHeaders(a) : { authorization: `Bearer ${a.token}` });
    return { status: res.status, json: res.json };
  }
  const tok = await getWebToken(PARTITION);
  return webGetJson(pathname, { headers: workspace ? bearerHeaders(tok) : { authorization: `Bearer ${tok.token}` } });
}

/** Workspaces the main account can use (Settings → Workspace) */
async function listWorkspaces() {
  const r = await mainGetJson(ACCOUNTS_PATH, { workspace: false });
  dumpDebug('accounts-check.json', { fetchedAt: new Date().toISOString(), status: r.status, raw: r.json });
  if (r.status < 200 || r.status >= 300) throw new AppError('err.http', { host: 'chatgpt.com', status: r.status });
  return parseAccountsCheck(r.json);
}

/**
 * Expiry dates of the main account's usage-limit resets. Only fetched when the usage response says
 * there are some, at most once an hour (or when the count changes). Never throws.
 */
let resetCreditsCache = { at: 0, count: -1, source: '', data: null };
async function resetCreditDetails(count) {
  const now = Date.now();
  const c = resetCreditsCache;
  if (c.count === count && c.source === config.source && now - c.at < 3600e3) return c.data;
  let data = null;
  try {
    const r = await mainGetJson(RESET_CREDITS_PATH);
    dumpDebug('reset-credits.json', { fetchedAt: new Date().toISOString(), status: r.status, raw: r.json });
    if (r.status >= 200 && r.status < 300) data = usage.parseResetCredits(r.json);
  } catch (e) { console.error('[reset-credits]', e.key || e.message); }
  resetCreditsCache = { at: now, count, source: config.source, data };
  return data;
}

/** A usage-limit reset expiring within a day is worth using: remind once per expiry time */
function checkResetExpiry(resets) {
  const at = resets?.nextExpiry ? new Date(resets.nextExpiry).getTime() : null;
  if (!at || at <= Date.now() || at - Date.now() > 24 * 3600e3 || !config.notify) return;
  const id = `reset-expiry|${at}`;
  if (notified.has(id)) return;
  notified.add(id);
  notify({
    title: t('notify.resetExpiringTitle'),
    body: t('notify.resetExpiringBody', { time: new Date(at).toLocaleString(lang) }),
  });
}

// ---------------------------------------------------------------- normalize
function normalize(data, source = config.source) { return usage.normalize(data, source); }
/** History is kept per account, keyed by lower-case email ('' while the email is unknown) */
const histKey = (email) => String(email || '').trim().toLowerCase();
function addEta(state, acct = '', now = Date.now()) {
  const h = history && { recentRate: (field, resetsAt, at) => history.recentRate(field, resetsAt, at, acct) };
  return usage.addEta(state, h, now);
}

/** Translated label of a window ("5-hour", "Code review · Weekly", …) */
function labelOf(w) {
  const main = t(w.labelKey, w.labelVars);
  return w.spanKey ? `${main} · ${t(w.spanKey, w.spanVars)}` : main;
}

// ---------------------------------------------------------------- main loop
const ISSUES_URL = 'https://github.com/ckolpeter/codexage/issues/new?template=bug_report.yml';

/**
 * After a failure, retry sooner than the normal interval: 15s, 30s, 60s, 120s…
 * capped at the normal interval. Sign-in problems don't retry (they need the user).
 */
function scheduleRetry() {
  clearTimeout(retryTimer);
  const normal = Math.max(30, Number(config.intervalSec) || 120) * 1000;
  const wait = Math.min(normal, 15e3 * 2 ** Math.max(0, failCount - 1));
  if (wait >= normal) return null; // the regular poll will handle it
  retryTimer = setTimeout(refresh, wait);
  return Date.now() + wait;
}

function refresh() {
  // Collapse overlapping triggers (timer + resume + manual click) into one request
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh() {
  clearTimeout(retryTimer);
  if (!net.isOnline()) {
    failCount++;
    const prev = lastState.status === 'ok' ? lastState : lastState.prev;
    lastState = { status: 'error', msgKey: 'err.offline', prev, others: lastState.others, email: lastState.email, account: mainName() };
    lastState.retryAt = scheduleRetry();
    push(lastState); updateTray();
    return;
  }
  push({ ...lastState, refreshing: true });
  // Extra accounts are fetched in parallel with the main one and never throw
  const othersP = fetchOthers();
  try {
    const data = config.source === 'cli' ? await fetchCliUsage() : await fetchWebUsage();
    const prevOk = lastState.status === 'ok' ? lastState : lastState.prev;
    const st = normalize(data);
    if (data.email && data.email !== config.mainEmail) { config.mainEmail = data.email; saveConfig(); }
    // With several accounts, notifications say which one they're about
    const who = (config.accounts || []).length ? mainName() : '';
    if (!st.windows.length) {
      lastState = { status: 'error', msgKey: hasUsage(data.raw) ? 'err.noData' : 'err.noLimits', reportable: hasUsage(data.raw), plan: st.plan };
    } else {
      failCount = 0;
      lastState = st;
      lastState.signInExpiresAt = checkPastedExpiry(data.pastedToken, PARTITION, who);
      if (lastState.resets) {
        const d = await resetCreditDetails(lastState.resets.available);
        if (d) { lastState.resets.nextExpiry = d.nextExpiry; checkResetExpiry(lastState.resets); }
      }
      const key = histKey(config.mainEmail);
      history?.claimUnlabeled(key);
      history?.add(lastState, Date.now(), key);
      addEta(lastState, key);
      maybeNotify(lastState, who);
      checkResets(prevOk, lastState, who);
    }
  } catch (e) {
    console.error('[refresh]', e);
    const msg = e instanceof AppError ? { msgKey: e.key, msgVars: e.vars } : { message: e.message || String(e) };
    if (e instanceof AuthError) {
      failCount = 0;
      lastState = { status: 'auth', source: config.source, ...msg };
    } else {
      failCount++;
      const isNet = isNetworkError(e);
      lastState = {
        status: 'error',
        ...(isNet ? { msgKey: 'err.network' } : msg),
        prev: lastState.windows ? lastState : lastState.prev,
        reportable: !isNet && !(e instanceof AppError && e.key === 'err.http' && e.vars?.status >= 500),
      };
      lastState.retryAt = scheduleRetry();
    }
  }
  lastState.others = await othersP;
  // Refresh right after the next reset of any account
  scheduleResetCheck([...(lastState.windows || []), ...lastState.others.flatMap(o => o.windows || [])]);
  lastState.email = config.mainEmail || '';
  lastState.account = mainName();
  push(lastState);
  updateTray();
}

function schedule() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, Math.max(30, Number(config.intervalSec) || 120) * 1000);
}

function resolvedTheme() {
  return config.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : config.theme;
}
function viewOpts() {
  return { compact: config.compact, theme: resolvedTheme(), clickThrough: config.clickThrough };
}
function push(state) {
  if (widget && !widget.isDestroyed()) widget.webContents.send('usage', state, viewOpts());
}
function stateMessage(s) { return s.msgKey ? t(s.msgKey, s.msgVars) : (s.message || ''); }

/** Names shown on the widget: custom name, else the email (masked if asked) */
function mainName() {
  const labelFits = !config.mainLabelEmail || !config.mainEmail || config.mainLabelEmail === config.mainEmail;
  return usage.accountName(config.mainEmail, labelFits ? config.mainLabel : '', config.maskEmail);
}
function acctName(acct) { return usage.accountName(acct.email, acct.label, config.maskEmail); }

/** Names changed (custom name or masking): update the widget without fetching again */
function relabel() {
  lastState.account = mainName();
  for (const o of lastState.others || []) { const a = accountOf(o.partition); if (a) o.name = acctName(a); }
  if (lastState.prev) lastState.prev.account = lastState.account;
  push(lastState); updateTray();
}

// ---------------------------------------------------------------- notifications
/** "HH:MM" → minutes since midnight, or null */
function hm(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

/** Inside quiet hours? Handles ranges that cross midnight (e.g. 23:00 → 08:00) */
function inQuietHours(now = new Date()) {
  if (!config.quietEnabled) return false;
  const a = hm(config.quietStart), b = hm(config.quietEnd);
  if (a == null || b == null || a === b) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** All notifications go through here so quiet hours apply everywhere */
function notify(opts, onClick) {
  if (!Notification.isSupported() || inQuietHours()) return;
  const n = new Notification(opts);
  if (onClick) n.on('click', onClick);
  n.show();
}

/**
 * A pasted session can't be renewed by us: when it's close to expiring, tell the user once
 * (per token) and point them at the paste window. Returns the expiry time to show in the widget.
 */
function checkPastedExpiry(token, part = PARTITION, who = '') {
  const r = token ? expiryReminder(token) : null;
  if (!r?.remind) return null;
  const id = `expiry|${part}|${r.expiresAt}`;
  if (config.notify && !notified.has(id)) {
    notified.add(id);
    notify({
      title: (who ? `${who} · ` : '') + t('notify.expiringTitle'),
      body: t('notify.expiringBody', { time: new Date(r.expiresAt).toLocaleString(lang) }),
    }, () => openPaste(part));
  }
  return r.expiresAt;
}

function thresholds() {
  const list = (Array.isArray(config.notifyThresholds) ? config.notifyThresholds : [80, 95])
    .map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 100);
  return [...new Set(list)].sort((a, b) => a - b).slice(0, 5);
}

function maybeNotify(state, who = '') {
  if (!config.notify) return;
  const ths = thresholds();
  const loudest = ths[ths.length - 1];
  for (const w of state.windows.filter(x => x.primary)) {
    // Only announce the highest threshold crossed; mark the lower ones as done too
    const crossed = ths.filter(th => w.pct >= th);
    const top = crossed[crossed.length - 1];
    if (top == null) continue;
    const id = (th) => `${who}|${w.key}|${w.resetsAt}|${th}`;
    if (notified.has(id(top))) continue;
    crossed.forEach(th => notified.add(id(th)));
    notify({
      title: (who ? `${who} · ` : '') + t('notify.title', { label: labelOf(w), pct: Math.round(w.pct) }),
      body: w.resetsAt ? t('notify.body', { time: new Date(w.resetsAt).toLocaleString(lang) }) : '',
      silent: top < loudest,
    });
  }
}

/** who: account name when there are several accounts */
function checkResets(prev, cur, who = '') {
  if (!prev?.windows || !config.notifyReset) return;
  const now = Date.now();
  for (const key of ['five_hour', 'seven_day']) {
    const p = prev.windows.find(w => w.key === key);
    const c = cur.windows.find(w => w.key === key);
    if (!p || !c || p.pct < 20) continue; // nothing worth announcing
    const prevEnded = p.resetsAt && new Date(p.resetsAt).getTime() <= now;
    const newWindow = p.resetsAt && c.resetsAt !== p.resetsAt; // includes "new window not started yet"
    if ((prevEnded || newWindow) && c.pct < p.pct - 5) {
      notify({
        title: (who ? `${who} · ` : '') + t('notify.resetTitle', { label: labelOf(c) }),
        body: t('notify.resetBody', { pct: Math.round(c.pct) }),
      });
    }
  }
}

/** Refresh right after the next reset so the widget and notification are timely */
function scheduleResetCheck(windows) {
  clearTimeout(resetTimer);
  const now = Date.now();
  const next = windows
    .filter(w => w.primary && w.resetsAt)
    .map(w => new Date(w.resetsAt).getTime())
    .filter(x => Number.isFinite(x) && x > now)
    .sort((a, b) => a - b)[0];
  if (next && next - now < 2 ** 31 - 1) resetTimer = setTimeout(refresh, next - now + 20e3);
}

// ---------------------------------------------------------------- windows
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - 300, y: wa.y + 20, width: 280, height: 160 };
}

function boundsVisible(b) {
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x + 40 > a.x && b.x < a.x + a.width - 40 && b.y + 20 > a.y && b.y < a.y + a.height - 20;
  });
}

function createWidget() {
  const b = config.bounds && boundsVisible(config.bounds) ? config.bounds : defaultBounds();
  widget = new BrowserWindow({
    ...b,
    width: widgetWidth(),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: config.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  applyTopmost();
  widget.setOpacity(config.opacity);
  widget.loadFile(path.join(__dirname, 'widget.html'));
  widget.webContents.on('did-finish-load', () => widget.webContents.setZoomFactor(scaleOf()));
  applyClickThrough();
  widget.once('ready-to-show', () => { widget.showInactive(); push(lastState); trayIconKey = ''; updateTrayIcon(); });
  const remember = () => {
    if (widget.isDestroyed()) return;
    if (config.snapEdges) snapToEdges();
    config.bounds = widget.getBounds(); saveConfig();
  };
  widget.on('moved', remember);
  widget.on('closed', () => { widget = null; });
}

/** If the widget was dropped within SNAP px of a work-area edge, stick it to that edge */
const SNAP = 24;
function snapToEdges() {
  const b = widget.getBounds();
  const a = screen.getDisplayMatching(b).workArea;
  let { x, y } = b;
  if (Math.abs(b.x - a.x) <= SNAP) x = a.x;
  else if (Math.abs(a.x + a.width - (b.x + b.width)) <= SNAP) x = a.x + a.width - b.width;
  if (Math.abs(b.y - a.y) <= SNAP) y = a.y;
  else if (Math.abs(a.y + a.height - (b.y + b.height)) <= SNAP) y = a.y + a.height - b.height;
  if (x !== b.x || y !== b.y) widget.setBounds({ ...b, x, y });
}

const BASE_WIDTH = 280;
function scaleOf() { return Math.max(0.8, Math.min(1.5, Number(config.scale) || 1)); }
function widgetWidth() { return Math.round(BASE_WIDTH * scaleOf()); }

function applyScale() {
  if (!widget || widget.isDestroyed()) return;
  widget.webContents.setZoomFactor(scaleOf());
  const b = widget.getBounds();
  widget.setBounds({ ...b, width: widgetWidth() });
  push(lastState); // renderer re-measures its height
}

function applyClickThrough() {
  if (!widget || widget.isDestroyed()) return;
  widget.setIgnoreMouseEvents(!!config.clickThrough, { forward: true });
  push(lastState);
}

function toggleClickThrough() {
  config.clickThrough = !config.clickThrough; saveConfig();
  applyClickThrough(); updateTray();
}

/** Global hotkeys: config.hotkey toggles the widget; Ctrl/Cmd+Alt+Shift+X toggles click-through */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  let ok = true;
  if (config.hotkey) {
    try { ok = globalShortcut.register(config.hotkey, toggleWidget); } catch { ok = false; }
  }
  try { globalShortcut.register('CommandOrControl+Alt+Shift+X', toggleClickThrough); } catch { /* taken */ }
  return ok;
}

function applyTopmost() {
  if (!widget) return;
  if (config.alwaysOnTop) {
    widget.setAlwaysOnTop(true, IS_MAC ? 'floating' : 'screen-saver');
    if (IS_MAC) widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !config.hideOnFullscreen });
  } else {
    widget.setAlwaysOnTop(false);
    if (IS_MAC) widget.setVisibleOnAllWorkspaces(false);
  }
}

function applyFullscreenMode() {
  if (config.hideOnFullscreen) fullscreen.start(); else fullscreen.stop();
  applyTopmost();
}

function toggleWidget() {
  hiddenForFullscreen = false;
  if (!widget) return createWidget();
  widget.isVisible() ? widget.hide() : widget.showInactive();
  updateTray();
}

/** Sign-in window for an account (default: the main account) */
/**
 * Google refuses sign-in inside embedded browsers ("This browser or app may not be secure").
 * As soon as the login window (or one of its popups) reaches Google, offer the paste sign-in instead.
 */
function offerPasteOnGoogle(win, part) {
  let asked = false;
  const popups = [];
  const onNav = (_e, url) => {
    if (asked || !/^https:\/\/accounts\.google\.com\//.test(String(url))) return;
    asked = true;
    dialog.showMessageBox(win, {
      type: 'info', message: t('login.googleTitle'), detail: t('login.googleBody'),
      buttons: [t('login.usePaste'), t('login.keepTrying')], defaultId: 0, cancelId: 1, noLink: true,
    }).then(({ response }) => {
      if (response !== 0) return;
      for (const w of [...popups, win]) if (!w.isDestroyed()) w.close();
      openPaste(part);
    }).catch(() => {});
  };
  win.webContents.on('did-navigate', onNav);
  win.webContents.on('did-create-window', (child) => { popups.push(child); child.webContents.on('did-navigate', onNav); });
}

function openLogin(part = PARTITION) {
  const open = loginWins.get(part);
  if (open && !open.isDestroyed()) { open.focus(); return; }
  const acct = accountOf(part);
  const win = new BrowserWindow({
    width: 500, height: 780, title: t('win.login') + (acct?.email ? ` · ${acct.email}` : ''),
    autoHideMenuBar: true,
    webPreferences: { partition: part, contextIsolation: true, sandbox: true },
  });
  loginWins.set(part, win);
  win.on('page-title-updated', (e) => e.preventDefault());
  // Microsoft / Apple sign-in may open popups; keep them in the same session
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: part } },
  }));
  offerPasteOnGoogle(win, part);
  win.loadURL(CHATGPT + '/auth/login');
  // Already signed in → keep the window open (lets the user switch accounts); close once a new sign-in happens
  let initial;
  sessionCookie(part).then(c => { initial = c; });
  let busy = false;
  const check = setInterval(async () => {
    if (win.isDestroyed()) return clearInterval(check);
    if (initial === undefined || busy) return;
    const url = win.webContents.getURL();
    if (!url.startsWith(CHATGPT) || /\/auth\//.test(url)) return;
    const cookie = await sessionCookie(part);
    if (!cookie || cookie === initial) return;
    busy = true;
    try {
      const tok = await getWebToken(part, { force: true });
      clearInterval(check);
      win.close();
      if (part === PARTITION) {
        if (config.source !== 'web') config.source = 'web';
        config.mainEmail = tok.email || ''; config.workspaceId = null;
      } else if (acct) acct.email = tok.email || acct.email;
      saveConfig();
      refresh();
    } catch (e) {
      console.error('[login]', e.key || e.message);
    } finally { busy = false; }
  }, 2000);
  win.on('closed', () => { clearInterval(check); loginWins.delete(part); });
}

async function logout(part = PARTITION) {
  await ses(part).clearStorageData();
  destroyFetcher(part);
  tokenCache.delete(part);
  setPasted(part, null);
  if (part === PARTITION) {
    config.mainEmail = ''; config.workspaceId = null; saveConfig();
    lastState = { status: 'auth', msgKey: 'msg.loggedOut', source: config.source, others: lastState.others };
    push(lastState);
    updateTray();
  } else {
    refresh();
  }
}

/** Window where the user pastes https://chatgpt.com/api/auth/session from their own browser */
function openPaste(part = PARTITION) {
  if (!isAccountPart(part)) return;
  if (pasteWin && !pasteWin.isDestroyed()) pasteWin.close();
  pasteWin = new BrowserWindow({
    width: 480, height: 690, title: t('win.paste'), resizable: false, autoHideMenuBar: true,
    minimizable: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  pasteWin.loadFile(path.join(__dirname, 'paste.html'), { query: { part } });
  pasteWin.on('page-title-updated', (e) => e.preventDefault());
  pasteWin.on('closed', () => { pasteWin = null; });
}

/** The account (other than `part`) already using this email, or null */
function emailTakenBy(email, part) {
  const e = histKey(email);
  if (!e) return null;
  if (part !== PARTITION && histKey(config.mainEmail) === e) return { partition: PARTITION, email };
  return (config.accounts || []).find(a => a.partition !== part && histKey(a.email) === e) || null;
}

async function applyPasted(text, part = PARTITION) {
  if (!isAccountPart(part)) return { ok: false, message: '' };
  let info;
  try { info = parsePastedSession(text); }
  catch (code) { return { ok: false, message: t(code === 'expired' ? 'p.expired' : 'p.bad') }; }
  // Copying the session page in a browser that's still signed in to the first account gives that account again
  if (emailTakenBy(info.email, part)) return { ok: false, message: t('p.dupAccount', { email: info.email }) };
  const persisted = setPasted(part, info);
  tokenCache.delete(part);
  if (part === PARTITION) {
    if (config.source !== 'web') config.source = 'web';
    config.mainEmail = info.email || ''; config.workspaceId = null;
  } else {
    const acct = accountOf(part); if (acct && info.email) acct.email = info.email;
  }
  saveConfig();
  await refresh();
  const st = part === PARTITION ? lastState : (lastState.others || []).find(o => o.partition === part) || {};
  const ok = st.status === 'ok';
  if (!ok && st.status === 'auth') setPasted(part, null); // rejected: don't keep a bad token around
  const until = info.expiresAt ? new Date(info.expiresAt).toLocaleString(lang) : '';
  // The token works like a password: don't leave it in the clipboard once it's stored
  const cleared = ok && clearClipboardToken(info.token);
  return {
    ok,
    message: ok
      ? t('p.ok') + (until ? ' ' + t('p.until', { time: until }) : '') + (persisted ? '' : ' ' + t('p.memoryOnly'))
        + (cleared ? ' ' + t('p.clipCleared') : '')
      : stateMessage(st),
  };
}

/** Session page contents sitting in the clipboard: { text, info } | { expired } | null */
function clipboardSession() {
  let text = '';
  try { text = clipboard.readText(); } catch { return null; }
  if (!text || text.length > 100e3 || !/accessToken/.test(text)) return null;
  try {
    const info = parsePastedSession(text);
    return info.email ? { text, info } : null;
  } catch (code) { return code === 'expired' ? { expired: true } : null; }
}
function clearClipboardToken(token) {
  try {
    if (!token || !clipboard.readText().includes(token)) return false;
    clipboard.clear();
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------- extra accounts
// config.accounts = [{ partition, email }]: accounts shown below the main one (always ChatGPT sign-in).
function accountOf(part) { return (config.accounts || []).find(a => a.partition === part); }

function addAccount() {
  const part = `${ACCT_PREFIX}${Date.now().toString(36)}`;
  config.accounts = [...(config.accounts || []), { partition: part, email: '' }];
  saveConfig();
  ses(part).setUserAgent(IS_MAC ? CHROME_UA_MAC : CHROME_UA);
  openLogin(part);
  return part;
}

async function removeAccount(part) {
  if (part === PARTITION || !accountOf(part)) return;
  await ses(part).clearStorageData().catch(() => {});
  destroyFetcher(part);
  tokenCache.delete(part);
  setPasted(part, null);
  config.accounts = (config.accounts || []).filter(a => a.partition !== part);
  saveConfig();
  if (lastState.others) lastState.others = lastState.others.filter(o => o.partition !== part);
  push(lastState);
}

const othersPrev = new Map(); // partition → last good state, to spot resets
/** Fetch every extra account (in parallel). Failures become per-account status, never throw. */
async function fetchOthers() {
  return Promise.all((config.accounts || []).map(async (acct) => {
    const base = { partition: acct.partition, email: acct.email || '', name: acctName(acct) };
    try {
      const data = await fetchWebUsage(acct.partition);
      if (data.email && data.email !== acct.email) { acct.email = data.email; base.email = data.email; base.name = acctName(acct); saveConfig(); }
      const st = normalize(data, 'web');
      const key = histKey(base.email);
      if (key) history?.add(st, Date.now(), key);
      addEta(st, key || acct.partition);
      maybeNotify(st, base.name || base.email);
      if (st.windows.length) { checkResets(othersPrev.get(acct.partition), st, base.name || base.email); othersPrev.set(acct.partition, st); }
      return {
        ...base, status: st.windows.length ? 'ok' : 'error', msgKey: st.windows.length ? undefined : 'err.noLimits',
        plan: st.plan, windows: st.windows.filter(w => w.primary),
        signInExpiresAt: checkPastedExpiry(data.pastedToken, acct.partition, base.name || base.email),
      };
    } catch (e) {
      return { ...base, status: e instanceof AuthError ? 'auth' : 'error', msgKey: e.key, msgVars: e.vars, message: e.key ? undefined : e.message };
    }
  }));
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 480, height: 820, title: t('win.settings'),
    resizable: false, autoHideMenuBar: true, minimizable: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('page-title-updated', (e) => e.preventDefault());
  settingsWin.on('closed', () => { settingsWin = null; });
}

let historyPick; // account key the history window should open on
/** part: show this account ('' = main, a partition = another account); omitted = keep the current choice */
function openHistory(part) {
  let key;
  if (typeof part === 'string') {
    const acct = part ? (config.accounts || []).find(a => a.partition === part) : null;
    key = acct ? histKey(acct.email) : histKey(config.mainEmail);
  }
  if (historyWin && !historyWin.isDestroyed()) {
    if (key) historyWin.webContents.send('history:select', key);
    historyWin.focus(); return;
  }
  historyPick = key || undefined;
  historyWin = new BrowserWindow({
    width: 600, height: 560, title: t('h.title'), backgroundColor: '#1b1d22',
    autoHideMenuBar: true, minWidth: 420, minHeight: 480,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  historyWin.loadFile(path.join(__dirname, 'history.html'));
  historyWin.on('closed', () => { historyWin = null; });
}

// ---------------------------------------------------------------- tray
function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', IS_MAC ? 'trayTemplate.png' : 'tray.png'));
  if (IS_MAC) img.setTemplateImage(true);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

function languageMenu() {
  return [
    { label: t('menu.langAuto'), type: 'radio', checked: config.language === 'auto', click: () => setLanguage('auto') },
    { type: 'separator' },
    ...Object.entries(LOCALES).map(([code, d]) => ({
      label: d._name || code, type: 'radio', checked: config.language === code, click: () => setLanguage(code),
    })),
  ];
}

function updateMenuItems() {
  const st = updater?.status;
  if (!st || st.state === 'idle') return [];
  return [
    { label: t(st.state === 'downloaded' ? 'menu.updateRestart' : 'menu.updateDownload', { version: st.version }), click: () => updater.apply() },
    { type: 'separator' },
  ];
}

function buildMenu() {
  const items = [
    ...updateMenuItems(),
    { label: widget && widget.isVisible() ? t('menu.hide') : t('menu.show'), click: toggleWidget },
    { label: t('menu.refresh'), click: refresh },
    { type: 'separator' },
    { label: t('menu.login'), click: () => openLogin(), enabled: config.source === 'web' },
    { label: t('menu.paste'), click: () => openPaste() },
    { label: t('menu.history'), click: () => openHistory() },
    { label: t('menu.openUsage'), click: () => shell.openExternal(USAGE_PAGE) },
    { type: 'separator' },
    {
      label: t('menu.alwaysOnTop'), type: 'checkbox', checked: config.alwaysOnTop,
      click: (m) => { config.alwaysOnTop = m.checked; applyTopmost(); saveConfig(); },
    },
    {
      label: t('menu.compact'), type: 'checkbox', checked: config.compact,
      click: (m) => { config.compact = m.checked; saveConfig(); push(lastState); },
    },
    {
      label: t('menu.clickThrough'), type: 'checkbox', checked: !!config.clickThrough,
      accelerator: 'CommandOrControl+Alt+Shift+X', click: toggleClickThrough,
    },
    { label: t('menu.language'), submenu: languageMenu() },
    { label: t('menu.settings'), click: openSettings },
    { label: t('menu.resetPos'), click: () => { if (widget) { widget.setBounds({ ...defaultBounds(), width: widgetWidth() }); config.bounds = null; saveConfig(); } } },
  ];
  if (!app.isPackaged) {
    items.push({ type: 'separator' }, {
      label: t('menu.openDebug'),
      click: () => { fs.mkdirSync(DEBUG_DIR, { recursive: true }); shell.openPath(DEBUG_DIR); },
    });
  }
  items.push({ type: 'separator' }, { label: t('menu.quit'), click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

const TRAY_COLORS = { ok: '#2f8f55', warn: '#c98411', bad: '#cc3f35' };

/**
 * Window whose % goes into the tray. "5-hour" falls back to weekly when there is no 5-hour limit.
 * With "all accounts", the highest of every signed-in account wins (the main one on a tie).
 */
function trayMetricWindow() {
  if (config.trayMetric === 'off') return null;
  const sets = [lastState.status === 'ok' ? lastState.windows : null];
  if (config.trayAllAccounts) for (const o of lastState.others || []) if (o.status === 'ok') sets.push(o.windows);
  return sets.filter(Boolean).map(metricOf).filter(Boolean).sort((a, b) => b.pct - a.pct)[0] || null;
}
function metricOf(ws) {
  const five = ws.find(w => w.key === 'five_hour');
  const week = ws.find(w => w.key === 'seven_day');
  if (config.trayMetric === 'seven_day') return week || five || null;
  if (config.trayMetric === 'max') return [five, week].filter(Boolean).sort((a, b) => b.pct - a.pct)[0] || null;
  return five || week || null;
}

/** Draw the tray icon (rounded square + percentage) with a canvas in the widget page */
let trayIconKey = '';
async function updateTrayIcon() {
  if (!tray || IS_MAC) return; // macOS shows the number as menu bar text instead
  const w = trayMetricWindow();
  const key = w ? `${Math.round(w.pct)}` : 'default';
  if (key === trayIconKey) return;
  if (!w) { tray.setImage(trayImage()); trayIconKey = key; return; }
  if (!widget || widget.isDestroyed() || widget.webContents.isLoading()) return;
  const pct = Math.round(w.pct);
  const color = pct >= 90 ? TRAY_COLORS.bad : pct >= 70 ? TRAY_COLORS.warn : TRAY_COLORS.ok;
  const draw = (S) => `(() => {
    const S = ${S}, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = ${JSON.stringify(color)};
    g.beginPath(); g.roundRect(0, 0, S, S, S * 0.22); g.fill();
    const txt = ${JSON.stringify(String(pct))};
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '700 ' + (txt.length >= 3 ? S * 0.5 : S * 0.68) + 'px "Segoe UI", Arial, sans-serif';
    g.fillText(txt, S / 2, S / 2 + S * 0.04);
    return c.toDataURL('image/png');
  })()`;
  try {
    const [u16, u32] = await Promise.all([16, 32].map(S => widget.webContents.executeJavaScript(draw(S), true)));
    const img = nativeImage.createFromDataURL(u16);
    img.addRepresentation({ scaleFactor: 2, dataURL: u32 });
    tray.setImage(img);
    trayIconKey = key;
  } catch (e) { console.error('[tray]', e); }
}

function updateTray() {
  if (!tray) return;
  updateTrayIcon();
  const five = lastState.windows?.find(w => w.key === 'five_hour');
  const week = lastState.windows?.find(w => w.key === 'seven_day');
  const tip = five || week
    ? t('tray.tooltip', { five: five ? Math.round(five.pct) + '%' : '-', week: week ? Math.round(week.pct) + '%' : '-' })
      + (five?.eta?.beforeReset ? '\n' + t('tray.eta', { time: new Date(five.eta.at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) }) : '')
    : t('tray.tooltipMsg', { msg: stateMessage(lastState) || t('tray.loading') });
  // Other accounts: one short line each
  const pctIn = (o, key) => { const w = o.windows?.find(x => x.key === key); return w ? Math.round(w.pct) + '%' : '-'; };
  const lines = (lastState.others || []).filter(o => o.status === 'ok')
    .map(o => t('tray.acctLine', { name: o.name || o.email, five: pctIn(o, 'five_hour'), week: pctIn(o, 'seven_day') }));
  let full = [lastState.account ? `${lastState.account}\n${tip}` : tip, ...lines].join('\n');
  if (process.platform === 'win32' && full.length > 127) full = full.slice(0, 126) + '…'; // Windows tooltip limit
  tray.setToolTip(full);
  if (IS_MAC) { const m = trayMetricWindow(); tray.setTitle(m ? ` ${Math.round(m.pct)}%` : ''); }
  tray.setContextMenu(buildMenu());
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('i18n', () => ({ lang, dict: { ...LOCALES[FALLBACK], ...LOCALES[lang] } }));
ipcMain.handle('get-state', () => ({ state: lastState, opts: viewOpts() }));
ipcMain.on('refresh', () => refresh());
ipcMain.on('login', () => openLogin());
ipcMain.on('open-settings', () => openSettings());
ipcMain.on('open-history', (_e, part) => openHistory(typeof part === 'string' ? part : undefined));
ipcMain.on('open-issue', () => shell.openExternal(ISSUES_URL));
ipcMain.on('use-source', (_e, src) => {
  if (src !== 'web' && src !== 'cli' || src === config.source) return;
  config.source = src; config.workspaceId = null; saveConfig();
  lastState = { status: 'loading', others: lastState.others };
  push(lastState); updateTray(); refresh();
});
ipcMain.on('paste:open', (_e, part) => openPaste(part || PARTITION));
ipcMain.handle('paste:apply', (_e, text, part) => applyPasted(text, part || PARTITION));
// The paste window looks at the clipboard when it opens or gets focus; the token never goes to the page
ipcMain.handle('paste:clipboard', (_e, part) => {
  const c = clipboardSession();
  if (!c) return null;
  if (c.expired) return { expired: true };
  const email = usage.accountName(c.info.email, '', config.maskEmail);
  if (emailTakenBy(c.info.email, part || PARTITION)) return { duplicate: true, email };
  return { email, plan: c.info.plan || '' };
});
ipcMain.handle('paste:apply-clipboard', (_e, part) => {
  const c = clipboardSession();
  if (!c?.text) return { ok: false, message: t('p.clipGone') };
  return applyPasted(c.text, part || PARTITION);
});
ipcMain.on('paste:open-session-page', () => shell.openExternal(SESSION_PAGE));
/** Name of a history account: the main / extra account's display name, else its email */
function historyName(key) {
  const main = histKey(config.mainEmail);
  if (key === main || !key) return (key === main && mainName()) || t('h.mainAccount');
  const a = (config.accounts || []).find(x => histKey(x.email) === key);
  return a ? acctName(a) : usage.accountName(key, '', config.maskEmail);
}
ipcMain.handle('history:get', (_e, acct) => {
  if (acct == null && historyPick) { acct = historyPick; historyPick = undefined; }
  const now = Date.now();
  const main = histKey(config.mainEmail);
  // Main account first, then the others by when they were last seen
  const keys = [main, ...(history ? history.accounts().map(a => a.key).filter(k => k !== main) : [])];
  const sel = typeof acct === 'string' && keys.includes(acct) ? acct : main;
  return {
    now,
    accounts: keys.map(key => ({ key, name: historyName(key) })),
    selected: sel,
    five: history ? history.series('f', now - 24 * 3600e3, sel) : [],
    fiveWeek: history ? history.series('f', now - 7 * 24 * 3600e3, sel) : [],
    week: history ? history.series('w', now - 7 * 24 * 3600e3, sel) : [],
  };
});
ipcMain.handle('history:clear', () => { history?.clear(); return true; });
ipcMain.handle('history:export', async () => {
  if (!history) return { ok: false };
  const d = new Date();
  const name = `codexage-history-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
  const r = await dialog.showSaveDialog(historyWin || undefined, {
    title: t('h.export'),
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false };
  // BOM so Excel opens UTF-8 correctly
  fs.writeFileSync(r.filePath, '﻿' + history.toCSV(), 'utf8');
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
});
ipcMain.on('hide', () => { widget?.hide(); updateTray(); });
ipcMain.on('context-menu', () => buildMenu().popup({ window: widget }));
ipcMain.on('toggle-compact', () => { config.compact = !config.compact; saveConfig(); push(lastState); updateTray(); });
ipcMain.on('resize', (_e, h) => {
  if (!widget || widget.isDestroyed()) return;
  const b = widget.getBounds();
  const height = Math.max(60, Math.min(900, Math.ceil(h * scaleOf())));
  if (b.height !== height) widget.setBounds({ ...b, height });
});

ipcMain.handle('settings:get', async () => {
  const p = getPasted(PARTITION);
  const cookie = !!(await sessionCookie(PARTITION));
  return {
    config,
    languages: Object.entries(LOCALES).map(([code, d]) => ({ code, name: d._name || code })),
    signIn: cookie ? 'cookie' : p ? 'pasted' : null,
    pastedUntil: !cookie && p?.expiresAt ? new Date(p.expiresAt).toLocaleString(lang) : '',
    hasCodexCli: fs.existsSync(codexAuthFile()),
    codexAuthPath: codexAuthFile(),
    encryption: safeStorage.isEncryptionAvailable(),
    fullscreenSupported: fullscreen.supported || IS_MAC,
    platform: process.platform,
    version: app.getVersion(),
    hotkeyOk,
  };
});
ipcMain.handle('settings:set', async (_e, patch) => {
  patch = { ...patch };
  for (const k of ['accounts', 'bounds', 'mainEmail', 'mainLabelEmail']) delete patch[k]; // managed by the app
  if ('language' in patch) { setLanguage(patch.language); delete patch.language; }
  const prevSource = config.source;
  Object.assign(config, patch);
  if (!['web', 'cli'].includes(config.source)) config.source = prevSource;
  if (prevSource !== config.source) config.workspaceId = null;
  config.intervalSec = Math.max(30, Number(config.intervalSec) || 120);
  if ('notifyThresholds' in patch) config.notifyThresholds = thresholds();
  config.opacity = Math.max(0.3, Math.min(1, Number(config.opacity) || 1));
  widget?.setOpacity(config.opacity);
  applyTopmost();
  app.setLoginItemSettings({ openAtLogin: !!config.openAtLogin });
  if ('trayMetric' in patch || 'trayAllAccounts' in patch) trayIconKey = '';
  if ('autoUpdate' in patch) updater?.start(config.autoUpdate);
  if ('scale' in patch) applyScale();
  if ('clickThrough' in patch) applyClickThrough();
  if ('hideOnFullscreen' in patch) applyFullscreenMode();
  if ('hotkey' in patch) hotkeyOk = registerHotkeys();
  if ('maskEmail' in patch || 'mainLabel' in patch) {
    config.mainLabel = String(config.mainLabel || '').trim().slice(0, 40);
    if ('mainLabel' in patch) config.mainLabelEmail = config.mainLabel ? config.mainEmail : '';
    relabel();
  }
  saveConfig(); schedule(); updateTray();
  if (prevSource !== config.source || 'workspaceId' in patch) refresh(); else push(lastState);
  return config;
});
ipcMain.handle('settings:list-workspaces', async () => {
  try { return await listWorkspaces(); } catch (e) { return { error: e.key ? t(e.key, e.vars) : e.message }; }
});
ipcMain.on('settings:login', () => openLogin());
ipcMain.on('settings:logout', () => logout());
ipcMain.handle('accounts:list', async () => Promise.all((config.accounts || []).map(async a => ({
  partition: a.partition, email: a.email || '', label: a.label || '', signedIn: await isSignedIn(a.partition),
}))));
ipcMain.on('accounts:add', () => addAccount());
ipcMain.handle('accounts:set-label', (_e, part, label) => {
  const acct = accountOf(part);
  if (!acct) return false;
  acct.label = String(label || '').trim().slice(0, 40);
  saveConfig(); relabel();
  return true;
});
ipcMain.on('accounts:login', (_e, part) => { if (accountOf(part)) openLogin(part); });
ipcMain.on('accounts:paste', (_e, part) => { if (accountOf(part)) openPaste(part); });
ipcMain.handle('accounts:add-paste', () => { const part = `${ACCT_PREFIX}${Date.now().toString(36)}`; config.accounts = [...(config.accounts || []), { partition: part, email: '' }]; saveConfig(); openPaste(part); return part; });
ipcMain.handle('accounts:remove', async (_e, part) => { await removeAccount(part); return true; });

// ---------------------------------------------------------------- startup
app.on('second-instance', () => { if (widget) widget.showInactive(); else createWidget(); });
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); fullscreen.stop(); });

app.whenReady().then(async () => {
  if (IS_MAC && app.dock) app.dock.hide();
  if (process.platform === 'win32') app.setAppUserModelId('io.github.ckolpeter.codexage');
  loadConfig();
  history = new History(path.join(app.getPath('userData'), 'history.json'));
  updater = new Updater((st) => {
    updateTray();
    notify({
      title: t(st.state === 'downloaded' ? 'notify.updateReady' : 'notify.updateAvailable', { version: st.version }),
      body: t(st.state === 'downloaded' ? 'notify.updateReadyBody' : 'notify.updateAvailableBody'),
    });
  });
  lang = resolveLang(config.language);
  for (const part of [PARTITION, ...(config.accounts || []).map(a => a.partition)]) {
    ses(part).setUserAgent(IS_MAC ? CHROME_UA_MAC : CHROME_UA);
  }

  tray = new Tray(trayImage());
  tray.on('click', toggleWidget);
  updateTray();

  createWidget();
  powerMonitor.on('resume', () => setTimeout(refresh, 5000));
  schedule();
  updater.start(config.autoUpdate);
  hotkeyOk = registerHotkeys();
  applyFullscreenMode();
  nativeTheme.on('updated', () => { if (config.theme === 'system') push(lastState); });
  await refresh();
  // First run with nothing signed in: open the sign-in window (the widget also offers "Paste sign-in")
  if (lastState.status === 'auth' && config.source === 'web' && lastState.msgKey === 'err.notLoggedIn') openLogin();
});
