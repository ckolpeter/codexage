// Minimal Electron stand-in so test/smoke.test.js can run src/main.js under plain Node.
// Env:
//   FIXTURE     wham/usage JSON returned to every account
//   FIXTURE_OTHER  wham/usage JSON for the extra accounts instead (default FIXTURE)
//   SIGNIN      'cookie' (default) | 'none'   — whether the partitions have a chatgpt.com session cookie
//   OFFLINE     net.isOnline() → false
//   NETFAIL     every request throws a network error
//   USAGE_STATUS  HTTP status for wham/usage (default 200)
//   PRECONFIG   config.json contents
//   VERBOSE     log requests
const os = require('os'), path = require('path'), fs = require('fs');
const fixture = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const fixtureOther = process.env.FIXTURE_OTHER ? JSON.parse(fs.readFileSync(process.env.FIXTURE_OTHER, 'utf8')) : fixture;
const log = (...a) => { if (process.env.VERBOSE) console.log('[fake]', ...a); };
const sent = global.__sent = [];
const handlers = global.__ipc = {};
const reqs = global.__reqs = [];
const userData = global.__userData = fs.mkdtempSync(path.join(os.tmpdir(), 'codexage-ud-'));
if (process.env.PRECONFIG) fs.writeFileSync(path.join(userData, 'config.json'), process.env.PRECONFIG);
const listeners = {};
let readyResolve; const ready = new Promise(r => (readyResolve = r));
const app = {
  isPackaged: false, dock: { hide() {} }, commandLine: { appendSwitch() {} },
  requestSingleInstanceLock: () => true, getPath: () => userData, getVersion: () => '0.1.0',
  getLocale: () => 'zh-TW', getPreferredSystemLanguages: () => ['zh-TW'],
  whenReady: () => ready, on: (e, f) => (listeners[e] = f), quit() {}, setAppUserModelId() {},
  setLoginItemSettings() {},
};
setTimeout(() => readyResolve(), 10);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = global.__jwt = (payload) => `eyJhbGciOiJub25lIn0.${b64(payload)}.sig`;
const future = () => Math.floor(Date.now() / 1000) + 3600;

/** Fake chatgpt.com: answers by path, records the headers it saw */
function respond(url, headers = {}, part = null) {
  if (process.env.NETFAIL) throw new TypeError('fetch failed');
  const u = new URL(url);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  reqs.push({ path: u.pathname, part, auth: h.authorization ? 'bearer' : null, account: h['chatgpt-account-id'] || null, ua: h['user-agent'] || null });
  log('fetch', part, u.pathname);
  let status = 200, body;
  if (u.pathname === '/api/auth/session') {
    const main = part === 'persist:chatgpt';
    body = {
      user: { email: main ? 'me@example.com' : 'work@example.com' },
      account: { id: main ? 'acc-1' : 'acc-2', planType: 'plus' },
      accessToken: jwt({ exp: future() }),
      expires: '2099-01-01T00:00:00Z',
    };
  } else if (u.pathname === '/backend-api/wham/usage') {
    if (!h.authorization) { status = 401; body = { detail: 'Unauthorized' }; }
    else { status = Number(process.env.USAGE_STATUS || 200); body = status !== 200 ? { detail: 'nope' } : part && part !== 'persist:chatgpt' ? fixtureOther : fixture; }
  } else if (u.pathname === '/backend-api/wham/rate-limit-reset-credits') {
    // RESET_EXPIRY_HOURS: hours until the soonest available reset expires (default 30 days)
    const soon = new Date(Date.now() + Number(process.env.RESET_EXPIRY_HOURS || 720) * 3600e3).toISOString();
    body = {
      available_count: 3,
      credits: [
        { id: 'r1', reset_type: 'full', status: 'available', granted_at: '2026-11-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' },
        { id: 'r2', reset_type: 'full', status: 'available', granted_at: '2026-11-02T00:00:00Z', expires_at: soon },
        { id: 'r0', reset_type: 'full', status: 'consumed', granted_at: '2026-10-01T00:00:00Z', expires_at: '2026-11-01T00:00:00Z' },
      ],
    };
  } else if (u.pathname === '/backend-api/wham/accounts/check') {
    body = { accounts: [{ id: 'acc-1', name: null, plan_type: 'plus', structure: 'personal' }, { id: 'ws-9', name: 'Acme', plan_type: 'team' }], default_account_id: 'acc-1' };
  } else { status = 404; body = {}; }
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

class WebContents {
  constructor() { this.handlers = {}; }
  send(ch, ...a) { sent.push([ch, ...a]); }
  on(e, f) { this.handlers[e] = f; if (e === 'did-finish-load') setTimeout(f, 5); }
  async executeJavaScript(js) { if (js.includes('toDataURL')) return 'data:image/png;base64,AAAA'; return { status: 200, body: '{}' }; }
  setZoomFactor() {} isLoading() { return false; } setWindowOpenHandler() {} getURL() { return 'https://chatgpt.com/'; } reload() {}
}
const windows = global.__windows = [];
class BrowserWindow {
  constructor(o) { this.o = o; this.webContents = new WebContents(); this.visible = false; this.bounds = { x: 0, y: 0, width: o.width || 280, height: o.height || 160 }; this.ev = {}; windows.push(this); }
  loadFile(f, opts) { this.file = f; this.query = opts?.query; setTimeout(() => this.ev['ready-to-show']?.(), 5); return Promise.resolve(); }
  loadURL(u) { this.url = u; return Promise.resolve(); }
  once(e, f) { this.ev[e] = f; } on(e, f) { this.ev[e] = f; }
  showInactive() { this.visible = true; } show() { this.visible = true; } hide() { this.visible = false; } isVisible() { return this.visible; }
  isDestroyed() { return !!this.destroyed; } destroy() { this.destroyed = true; } close() { this.destroyed = true; this.ev.closed?.(); } focus() {}
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setOpacity() {} setIgnoreMouseEvents(v) { this.ignore = v; }
  getBounds() { return { ...this.bounds }; } setBounds(b) { Object.assign(this.bounds, b); } setTitle() {}
}
const img = () => ({ isEmpty: () => false, resize() { return this; }, setTemplateImage() {}, addRepresentation() {} });
const signedIn = (process.env.SIGNIN || 'cookie') === 'cookie';
const session = { fromPartition: (part) => ({
  cookies: {
    // The session cookie is split into two chunks, like chatgpt.com does for large sessions
    get: async () => (signedIn ? [
      { name: '__Secure-next-auth.session-token.1', value: 'b' },
      { name: '__Secure-next-auth.session-token.0', value: 'a' },
      { name: 'oai-did', value: 'x' },
    ] : []),
    set: async () => {},
  },
  fetch: async (url, opts = {}) => respond(url, opts.headers, part),
  setUserAgent() {}, clearStorageData: async () => {},
}) };
class Notification {
  static isSupported() { return true; }
  constructor(o) { this.o = o; }
  on(e, f) { if (e === 'click') this.o = { ...this.o, clickable: true }; this.click = f; }
  show() { (global.__notes ||= []).push(this.o); (global.__noteObjs ||= []).push(this); }
}
class Tray { constructor() {} on() {} setToolTip(t) { global.__tooltip = t; } setContextMenu(m) { global.__menu = m; } setImage() { global.__trayImage = true; } setTitle(t) { global.__trayTitle = t; } }
const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
// "Encryption": reversible marker so tests can check nothing is stored in plain text
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + Buffer.from(s).toString('base64')),
  decryptString: (b) => Buffer.from(String(b).replace(/^ENC:/, ''), 'base64').toString(),
};
module.exports = {
  app, BrowserWindow, Tray, Notification, session, safeStorage,
  clipboard: { readText: () => global.__clip || '', clear: () => { global.__clip = ''; } },
  Menu: { buildFromTemplate: (t) => ({ t, popup() {} }) },
  ipcMain: { handle: (c, f) => (handlers[c] = f), on: (c, f) => (handlers[c] = f) },
  nativeImage: { createFromPath: img, createFromDataURL: img },
  screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display], getDisplayMatching: () => display },
  powerMonitor: { on() {} }, shell: { openExternal() {}, showItemInFolder() {}, openPath() {} },
  globalShortcut: { register: () => true, unregisterAll() {} },
  nativeTheme: { on() {}, shouldUseDarkColors: true },
  net: { isOnline: () => !process.env.OFFLINE, fetch: async (url, opts = {}) => respond(url, opts.headers, null) },
  dialog: {
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async (_w, o) => { (global.__dialogs ||= []).push(o.message); return { response: 0 }; }, // first button
  },
};
