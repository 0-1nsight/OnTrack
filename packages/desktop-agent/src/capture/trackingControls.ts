/**
 * Tracking controls (capture stage, runtime-agnostic).
 *
 * Lets the user decide when recording happens: pause for a fixed time,
 * go off the record until they turn it back on, and set a weekly schedule.
 * The decision is made on the device, before any event is queued.
 */

export interface ScheduleWindow {
  /** 0 = Sunday ... 6 = Saturday, matching Date#getDay. */
  days: number[];
  /** "HH:MM" 24-hour, local time. */
  start: string;
  /** "HH:MM" 24-hour, local time. A value earlier than `start` means the window crosses midnight. */
  end: string;
}

export interface TrackingControlState {
  /** Off the record until explicitly resumed. */
  offTheRecord: boolean;
  /** Paused until this time (ms since epoch), or null. */
  pausedUntilMs: number | null;
  /** Weekly schedule. Empty means "always allowed". */
  schedule: ScheduleWindow[];
}

export type TrackingBlockReason = 'off_the_record' | 'paused' | 'outside_schedule';

export interface TrackingDecision {
  allowed: boolean;
  reason: TrackingBlockReason | null;
  /** When recording will next be allowed, if known. */
  resumesAtMs: number | null;
}

export const DEFAULT_TRACKING_CONTROLS: TrackingControlState = {
  offTheRecord: false,
  pausedUntilMs: null,
  schedule: [],
};

function minutesOfDay(hhmm: string): number | null {
  const m = hhmm.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function inWindow(window: ScheduleWindow, localDay: number, localMinutes: number): boolean {
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  if (start === null || end === null || start === end) return false;

  if (start < end) {
    return window.days.includes(localDay) && localMinutes >= start && localMinutes < end;
  }
  // Crosses midnight: the late part belongs to the listed day, the early part to the next day.
  const prevDay = (localDay + 6) % 7;
  return (
    (window.days.includes(localDay) && localMinutes >= start) ||
    (window.days.includes(prevDay) && localMinutes < end)
  );
}

/** True when the schedule is empty or `at` falls inside any window (local time). */
export function isWithinSchedule(schedule: ScheduleWindow[], at: Date): boolean {
  if (schedule.length === 0) return true;
  const day = at.getDay();
  const minutes = at.getHours() * 60 + at.getMinutes();
  return schedule.some((w) => inWindow(w, day, minutes));
}

function nextScheduleStartMs(schedule: ScheduleWindow[], from: Date): number | null {
  // Scan forward minute by minute, bounded to one week.
  const step = 60_000;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 1; i <= 7 * 24 * 60; i++) {
    cursor.setTime(cursor.getTime() + step);
    if (isWithinSchedule(schedule, cursor)) return cursor.getTime();
  }
  return null;
}

export function evaluateTracking(state: TrackingControlState, now: Date): TrackingDecision {
  if (state.offTheRecord) {
    return { allowed: false, reason: 'off_the_record', resumesAtMs: null };
  }
  if (state.pausedUntilMs !== null && now.getTime() < state.pausedUntilMs) {
    return { allowed: false, reason: 'paused', resumesAtMs: state.pausedUntilMs };
  }
  if (!isWithinSchedule(state.schedule, now)) {
    return {
      allowed: false,
      reason: 'outside_schedule',
      resumesAtMs: nextScheduleStartMs(state.schedule, now),
    };
  }
  return { allowed: true, reason: null, resumesAtMs: null };
}

export function pauseFor(state: TrackingControlState, minutes: number, now: Date): TrackingControlState {
  const clamped = Math.max(1, Math.min(minutes, 24 * 60));
  return { ...state, pausedUntilMs: now.getTime() + clamped * 60_000 };
}

export function setOffTheRecord(state: TrackingControlState, enabled: boolean): TrackingControlState {
  return { ...state, offTheRecord: enabled, pausedUntilMs: enabled ? state.pausedUntilMs : null };
}

export function resumeTracking(state: TrackingControlState): TrackingControlState {
  return { ...state, offTheRecord: false, pausedUntilMs: null };
}

/** Validates user-supplied control state (e.g. from a config file or bridge request). */
export function normalizeTrackingControls(input: unknown): TrackingControlState {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const schedule: ScheduleWindow[] = [];
  if (Array.isArray(raw.schedule)) {
    for (const w of raw.schedule) {
      if (!w || typeof w !== 'object') continue;
      const win = w as Record<string, unknown>;
      const days = Array.isArray(win.days)
        ? win.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
        : [];
      if (
        days.length > 0 &&
        typeof win.start === 'string' &&
        typeof win.end === 'string' &&
        minutesOfDay(win.start) !== null &&
        minutesOfDay(win.end) !== null
      ) {
        schedule.push({ days, start: win.start, end: win.end });
      }
    }
  }
  return {
    offTheRecord: raw.offTheRecord === true,
    pausedUntilMs: typeof raw.pausedUntilMs === 'number' && Number.isFinite(raw.pausedUntilMs) ? raw.pausedUntilMs : null,
    schedule,
  };
}
