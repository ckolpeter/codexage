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
    paste = await ipc['paste:apply']({}, process.env.PASTE === 'valid'
      ? 'Pretty-print\n' + JSON.stringify({ user: { email: 'pasted@example.com' }, account: { id: 'acc-p', planType: 'pro' }, accessToken: global.__jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) })
      : process.env.PASTE);
  }
  const state = global.__sent.filter(s => s[0] === 'usage').pop()?.[1];
  const settings = await ipc['settings:get']();
  await ipc['settings:set']({}, { notifyThresholds: [95, 50, 200, 'x'] });
  const after = await ipc['settings:get']();
  const workspaces = process.env.WORKSPACES ? await ipc['settings:list-workspaces']() : undefined;
  const pastedFile = path.join(global.__userData, 'pasted-sessions.bin');
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({
    state, tooltip: global.__tooltip, trayImage: !!global.__trayImage, trayTitle: global.__trayTitle || '', platform: process.platform,
    languages: settings.languages.length, thresholds: after.config.notifyThresholds, signIn: settings.signIn,
    reqs: global.__reqs, paste, workspaces,
    pastedStored: fs.existsSync(pastedFile) ? fs.readFileSync(pastedFile, 'utf8') : null,
    loginWindows: global.__windows.filter(w => String(w.url || '').includes('/auth/login')).length,
    notes: global.__notes || [],
    electronOk: !!electron.app,
  }));
  process.exit(0);
}, Number(process.env.WAIT_MS || 800));
