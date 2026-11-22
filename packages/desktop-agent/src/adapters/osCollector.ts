import { execFile } from 'node:child_process';
import os from 'node:os';
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

async function sampleWindows(): Promise<Partial<WindowSample>> {
  const psScript = [
    '$code = @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public class WinFocus {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);',
    '  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
    '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
    '  public static uint IdleMs() { LASTINPUTINFO lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(lii); GetLastInputInfo(ref lii); return ((uint)Environment.TickCount - lii.dwTime); }',
    '}',
    '"@',
    'Add-Type $code -ErrorAction SilentlyContinue',
    '$h = [WinFocus]::GetForegroundWindow()',
    '$sb = New-Object System.Text.StringBuilder 512',
    '[WinFocus]::GetWindowText($h, $sb, 512) | Out-Null',
    '$pidOut = 0; [WinFocus]::GetWindowThreadProcessId($h, [ref]$pidOut) | Out-Null',
    '$proc = (Get-Process -Id $pidOut -ErrorAction SilentlyContinue).ProcessName',
    '$idleSec = [Math]::Floor([WinFocus]::IdleMs() / 1000)',
    'Write-Output "$proc||$($sb.ToString())||$idleSec"',
  ].join('\n');

  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { timeout: 2500 }
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

  let idleSeconds = 0;
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

  let idleSeconds = 0;
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

  let partial: Partial<WindowSample> = {};
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
