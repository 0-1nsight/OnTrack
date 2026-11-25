import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectMeeting, friendlyAppName } from './appNames.ts';

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
  sessionLocked: boolean;
  systemSleeping?: boolean;
  mediaInUse: boolean;
  virtualDesktopId: string | null;
  /** macOS: false when window titles are blocked by the Accessibility permission. */
  accessibilityGranted?: boolean;
  linuxSession?: 'x11' | 'wayland' | 'unknown';
  /** True when the OS probe failed; the other fields are placeholders and must not be recorded. */
  collectorFailed: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr?: string;
}

export type ExecRunner = (
  file: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<CommandResult>;

export interface OsCollectorDeps {
  exec?: ExecRunner;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  hostname?: string;
  readFileSync?: (filePath: string, encoding: BufferEncoding) => string;
}

const defaultExec: ExecRunner = async (file, args, options) => {
  const res = await execFileAsync(file, args, options);
  return { stdout: String(res.stdout ?? ''), stderr: String(res.stderr ?? '') };
};

function isRDPSession(env: Record<string, string | undefined>): boolean {
  const sessionName = (env.SESSIONNAME || '').toLowerCase();
  const display = (env.DISPLAY || '').toLowerCase();
  return (
    sessionName.startsWith('rdp-') ||
    sessionName.startsWith('ica-') ||
    Boolean(env.CITRIX_SESSION_ID) ||
    display.includes(':10')
  );
}

/**
 * Normalizes a metadata-only file URL or native path (from AXDocument or window title),
 * stripping personal user-home prefixes (/Users/<name>/, /home/<name>/) while preserving
 * relative workpaper folder hints (e.g. Clients/Acme_Ltd/Tax.xlsx). Never reads file contents.
 */
export function normalizeDocumentPath(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  let cleaned = rawPath.trim();
  if (!cleaned || cleaned === 'missing value' || cleaned === 'null') return null;

  if (/^file:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^file:\/\/(?:localhost)?/i, '');
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Keep undecoded path if percent-encoding is malformed
    }
  }

  cleaned = cleaned.replace(/^\/Users\/[^/]+\//i, '');
  cleaned = cleaned.replace(/^\/home\/[^/]+\//i, '');
  cleaned = cleaned.replace(/^[A-Za-z]:\\Users\\[^\\]+\\/i, '');
  cleaned = cleaned.replace(/^~\//, '');
  cleaned = cleaned.replace(/^\/+/, '');
  cleaned = cleaned.trim();

  if (!cleaned || /^untitled(\.\w+)?$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

const WIN_PROBE_EXE = path.join(os.tmpdir(), 'ontrack-win-focus-v1.exe');

async function ensureWindowsProbeBinary(exec: ExecRunner): Promise<boolean> {
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
    await exec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', compileScript],
      { timeout: 10000 }
    );
    return fs.existsSync(WIN_PROBE_EXE);
  } catch {
    return false;
  }
}

async function sampleWindows(exec: ExecRunner): Promise<Partial<WindowSample>> {
  const hasBinary = await ensureWindowsProbeBinary(exec);
  if (hasBinary) {
    const { stdout } = await exec(WIN_PROBE_EXE, [], { timeout: 1200 });
    const [appRaw = 'Unknown', titleRaw = '', idleRaw = '0'] = stdout.trim().split('||');
    return {
      app: friendlyAppName(appRaw, 'Windows App'),
      windowTitle: titleRaw.trim() || 'Active Window',
      idleSeconds: Number.parseInt(idleRaw, 10) || 0,
      systemSleeping: false,
      mediaInUse: false,
    };
  }

  const fallbackPs = [
    '$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'Write-Output "$($p.ProcessName)||$($p.MainWindowTitle)||0"',
  ].join('; ');
  const { stdout } = await exec(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', fallbackPs],
    { timeout: 2000 }
  );
  const [appRaw = 'Unknown', titleRaw = '', idleRaw = '0'] = stdout.trim().split('||');
  return {
    app: friendlyAppName(appRaw, 'Windows App'),
    windowTitle: titleRaw.trim() || 'Active Window',
    idleSeconds: Number.parseInt(idleRaw, 10) || 0,
    systemSleeping: false,
    mediaInUse: false,
  };
}

export async function sampleMacOSWithRunner(
  exec: ExecRunner = defaultExec
): Promise<Partial<WindowSample>> {
  const script = `
    tell application "System Events"
      set frontProc to first application process whose frontmost is true
      set frontApp to name of frontProc
      set winTitle to ""
      set docPath to ""
      set axState to "ok"
      try
        set winObj to front window of frontProc
        set winTitle to name of winObj
        try
          set docAttr to value of attribute "AXDocument" of winObj
          if docAttr is not missing value then set docPath to (docAttr as text)
        end try
      on error errMsg number errNum
        if errNum is -25211 or errNum is -1719 then set axState to "denied"
      end try
    end tell
    if docPath is "" and axState is "ok" then
      try
        if frontApp is "Preview" then
          tell application "Preview" to set docPath to path of document of front window
        else if frontApp is "Microsoft Excel" then
          tell application "Microsoft Excel" to set docPath to full name of active workbook
        else if frontApp is "Microsoft Word" then
          tell application "Microsoft Word" to set docPath to full name of active document
        else if frontApp is "Finder" then
          tell application "Finder" to set docPath to POSIX path of (target of front window as alias)
        else if frontApp contains "Acrobat" then
          tell application "Adobe Acrobat" to set docPath to file alias of active doc as text
        end if
      end try
    end if
    return frontApp & "||" & winTitle & "||" & docPath & "||" & axState
  `;

  const { stdout } = await exec('osascript', ['-e', script], { timeout: 2200 });
  const parts = stdout.trim().split('||');
  const appRaw = (parts[0] || '').trim();
  if (!appRaw) {
    throw new Error('macOS collector returned empty foreground application');
  }

  let titleRaw = '';
  let docRaw = '';
  let axRaw = 'ok';
  if (parts.length >= 4) {
    titleRaw = parts[1] || '';
    docRaw = parts[2] || '';
    axRaw = parts[3] || 'ok';
  } else {
    titleRaw = parts[1] || '';
    axRaw = parts[2] || 'ok';
  }

  const normalizedApp = friendlyAppName(appRaw, 'macOS App');
  const accessibilityGranted = axRaw.trim() !== 'denied';

  let idleSeconds = 0;
  try {
    const { stdout: ioOut } = await exec(
      'sh',
      ['-c', 'ioreg -c IOHIDSystem | awk \'/HIDIdleTime/ {print int($NF/1000000000); exit}\''],
      { timeout: 1200 }
    );
    idleSeconds = Math.max(0, Number.parseInt(ioOut.trim(), 10) || 0);
  } catch {
    idleSeconds = 0;
  }

  let sessionLocked = false;
  try {
    const { stdout: lockOut } = await exec(
      'sh',
      ['-c', 'ioreg -n Root -d1 -a | grep -c "CGSSessionScreenIsLocked" || true'],
      { timeout: 1200 }
    );
    sessionLocked = Number.parseInt(lockOut.trim(), 10) > 0;
  } catch {
    sessionLocked = false;
  }

  let systemSleeping = false;
  let mediaInUse = false;
  try {
    const { stdout: pmOut } = await exec('pmset', ['-g', 'assertions'], { timeout: 1200 });
    const lowerPm = pmOut.toLowerCase();
    if (/preventuseridle(system)?sleep|coreaudiod|audio|microphone|camera/i.test(lowerPm)) {
      if (/(coreaudiod|applehdaengineinput|zoom|teams|webex|slack|faceTime|avcapture)/i.test(lowerPm)) {
        mediaInUse = true;
      }
    }
    if (/current power state:\s*0|display is asleep/i.test(lowerPm)) {
      systemSleeping = true;
    }
  } catch {
    // ignore pmset failure
  }

  if (!systemSleeping) {
    try {
      const { stdout: dispOut } = await exec(
        'sh',
        ['-c', 'ioreg -n IODisplayWrangler | grep -i DevicePowerState || true'],
        { timeout: 1200 }
      );
      const stateMatch = dispOut.match(/"DevicePowerState"\s*=\s*(\d+)/i);
      if (stateMatch && Number.parseInt(stateMatch[1], 10) === 0) {
        systemSleeping = true;
      }
    } catch {
      // ignore
    }
  }

  return {
    app: normalizedApp,
    windowTitle: titleRaw.trim() || normalizedApp,
    filePath: normalizeDocumentPath(docRaw),
    idleSeconds,
    sessionLocked,
    systemSleeping,
    mediaInUse,
    accessibilityGranted,
  };
}

function detectLinuxSession(env: Record<string, string | undefined>): 'x11' | 'wayland' | 'unknown' {
  const xdgType = (env.XDG_SESSION_TYPE || '').trim().toLowerCase();
  if (xdgType === 'wayland') return 'wayland';
  if (xdgType === 'x11') return 'x11';
  if (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim()) return 'wayland';
  if (env.DISPLAY && env.DISPLAY.trim()) return 'x11';
  return 'unknown';
}

function readLinuxProcComm(
  pid: number,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    return comm || null;
  } catch {
    return null;
  }
}

function findFocusedSwayNode(node: any): { name?: string; app_id?: string; window_properties?: { class?: string; instance?: string; title?: string }; pid?: number } | null {
  if (!node || typeof node !== 'object') return null;
  if (node.focused === true && (node.name || node.app_id || node.window_properties)) {
    return node;
  }
  const children = [...(Array.isArray(node.nodes) ? node.nodes : []), ...(Array.isArray(node.floating_nodes) ? node.floating_nodes : [])];
  for (const child of children) {
    const hit = findFocusedSwayNode(child);
    if (hit) return hit;
  }
  return null;
}

async function probeLinuxX11Window(
  exec: ExecRunner,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string
): Promise<{ app: string; title: string } | null> {
  // Primary X11 probe: xprop _NET_ACTIVE_WINDOW -> _NET_WM_NAME, WM_CLASS, _NET_WM_PID
  try {
    const { stdout: activeOut } = await exec('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { timeout: 1200 });
    const idMatch = activeOut.match(/0x[0-9a-fA-F]+/);
    if (idMatch && idMatch[0] !== '0x0') {
      const winId = idMatch[0];
      const { stdout: propsOut } = await exec(
        'xprop',
        ['-id', winId, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID'],
        { timeout: 1200 }
      );
      const netNameMatch = propsOut.match(/_NET_WM_NAME\([^)]+\)\s*=\s*"([^"]*)"/);
      const wmNameMatch = propsOut.match(/WM_NAME\([^)]+\)\s*=\s*"([^"]*)"/);
      const title = (netNameMatch?.[1] || wmNameMatch?.[1] || '').trim();

      const pidMatch = propsOut.match(/_NET_WM_PID\([^)]+\)\s*=\s*(\d+)/);
      const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : 0;
      const procName = pid ? readLinuxProcComm(pid, readFileSync) : null;

      let wmClass = '';
      const classMatch = propsOut.match(/WM_CLASS\([^)]+\)\s*=\s*(.+)/);
      if (classMatch) {
        const quoted = [...classMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        wmClass = quoted[quoted.length - 1] || quoted[0] || '';
      }

      const rawApp = procName || wmClass || title.split(' - ').pop() || '';
      if (title || rawApp) {
        const app = friendlyAppName(rawApp, 'Linux App');
        return { app, title: title || app };
      }
    }
  } catch {
    // Fall through to xdotool
  }

  // Fallback X11 probe: xdotool window title + PID
  try {
    const { stdout: winIdOut } = await exec('xdotool', ['getactivewindow'], { timeout: 1200 });
    const winId = winIdOut.trim();
    if (winId) {
      const { stdout: titleOut } = await exec('xdotool', ['getwindowname', winId], { timeout: 1200 });
      const title = titleOut.trim();
      let procName: string | null = null;
      try {
        const { stdout: pidOut } = await exec('xdotool', ['getwindowpid', winId], { timeout: 1000 });
        const pid = Number.parseInt(pidOut.trim(), 10) || 0;
        procName = pid ? readLinuxProcComm(pid, readFileSync) : null;
      } catch {
        // ignore PID lookup failure
      }
      if (title || procName) {
        const rawApp = procName || title.split(' - ').pop() || '';
        const app = friendlyAppName(rawApp, 'Linux App');
        return { app, title: title || app };
      }
    }
  } catch {
    // Fallback shell command for backwards compatibility in simple setups
    try {
      const { stdout } = await exec('sh', ['-c', 'xdotool getactivewindow getwindowname'], { timeout: 1200 });
      const title = stdout.trim();
      if (title) {
        const rawApp = title.split(' - ').pop() || '';
        const app = friendlyAppName(rawApp, 'Linux App');
        return { app, title };
      }
    } catch {
      // failed
    }
  }

  return null;
}

async function probeLinuxWaylandWindow(
  exec: ExecRunner,
  env: Record<string, string | undefined>,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string
): Promise<{ app: string; title: string } | null> {
  // 1. Sway / wlroots IPC
  if (env.SWAYSOCK) {
    try {
      const { stdout } = await exec('swaymsg', ['-t', 'get_tree'], { timeout: 1500 });
      const tree = JSON.parse(stdout);
      const focused = findFocusedSwayNode(tree);
      if (focused) {
        const procName = focused.pid ? readLinuxProcComm(focused.pid, readFileSync) : null;
        const rawApp = procName || focused.app_id || focused.window_properties?.class || focused.window_properties?.instance || '';
        const title = (focused.name || focused.window_properties?.title || rawApp || '').trim();
        if (title || rawApp) {
          const app = friendlyAppName(rawApp, 'Wayland App');
          return { app, title: title || app };
        }
      }
    } catch {
      // try next compositor
    }
  }

  // 2. Hyprland IPC
  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    try {
      const { stdout } = await exec('hyprctl', ['activewindow', '-j'], { timeout: 1500 });
      const win = JSON.parse(stdout);
      const procName = typeof win.pid === 'number' ? readLinuxProcComm(win.pid, readFileSync) : null;
      const rawApp = procName || String(win.class || win.initialClass || '');
      const title = String(win.title || win.initialTitle || rawApp || '').trim();
      if (title || rawApp) {
        const app = friendlyAppName(rawApp, 'Wayland App');
        return { app, title: title || app };
      }
    } catch {
      // try next compositor
    }
  }

  // 3. KDE Plasma / KWin via kdotool
  if ((env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('kde')) {
    try {
      const { stdout: winId } = await exec('kdotool', ['getactivewindow'], { timeout: 1200 });
      const id = winId.trim();
      if (id) {
        const [{ stdout: titleOut }, { stdout: clsOut }] = await Promise.all([
          exec('kdotool', ['getwindowname', id], { timeout: 1200 }).catch(() => ({ stdout: '' })),
          exec('kdotool', ['getwindowclassname', id], { timeout: 1200 }).catch(() => ({ stdout: '' })),
        ]);
        const title = titleOut.trim();
        const rawApp = clsOut.trim() || title.split(' - ').pop() || '';
        if (title || rawApp) {
          const app = friendlyAppName(rawApp, 'Wayland App');
          return { app, title: title || app };
        }
      }
    } catch {
      // try next
    }
  }

  // 4. GNOME Shell Focused Window extension / DBus eval fallback if enabled
  if ((env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gnome')) {
    try {
      const { stdout } = await exec(
        'gdbus',
        [
          'call',
          '--session',
          '--dest',
          'org.gnome.Shell',
          '--object-path',
          '/org/gnome/shell/extensions/FocusedWindow',
          '--method',
          'org.gnome.shell.extensions.FocusedWindow.Get',
        ],
        { timeout: 1200 }
      );
      const jsonMatch = stdout.match(/\{.*\}/);
      if (jsonMatch) {
        const info = JSON.parse(jsonMatch[0]);
        const rawApp = String(info['wm-class'] || info.app || '');
        const title = String(info.title || rawApp || '').trim();
        if (title || rawApp) {
          const app = friendlyAppName(rawApp, 'Wayland App');
          return { app, title: title || app };
        }
      }
    } catch {
      // try XWayland fallback
    }
  }

  // 5. XWayland fallback if DISPLAY is present
  if (env.DISPLAY && env.DISPLAY.trim()) {
    return probeLinuxX11Window(exec, readFileSync);
  }

  return null;
}

export async function sampleLinuxWithRunner(
  exec: ExecRunner = defaultExec,
  env: Record<string, string | undefined> = process.env,
  readFileSync: (filePath: string, encoding: BufferEncoding) => string = (p, enc) => fs.readFileSync(p, enc)
): Promise<Partial<WindowSample>> {
  const linuxSession = detectLinuxSession(env);

  const focused =
    linuxSession === 'wayland'
      ? await probeLinuxWaylandWindow(exec, env, readFileSync)
      : await probeLinuxX11Window(exec, readFileSync);

  if (!focused || (!focused.title && !focused.app)) {
    throw new Error(`Linux (${linuxSession}) foreground probe unavailable`);
  }

  let idleSeconds = 0;
  try {
    const { stdout: idleOut } = await exec(
      'sh',
      [
        '-c',
        [
          'if command -v xprintidle >/dev/null 2>&1; then xprintidle;',
          'elif command -v xssstate >/dev/null 2>&1; then xssstate -i;',
          'else gdbus call --session --dest org.gnome.Mutter.IdleMonitor --object-path /org/gnome/Mutter/IdleMonitor/Core --method org.gnome.Mutter.IdleMonitor.GetIdletime 2>/dev/null | sed -n "s/.*uint64 \\([0-9]*\\).*/\\1/p" || echo "0"; fi',
        ].join(' '),
      ],
      { timeout: 1200 }
    );
    const ms = Number.parseInt(idleOut.trim(), 10) || 0;
    idleSeconds = Math.max(0, Math.floor(ms / 1000));
  } catch {
    idleSeconds = 0;
  }

  let sessionLocked = false;
  try {
    const { stdout: lockOut } = await exec(
      'sh',
      [
        '-c',
        'loginctl show-session "$XDG_SESSION_ID" -p LockedHint --value 2>/dev/null || (xdg-screensaver status 2>/dev/null | grep -qi enabled && echo yes || echo no)',
      ],
      { timeout: 1000 }
    );
    sessionLocked = lockOut.trim() === 'yes';
  } catch {
    sessionLocked = false;
  }

  let mediaInUse = false;
  try {
    const { stdout: mediaOut } = await exec(
      'sh',
      [
        '-c',
        'pactl list short source-outputs 2>/dev/null || (pw-cli list-objects Node 2>/dev/null | grep -i "Audio/Source" || true)',
      ],
      { timeout: 1000 }
    );
    const lines = mediaOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    mediaInUse = lines.length > 0;
  } catch {
    mediaInUse = false;
  }

  return {
    app: focused.app,
    windowTitle: focused.title,
    idleSeconds,
    sessionLocked,
    systemSleeping: false,
    mediaInUse,
    linuxSession,
  };
}

/**
 * Cross-Platform OS Activity Adapter:
 * Captures metadata ONLY (foreground app, window title, idle state, meeting detection).
 * Never captures screenshots, keystrokes, clipboard, or document contents.
 */
export async function captureForegroundMetadata(
  deps: OsCollectorDeps = {}
): Promise<WindowSample> {
  const exec = deps.exec ?? defaultExec;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? os.platform();
  const host = deps.hostname ?? os.hostname();
  const readFile = deps.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc));

  const virtualDesktop = isRDPSession(env);
  const osPlatform: AgentOSPlatform = virtualDesktop
    ? 'vdi'
    : platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
    ? 'macos'
    : 'linux';

  let partial: Partial<WindowSample>;
  let collectorFailed = false;
  try {
    if (platform === 'win32') partial = await sampleWindows(exec);
    else if (platform === 'darwin') partial = await sampleMacOSWithRunner(exec);
    else partial = await sampleLinuxWithRunner(exec, env, readFile);
  } catch {
    collectorFailed = true;
    partial = {
      app: osPlatform === 'vdi' ? 'Remote Desktop Session' : 'Workstation App',
      windowTitle: `${host} Active Session`,
      idleSeconds: 0,
      linuxSession: platform === 'linux' ? detectLinuxSession(env) : undefined,
    };
  }

  const app = partial.app || 'Workstation';
  const windowTitle = partial.windowTitle || app;
  const fileMatch = windowTitle.match(/([\w .-]+\.(?:xlsx|xls|pdf|docx|qbw|csv))/i);
  const filePath = partial.filePath ?? (fileMatch ? fileMatch[1] : null);
  const mediaInUse = partial.mediaInUse ?? false;

  return {
    app,
    windowTitle,
    filePath,
    idleSeconds: partial.idleSeconds ?? 0,
    meetingActive: detectMeeting(app, windowTitle, mediaInUse),
    osPlatform,
    isVirtualDesktop: virtualDesktop,
    sessionLocked: partial.sessionLocked ?? false,
    systemSleeping: partial.systemSleeping ?? false,
    mediaInUse,
    virtualDesktopId: null,
    accessibilityGranted: partial.accessibilityGranted,
    linuxSession: partial.linuxSession,
    collectorFailed,
  };
}
