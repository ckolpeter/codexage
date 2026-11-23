'use strict';
// Runs src/main.js with test/fake-electron.js in place of Electron, then prints the
// last state pushed to the widget plus a few IPC results as JSON on stdout.
// Extra env: CLI_AUTH ('valid' | 'expired' | 'apikey') writes a Codex CLI auth.json; PASTE runs the paste flow.
process.env.CODEXAGE_TEST = '1'; // don't overwrite the developer's debug/ folder
const fs = require('fs');
const os = require('os');
const path = require('path');
// Keep the developer's real ~/.codex out of the test
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codexage-codex-'));
// Pretend to be another OS (e.g. SIM_PLATFORM=darwin) to test platform-specific paths anywhere.
// os.tmpdir() looks at process.platform (win32 → %TEMP%), so pin the real one first.
if (process.env.SIM_PLATFORM) {
  const tmp = os.tmpdir();
  os.tmpdir = () => tmp;
  Object.defineProperty(process, 'platform', { value: process.env.SIM_PLATFORM });
}
const Module = require('module');
const fake = path.join(__dirname, 'fake-electron.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'electron' ? fake : resolve.call(this, request, ...rest);
};
const electron = require('electron');

if (process.env.CLI_AUTH) {
  const jwt = global.__jwt;
  const exp = Math.floor(Date.now() / 1000) + (process.env.CLI_AUTH === 'expired' ? -60 : 3600);
  const auth = process.env.CLI_AUTH === 'apikey'
    ? { OPENAI_API_KEY: 'sk-test', tokens: null }
    : {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({ email: 'cli@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acc-cli' } }),
        access_token: jwt({ exp }),
        refresh_token: 'rt',
        account_id: 'acc-cli',
      },
    };
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify(auth));
}

require('../src/main.js');
setTimeout(async () => {
  const ipc = global.__ipc;
  let paste = null;
  if (process.env.PASTE) {
    // valid: a fresh 10-day token; expiring: issued 9 days ago, 1 hour left
    const s = Math.floor(Date.now() / 1000);
    const claims = { valid: { iat: s - 3600, exp: s + 10 * 86400 }, expiring: { iat: s - 9 * 86400, exp: s + 3600 } }[process.env.PASTE];
    paste = await ipc['paste:apply']({}, claims
      ? 'Pretty-print\n' + JSON.stringify({ user: { email: 'pasted@example.com' }, account: { id: 'acc-p', planType: 'pro' }, accessToken: global.__jwt(claims) })
      : process.env.PASTE);
    if (process.env.REFRESH_AGAIN) await ipc['refresh']?.(); // a second refresh must not repeat the reminder
    await new Promise(r => setTimeout(r, 300));
  }
  // CLIP: what the paste window finds in the clipboard ('valid' | 'expired' | other text), then applies it
  let clip;
  if (process.env.CLIP) {
    const s = Math.floor(Date.now() / 1000);
    const claims = { valid: { iat: s - 3600, exp: s + 10 * 86400 }, expired: { iat: s - 11 * 86400, exp: s - 60 } }[process.env.CLIP];
    global.__clip = claims
      ? JSON.stringify({ user: { email: process.env.CLIP_EMAIL || 'clip@example.com' }, account: { id: 'acc-c', planType: 'pro' }, accessToken: global.__jwt(claims) })
      : process.env.CLIP;
    const seen = await ipc['paste:clipboard']({}, process.env.CLIP_PART);
    const apply = await ipc['paste:apply-clipboard']({}, process.env.CLIP_PART);
    await new Promise(r => setTimeout(r, 300));
    clip = { seen, apply, left: global.__clip };
  }
  // GOOGLE: the login window reaches Google's sign-in page → the paste sign-in is offered (and accepted)
  let google;
  if (process.env.GOOGLE) {
    const login = global.__windows.find(w => String(w.url || '').includes('/auth/login'));
    login.webContents.handlers['did-navigate']({}, 'https://accounts.google.com/v3/signin/identifier?flowName=x');
    login.webContents.handlers['did-navigate']({}, 'https://accounts.google.com/v3/signin/rejected'); // asked once
    await new Promise(r => setTimeout(r, 50));
    const paste = global.__windows.find(w => String(w.file || '').endsWith('paste.html') && !w.destroyed);
    google = { dialogs: global.__dialogs || [], loginClosed: !!login.destroyed, pastePart: paste?.query?.part || null };
  }
  // RESET_OTHER: the extra account's limit resets between two refreshes
  if (process.env.RESET_OTHER) {
    const f = JSON.parse(fs.readFileSync(process.env.FIXTURE_OTHER || process.env.FIXTURE, 'utf8'));
    f.rate_limit.primary_window = { ...f.rate_limit.primary_window, used_percent: 3, reset_at: f.rate_limit.primary_window.reset_at + 604800 };
    global.__fixtureOther = f;
    await ipc['refresh']();
    await new Promise(r => setTimeout(r, 300));
  }
  const state = global.__sent.filter(s => s[0] === 'usage').pop()?.[1];
  const settings = await ipc['settings:get']();
  await ipc['settings:set']({}, { notifyThresholds: [95, 50, 200, 'x'] });
  const after = await ipc['settings:get']();
  // HISTORY: what the history window gets (HISTORY=<key> picks an account)
  const history = process.env.HISTORY ? await ipc['history:get']({}, process.env.HISTORY === '1' ? undefined : process.env.HISTORY) : undefined;
  // OPEN_HISTORY=<partition>: click that account's name on the widget → history opens on it;
  // then the header button (no account) and the main account's name while it's open
  let openHistory;
  if (process.env.OPEN_HISTORY) {
    ipc['open-history']({}, process.env.OPEN_HISTORY);
    const first = await ipc['history:get']({}, undefined);
    const second = await ipc['history:get']({}, undefined); // the pick is used once
    const selects = () => global.__sent.filter(s => s[0] === 'history:select').map(s => s[1]);
    ipc['open-history']({}, undefined);
    const afterButton = selects();
    ipc['open-history']({}, '');
    openHistory = { first: first.selected, second: second.selected, afterButton, afterMain: selects(),
      windows: global.__windows.filter(w => String(w.file || '').endsWith('history.html')).length };
  }
  const workspaces = process.env.WORKSPACES ? await ipc['settings:list-workspaces']() : undefined;
  const pastedFile = path.join(global.__userData, 'pasted-sessions.bin');
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({
    state, tooltip: global.__tooltip, trayImage: !!global.__trayImage, trayTitle: global.__trayTitle || '', platform: process.platform,
    languages: settings.languages.length, thresholds: after.config.notifyThresholds, signIn: settings.signIn,
    reqs: global.__reqs, paste, workspaces, history, clip, google, openHistory,
    pastedStored: fs.existsSync(pastedFile) ? fs.readFileSync(pastedFile, 'utf8') : null,
    loginWindows: global.__windows.filter(w => String(w.url || '').includes('/auth/login')).length,
    notes: global.__notes || [],
    pasteWindowAfterClick: (() => {
      // Click the sign-in reminder (if any) and report whether the paste window opened
      const n = (global.__noteObjs || []).find(x => x.click);
      if (!n) return null;
      n.click();
      return global.__windows.some(w => String(w.file || '').endsWith('paste.html') && !w.destroyed);
    })(),
    electronOk: !!electron.app,
  }));
  process.exit(0);
}, Number(process.env.WAIT_MS || 800));
