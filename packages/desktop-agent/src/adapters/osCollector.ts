import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type AgentOSPlatform = 'windows' | 'macos' | 'linux' | 'vdi';

export interface WindowSample {
  app: string;
  windowTitle: string;
  filePath: string | null;
  idleSeconds: number;
  meetingActive: boolean;
  osPlatform: AgentOSPlatform;
  isVirtualDesktop: boolean;
}

const MEETING_APP_PATTERN = /zoom|microsoft teams|teams|webex|google meet|slack huddle/i;

function isRDPSession(): boolean {
  const sessionName = (process.env.SESSIONNAME || '').toLowerCase();
  const display = (process.env.DISPLAY || '').toLowerCase();
  return (
    sessionName.startsWith('rdp-') ||
    sessionName.startsWith('ica-') ||
    Boolean(process.env.CITRIX_SESSION_ID) ||
    display.includes(':10')
  );
}

const WIN_PROBE_EXE = path.join(os.tmpdir(), 'ontrack-win-focus-v1.exe');

async function ensureWindowsProbeBinary(): Promise<boolean> {
  if (fs.existsSync(WIN_PROBE_EXE)) return true;
  const csCode = [
    'using System;',
    'using System.Diagnostics;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public static class WinFocus {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
    '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
    '  public static void Main() {',
    '    IntPtr h = GetForegroundWindow();',
    '    StringBuilder sb = new StringBuilder(512);',
    '    GetWindowText(h, sb, 512);',
    '    uint pid = 0; GetWindowThreadProcessId(h, out pid);',
    '    string proc = "Windows App";',
    '    try { if (pid > 0) proc = Process.GetProcessById((int)pid).ProcessName; } catch {}',
    '    LASTINPUTINFO lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));',
    '    GetLastInputInfo(ref lii);',
    '    uint idleSec = ((uint)Environment.TickCount - lii.dwTime) / 1000;',
    '    Console.WriteLine(proc + "||" + sb.ToString() + "||" + idleSec);',
    '  }',
    '}',
  ].join('\n');

  const compileScript = `Add-Type -TypeDefinition @'\n${csCode}\n'@ -OutputAssembly '${WIN_PROBE_EXE.replace(/'/g, "''")}' -OutputType ConsoleApplication`;
  try {
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', compileScript],
      { timeout: 10000 }
    );
    return fs.existsSync(WIN_PROBE_EXE);
  } catch {
    return false;
  }
}

async function sampleWindows(): Promise<Partial<WindowSample>> {
  const hasBinary = await ensureWindowsProbeBinary();
  if (hasBinary) {
    const { stdout } = await execFileAsync(WIN_PROBE_EXE, [], { timeout: 1200 });
    const [appRaw = 'Unknown', titleRaw = '', idleRaw = '0'] = stdout.trim().split('||');
    return {
      app: appRaw.trim() || 'Windows App',
      windowTitle: titleRaw.trim() || 'Active Window',
      idleSeconds: Number.parseInt(idleRaw, 10) || 0,
    };
  }

  const fallbackPs = [
    '$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'Write-Output "$($p.ProcessName)||$($p.MainWindowTitle)||0"',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', fallbackPs],
    { timeout: 2000 }
  );
  const [appRaw = 'Unknown', titleRaw = '', idleRaw = '0'] = stdout.trim().split('||');
  return {
    app: appRaw.trim() || 'Windows App',
    windowTitle: titleRaw.trim() || 'Active Window',
    idleSeconds: Number.parseInt(idleRaw, 10) || 0,
  };
}

async function sampleMacOS(): Promise<Partial<WindowSample>> {
  const script = `
    tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
      set winTitle to ""
      try
        set winTitle to name of front window of application process frontApp
      end try
      return frontApp & "||" & winTitle
    end tell
  `;
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 2000 });
  const [appRaw = 'Unknown', titleRaw = ''] = stdout.trim().split('||');

  let idleSeconds: number;
  try {
    const { stdout: ioOut } = await execFileAsync(
      'sh',
      ['-c', 'ioreg -c IOHIDSystem | awk \'/HIDIdleTime/ {print int($NF/1000000000); exit}\''],
      { timeout: 1200 }
    );
    idleSeconds = Number.parseInt(ioOut.trim(), 10) || 0;
  } catch {
    idleSeconds = 0;
  }

  return {
    app: appRaw.trim() || 'macOS App',
    windowTitle: titleRaw.trim() || appRaw.trim(),
    idleSeconds,
  };
}

async function sampleLinux(): Promise<Partial<WindowSample>> {
  const { stdout } = await execFileAsync(
    'sh',
    ['-c', 'xdotool getactivewindow getwindowname 2>/dev/null || echo "Active Window"'],
    { timeout: 1500 }
  );
  const title = stdout.trim() || 'Linux Workspace';

  let idleSeconds: number;
  try {
    const { stdout: idleOut } = await execFileAsync(
      'sh',
      ['-c', 'xprintidle 2>/dev/null || echo "0"'],
      { timeout: 1000 }
    );
    const ms = Number.parseInt(idleOut.trim(), 10) || 0;
    idleSeconds = Math.floor(ms / 1000);
  } catch {
    idleSeconds = 0;
  }

  return {
    app: title.split(' - ').pop() || 'Desktop App',
    windowTitle: title,
    idleSeconds,
  };
}

/**
 * Cross-Platform OS Activity Adapter:
 * Captures metadata ONLY (foreground app, window title, idle state, meeting detection).
 * Never captures screenshots, keystrokes, clipboard, or document contents.
 */
export async function captureForegroundMetadata(): Promise<WindowSample> {
  const platform = os.platform();
  const virtualDesktop = isRDPSession();
  const osPlatform: AgentOSPlatform = virtualDesktop
    ? 'vdi'
    : platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
    ? 'macos'
    : 'linux';

  let partial: Partial<WindowSample>;
  try {
    if (platform === 'win32') partial = await sampleWindows();
    else if (platform === 'darwin') partial = await sampleMacOS();
    else partial = await sampleLinux();
  } catch {
    partial = {
      app: osPlatform === 'vdi' ? 'Remote Desktop Session' : 'Workstation App',
      windowTitle: `${os.hostname()} Active Session`,
      idleSeconds: 0,
    };
  }

  const app = partial.app || 'Workstation';
  const windowTitle = partial.windowTitle || app;
  const fileMatch = windowTitle.match(/([\w .-]+\.(?:xlsx|xls|pdf|docx|qbw|csv))/i);

  return {
    app,
    windowTitle,
    filePath: fileMatch ? fileMatch[1] : null,
    idleSeconds: partial.idleSeconds ?? 0,
    meetingActive: MEETING_APP_PATTERN.test(`${app} ${windowTitle}`),
    osPlatform,
    isVirtualDesktop: virtualDesktop,
  };
}
