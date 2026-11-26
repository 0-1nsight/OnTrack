import {
  assessCaptureHealth,
  type CaptureHealthReport,
  type CollectorMode,
} from './capture/captureHealth.ts';
import {
  CapturePipeline,
  type CapturedEvent,
  type CapturePipelineOptions,
  type CaptureSample,
  type OpenSegment,
} from './capture/captureSampler.ts';
import {
  DEFAULT_TRACKING_CONTROLS,
  evaluateTracking,
  normalizeTrackingControls,
  pauseFor,
  resumeTracking,
  setOffTheRecord,
  type TrackingControlState,
} from './capture/trackingControls.ts';

export interface ControlStore {
  load(): unknown;
  save(state: TrackingControlState): void;
}

export interface CaptureRuntimeOptions {
  platform: 'windows' | 'macos' | 'linux' | 'vdi';
  store: ControlStore;
  /** Receives events produced outside a sample (for example when the user pauses). */
  onEvents: (events: CapturedEvent[]) => void;
  pipeline?: Omit<CapturePipelineOptions, 'getControls'>;
  now?: () => number;
  recentLimit?: number;
}

export interface RecordedEvent {
  type: string;
  timeUtc: string;
  payload: Record<string, unknown>;
}

const HEALTH_WINDOW = 200;

/**
 * Owns the capture pipeline, the user's tracking controls, capture-health counters and a
 * short log of what was recorded. No timers or network, so it can be tested directly.
 */
export class CaptureRuntime {
  private controls: TrackingControlState;
  private readonly pipeline: CapturePipeline;
  private collectorMode: CollectorMode = 'none';
  private lastSampleMs: number | null = null;
  private consecutiveErrors = 0;
  private recentSamples: boolean[] = []; // true = title present
  private accessibilityGranted: boolean | undefined;
  private linuxSession: 'x11' | 'wayland' | 'unknown' | undefined;
  private readonly recent: RecordedEvent[] = [];
  private readonly now: () => number;
  private readonly recentLimit: number;

  private readonly options: CaptureRuntimeOptions;

  constructor(options: CaptureRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.recentLimit = options.recentLimit ?? 200;
    this.controls = normalizeTrackingControls(options.store.load());
    this.pipeline = new CapturePipeline({ ...options.pipeline, getControls: () => this.controls });
  }

  setCollectorMode(mode: CollectorMode): void {
    this.collectorMode = mode;
  }

  recordCollectorError(): void {
    this.consecutiveErrors += 1;
  }

  handleSample(sample: CaptureSample, extensionConnected: boolean): CapturedEvent[] {
    this.consecutiveErrors = 0;
    this.lastSampleMs = this.now();
    this.recentSamples.push(sample.windowTitle.trim().length > 0 && sample.windowTitle !== sample.app);
    if (this.recentSamples.length > HEALTH_WINDOW) this.recentSamples.shift();
    return this.pipeline.ingest(sample, { extensionConnected });
  }

  getOpenState(): OpenSegment | null {
    return this.pipeline.getOpenSegment();
  }

  setPlatformFacts(facts: { accessibilityGranted?: boolean; linuxSession?: 'x11' | 'wayland' | 'unknown' }): void {
    if (facts.accessibilityGranted !== undefined) this.accessibilityGranted = facts.accessibilityGranted;
    if (facts.linuxSession !== undefined) this.linuxSession = facts.linuxSession;
  }

  /** Stores an event after it has passed exclusions, so the "recorded about me" view matches what is sent. */
  recordQueued(type: string, timeMs: number, payload: Record<string, unknown>): void {
    this.recent.push({ type, timeUtc: new Date(timeMs).toISOString(), payload });
    if (this.recent.length > this.recentLimit) this.recent.shift();
  }

  getRecentEvents(limit: number): RecordedEvent[] {
    return this.recent.slice(-limit).reverse();
  }

  getControls(): Record<string, unknown> {
    const decision = evaluateTracking(this.controls, new Date(this.now()));
    return { ...this.controls, allowedNow: decision.allowed, blockedReason: decision.reason, resumesAtMs: decision.resumesAtMs };
  }

  applyControl(msg: Record<string, unknown>): { ok: boolean; error?: string; controls?: Record<string, unknown> } {
    const nowMs = this.now();
    let next: TrackingControlState;
    switch (msg.action) {
      case 'pause': {
        const minutes = Number(msg.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: 'minutes must be a positive number' };
        next = pauseFor(this.controls, minutes, new Date(nowMs));
        break;
      }
      case 'offTheRecord':
        next = setOffTheRecord(this.controls, msg.enabled !== false);
        break;
      case 'resume':
        next = resumeTracking(this.controls);
        break;
      case 'setSchedule': {
        const normalized = normalizeTrackingControls({ schedule: msg.schedule });
        const provided = Array.isArray(msg.schedule) ? msg.schedule.length : 0;
        if (normalized.schedule.length !== provided) return { ok: false, error: 'invalid schedule window' };
        next = { ...this.controls, schedule: normalized.schedule };
        break;
      }
      default:
        return { ok: false, error: 'unknown action' };
    }
    this.controls = next;
    this.options.store.save(next);

    // Stop at the moment of the request, not at the next sample.
    if (!evaluateTracking(next, new Date(nowMs)).allowed) {
      const closed = this.pipeline.close(nowMs);
      if (closed.length > 0) this.options.onEvents(closed);
    }
    return { ok: true, controls: this.getControls() };
  }

  getHealth(extensionConnected: boolean): CaptureHealthReport & { collectorMode: CollectorMode } {
    const decision = evaluateTracking(this.controls, new Date(this.now()));
    const empty = this.recentSamples.filter((hasTitle) => !hasTitle).length;
    const report = assessCaptureHealth({
      platform: this.options.platform,
      collectorMode: this.collectorMode,
      accessibilityGranted: this.accessibilityGranted,
      linuxSession: this.linuxSession,
      extensionConnected,
      lastSampleAgeMs: this.lastSampleMs === null ? null : this.now() - this.lastSampleMs,
      sampleCount: this.recentSamples.length,
      emptyTitleCount: empty,
      consecutiveErrors: this.consecutiveErrors,
      trackingBlockedReason: decision.reason,
    });
    return { ...report, collectorMode: this.collectorMode };
  }

  /** Flushes the open segment on shutdown. */
  shutdown(): CapturedEvent[] {
    return this.pipeline.close(this.now());
  }

  static emptyControls(): TrackingControlState {
    return { ...DEFAULT_TRACKING_CONTROLS };
  }
}
