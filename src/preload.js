'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  i18n: () => ipcRenderer.invoke('i18n'),
  // 小工具
  getState: () => ipcRenderer.invoke('get-state'),
  onUsage: (cb) => ipcRenderer.on('usage', (_e, state, opts) => cb(state, opts)),
  refresh: () => ipcRenderer.send('refresh'),
  login: () => ipcRenderer.send('login'),
  useSource: (src) => ipcRenderer.send('use-source', src),
  openSettings: () => ipcRenderer.send('open-settings'),
  openHistory: () => ipcRenderer.send('open-history'),
  openIssue: () => ipcRenderer.send('open-issue'),
  hide: () => ipcRenderer.send('hide'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  toggleCompact: () => ipcRenderer.send('toggle-compact'),
  resize: (h) => ipcRenderer.send('resize', h),
  // 貼上登入資料（part：帳號的 partition，省略 = 主帳號）
  paste: {
    open: (part) => ipcRenderer.send('paste:open', part),
    apply: (text, part) => ipcRenderer.invoke('paste:apply', text, part),
    clipboard: () => ipcRenderer.invoke('paste:clipboard'),
    applyClipboard: (part) => ipcRenderer.invoke('paste:apply-clipboard', part),
    openSessionPage: () => ipcRenderer.send('paste:open-session-page'),
  },
  history: {
    get: (acct) => ipcRenderer.invoke('history:get', acct),
    clear: () => ipcRenderer.invoke('history:clear'),
    exportCSV: () => ipcRenderer.invoke('history:export'),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: () => ipcRenderer.send('accounts:add'),
    addByPaste: () => ipcRenderer.invoke('accounts:add-paste'),
    login: (part) => ipcRenderer.send('accounts:login', part),
    paste: (part) => ipcRenderer.send('accounts:paste', part),
    setLabel: (part, label) => ipcRenderer.invoke('accounts:set-label', part, label),
    remove: (part) => ipcRenderer.invoke('accounts:remove', part),
  },
  // 設定視窗
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    listWorkspaces: () => ipcRenderer.invoke('settings:list-workspaces'),
    login: () => ipcRenderer.send('settings:login'),
    logout: () => ipcRenderer.send('settings:logout'),
  },
});
