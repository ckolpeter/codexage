# Codexage — project guide for Claude Code

Unofficial, open-source floating desktop widget (Electron) that shows **OpenAI Codex / ChatGPT plan usage limits**: the 5-hour window, the weekly limit, extra limits (code review, …), reset countdowns, and more. Windows / macOS / Linux. MIT. Repo: https://github.com/ckolpeter/codexage

Sister project: Clausage (same architecture, for Claude) — https://github.com/ckolpeter/clausage. Port fixes between the two.

Personal environment notes and current status may be in `CLAUDE.local.md` (gitignored) — read it too.

## Layout

| Path | What |
|---|---|
| `src/main.js` | Main process: windows, tray, sign-in (web / pasted / Codex CLI), fetching, refresh loop, notifications, IPC, settings |
| `src/usage.js` | **Pure** parsing (`normalize`, `addEta`, `hasUsage`, `classify`, `parseCodexAuth`, `parsePastedSession`, `parseAccountsCheck`, `redact`). No Electron imports — unit-tested |
| `src/history.js` | Local usage history (8 days, `<userData>/history.json`), recent-rate calc, CSV export |
| `src/updater.js` / `src/version.js` | Auto-update (electron-updater on Win installer / AppImage; GitHub API link elsewhere) |
| `src/fullscreen.js` | Windows full-screen detection via one long-lived hidden PowerShell (user32) |
| `src/preload.js` | contextBridge — the only API renderers can call |
| `src/widget.*`, `src/settings.*`, `src/paste.*`, `src/history.html` + `history-view.js` | Renderer UIs (plain HTML/JS, no framework) |
| `src/locales/*.json` | 10 languages: en, zh-TW, zh-CN, ja, ko, es, fr, de, pt-BR, ru |
| `test/` | `node --test` unit tests + `smoke.test.js` (runs real `main.js` against `test/fake-electron.js`) |
| `scripts/fix-electron.ps1` | Repairs a broken Electron install on Windows (`npm run fix-electron`) |
| `scripts/make-icons.js` | Generates `assets/*.png` (original gauge design — never use OpenAI logos) |

## Data source (undocumented — may change any time)

`GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access token>` and `chatgpt-account-id: <workspace id>`. This is what the open-source Codex client (`codex-rs/backend-client`, `rate_limit_status_url`) uses.

- Response: `plan_type`, `rate_limit { allowed, limit_reached, primary_window, secondary_window }`, `code_review_rate_limit`, `additional_rate_limits[]`, `credits`, `spend_control`, `rate_limit_reached_type`, `model_usage`, `rate_limit_reset_credits`, `promo`. Window = `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at (unix s) }`. Real sample: `test/fixtures/usage-plus-real.json`.
- **primary ≠ 5-hour.** Classify windows by `limit_window_seconds` (≈18000 → `five_hour`, ≈604800 → `seven_day`, else `win:<s>`), like Codex's own UI does. OpenAI has run with only a weekly window — that must keep working (`weeklyOnly`, tray falls back to weekly).
- An unused window reports `used_percent: 0` and `reset_after_seconds == limit_window_seconds` on every call → `idle: true`, no countdown.
- Workspaces: `GET /backend-api/wham/accounts/check` (`accounts` is a list *or* a map + `account_ordering`).

Where the token comes from (`config.source`):
- **web (default):** sign in inside the app (partition `persist:chatgpt`; extra accounts `persist:chatgpt-acct-*`), session cookie `__Secure-next-auth.session-token` (may be chunked `.0`/`.1`) → `GET /api/auth/session` → `accessToken`. `session.fetch` first, hidden-page fetch if Cloudflare answers with HTML.
- **pasted (fallback for web):** Google blocks sign-in in embedded browsers, so the user can paste `chatgpt.com/api/auth/session` from their own browser. Stored per partition in `<userData>/pasted-sessions.bin`, encrypted with `safeStorage` (memory-only if unavailable). Cookie sign-in wins over a pasted session.
- **cli:** `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) → `tokens.access_token` / `tokens.account_id`. **Read-only. Never refresh or write it** — refresh tokens rotate and refreshing here would sign the CLI out. Expired → ask the user to run `codex` once.
- From source, raw responses are dumped to `debug/` through `usage.redact()` (tokens removed, emails/ids masked). Disabled under `CODEXAGE_TEST`.

## Conventions

- Privacy: requests go only to chatgpt.com / GitHub (updates). No telemetry. Never log tokens/cookies; anything written to `debug/` goes through `redact()`.
- Keep `contextIsolation: true`, `sandbox: true`; renderers use `textContent`/`esc()` for any data.
- Polling default 120 s, min 30 s. Failures retry with backoff 15/30/60 s; offline uses `net.isOnline()`.
- Every user-facing string goes through i18n. **Add new keys to all 10 locale files** with identical `{placeholders}` — `test/misc.test.js` enforces this and that every key used in `src/` exists. Errors carry i18n keys (`AppError(key, vars)`), not text.
- All notifications go through `notify()` so quiet hours apply.
- Platform differences are expected: macOS shows the tray number as menu-bar text (`tray.setTitle`), Windows/Linux draw it into the icon. Tests must not assume one behaviour — use `SIM_PLATFORM=darwin|win32` in the smoke runner.
- Branding: "Codexage", unofficial. Never use OpenAI logos or imply it's an OpenAI product.

## Commands

```bash
npm start              # run from source
npm test               # unit + smoke tests (no GUI/Electron binary needed)
npm run fix-electron   # Windows: repair a half-extracted Electron
npm run dist:win:local # Windows installer reusing node_modules/electron/dist (no Electron download)
npm run dist:win | dist:mac | dist:linux
```

Release: write bilingual notes in `docs/releases/vX.Y.Z.md` and commit → `npm version patch|minor|major` → `git push origin main --follow-tags`. GitHub Actions builds all 3 platforms into a draft, then the `publish` job publishes it with those notes once every build succeeded and `latest*.yml` are present (no notes file → stays a draft). Afterwards verify assets + `latest*.yml` via the public API (`/releases/latest`, `releases/latest/download/latest.yml`). Don't release docs-only changes.

## Known pitfalls (same as Clausage)

- **Lockfile:** after changing dependencies, run `npm install` and commit `package-lock.json`; CI uses `npm ci`.
- **npm 11 `allowScripts`:** install scripts are blocked unless listed in `package.json` → `allowScripts` (electron, electron-winstaller).
- **Electron on Node 26 (Windows):** postinstall unzip can stop silently → `npm run fix-electron`.
- **Slow GitHub downloads:** `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`, `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.
- **PowerShell** splits `-c.foo=bar` at the dot — put electron-builder overrides in npm scripts.
- **Single instance:** `npm start` exits if Codexage is already running — quit it from the tray or `taskkill /IM electron.exe /F`.
- Windows installer and portable builds need different file names (`portable.artifactName`) or the portable overwrites the installer and `latest.yml`.
- Linux `.deb` needs `author.email` / `linux.maintainer` (we use `ckolpeter@users.noreply.github.com`).
- macOS builds are unsigned → can't self-update; updater falls back to a release link.
