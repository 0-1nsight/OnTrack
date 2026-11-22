import { extractEntitiesFromPayload } from './entityExtractor';
import {
  ActivityDictionaryEntry,
  ClientDictionaryEntry,
  TenantConfig,
  TrackingEvent,
  WorkSession,
} from './types';

function toMs(isoUtc: string): number {
  const parsed = Date.parse(isoUtc);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isBriefInterruptionApp(app: string): boolean {
  return /slack|teams|outlook|mail|calendar|messages/i.test(app);
}

function sameClusterKey(
  a: ReturnType<typeof extractEntitiesFromPayload>,
  b: ReturnType<typeof extractEntitiesFromPayload>,
  pathA: string | null,
  pathB: string | null
): boolean {
  if (a.clientId && b.clientId && a.clientId === b.clientId) {
    // Same client & compatible period (either equal or one missing)
    if (!a.period || !b.period || a.period === b.period) return true;
  }
  if (pathA && pathB && pathA === pathB) return true;
  return false;
}

/**
 * Stage 4: Sessionizer
 * - Merges OS Desktop Agent and Browser Extension events chronologically
 * - Bridges brief interruptions (e.g., <= 30s glance at Slack/email)
 * - Clusters interleaved work sharing client, file, or fiscal period
 * - Closes a session on long idle gaps
 */
export function sessionizeEvents(
  events: TrackingEvent[],
  clients: ClientDictionaryEntry[],
  activityRules: ActivityDictionaryEntry[],
  config: TenantConfig
): WorkSession[] {
  const activityEvents = events
    .filter(
      (e) =>
        e.priority === 'activity' &&
        e.type !== 'activity.heartbeat'
    )
    .slice()
    .sort((a, b) => toMs(a.event_time_utc) - toMs(b.event_time_utc));

  if (activityEvents.length === 0) return [];

  const maxInterruptionMs =
    (config.sessionizer.maxInterruptionSeconds || 30) * 1000;
  const idleCloseMs = (config.sessionizer.idleCloseSeconds || 180) * 1000;

  interface RawUnit {
    event: TrackingEvent;
    startMs: number;
    endMs: number;
    durMs: number;
    isIdle: boolean;
    entities: ReturnType<typeof extractEntitiesFromPayload>;
  }

  const units: RawUnit[] = activityEvents.map((ev) => {
    const startMs = toMs(ev.event_time_utc);
    const durMs = Math.max(5000, ev.payload.duration_ms ?? 15000);
    const endMs = startMs + durMs;
    const isIdle = ev.type === 'activity.idle' || ev.payload.idle === true;
    const entities = isIdle
      ? {
          clientId: null,
          clientName: null,
          period: null,
          docType: null,
          activityType: 'Idle / Away',
          signals: ['workstation idle event'],
        }
      : extractEntitiesFromPayload(ev.payload, clients, activityRules);

    return { event: ev, startMs, endMs, durMs, isIdle, entities };
  });

  const sessions: WorkSession[] = [];
  let current: {
    events: RawUnit[];
    startMs: number;
    endMs: number;
    isIdle: boolean;
    dominantEntities: ReturnType<typeof extractEntitiesFromPayload>;
    dominantPath: string | null;
    dominantUrl: string | null;
    dominantApp: string;
    dominantTitle: string;
    dominantDuration: number;
    extensionConnected: boolean;
  } | null = null;

  const flushCurrent = () => {
    if (!current || current.events.length === 0) return;
    const first = current.events[0].event;
    const totalSec = Math.max(
      15,
      Math.round((current.endMs - current.startMs) / 1000)
    );
    sessions.push({
      id: `ses-${first.device_id}-${first.seq}`,
      tenantId: first.tenant_id,
      userId: first.user_id,
      deviceId: first.device_id,
      startTimeUtc: new Date(current.startMs).toISOString(),
      endTimeUtc: new Date(current.endMs).toISOString(),
      durationSeconds: totalSec,
      primaryApp: current.dominantApp,
      primaryTitle: current.dominantTitle,
      primaryPath: current.dominantPath,
      primaryUrl: current.dominantUrl,
      isIdle: current.isIdle,
      extensionConnected: current.extensionConnected,
      osPlatform: first.payload.os_platform || 'windows',
      entities: current.dominantEntities,
      eventIds: current.events.map((u) => u.event.event_id),
    });
    current = null;
  };

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];

    if (!current) {
      current = {
        events: [unit],
        startMs: unit.startMs,
        endMs: unit.endMs,
        isIdle: unit.isIdle,
        dominantEntities: unit.entities,
        dominantPath: unit.event.payload.file_path || null,
        dominantUrl: unit.event.payload.url || null,
        dominantApp: unit.event.payload.app || 'Unknown App',
        dominantTitle: unit.event.payload.window_title || 'Active Window',
        dominantDuration: unit.durMs,
        extensionConnected: unit.event.payload.extension_connected !== false,
      };
      continue;
    }

    const gapMs = Math.max(0, unit.startMs - current.endMs);

    // Long idle gap closes current session cleanly
    if (gapMs >= idleCloseMs || unit.isIdle !== current.isIdle) {
      flushCurrent();
      i--;
      continue;
    }

    // Check if this unit is a brief interruption (e.g., <=30s Slack check)
    // followed closely by work in the same client/context
    const nextUnit = units[i + 1];
    const isBriefGlance =
      !unit.isIdle &&
      unit.durMs <= maxInterruptionMs &&
      (isBriefInterruptionApp(unit.event.payload.app || '') || !unit.entities.clientId) &&
      nextUnit &&
      !nextUnit.isIdle &&
      sameClusterKey(
        current.dominantEntities,
        nextUnit.entities,
        current.dominantPath,
        nextUnit.event.payload.file_path || null
      );

    // Check if event clusters with current session by client/file/period, or same app+title
    const sameAppTitle =
      (unit.event.payload.app || '') === current.dominantApp &&
      (unit.event.payload.window_title || '') === current.dominantTitle;

    const sameClientCluster = sameClusterKey(
      current.dominantEntities,
      unit.entities,
      current.dominantPath,
      unit.event.payload.file_path || null
    );

    // Also bridge Browser Extension event arriving right alongside Desktop Window event
    const isExtensionMerge =
      Math.abs(unit.startMs - current.endMs) <= 5000 &&
      unit.event.type === 'activity.browser' &&
      !current.isIdle;

    if (isBriefGlance || sameClientCluster || sameAppTitle || isExtensionMerge) {
      current.events.push(unit);
      current.endMs = Math.max(current.endMs, unit.endMs);
      if (unit.event.payload.extension_connected === false) {
        current.extensionConnected = false;
      }
      if (unit.event.payload.url && !current.dominantUrl) {
        current.dominantUrl = unit.event.payload.url;
      }
      if (unit.event.payload.file_path && !current.dominantPath) {
        current.dominantPath = unit.event.payload.file_path;
      }
      if (
        !isBriefGlance &&
        (unit.entities.clientId && !current.dominantEntities.clientId ||
          unit.durMs > current.dominantDuration)
      ) {
        current.dominantApp = unit.event.payload.app || current.dominantApp;
        current.dominantTitle = unit.event.payload.window_title || current.dominantTitle;
        current.dominantDuration = unit.durMs;
        if (unit.entities.clientId || !current.dominantEntities.clientId) {
          current.dominantEntities = {
            ...current.dominantEntities,
            ...unit.entities,
            clientId: unit.entities.clientId || current.dominantEntities.clientId,
            clientName: unit.entities.clientName || current.dominantEntities.clientName,
            period: unit.entities.period || current.dominantEntities.period,
            docType: unit.entities.docType || current.dominantEntities.docType,
            activityType:
              unit.entities.activityType || current.dominantEntities.activityType,
            signals: Array.from(
              new Set([...current.dominantEntities.signals, ...unit.entities.signals])
            ),
          };
        }
      }
    } else {
      flushCurrent();
      i--;
    }
  }

  flushCurrent();
  return sessions;
}
