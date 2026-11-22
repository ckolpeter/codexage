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
      ? JSON.stringify({ user: { email: 'clip@example.com' }, account: { id: 'acc-c', planType: 'pro' }, accessToken: global.__jwt(claims) })
      : process.env.CLIP;
    const seen = await ipc['paste:clipboard']();
    const apply = await ipc['paste:apply-clipboard']({});
    await new Promise(r => setTimeout(r, 300));
    clip = { seen, apply, left: global.__clip };
  }
  const state = global.__sent.filter(s => s[0] === 'usage').pop()?.[1];
  const settings = await ipc['settings:get']();
  await ipc['settings:set']({}, { notifyThresholds: [95, 50, 200, 'x'] });
  const after = await ipc['settings:get']();
  // HISTORY: what the history window gets (HISTORY=<key> picks an account)
  const history = process.env.HISTORY ? await ipc['history:get']({}, process.env.HISTORY === '1' ? undefined : process.env.HISTORY) : undefined;
  const workspaces = process.env.WORKSPACES ? await ipc['settings:list-workspaces']() : undefined;
  const pastedFile = path.join(global.__userData, 'pasted-sessions.bin');
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({
    state, tooltip: global.__tooltip, trayImage: !!global.__trayImage, trayTitle: global.__trayTitle || '', platform: process.platform,
    languages: settings.languages.length, thresholds: after.config.notifyThresholds, signIn: settings.signIn,
    reqs: global.__reqs, paste, workspaces, history, clip,
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
