import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { detectMeeting, friendlyAppName } from './appNames.ts';

const execFileAsync = promisify(execFile);

export interface WatcherSample {
  atMs: number;
  app: string;
  windowTitle: string;
  idleSeconds: number;
  sessionLocked: boolean;
  systemSleeping: boolean;
  mediaInUse: boolean;
  meetingActive: boolean;
  virtualDesktopId: string | null;
  reason: string;
}

export interface WinFocusWatcherOptions {
  onSample: (sample: WatcherSample) => void;
  onError?: (message: string) => void;
  /** Called when the watcher has permanently stopped (could not start or kept crashing). */
  onGiveUp?: (reason: string) => void;
}

const SOURCE_PATH = fileURLToPath(new URL('../../native/windows/FocusWatcher.cs', import.meta.url));
const MAX_RESTARTS = 5;

function findCsc(): string | null {
  const windir = process.env.WINDIR || 'C:\\Windows';
  for (const dir of ['Framework64', 'Framework']) {
    const candidate = path.join(windir, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Compiles the helper once per source version and reuses the binary.
 * Returns null if the .NET Framework compiler is missing or the build fails.
 */
export async function ensureWatcherBinary(): Promise<string | null> {
  if (os.platform() !== 'win32') return null;
  if (!fs.existsSync(SOURCE_PATH)) return null;

  const source = fs.readFileSync(SOURCE_PATH);
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 10);
  const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'OnTrack');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, `ontrack-focus-watcher-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;

  const csc = findCsc();
  if (!csc) return null;
  try {
    await execFileAsync(csc, ['/nologo', '/target:exe', '/optimize+', '/r:System.dll', `/out:${exe}`, SOURCE_PATH], {
      timeout: 60_000,
    });
  } catch {
    return null;
  }
  return fs.existsSync(exe) ? exe : null;
}

export class WinFocusWatcher {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private restarts = 0;
  private binary: string | null = null;

  private readonly options: WinFocusWatcherOptions;

  constructor(options: WinFocusWatcherOptions) {
    this.options = options;
  }

  async start(): Promise<boolean> {
    this.binary = await ensureWatcherBinary();
    if (!this.binary) return false;
    this.launch();
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
  }

  private launch(): void {
    if (!this.binary || this.stopped) return;
    const child = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (d) => this.options.onError?.(String(d).trim()));
    child.on('error', (err) => this.options.onError?.(err.message));
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.restarts += 1;
      if (this.restarts > MAX_RESTARTS) {
        this.options.onGiveUp?.(`focus watcher exited ${this.restarts} times (last code ${code})`);
        return;
      }
      setTimeout(() => this.launch(), Math.min(30_000, 1000 * 2 ** this.restarts));
    });
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === 'error') {
      this.options.onError?.(String(msg.message ?? 'watcher error'));
      return;
    }
    if (msg.type !== 'sample') return;
    this.restarts = 0; // a healthy sample resets the crash counter

    const exe = String(msg.exe ?? '');
    const app = friendlyAppName(exe);
    const title = String(msg.title ?? '');
    const mediaInUse = msg.mediaInUse === true;
    this.options.onSample({
      atMs: Number(msg.atMs) || Date.now(),
      app,
      windowTitle: title || app,
      idleSeconds: Number(msg.idleSeconds) || 0,
      sessionLocked: msg.locked === true,
      systemSleeping: msg.sleeping === true,
      mediaInUse,
      meetingActive: detectMeeting(app, title, mediaInUse),
      virtualDesktopId: typeof msg.desktopId === 'string' ? msg.desktopId : null,
      reason: String(msg.reason ?? ''),
    });
  }
}
