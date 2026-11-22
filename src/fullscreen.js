'use strict';
/**
 * Detects when another app is full screen, so the widget can step aside
 * (games, presentations, full-screen video).
 *
 * - Windows: one long-lived hidden PowerShell process checks the foreground window
 *   every 1.5 s via user32 (GetForegroundWindow / GetWindowRect / GetMonitorInfo)
 *   and prints 1 or 0. No native modules needed.
 * - macOS: not needed here; main.js sets visibleOnFullScreen=false instead and
 *   macOS hides the widget on full-screen Spaces by itself.
 * - Linux: not supported (no-op).
 */
const { spawn } = require('child_process');

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexageFS {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  public static int Check() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero || h == GetShellWindow()) return 0;
    var cls = new StringBuilder(256); GetClassName(h, cls, 256);
    string c = cls.ToString();
    if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd") return 0; // desktop / taskbar
    const int GWL_STYLE = -16; const int WS_CAPTION = 0x00C00000;
    if ((GetWindowLong(h, GWL_STYLE) & WS_CAPTION) == WS_CAPTION) return 0; // normal / maximized windows keep a title bar
    RECT r; if (!GetWindowRect(h, out r)) return 0;
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return 0;
    var m = mi.rcMonitor;
    return (r.L <= m.L && r.T <= m.T && r.R >= m.R && r.B >= m.B) ? 1 : 0;
  }
}
"@
while ($true) {
  [Console]::Out.WriteLine([CodexageFS]::Check())
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1500
}
`;

class FullscreenWatcher {
  /** onChange(isFullscreen) fires only when the state flips */
  constructor(onChange) {
    this.onChange = onChange;
    this.proc = null;
    this.state = false;
    this.buf = '';
  }

  get supported() { return process.platform === 'win32'; }

  start() {
    if (!this.supported || this.proc) return;
    const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
    try {
      this.proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { console.error('[fullscreen]', e); this.proc = null; return; }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      const lines = this.buf.split(/\r?\n/);
      this.buf = lines.pop();
      const last = lines.filter(Boolean).pop();
      if (last == null) return;
      const fs = last.trim() === '1';
      if (fs !== this.state) { this.state = fs; this.onChange?.(fs); }
    });
    this.proc.on('exit', () => {
      this.proc = null;
      if (this.state) { this.state = false; this.onChange?.(false); }
    });
    this.proc.on('error', (e) => { console.error('[fullscreen]', e); this.proc = null; });
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* already gone */ } this.proc = null; }
    if (this.state) { this.state = false; this.onChange?.(false); }
  }
}

module.exports = { FullscreenWatcher };
