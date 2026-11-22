import { runAttributionPipeline } from './attributionEngine';
import { sanitizeAndFilterEvent } from './privacyFilter';
import { sessionizeEvents } from './sessionizer';
import {
  ActivityDictionaryEntry,
  ClientDictionaryEntry,
  EngineTask,
  LearnedRule,
  PrivacyRule,
  ReplayGroundTruthItem,
  ReplayMetricsResult,
  TaskTemplate,
  TenantConfig,
  TrackingEvent,
} from './types';

export interface SimulatedReplayScenario {
  events: TrackingEvent[];
  groundTruth: ReplayGroundTruthItem[];
}

/**
 * Generates realistic accounting workday events (QuickBooks, Xero, Excel, PDFs,
 * brief Slack glances, incognito/excluded banking windows, untitled Excel session
 * retroactively attributed by a later QuickBooks open, and window-title fallback).
 */
export function generateRealisticAccountingScenario(
  tenantId: string,
  userId: string,
  deviceId: string
): SimulatedReplayScenario {
  const prefix = tenantId === 'firm_demo' ? 'demo_' : '';
  const baseMs = Date.now() - 2 * 60 * 60 * 1000;
  let seq = 100;
  const events: TrackingEvent[] = [];
  const groundTruth: ReplayGroundTruthItem[] = [];

  const pushEvent = (
    offsetSec: number,
    durationMs: number,
    type: TrackingEvent['type'],
    payload: TrackingEvent['payload'],
    expectedClientId: string | null,
    expectedTaskId: string | null,
    isExcluded = false
  ) => {
    const id = `sim-ev-${++seq}`;
    events.push({
      event_id: id,
      schema_version: 1,
      tenant_id: tenantId,
      user_id: userId,
      device_id: deviceId,
      seq,
      type,
      priority: 'activity',
      event_time_utc: new Date(baseMs + offsetSec * 1000).toISOString(),
      received_at: null,
      payload: {
        duration_ms: durationMs,
        idle: false,
        incognito: false,
        os_platform: 'windows',
        extension_connected: true,
        ...payload,
      },
    });
    groundTruth.push({
      event_id: id,
      expectedClientId,
      expectedTaskId,
      isExcluded,
    });
  };

  // 1. Ambiguous untitled Excel workpaper (will be retroactively attributed by QuickBooks right after!)
  pushEvent(
    0,
    8 * 60 * 1000,
    'activity.window',
    {
      app: 'Microsoft Excel',
      window_title: 'Book1.xlsx - Excel',
      file_path: 'C:\\Temp\\Book1.xlsx',
    },
    `${prefix}cli-acme`,
    `${prefix}tsk-eng-101`
  );

  // 2. Strong QuickBooks signal for Acme Ltd Oct 2026 Reconciliation -> triggers Retroactive Revision!
  pushEvent(
    9 * 60,
    18 * 60 * 1000,
    'activity.window',
    {
      app: 'QuickBooks',
      window_title: 'Acme Ltd - Reconcile - Chequing Oct 2026',
      file_path: 'C:\\Clients\\Acme_Ltd\\2026-10\\Chequing_Rec.qbw',
    },
    `${prefix}cli-acme`,
    `${prefix}tsk-eng-101`
  );

  // 3. Brief 18s Slack interruption (should bridge into the Acme session without splitting)
  pushEvent(
    27 * 60 + 10,
    18 * 1000,
    'activity.window',
    {
      app: 'Slack',
      window_title: 'Slack | #audit-team',
    },
    `${prefix}cli-acme`,
    `${prefix}tsk-eng-101`
  );

  // 4. Acme Bank Statement PDF review (20m)
  pushEvent(
    27 * 60 + 30,
    15 * 60 * 1000,
    'activity.file',
    {
      app: 'Adobe Acrobat',
      window_title: 'Acme_Oct2026_BankStatement.pdf',
      file_path: 'C:\\Clients\\Acme_Ltd\\2026-10\\Acme_Oct2026_BankStatement.pdf',
    },
    `${prefix}cli-acme`,
    `${prefix}tsk-eng-101`
  );

  // 5. Excluded personal banking tab + Incognito window (MUST be filtered on device -> 0 leaks)
  pushEvent(
    43 * 60,
    4 * 60 * 1000,
    'activity.browser',
    {
      app: 'Google Chrome',
      window_title: 'Chase Online Banking - Personal Checking',
      url: 'https://personalbank.example.com/accounts',
      domain: 'personalbank.example.com',
    },
    null,
    null,
    true
  );

  pushEvent(
    48 * 60,
    3 * 60 * 1000,
    'activity.browser',
    {
      app: 'Google Chrome',
      window_title: 'Private Tab - Medical Portal',
      url: 'https://health.example.org/records',
      domain: 'health.example.org',
      incognito: true,
    },
    null,
    null,
    true
  );

  // 6. Xero Payroll work for Northstar Logistics (Q3 2026) via Browser Extension
  pushEvent(
    55 * 60,
    22 * 60 * 1000,
    'activity.browser',
    {
      app: 'Microsoft Edge',
      window_title: 'Xero | Payroll Register - Northstar Logistics Q3 2026',
      url: 'https://go.xero.com/Payroll/Run/northstar-q3-2026',
      domain: 'go.xero.com',
    },
    `${prefix}cli-northstar`,
    `${prefix}tsk-eng-102`
  );

  // 7. Harbor Health Tax Return in Excel (browser extension disabled fallback test)
  pushEvent(
    80 * 60,
    14 * 60 * 1000,
    'activity.window',
    {
      app: 'Google Chrome',
      window_title: 'Harbor Health - FY25 Corporate Tax Return Draft',
      extension_connected: false,
    },
    `${prefix}cli-harbor`,
    `${prefix}tsk-eng-103`
  );

  // 8. Generic unattributable desktop window (should stay in Review Tray < 0.50, never silently assigned)
  pushEvent(
    112 * 60,
    7 * 60 * 1000,
    'activity.window',
    {
      app: 'Notepad',
      window_title: 'scratch-notes.txt',
    },
    null,
    null
  );

  return { events, groundTruth };
}

/**
 * Offline Replay Harness (Milestone 8 / ATTR-4):
 * Runs recorded or simulated events through filter -> sessionize -> attribute
 * and reports accuracy, coverage, daily review estimate, and excluded leak count.
 */
export function runReplayHarness(params: {
  events: TrackingEvent[];
  groundTruth: ReplayGroundTruthItem[];
  clients: ClientDictionaryEntry[];
  activityRules: ActivityDictionaryEntry[];
  privacyRules: PrivacyRule[];
  tasks: EngineTask[];
  templates: TaskTemplate[];
  learnedRules: LearnedRule[];
  config: TenantConfig;
}): ReplayMetricsResult {
  const {
    events,
    groundTruth,
    clients,
    activityRules,
    privacyRules,
    tasks,
    templates,
    learnedRules,
    config,
  } = params;

  const truthByEventId = new Map<string, ReplayGroundTruthItem>();
  for (const g of groundTruth) truthByEventId.set(g.event_id, g);

  const passedEvents: TrackingEvent[] = [];
  let filteredOutCount = 0;
  let excludedLeaksCount = 0;

  for (const ev of events) {
    const truth = truthByEventId.get(ev.event_id);
    const res = sanitizeAndFilterEvent(ev, privacyRules);
    if (!res.allowed || !res.sanitizedEvent) {
      filteredOutCount++;
    } else {
      passedEvents.push(res.sanitizedEvent);
      if (truth?.isExcluded) {
        excludedLeaksCount++;
      }
    }
  }

  const sessions = sessionizeEvents(passedEvents, clients, activityRules, config);
  const { attributions, revisionsPublished } = runAttributionPipeline({
    sessions,
    rawEvents: passedEvents,
    tasks,
    templates,
    learnedRules,
    config,
  });

  const attrBySession = new Map(attributions.map((a) => [a.sessionId, a]));

  let autoAssignedCount = 0;
  let suggestedCount = 0;
  let reviewTrayCount = 0;
  let correctCount = 0;
  let attributedDurationSec = 0;
  let totalDurationSec = 0;

  const items: ReplayMetricsResult['items'] = [];

  for (const sess of sessions) {
    const attr = attrBySession.get(sess.id);
    if (!attr) continue;
    totalDurationSec += sess.durationSeconds;

    if (attr.status === 'detected' || attr.status === 'confirmed') {
      autoAssignedCount++;
      attributedDurationSec += sess.durationSeconds;
    } else if (attr.status === 'suggested') {
      suggestedCount++;
      attributedDurationSec += sess.durationSeconds;
    } else {
      reviewTrayCount++;
    }

    // Determine majority ground-truth client across contributing events
    const counts = new Map<string, number>();
    let expectedClientId: string | null = null;
    for (const eid of sess.eventIds) {
      const gt = truthByEventId.get(eid);
      if (gt && gt.expectedClientId) {
        counts.set(gt.expectedClientId, (counts.get(gt.expectedClientId) || 0) + 1);
      }
    }
    let topC = 0;
    for (const [cid, c] of counts.entries()) {
      if (c > topC) {
        topC = c;
        expectedClientId = cid;
      }
    }

    const correct =
      expectedClientId === null
        ? attr.status === 'review_tray'
        : attr.clientId === expectedClientId;
    if (correct) correctCount++;

    items.push({
      sessionId: sess.id,
      primaryTitle: sess.primaryTitle,
      primaryApp: sess.primaryApp,
      durationMinutes: Math.max(1, Math.round(sess.durationSeconds / 60)),
      expectedClientId,
      predictedClientId: attr.clientId,
      predictedTaskId: attr.taskId,
      confidence: attr.confidence,
      status: attr.status,
      reason: attr.reason,
      correct,
    });
  }

  const accuracy =
    sessions.length > 0 ? Math.round((correctCount / sessions.length) * 100) : 100;
  const coverage =
    totalDurationSec > 0
      ? Math.round((attributedDurationSec / totalDurationSec) * 100)
      : 0;
  // ~15 seconds to review each suggested/review-tray item in daily review
  const estimatedDailyReviewMinutes = Math.max(
    0.5,
    Math.round(((suggestedCount + reviewTrayCount) * 0.35) * 10) / 10
  );

  return {
    totalEventsInput: events.length,
    filteredOutCount,
    excludedLeaksCount,
    sessionCount: sessions.length,
    autoAssignedCount,
    suggestedCount,
    reviewTrayCount,
    retroactiveRevisionsCount: revisionsPublished.length,
    autoAssignmentAccuracyPercent: accuracy,
    coveragePercent: coverage,
    estimatedDailyReviewMinutes,
    items,
  };
}
