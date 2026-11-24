/**
 * Activity state machine (capture stage, runtime-agnostic).
 *
 * Folds OS signals (idle seconds, session lock, sleep, meeting indicators) into
 * one state so the pipeline can tell "away", "in a meeting" and "locked" apart,
 * instead of treating all of them as plain idle.
 */

export type ActivityState = 'active' | 'idle' | 'away' | 'meeting' | 'locked' | 'sleeping';

export interface ActivitySignals {
  /** Seconds since last keyboard/mouse input. */
  idleSeconds: number;
  sessionLocked: boolean;
  systemSleeping: boolean;
  /** A meeting app is focused or the mic/camera is in use. */
  meetingActive: boolean;
  /** Microphone or camera is currently in use by any app. */
  mediaInUse?: boolean;
  /** Milliseconds since epoch for this reading. */
  nowMs: number;
}

export interface ActivityStateConfig {
  /** Idle time before the user counts as idle. */
  idleThresholdSeconds: number;
  /** Idle time before idle becomes away (the user has left the desk). */
  awayThresholdSeconds: number;
  /** Idle time allowed inside a meeting before it stops counting as a meeting (passive listening). */
  meetingIdleGraceSeconds: number;
}

export const DEFAULT_ACTIVITY_STATE_CONFIG: ActivityStateConfig = {
  idleThresholdSeconds: 180,
  awayThresholdSeconds: 900,
  meetingIdleGraceSeconds: 3600,
};

export interface ActivityTransition {
  from: ActivityState | null;
  to: ActivityState;
  atMs: number;
  /** Seconds the previous state lasted; 0 for the first reading. */
  previousDurationSeconds: number;
}

export function classifyActivity(
  signals: ActivitySignals,
  config: ActivityStateConfig = DEFAULT_ACTIVITY_STATE_CONFIG
): ActivityState {
  if (signals.systemSleeping) return 'sleeping';
  if (signals.sessionLocked) return 'locked';

  const inMeeting = signals.meetingActive || Boolean(signals.mediaInUse);
  // A call with the mic open is work even when nobody touches the keyboard,
  // up to the grace window. Past it the user has probably left the call running.
  if (inMeeting && signals.idleSeconds < config.meetingIdleGraceSeconds) return 'meeting';

  if (signals.idleSeconds >= config.awayThresholdSeconds) return 'away';
  if (signals.idleSeconds >= config.idleThresholdSeconds) return 'idle';
  return 'active';
}

/**
 * Stateful tracker that emits a transition only when the classified state changes.
 * Debounces flapping between active and meeting: that change must hold for `minHoldMs`
 * before it is reported. Every other change is reported immediately.
 */
export class ActivityStateTracker {
  private current: ActivityState | null = null;
  private currentSinceMs = 0;
  private pending: { state: ActivityState; sinceMs: number } | null = null;

  private readonly config: ActivityStateConfig;
  private readonly minHoldMs: number;

  // Explicit fields: the desktop agent runs in Node's strip-only TypeScript mode,
  // which does not support constructor parameter properties.
  constructor(config: ActivityStateConfig = DEFAULT_ACTIVITY_STATE_CONFIG, minHoldMs = 2000) {
    this.config = config;
    this.minHoldMs = minHoldMs;
  }

  get state(): ActivityState | null {
    return this.current;
  }

  update(signals: ActivitySignals): ActivityTransition | null {
    const next = classifyActivity(signals, this.config);

    if (this.current === null) {
      this.current = next;
      this.currentSinceMs = signals.nowMs;
      this.pending = null;
      return { from: null, to: next, atMs: signals.nowMs, previousDurationSeconds: 0 };
    }

    if (next === this.current) {
      this.pending = null;
      return null;
    }

    // Only active <-> meeting flips are debounced. Idle, away, lock and sleep come from
    // monotonic OS counters or explicit OS events, so they are reported at once.
    const flappy = (s: ActivityState) => s === 'active' || s === 'meeting';
    const immediate = !(flappy(this.current) && flappy(next));
    if (!immediate) {
      if (!this.pending || this.pending.state !== next) {
        this.pending = { state: next, sinceMs: signals.nowMs };
        return null;
      }
      if (signals.nowMs - this.pending.sinceMs < this.minHoldMs) return null;
    }

    const effectiveAtMs = immediate ? signals.nowMs : this.pending!.sinceMs;
    const transition: ActivityTransition = {
      from: this.current,
      to: next,
      atMs: effectiveAtMs,
      previousDurationSeconds: Math.max(0, Math.round((effectiveAtMs - this.currentSinceMs) / 1000)),
    };
    this.current = next;
    this.currentSinceMs = effectiveAtMs;
    this.pending = null;
    return transition;
  }
}

/** States during which activity must not be attributed to client work. */
export function isNonWorkState(state: ActivityState): boolean {
  return state === 'idle' || state === 'away' || state === 'locked' || state === 'sleeping';
}
