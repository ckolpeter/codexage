# Security Policy

Codexage keeps your ChatGPT sign-in only on your machine: in the local Electron profile, or (for pasted sessions) encrypted with the OS (Windows DPAPI / macOS Keychain / Linux secret store). In Codex CLI mode it only reads `~/.codex/auth.json` and never writes to it. Tokens are sent nowhere except `chatgpt.com`.

If you find a security issue (e.g. credentials leaking to logs, the debug folder, other hosts, or other apps), **please do not open a public issue**. Use GitHub's private vulnerability reporting: *Security → Report a vulnerability* on this repository.

如果發現資安問題（例如憑證外洩到記錄檔、debug 資料夾、其他主機或其他程式），請勿公開開 issue，改用本儲存庫的 *Security → Report a vulnerability* 私下回報。
