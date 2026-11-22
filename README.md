# Codexage

**English** | [繁體中文](README.zh-TW.md)

A tiny, always-on-top desktop widget that shows your **OpenAI Codex / ChatGPT plan usage limits**: the 5-hour window and the weekly limit, each with a reset countdown.

Windows · macOS · Linux

> **Unofficial.** Codexage is a community project. It is not affiliated with, endorsed by or sponsored by OpenAI. OpenAI, Codex and ChatGPT are trademarks of OpenAI. Codexage reads the same private endpoint (`chatgpt.com/backend-api/wham/usage`) that the open-source Codex client uses for its rate-limit display. That endpoint has no compatibility guarantee and may change without notice.

## Features

- 5-hour and weekly usage bars with reset countdowns. The limit is shared by Codex, ChatGPT Work, Workspace Agents and ChatGPT for Excel
- Works when there is **only a weekly limit** (windows are classified by length, not by position)
- Code review and other extra limits, plus credits, whenever the API reports them
- **Run-out prediction**: "At this pace, runs out in 1h 18m", based on your pace over the last hour
- A **pace marker** on each bar shows how much of the window has elapsed; an unused 5-hour window shows "not started" instead of a frozen countdown
- **Usage history** charts (5-hour over 24 hours, weekly over 7 days) and CSV export
- **Tray icon shows the number** and turns green / amber / red (macOS: menu bar text)
- Notifications at custom thresholds (default 80% / 95%) and when a limit resets, with quiet hours
- **Multiple accounts** in one widget, and a workspace picker for Business / Enterprise users
- Dark / light / system theme, size scaling, opacity, compact mode, click-through mode
- Global hotkey (Ctrl+Alt+X) to show/hide; Ctrl+Alt+Shift+X toggles click-through
- Auto-hide while another app is full screen (Windows, optional); snaps to screen edges; remembers its position
- Retries automatically when offline or the network drops
- Auto-update from GitHub Releases
- 10 languages: English, 繁體中文, 简体中文, 日本語, 한국어, Español, Français, Deutsch, Português (Brasil), Русский. Follows your system language. [Add yours](CONTRIBUTING.md#翻譯--translations)

## Install

Download the latest build from [Releases](../../releases):

| OS | File |
|---|---|
| Windows | `Codexage-x.y.z-win-x64.exe` (installer) or `Codexage-x.y.z-win-x64-portable.exe` (portable) |
| macOS | `Codexage-x.y.z-mac-universal.dmg` |
| Linux | `.AppImage` or `.deb` |

Builds are not code-signed yet:
- **Windows:** in SmartScreen, click *More info → Run anyway*
- **macOS:** right-click the app → *Open* (first launch only)

## Usage

1. Launch Codexage. A ChatGPT sign-in window appears. Sign in, and it closes by itself.
2. The widget now updates every 2 minutes. Drag it by the title bar. Right-click it or the tray icon for options.

### Signing in with Google

Google blocks sign-in inside embedded app windows ("This browser or app may not be secure"). Use **Paste sign-in** instead:

1. Sign in to chatgpt.com in your normal browser.
2. Open `https://chatgpt.com/api/auth/session` in that browser, select all and copy.
3. In Codexage, click **Paste sign-in** (on the widget, in the tray menu, or in Settings) and paste.

The pasted session is stored encrypted with your OS (Windows DPAPI / macOS Keychain / Linux secret store) and only on this computer. It expires after a while; paste it again when the widget asks.

### Data sources

| Mode | How it works |
|---|---|
| ChatGPT account (default) | Sign in inside the app (or paste your session). Reads the access token from `chatgpt.com/api/auth/session`, then calls `chatgpt.com/backend-api/wham/usage` |
| Codex CLI credentials | Reads `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) written by `codex login`. **Read-only**: Codexage never refreshes the token, because that would sign the CLI out. If it expires, run `codex` once |

## Troubleshooting

- **"No Codex usage limits for this account"**: Free plans and API-key accounts have no plan limits.
- **Business / Enterprise with several workspaces**: pick the right one under *Settings → Workspace*.
- **Nothing happens on `npm start`**: Codexage is already running. Quit it from the tray icon (or `taskkill /IM electron.exe /F`) first.
- **`Electron failed to install correctly`** (running from source on Windows): run `npm run fix-electron`.
- When running from source, raw API responses are saved to `debug/` (gitignored, tokens removed, emails and IDs masked). Attach the relevant parts to bug reports after checking them.

## Privacy

- Your sign-in lives only in the app's local profile folder (pasted sessions: encrypted by the OS)
- Requests go only to `chatgpt.com` (and `api.github.com` / GitHub Releases for update checks)
- No telemetry, no analytics, no third-party servers

## Build from source

```bash
npm install
npm start          # run
npm test           # unit + end-to-end tests (no GUI needed)
npm run dist:win   # or dist:mac / dist:linux
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Codexage is not an OpenAI product and does not use OpenAI's logos.
