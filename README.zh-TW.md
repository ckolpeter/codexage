# Codexage

[English](README.md) | **繁體中文**

一個永遠在最上層的桌面小工具，顯示你的 **OpenAI Codex / ChatGPT 訂閱方案使用量**：5 小時額度與每週額度，以及各自的重置倒數。

Windows · macOS · Linux

> **非官方專案。** Codexage 是社群專案，與 OpenAI 無關，也未獲得 OpenAI 的認可或贊助。OpenAI、Codex、ChatGPT 為 OpenAI 的商標。Codexage 讀取的是開源 Codex 客戶端顯示額度時所用的同一個非公開端點（`chatgpt.com/backend-api/wham/usage`），這個端點沒有相容性保證，隨時可能變更。

## 功能

- 5 小時與每週用量條，附重置倒數。這個額度由 Codex、ChatGPT Work、Workspace Agents、ChatGPT for Excel 共用
- **只有每週額度**時也能正確顯示（依時段長度判斷，不依欄位位置）
- API 有提供時，也會顯示程式碼審查等額外額度、點數，以及剩餘的**額度重置次數**（在 Codex CLI 輸入 `/usage` 使用）
- 額度用完時顯示**原因**（個人額度、工作區點數用完、或工作區設定的上限）、哪些模型暫時不能用及恢復時間；額度重置即將到期時提醒你。Business／Enterprise 會顯示**每月點數上限**（「已用 8,000 / 25,000 點」）
- **用完時間預測**：「照目前速度，1 小時 18 分後用完」，依最近一小時的速度估算
- 每條用量條上的**時間進度刻度**顯示時段已過多少；還沒用過的 5 小時額度會顯示「尚未開始計時」，不會出現卡住的倒數
- **用量歷史圖**（5 小時用量看 24 小時、每週用量看 7 天），可匯出 CSV
- **系統匣圖示顯示百分比**，並依用量變成綠／黃／紅（macOS 顯示在選單列）
- 自訂通知門檻（預設 80%／95%）、額度重置通知、勿擾時段
- **多帳號**同時顯示；Business／Enterprise 使用者可選擇工作區
- 深色／亮色／跟隨系統主題、大小縮放、不透明度、精簡模式、滑鼠穿透
- 全域快捷鍵（Ctrl+Alt+X）顯示／隱藏；Ctrl+Alt+Shift+X 切換滑鼠穿透
- 其他程式全螢幕時自動隱藏（Windows，可選）；拖曳時貼齊螢幕邊緣；記住位置
- 離線或斷線時自動重試
- 從 GitHub Releases 自動更新
- 10 種語言：English、繁體中文、简体中文、日本語、한국어、Español、Français、Deutsch、Português (Brasil)、Русский，預設跟隨系統語言。[新增語言](CONTRIBUTING.md#翻譯--translations)

## 安裝

到 [Releases](../../releases) 下載最新版：

| 系統 | 檔案 |
|---|---|
| Windows | `Codexage-x.y.z-win-x64.exe`（安裝版）或 `Codexage-x.y.z-win-x64-portable.exe`（免安裝版） |
| macOS | `Codexage-x.y.z-mac-universal.dmg` |
| Linux | `.AppImage` 或 `.deb` |

目前尚未做程式碼簽章：
- **Windows：** SmartScreen 出現時按「其他資訊 → 仍要執行」
- **macOS：** 第一次開啟時對 App 按右鍵 →「打開」

## 使用方式

1. 啟動 Codexage，會出現 ChatGPT 登入視窗，登入後會自動關閉。
2. 小工具每 2 分鐘更新一次。拖曳標題列可移動，對小工具或系統匣圖示按右鍵可開啟選單。

### 用 Google 帳號登入

Google 會封鎖 App 內嵌的登入視窗（「這個瀏覽器或應用程式可能有安全疑慮」）。請改用**貼上登入資料**：

1. 在平常使用的瀏覽器登入 chatgpt.com。
2. 在同一個瀏覽器開啟 `https://chatgpt.com/api/auth/session`，全選並複製。
3. 在 Codexage 按「**貼上登入資料**」（小工具上、系統匣選單或設定裡都有），貼上即可。

貼上的登入資料會用作業系統的加密功能（Windows DPAPI／macOS 鑰匙圈／Linux secret store）保存，只存在這台電腦。它過一段時間會過期；過期前一兩天，Codexage 會發出通知，小工具上也會出現「重新貼上」連結。

### 資料來源

| 模式 | 運作方式 |
|---|---|
| ChatGPT 帳號（預設） | 在 App 內登入（或貼上登入資料），從 `chatgpt.com/api/auth/session` 取得 access token，再呼叫 `chatgpt.com/backend-api/wham/usage` |
| Codex CLI 憑證 | 讀取 `codex login` 產生的 `~/.codex/auth.json`（或 `$CODEX_HOME/auth.json`）。**只讀取**：Codexage 不會幫它更新 token，否則會讓 Codex CLI 被登出。過期時請執行一次 `codex` |

## 疑難排解

- **「這個帳號沒有 Codex 使用額度」**：免費方案和 API 金鑰帳號沒有方案額度。
- **Business／Enterprise 有多個工作區**：到「設定 → 工作區」選擇正確的工作區。
- **`npm start` 沒反應**：Codexage 已經在執行中。先從系統匣圖示結束它（或執行 `taskkill /IM electron.exe /F`）。
- **`Electron failed to install correctly`**（Windows 從原始碼執行時）：執行 `npm run fix-electron`。
- 從原始碼執行時，原始 API 回應會存到 `debug/`（已加入 .gitignore，token 已移除，email 和 ID 已遮蔽）。回報問題時，請先自行檢查內容再附上相關部分。

## 隱私

- 登入資料只存在 App 的本機設定資料夾（貼上的登入資料由作業系統加密）
- 連線對象只有 `chatgpt.com`（檢查更新時另外連到 `api.github.com`／GitHub Releases）
- 沒有遙測、沒有分析、沒有第三方伺服器

## 從原始碼建置

```bash
npm install
npm start          # 執行
npm test           # 單元測試與完整流程測試（不需要開視窗）
npm run dist:win   # 或 dist:mac / dist:linux
```

詳見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權

[MIT](LICENSE)。Codexage 不是 OpenAI 的產品，也沒有使用 OpenAI 的 logo。
