'use strict';
/**
 * Updates from GitHub Releases.
 *
 * - Windows installer / Linux AppImage: electron-updater downloads the update in the
 *   background; the user restarts from the tray menu (or it installs on quit).
 * - macOS (unsigned builds can't self-update), Windows portable, or if electron-updater
 *   fails: check the GitHub API and offer a link to the release page.
 * - Running from source (npm start): does nothing.
 */
const { app, shell } = require('electron');
const { newer } = require('./version');

const REPO = 'ckolpeter/codexage';
const CHECK_EVERY_MS = 6 * 3600e3;

class Updater {
  /** onChange(status) is called whenever there's something to show in the menu */
  constructor(onChange) {
    this.onChange = onChange;
    this.status = { state: 'idle' }; // idle | available | downloaded
    this.timer = null;
    this.au = null;
  }

  get canSelfUpdate() {
    if (process.platform === 'darwin') return false;
    if (process.env.PORTABLE_EXECUTABLE_DIR) return false; // Windows portable build
    if (process.platform === 'linux' && !process.env.APPIMAGE) return false; // .deb: use the package manager
    return true;
  }

  start(enabled) {
    clearInterval(this.timer);
    if (!enabled || !app.isPackaged) return;
    if (this.canSelfUpdate) {
      try {
        const { autoUpdater } = require('electron-updater');
        this.au = autoUpdater;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.on('update-downloaded', (info) => this.set({ state: 'downloaded', version: info.version }));
        autoUpdater.on('error', (e) => { console.error('[updater]', e); this.au = null; this.checkGitHub(); });
      } catch (e) {
        console.error('[updater] electron-updater unavailable', e);
        this.au = null;
      }
    }
    this.check();
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  check() {
    if (this.status.state === 'downloaded') return;
    if (this.au) this.au.checkForUpdates().catch(() => this.checkGitHub());
    else this.checkGitHub();
  }

  async checkGitHub() {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `codexage/${app.getVersion()}` },
      });
      if (!r.ok) return;
      const rel = await r.json();
      if (rel.tag_name && newer(rel.tag_name, app.getVersion())) {
        this.set({ state: 'available', version: rel.tag_name.replace(/^v/, ''), url: rel.html_url });
      }
    } catch (e) { console.error('[updater] github', e); }
  }

  set(status) { this.status = status; this.onChange?.(status); }

  /** Action for the tray menu item */
  apply() {
    if (this.status.state === 'downloaded' && this.au) this.au.quitAndInstall();
    else if (this.status.url) shell.openExternal(this.status.url);
    else shell.openExternal(`https://github.com/${REPO}/releases/latest`);
  }
}

module.exports = { Updater, newer };
