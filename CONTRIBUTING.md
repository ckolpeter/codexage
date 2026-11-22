# Contributing / 貢獻指南

歡迎 PR 與 issue！ PRs and issues are welcome.

## 開發 / Development

```bash
git clone https://github.com/ckolpeter/codexage.git
cd codexage
npm install
npm start
npm test     # 單元測試與完整流程測試 / unit + end-to-end tests (no Electron window needed)
```

Windows 上如果出現 `Electron failed to install correctly`，執行 `npm run fix-electron`。
On Windows, if you see `Electron failed to install correctly`, run `npm run fix-electron`.

- `src/main.js`：main process，負責視窗、系統匣、登入、資料抓取、通知、設定
- `src/usage.js`：解析 `wham/usage` 回應、預測用完時間、解析憑證（純函式，有單元測試）
- `src/history.js` / `src/updater.js` / `src/fullscreen.js`：用量紀錄、自動更新、全螢幕偵測
- `src/preload.js`：contextBridge，renderer 唯一能呼叫的 API
- `src/widget.*` / `src/settings.*` / `src/history.*` / `src/paste.*`：UI（無框架，純 HTML/JS）
- `test/`：`node --test`。`fake-electron.js` 和 `smoke-runner.js` 會在假的 Electron 環境裡執行真正的 `main.js`
- `test/fixtures/`：`wham/usage` 的實際回應格式（已移除個資）
- `scripts/make-icons.js`：產生圖示（原創儀表圖案，不使用 OpenAI 的 logo）

### 看真實回應 / Inspecting real responses

用 `npm start` 執行時，原始回應會存到 `debug/`。這個資料夾已加入 .gitignore，token 已移除，email 和 ID 也已遮蔽。API 格式改變時，先看這裡的檔案，再更新 `src/usage.js` 和 `test/fixtures/`。
When run with `npm start`, raw responses are saved to `debug/` (gitignored; tokens removed, emails and IDs masked).

## 翻譯 / Translations

介面文字都在 `src/locales/*.json`。新增語言 / To add a language：

1. 複製 `src/locales/en.json`，檔名用語言代碼，例如 `it.json`
2. 把 `_name` 改成該語言的自稱（例如 `Italiano`），翻譯所有值；`{變數}` 保持原樣
3. 更新 `test/misc.test.js` 裡的語言清單，執行 `npm test`
4. `npm start`，右鍵小工具 → Language 選擇新語言，確認顯示正常
5. 發 PR

缺少的 key 會自動使用英文。Missing keys fall back to English.

## 原則 / Principles

1. **隱私優先**：登入資料只能送往 `chatgpt.com`，不得加入任何遙測或第三方服務。
2. **不碰 Codex CLI 的 token**：只讀取 `auth.json`，絕不更新或寫回（refresh token 每用一次就會換新）。
3. **對 OpenAI 友善**：預設更新間隔 120 秒，最少 30 秒。
4. **安全預設**：維持 `contextIsolation: true`、`sandbox: true`，renderer 不可直接存取 Node。
5. **零框架**：UI 保持輕量，新增相依套件前請先開 issue 討論。
6. **非官方**：名稱、圖示與文案不得暗示是 OpenAI 的產品，也不得使用 OpenAI 的 logo。

## 發佈 / Releasing（維護者）

1. 寫 `docs/releases/vX.Y.Z.md`（中英雙語 Release 說明，格式參考既有檔案）並 commit
2. 建立版本並推送：

```bash
npm version patch   # 或 minor / major，會 commit 版本號並建立 vX.Y.Z 標籤
git push origin main --follow-tags
```

GitHub Actions 會在三個平台建置並上傳到 Release 草稿；三個平台都成功、且 `latest*.yml` 都在時，會用 `docs/releases/vX.Y.Z.md` 當說明自動正式發佈。找不到說明檔時會保留為草稿，需手動發佈。

Write `docs/releases/vX.Y.Z.md` first, then `npm version` + push. CI builds all three platforms and publishes the release with those notes once every build succeeded (it stays a draft if the notes file is missing).
