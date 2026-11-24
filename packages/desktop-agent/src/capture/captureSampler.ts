/**
 * Capture sampler (runtime-agnostic).
 *
 * Takes raw foreground samples (from the native helper or a polling fallback) and
 * produces activity events with exact durations: a segment is closed when the window
 * changes, when the user goes idle (back-dated to the last input), or every
 * `segmentMaxMs` so long stretches still reach viewers within the live-presence target.
 */

import { type ActivityState, type ActivityStateConfig, ActivityStateTracker, DEFAULT_ACTIVITY_STATE_CONFIG } from './activityState.ts';
import { applyDocumentContext, type DocumentAdapterOptions } from './documentAdapters.ts';
import { DEFAULT_TRACKING_CONTROLS, evaluateTracking, type TrackingControlState } from './trackingControls.ts';
import type { ActivityEventType, OSPlatform, TrackingEventPayload } from '../../../../src/engine/types.ts';

export interface CaptureSample {
  atMs: number;
  app: string;
  windowTitle: string;
  filePath: string | null;
  idleSeconds: number;
  sessionLocked: boolean;
  systemSleeping: boolean;
  meetingActive: boolean;
  mediaInUse?: boolean;
  osPlatform: OSPlatform;
  virtualDesktopId?: string | null;
  source: 'native_events' | 'polling' | 'fallback';
}

export interface CapturedEvent {
  type: ActivityEventType;
  priority: 'activity';
  /** Segment start, ms since epoch. */
  eventTimeMs: number;
  payload: TrackingEventPayload;
}

export interface CapturePipelineOptions {
  activity?: ActivityStateConfig;
  getControls?: () => TrackingControlState;
  documents?: DocumentAdapterOptions;
  /** Longest a single segment runs before it is flushed and continued. */
  segmentMaxMs?: number;
  /** Work segments shorter than this are alt-tab noise and are dropped. */
  minSegmentMs?: number;
  /** Debounce for state changes that are not explicit OS events. */
  stateHoldMs?: number;
}

interface OpenSegment {
  key: string;
  type: ActivityEventType;
  startMs: number;
  state: ActivityState;
  payload: TrackingEventPayload;
  isWork: boolean;
}

export class CapturePipeline {
  private readonly tracker: ActivityStateTracker;
  private readonly activityConfig: ActivityStateConfig;
  private readonly getControls: () => TrackingControlState;
  private readonly documents: DocumentAdapterOptions;
  private readonly segmentMaxMs: number;
  private readonly minSegmentMs: number;
  private segment: OpenSegment | null = null;

  constructor(options: CapturePipelineOptions = {}) {
    this.activityConfig = options.activity ?? DEFAULT_ACTIVITY_STATE_CONFIG;
    this.tracker = new ActivityStateTracker(this.activityConfig, options.stateHoldMs ?? 2000);
    this.getControls = options.getControls ?? (() => DEFAULT_TRACKING_CONTROLS);
    this.documents = options.documents ?? {};
    this.segmentMaxMs = options.segmentMaxMs ?? 15_000;
    this.minSegmentMs = options.minSegmentMs ?? 1_500;
  }

  get currentState(): ActivityState | null {
    return this.tracker.state;
  }

  get blockedReason() {
    return this.lastBlockedReason;
  }
  private lastBlockedReason: ReturnType<typeof evaluateTracking>['reason'] = null;

  ingest(sample: CaptureSample, ctx: { extensionConnected: boolean }): CapturedEvent[] {
    const decision = evaluateTracking(this.getControls(), new Date(sample.atMs));
    this.lastBlockedReason = decision.reason;
    if (!decision.allowed) {
      // Stop recording at once. Nothing from this sample is kept.
      return this.close(sample.atMs);
    }

    this.tracker.update({
      idleSeconds: sample.idleSeconds,
      sessionLocked: sample.sessionLocked,
      systemSleeping: sample.systemSleeping,
      meetingActive: sample.meetingActive,
      mediaInUse: sample.mediaInUse,
      nowMs: sample.atMs,
    });
    const state = this.tracker.state ?? 'active';
    const isWork = state === 'active' || state === 'meeting';

    const next = isWork
      ? this.workSegment(sample, state, ctx)
      : this.restSegment(sample, state);

    const out: CapturedEvent[] = [];

    if (!this.segment) {
      this.segment = { ...next, startMs: this.boundaryStart(sample, state, null) };
      return out;
    }

    if (this.segment.key !== next.key) {
      const endMs = this.boundaryEnd(sample, state, this.segment);
      const closed = this.emit(this.segment, endMs);
      if (closed) out.push(closed);
      this.segment = { ...next, startMs: endMs };
      return out;
    }

    // Same segment: keep the freshest payload (e.g. extension status) and flush long runs.
    this.segment.payload = { ...this.segment.payload, extension_connected: ctx.extensionConnected };
    if (sample.atMs - this.segment.startMs >= this.segmentMaxMs) {
      const closed = this.emit(this.segment, sample.atMs);
      if (closed) out.push(closed);
      this.segment = { ...next, startMs: sample.atMs };
    }
    return out;
  }

  /** Closes the open segment (shutdown, pause, off-the-record). */
  close(atMs: number): CapturedEvent[] {
    if (!this.segment) return [];
    const closed = this.emit(this.segment, Math.max(atMs, this.segment.startMs));
    this.segment = null;
    return closed ? [closed] : [];
  }

  private workSegment(
    sample: CaptureSample,
    state: ActivityState,
    ctx: { extensionConnected: boolean }
  ): Omit<OpenSegment, 'startMs'> {
    const doc = applyDocumentContext(sample.app, sample.windowTitle, sample.filePath, this.documents);
    const type: ActivityEventType = state === 'meeting' ? 'activity.meeting' : 'activity.window';
    const payload: TrackingEventPayload = {
      app: sample.app,
      window_title: doc.window_title,
      file_path: doc.file_path,
      document_kind: doc.document_kind,
      document_name: doc.document_name,
      document_section: doc.document_section,
      idle: false,
      meeting_active: state === 'meeting',
      activity_state: state,
      os_platform: sample.osPlatform,
      virtual_desktop_id: sample.virtualDesktopId ?? null,
      capture_source: sample.source,
      extension_connected: ctx.extensionConnected,
    };
    return {
      key: `${type}|${sample.app}|${doc.window_title}|${sample.virtualDesktopId ?? ''}`,
      type,
      state,
      payload,
      isWork: true,
    };
  }

  private restSegment(sample: CaptureSample, state: ActivityState): Omit<OpenSegment, 'startMs'> {
    return {
      key: `rest|${state}`,
      type: 'activity.idle',
      state,
      // No app or title while idle, locked or asleep: nothing to attribute and nothing to leak.
      payload: {
        app: state === 'locked' ? 'Lock screen' : state === 'sleeping' ? 'System sleep' : 'Idle',
        window_title: state,
        idle: true,
        meeting_active: false,
        activity_state: state,
        os_platform: sample.osPlatform,
        capture_source: sample.source,
      },
      isWork: false,
    };
  }

  /** Where a segment that starts with this sample begins. Idle is back-dated to the last input. */
  private boundaryStart(sample: CaptureSample, state: ActivityState, prev: OpenSegment | null): number {
    if ((state === 'idle' || state === 'away') && sample.idleSeconds > 0) {
      const backdated = sample.atMs - sample.idleSeconds * 1000;
      return prev ? Math.max(prev.startMs, backdated) : backdated;
    }
    return sample.atMs;
  }

  private boundaryEnd(sample: CaptureSample, state: ActivityState, prev: OpenSegment): number {
    return this.boundaryStart(sample, state, prev);
  }

  private emit(seg: OpenSegment, endMs: number): CapturedEvent | null {
    const durationMs = endMs - seg.startMs;
    if (durationMs <= 0) return null;
    if (seg.isWork && durationMs < this.minSegmentMs) return null;
    return {
      type: seg.type,
      priority: 'activity',
      eventTimeMs: seg.startMs,
      payload: { ...seg.payload, duration_ms: durationMs },
    };
  }
}
