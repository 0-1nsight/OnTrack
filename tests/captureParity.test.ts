import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActivityStateTracker, classifyActivity, DEFAULT_ACTIVITY_STATE_CONFIG } from '../packages/desktop-agent/src/capture/activityState.ts';
import { assessCaptureHealth } from '../packages/desktop-agent/src/capture/captureHealth.ts';
import { CapturedEvent, CapturePipeline, CaptureSample } from '../packages/desktop-agent/src/capture/captureSampler.ts';
import { resolveDocumentContext } from '../packages/desktop-agent/src/capture/documentAdapters.ts';
import { sanitizeAndFilterEvent } from '../src/engine/privacyFilter.ts';
import { sessionizeEvents } from '../src/engine/sessionizer.ts';
import {
  evaluateTracking,
  isWithinSchedule,
  normalizeTrackingControls,
  pauseFor,
  setOffTheRecord,
  DEFAULT_TRACKING_CONTROLS,
} from '../packages/desktop-agent/src/capture/trackingControls.ts';
import { ClientDictionaryEntry, TenantConfig, TrackingEvent } from '../src/engine/types.ts';

describe('document adapters', () => {
  it('reads Excel, Word and PowerPoint names without status noise', () => {
    expect(resolveDocumentContext('Microsoft Excel', 'Acme TB.xlsx - Saved to this PC - Excel')).toMatchObject({
      kind: 'spreadsheet',
      documentName: 'Acme TB.xlsx',
      extension: 'xlsx',
    });
    expect(resolveDocumentContext('Microsoft Excel', 'Budget [Read-Only] - Excel')?.documentName).toBe('Budget');
    expect(resolveDocumentContext('WINWORD', 'Engagement Letter - Word')).toMatchObject({
      kind: 'document',
      documentName: 'Engagement Letter',
    });
    expect(resolveDocumentContext('POWERPNT', 'Board Deck.pptx - PowerPoint')?.kind).toBe('presentation');
  });

  it('ignores office start screens', () => {
    expect(resolveDocumentContext('Microsoft Excel', 'Excel')).toBeNull();
  });

  it('reads PDF viewer titles', () => {
    expect(resolveDocumentContext('AcroRd32', 'Invoice 553.pdf - Adobe Acrobat Reader (64-bit)')).toMatchObject({
      kind: 'pdf',
      documentName: 'Invoice 553.pdf',
    });
    expect(resolveDocumentContext('SumatraPDF', 'Statement.pdf - SumatraPDF')?.documentName).toBe('Statement.pdf');
  });

  it('reads QuickBooks company and screen', () => {
    expect(
      resolveDocumentContext('QuickBooks', 'QuickBooks Desktop Pro 2024 - Acme Inc - [Create Invoices]')
    ).toMatchObject({ kind: 'accounting_file', documentName: 'Acme Inc', section: 'Create Invoices' });
    expect(resolveDocumentContext('QuickBooks', 'Acme Inc - QuickBooks Desktop Enterprise 24.0')?.documentName).toBe(
      'Acme Inc'
    );
  });

  it('redacts Outlook subjects and keeps only client codes', () => {
    const ctx = resolveDocumentContext('Outlook', 'Re: Salary review for J. Smith ACME-1042 - Message (HTML)');
    expect(ctx?.suppressTitle).toBe(true);
    expect(ctx?.redactedTitle).toBe('Outlook – Mail [ACME-1042]');
    expect(JSON.stringify(ctx)).not.toContain('Salary');
  });

  it('redacts chat titles', () => {
    const ctx = resolveDocumentContext('Slack', 'dm-with-sam-personal - Slack');
    expect(ctx?.redactedTitle).toBe('Slack – Chat');
  });
});

describe('activity state machine', () => {
  const sig = (over: Partial<Parameters<typeof classifyActivity>[0]>) => ({
    idleSeconds: 0,
    sessionLocked: false,
    systemSleeping: false,
    meetingActive: false,
    nowMs: 0,
    ...over,
  });

  it('classifies idle, away, locked, sleeping and meeting', () => {
    expect(classifyActivity(sig({}))).toBe('active');
    expect(classifyActivity(sig({ idleSeconds: 200 }))).toBe('idle');
    expect(classifyActivity(sig({ idleSeconds: 1000 }))).toBe('away');
    expect(classifyActivity(sig({ sessionLocked: true }))).toBe('locked');
    expect(classifyActivity(sig({ systemSleeping: true, sessionLocked: true }))).toBe('sleeping');
    expect(classifyActivity(sig({ meetingActive: true, idleSeconds: 1000 }))).toBe('meeting');
    expect(classifyActivity(sig({ mediaInUse: true, idleSeconds: 1000 }))).toBe('meeting');
  });

  it('stops counting a call as a meeting after the grace window', () => {
    const cfg = DEFAULT_ACTIVITY_STATE_CONFIG;
    expect(classifyActivity(sig({ meetingActive: true, idleSeconds: cfg.meetingIdleGraceSeconds + 1 }), cfg)).toBe(
      'away'
    );
  });

  it('reports idle and lock at once but debounces active/meeting flips', () => {
    const t = new ActivityStateTracker(DEFAULT_ACTIVITY_STATE_CONFIG, 2000);
    expect(t.update(sig({ nowMs: 0 }))?.to).toBe('active');
    expect(t.update(sig({ nowMs: 1000, idleSeconds: 200 }))?.to).toBe('idle');
    expect(t.update(sig({ nowMs: 2000, sessionLocked: true }))?.to).toBe('locked');
    expect(t.update(sig({ nowMs: 3000 }))?.to).toBe('active');
    // meeting flip needs to hold
    expect(t.update(sig({ nowMs: 4000, meetingActive: true }))).toBeNull();
    expect(t.state).toBe('active');
    expect(t.update(sig({ nowMs: 6500, meetingActive: true }))?.to).toBe('meeting');
  });
});

describe('tracking controls', () => {
  const at = (iso: string) => new Date(iso);

  it('blocks while paused, then resumes', () => {
    const now = at('2026-11-23T10:00:00');
    const paused = pauseFor(DEFAULT_TRACKING_CONTROLS, 30, now);
    expect(evaluateTracking(paused, now).reason).toBe('paused');
    expect(evaluateTracking(paused, at('2026-11-23T10:31:00')).allowed).toBe(true);
  });

  it('stays blocked off the record until turned back on', () => {
    const off = setOffTheRecord(DEFAULT_TRACKING_CONTROLS, true);
    expect(evaluateTracking(off, at('2026-11-23T10:00:00')).reason).toBe('off_the_record');
    expect(evaluateTracking(setOffTheRecord(off, false), at('2026-11-23T10:00:00')).allowed).toBe(true);
  });

  it('applies weekly schedules, including windows that cross midnight', () => {
    const weekdays = [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' }];
    expect(isWithinSchedule(weekdays, at('2026-11-23T09:00:00'))).toBe(true); // Monday
    expect(isWithinSchedule(weekdays, at('2026-11-23T18:00:00'))).toBe(false);
    expect(isWithinSchedule(weekdays, at('2026-11-22T10:00:00'))).toBe(false); // Sunday

    const evening = [{ days: [1], start: '17:00', end: '01:00' }];
    expect(isWithinSchedule(evening, at('2026-11-23T23:30:00'))).toBe(true);
    expect(isWithinSchedule(evening, at('2026-11-24T00:30:00'))).toBe(true); // Tuesday early morning
    expect(isWithinSchedule(evening, at('2026-11-24T02:00:00'))).toBe(false);
  });

  it('reports when the schedule next opens', () => {
    const weekdays = [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' }];
    const d = evaluateTracking({ ...DEFAULT_TRACKING_CONTROLS, schedule: weekdays }, at('2026-11-23T18:00:00'));
    expect(d.reason).toBe('outside_schedule');
    expect(new Date(d.resumesAtMs!).getHours()).toBe(8);
  });

  it('rejects malformed control input', () => {
    const n = normalizeTrackingControls({ schedule: [{ days: [9], start: '8am', end: '5pm' }, 'x'], offTheRecord: 'yes' });
    expect(n.schedule).toEqual([]);
    expect(n.offTheRecord).toBe(false);
  });
});

describe('capture health', () => {
  const healthy = {
    platform: 'windows' as const,
    collectorMode: 'native_events' as const,
    extensionConnected: true,
    lastSampleAgeMs: 1000,
    sampleCount: 100,
    emptyTitleCount: 1,
    consecutiveErrors: 0,
  };

  it('is good when everything works', () => {
    expect(assessCaptureHealth(healthy)).toMatchObject({ level: 'good', score: 100 });
  });

  it('flags the fallback collector and missing macOS permission', () => {
    const r = assessCaptureHealth({ ...healthy, collectorMode: 'fallback' });
    expect(r.issues.map((i) => i.code)).toContain('collector_fallback');
    const mac = assessCaptureHealth({ ...healthy, platform: 'macos', accessibilityGranted: false });
    expect(mac.issues.map((i) => i.code)).toContain('macos_accessibility_missing');
    expect(mac.level).not.toBe('good');
  });

  it('reports a deliberate stop as stopped, not as a fault', () => {
    const r = assessCaptureHealth({ ...healthy, lastSampleAgeMs: null, trackingBlockedReason: 'paused' });
    expect(r.level).toBe('stopped');
    expect(r.issues.every((i) => i.severity === 'info')).toBe(true);
  });

  it('is poor when samples are stale', () => {
    expect(assessCaptureHealth({ ...healthy, lastSampleAgeMs: 120_000 }).level).toBe('poor');
  });
});

describe('golden capture traces', () => {
  interface TraceSample {
    t: number;
    app: string;
    title: string;
    idle: number;
    meeting?: boolean;
    media?: boolean;
    locked?: boolean;
  }
  const BASE = Date.parse('2026-11-23T09:00:00Z');

  function replay(name: string, pipelineOptions: ConstructorParameters<typeof CapturePipeline>[0] = {}) {
    const trace = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'fixtures/capture-traces', `${name}.json`), 'utf8')
    ) as { samples: TraceSample[] };
    const pipeline = new CapturePipeline(pipelineOptions);
    const events: CapturedEvent[] = [];
    for (const s of trace.samples) {
      const sample: CaptureSample = {
        atMs: BASE + s.t * 1000,
        app: s.app,
        windowTitle: s.title,
        filePath: null,
        idleSeconds: s.idle,
        sessionLocked: Boolean(s.locked),
        systemSleeping: false,
        meetingActive: Boolean(s.meeting),
        mediaInUse: Boolean(s.media),
        osPlatform: 'windows',
        source: 'native_events',
      };
      events.push(...pipeline.ingest(sample, { extensionConnected: true }));
    }
    const last = trace.samples[trace.samples.length - 1];
    events.push(...pipeline.close(BASE + last.t * 1000));
    return events;
  }

  it('records exact durations, drops alt-tab noise and back-fills idle', () => {
    const events = replay('workday-switch-idle-resume');
    const summary = events.map((e) => [
      e.type,
      (e.eventTimeMs - BASE) / 1000,
      (e.payload.duration_ms ?? 0) / 1000,
      e.payload.document_name ?? e.payload.activity_state,
    ]);
    // Notepad (1s) is dropped.
    expect(events.some((e) => e.payload.app === 'Notepad')).toBe(false);
    expect(summary[0]).toEqual(['activity.window', 0, 11, 'Acme_Ltd_Bank_Rec_Oct 2026.xlsx']);
    expect(summary[1]).toEqual(['activity.window', 12, 18, 'Acme_Ltd_Bank_Rec_Oct 2026.xlsx']);
    const qb = events.find((e) => e.payload.app === 'QuickBooks')!;
    expect(qb.payload.document_name).toBe('Acme Ltd');
    expect(qb.payload.document_section).toBe('Reconcile');
    const idle = events.filter((e) => e.type === 'activity.idle');
    // Long stretches are flushed in chunks, so assert on the total, not the count.
    expect(idle.length).toBeGreaterThanOrEqual(1);
    expect(idle.every((e) => e.payload.idle === true)).toBe(true);
    expect(idle.reduce((n, e) => n + (e.payload.duration_ms ?? 0), 0)).toBe(370_000);
    // No overlap between consecutive events.
    for (let i = 1; i < events.length; i++) {
      const prevEnd = events[i - 1].eventTimeMs + (events[i - 1].payload.duration_ms ?? 0);
      expect(events[i].eventTimeMs).toBeGreaterThanOrEqual(prevEnd);
    }
  });

  it('keeps a silent call as a meeting instead of idle', () => {
    const events = replay('silent-call');
    expect(events.every((e) => e.type === 'activity.meeting')).toBe(true);
    const total = events.reduce((n, e) => n + (e.payload.duration_ms ?? 0), 0);
    expect(total).toBe(1210_000);
  });

  it('treats a locked screen as non-work and never records the lock screen app', () => {
    const events = replay('lock-and-return');
    const locked = events.filter((e) => e.payload.activity_state === 'locked');
    expect(locked.reduce((n, e) => n + (e.payload.duration_ms ?? 0), 0)).toBe(610_000);
    expect(events.some((e) => e.payload.app === 'LockApp')).toBe(false);
    expect(locked.every((e) => e.type === 'activity.idle' && e.payload.idle === true)).toBe(true);
  });

  it('never records email subjects, only client codes', () => {
    const events = replay('email-redaction');
    const text = JSON.stringify(events);
    expect(text).not.toContain('Divorce');
    expect(text).not.toContain('maya@firm');
    expect(events[0].payload.window_title).toBe('Outlook – Mail [ACME-1042]');
  });

  it('stops recording the moment tracking is paused', () => {
    const trace = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'fixtures/capture-traces/workday-switch-idle-resume.json'), 'utf8')
    ) as { samples: TraceSample[] };
    let controls = DEFAULT_TRACKING_CONTROLS;
    const pipeline = new CapturePipeline({ getControls: () => controls });
    const events: CapturedEvent[] = [];
    for (const s of trace.samples) {
      if (s.t === 30) controls = setOffTheRecord(controls, true);
      events.push(
        ...pipeline.ingest(
          {
            atMs: BASE + s.t * 1000,
            app: s.app,
            windowTitle: s.title,
            filePath: null,
            idleSeconds: s.idle,
            sessionLocked: false,
            systemSleeping: false,
            meetingActive: false,
            osPlatform: 'windows',
            source: 'native_events',
          },
          { extensionConnected: true }
        )
      );
    }
    expect(events.some((e) => e.payload.app === 'QuickBooks')).toBe(false);
    expect(pipeline.blockedReason).toBe('off_the_record');
  });

  it('produces events the privacy filter and sessionizer accept', () => {
    const captured = replay('workday-switch-idle-resume');
    const events: TrackingEvent[] = captured.map((c, i) => ({
      event_id: `e${i}`,
      schema_version: 1,
      tenant_id: 't1',
      user_id: 'u1',
      device_id: 'd1',
      seq: i + 1,
      type: c.type,
      priority: 'activity',
      event_time_utc: new Date(c.eventTimeMs).toISOString(),
      received_at: null,
      payload: c.payload,
    }));
    for (const e of events) {
      expect(sanitizeAndFilterEvent(e, []).allowed).toBe(true);
    }
    const config: TenantConfig = {
      id: 't1',
      name: 'Test',
      confidenceThresholds: { detected: 0.85, suggested: 0.5 },
      sessionizer: { maxInterruptionSeconds: 30, idleCloseSeconds: 180 },
      heartbeatIntervalSeconds: 12,
      delayedThresholdSeconds: 120,
      retentionDays: 60,
      monitoringPolicy: 'mandatory',
      serverUrl: 'http://localhost:3000',
    } as TenantConfig;
    const clients: ClientDictionaryEntry[] = [
      {
        id: 'cli-acme',
        tenantId: 't1',
        legalName: 'Acme Ltd',
        aliases: ['Acme'],
        codes: ['ACME-01'],
        folderPatterns: ['Acme_Ltd'],
        knownDomains: [],
        restrictedUserIds: [],
        source: 'manual',
        updatedAtUtc: '2026-11-22T00:00:00Z',
      } as ClientDictionaryEntry,
    ];
    const sessions = sessionizeEvents(events, clients, [], config);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((s) => /Bank_Rec|Acme/.test(`${s.primaryTitle} ${s.primaryPath ?? ''}`))).toBe(true);
  });
});
