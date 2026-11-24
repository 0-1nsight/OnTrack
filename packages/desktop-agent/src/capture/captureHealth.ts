/**
 * Capture health (runtime-agnostic).
 *
 * Turns collector facts into a status the user and IT can see, so degraded
 * capture is visible instead of silently producing weak attribution.
 */

export type CollectorMode = 'native_events' | 'polling' | 'fallback' | 'none';
export type CaptureHealthLevel = 'good' | 'degraded' | 'poor' | 'stopped';

export interface CaptureHealthInput {
  platform: 'windows' | 'macos' | 'linux' | 'vdi';
  collectorMode: CollectorMode;
  /** macOS: Accessibility permission granted for window titles. */
  accessibilityGranted?: boolean;
  /** Linux: session type, if known. */
  linuxSession?: 'x11' | 'wayland' | 'unknown';
  extensionConnected: boolean;
  /** Milliseconds since the last successful foreground sample. */
  lastSampleAgeMs: number | null;
  /** Foreground samples in the window. */
  sampleCount: number;
  /** Samples where the title came back empty or generic. */
  emptyTitleCount: number;
  /** Consecutive collector errors. */
  consecutiveErrors: number;
  trackingBlockedReason?: 'off_the_record' | 'paused' | 'outside_schedule' | null;
}

export interface CaptureHealthIssue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface CaptureHealthReport {
  level: CaptureHealthLevel;
  /** 0-100, intended for a coverage indicator. */
  score: number;
  issues: CaptureHealthIssue[];
}

const STALE_SAMPLE_MS = 30_000;

export function assessCaptureHealth(input: CaptureHealthInput): CaptureHealthReport {
  const issues: CaptureHealthIssue[] = [];
  let score = 100;

  if (input.trackingBlockedReason) {
    // A deliberate stop is not a fault; report it and skip the fault checks.
    const labels = {
      off_the_record: 'Tracking is off the record.',
      paused: 'Tracking is paused.',
      outside_schedule: 'Outside the tracking schedule.',
    } as const;
    return {
      level: 'stopped',
      score: 0,
      issues: [{ code: `blocked_${input.trackingBlockedReason}`, severity: 'info', message: labels[input.trackingBlockedReason] }],
    };
  }

  if (input.collectorMode === 'none' || input.consecutiveErrors >= 5) {
    issues.push({
      code: 'collector_failing',
      severity: 'error',
      message: 'The foreground collector is not returning samples.',
    });
    score -= 60;
  } else if (input.collectorMode === 'fallback') {
    issues.push({
      code: 'collector_fallback',
      severity: 'warning',
      message: 'Using the fallback collector, which can report the wrong window. Reinstall the agent helper.',
    });
    score -= 30;
  } else if (input.collectorMode === 'polling') {
    issues.push({
      code: 'collector_polling',
      severity: 'info',
      message: 'Sampling by polling; very short window switches can be missed.',
    });
    score -= 8;
  }

  if (input.lastSampleAgeMs === null || input.lastSampleAgeMs > STALE_SAMPLE_MS) {
    issues.push({
      code: 'stale_samples',
      severity: 'error',
      message: 'No recent foreground sample.',
    });
    score -= 30;
  }

  if (input.platform === 'macos' && input.accessibilityGranted === false) {
    issues.push({
      code: 'macos_accessibility_missing',
      severity: 'warning',
      message: 'Accessibility permission is missing, so window titles are blank. Grant it in System Settings.',
    });
    score -= 25;
  }

  if (input.platform === 'linux' && input.linuxSession === 'wayland') {
    issues.push({
      code: 'linux_wayland_limited',
      severity: 'warning',
      message: 'Wayland limits window capture. Use an X11 session or a supported compositor.',
    });
    score -= 20;
  }

  if (input.platform === 'vdi') {
    issues.push({
      code: 'vdi_scope',
      severity: 'info',
      message: 'Remote session: only windows inside this session are visible to the agent.',
    });
  }

  if (input.sampleCount >= 20 && input.emptyTitleCount / input.sampleCount > 0.3) {
    issues.push({
      code: 'many_empty_titles',
      severity: 'warning',
      message: 'Many samples have no window title, which weakens attribution.',
    });
    score -= 15;
  }

  if (!input.extensionConnected) {
    issues.push({
      code: 'extension_missing',
      severity: 'info',
      message: 'Browser extension not connected; browser activity uses window titles only.',
    });
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));
  const hasError = issues.some((i) => i.severity === 'error');
  const level: CaptureHealthLevel = hasError || score < 50 ? 'poor' : score < 90 ? 'degraded' : 'good';
  return { level, score, issues };
}
