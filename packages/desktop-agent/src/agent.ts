import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { captureForegroundMetadata, type WindowSample } from './adapters/osCollector.ts';
import { WinFocusWatcher, type WatcherSample } from './adapters/winFocusWatcher.ts';
import { createBridgeRequestHandler } from './bridge.ts';
import { CaptureRuntime } from './captureRuntime.ts';
import { LocalAgentSqliteStore } from './localStore.ts';
import type { CapturedEvent, CaptureSample } from './capture/captureSampler.ts';

interface AgentConfig {
  serverUrl: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  deviceToken: string;
  bridgePort: number;
  bridgeSecret: string;
  heartbeatSeconds: number;
  pollSampleMs: number;
  idleThresholdSeconds: number;
  localCleanupMinutes: number;
  maxLocalPendingRows: number;
  maxLocalPendingHours: number;
  exclusions: {
    apps: string[];
    domains: string[];
    paths: string[];
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  serverUrl: process.env.ONTRACK_SERVER_URL || 'http://localhost:3000',
  tenantId: process.env.ONTRACK_TENANT_ID || '',
  userId: process.env.ONTRACK_USER_ID || '',
  deviceId: process.env.ONTRACK_DEVICE_ID || `dev-${os.hostname()}`,
  deviceToken: process.env.ONTRACK_DEVICE_TOKEN || '',
  bridgePort: Number(process.env.ONTRACK_BRIDGE_PORT || 47621),
  bridgeSecret: process.env.ONTRACK_BRIDGE_SECRET || '',
  heartbeatSeconds: 12,
  pollSampleMs: 2000,
  idleThresholdSeconds: 180,
  localCleanupMinutes: Number(process.env.ONTRACK_LOCAL_CLEANUP_MINUTES || 5),
  maxLocalPendingRows: Number(process.env.ONTRACK_MAX_LOCAL_PENDING_ROWS || 10000),
  maxLocalPendingHours: Number(process.env.ONTRACK_MAX_LOCAL_PENDING_HOURS || 72),
  exclusions: {
    apps: ['1Password', 'Bitwarden', 'KeePass'],
    domains: ['personalbank', 'chase.com', 'health', 'mychart'],
    paths: ['Private', 'Personal'],
  },
};

const FORBIDDEN_METADATA_KEYS = new Set([
  'screenshot',
  'screenshots',
  'image_base64',
  'keystroke',
  'keystrokes',
  'key_log',
  'clipboard',
  'clipboard_text',
  'document_content',
  'file_content',
  'page_content',
  'body_html',
  'dom_text',
  'raw_text',
  'gps',
  'latitude',
  'longitude',
]);

let hasEphemeralBridgeSecret = false;

function loadConfig(): AgentConfig {
  const cfgPath = path.resolve(process.cwd(), 'agent.config.json');
  let merged: AgentConfig = { ...DEFAULT_CONFIG };
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      merged = {
        ...DEFAULT_CONFIG,
        ...parsed,
        exclusions: {
          ...DEFAULT_CONFIG.exclusions,
          ...(parsed.exclusions || {}),
        },
      };
    } catch {
      // fall back to default
    }
  }
  if (!merged.bridgeSecret || !String(merged.bridgeSecret).trim()) {
    merged.bridgeSecret = crypto.randomBytes(24).toString('base64url');
    hasEphemeralBridgeSecret = true;
  }
  return merged;
}

const config = loadConfig();
const AGENT_PLATFORM: 'windows' | 'macos' | 'linux' | 'vdi' =
  os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'macos' : 'linux';

const localStore = new LocalAgentSqliteStore({
  dbPath: process.env.ONTRACK_LOCAL_DB_PATH || path.resolve(process.cwd(), '.ontrack-agent.db'),
  legacyDir: process.cwd(),
  maxPendingRows: config.maxLocalPendingRows,
  maxPendingAgeHours: config.maxLocalPendingHours,
});

const runtime = new CaptureRuntime({
  platform: AGENT_PLATFORM,
  store: {
    load: () => localStore.loadControls(),
    save: (state) => localStore.saveControls(state),
  },
  onEvents: (events) => enqueueCaptured(events),
  pipeline: {
    segmentMaxMs: 5_000,
    activity: {
      idleThresholdSeconds: config.idleThresholdSeconds,
      awayThresholdSeconds: Math.max(config.idleThresholdSeconds * 5, 900),
      meetingIdleGraceSeconds: 3600,
    },
  },
});

function nextSeq(): number {
  return localStore.nextSeq();
}

let clockSkewMs = 0;
let lastBrowserPingMs = 0;
let latestSample: WindowSample | null = null;
let wsClient: WebSocket | null = null;
let wsConnected = false;
let inFlightWsEventIds = new Set<string>();
let pendingWsAckTimer: ReturnType<typeof setTimeout> | null = null;
let activityFlushTimer: ReturnType<typeof setTimeout> | null = null;
let lastLivePulseKey = '';
let lastLivePulseAtMs = 0;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.deviceToken) {
    headers.Authorization = `Bearer ${config.deviceToken}`;
  }
  return headers;
}

async function syncBootstrapFromServer() {
  if (!config.tenantId && !config.deviceToken) return;
  try {
    const qs = new URLSearchParams();
    if (config.tenantId) qs.set('tenantId', config.tenantId);
    const querySuffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await fetch(`${config.serverUrl}/api/engine/agent/bootstrap${querySuffix}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    const data = (await res.json()) as {
      serverTimeUtc?: string;
      tenantId?: string;
      userId?: string;
      deviceId?: string | null;
      config?: { heartbeatIntervalSeconds?: number; sessionizer?: { idleCloseSeconds?: number } };
      privacyRules?: { kind: 'app' | 'domain' | 'path'; pattern: string; enabled: boolean }[];
    };

    if (data.serverTimeUtc) {
      const serverMs = Date.parse(data.serverTimeUtc);
      if (!Number.isNaN(serverMs)) {
        clockSkewMs = serverMs - Date.now();
      }
    }
    if (data.tenantId) config.tenantId = data.tenantId;
    if (data.userId) config.userId = data.userId;
    if (data.deviceId) config.deviceId = data.deviceId;
    if (data.config?.heartbeatIntervalSeconds) {
      config.heartbeatSeconds = data.config.heartbeatIntervalSeconds;
    }
    if (data.config?.sessionizer?.idleCloseSeconds) {
      config.idleThresholdSeconds = data.config.sessionizer.idleCloseSeconds;
    }

    if (Array.isArray(data.privacyRules)) {
      const apps = new Set<string>(['1Password', 'Bitwarden', 'KeePass']);
      const domains = new Set<string>(['personalbank', 'mychart']);
      const paths = new Set<string>(['Personal']);
      for (const r of data.privacyRules) {
        if (!r.enabled) continue;
        if (r.kind === 'app') apps.add(r.pattern);
        if (r.kind === 'domain') domains.add(r.pattern);
        if (r.kind === 'path') paths.add(r.pattern);
      }
      config.exclusions = {
        apps: Array.from(apps),
        domains: Array.from(domains),
        paths: Array.from(paths),
      };
    }
  } catch {
    // Offline or waiting for server; retain local exclusion policy
  }
}

function acknowledgeEventIds(ackedIds: Set<string>) {
  if (ackedIds.size === 0) return;
  localStore.acknowledgeSynced(ackedIds);
}

function clearPendingWsAck() {
  inFlightWsEventIds.clear();
  if (pendingWsAckTimer) {
    clearTimeout(pendingWsAckTimer);
    pendingWsAckTimer = null;
  }
}

function connectWebSocket() {
  if (typeof globalThis.WebSocket !== 'function') return;
  if (!config.deviceToken && !config.tenantId) return;
  try {
    const baseWs = config.serverUrl.replace(/^http/i, 'ws');
    const qs = new URLSearchParams();
    if (config.tenantId) qs.set('tenantId', config.tenantId);
    if (config.userId) qs.set('userId', config.userId);
    qs.set('role', 'accountant');
    if (config.deviceToken) {
      qs.set('token', config.deviceToken);
    }
    const ws = new globalThis.WebSocket(`${baseWs}/ws/engine?${qs.toString()}`);
    wsClient = ws;

    ws.onopen = () => {
      wsConnected = true;
      void flushQueue();
      emitLivePulse(true);
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.type === 'sync:ack') {
          acknowledgeEventIds(inFlightWsEventIds);
          clearPendingWsAck();
        } else if (msg.type === 'state:updated') {
          void syncBootstrapFromServer();
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      wsConnected = false;
      clearPendingWsAck();
      setTimeout(connectWebSocket, 10000);
    };
    ws.onerror = () => {
      wsConnected = false;
    };
  } catch {
    wsConnected = false;
  }
}

function wildcardMatch(target: string, pattern: string): boolean {
  const cleanTarget = target.toLowerCase();
  const cleanPattern = pattern.trim().toLowerCase();
  if (!cleanPattern) return false;
  if (!cleanPattern.includes('*')) {
    return cleanTarget.includes(cleanPattern);
  }
  const escaped = cleanPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i').test(cleanTarget);
}

function isExcluded(payload: Record<string, any>): boolean {
  if (payload.incognito === true) return true;
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase()) && payload[key] != null) {
      return true;
    }
  }
  const app = String(payload.app || '');
  const title = String(payload.window_title || '');
  const url = String(payload.url || '');
  const domain = String(payload.domain || '');
  const filePath = String(payload.file_path || '');

  for (const p of config.exclusions.apps) {
    if (wildcardMatch(app, p) || wildcardMatch(title, p)) return true;
  }
  for (const d of config.exclusions.domains) {
    if (wildcardMatch(url, d) || wildcardMatch(domain, d) || wildcardMatch(title, d)) {
      return true;
    }
  }
  for (const fp of config.exclusions.paths) {
    if (wildcardMatch(filePath, fp)) return true;
  }
  return false;
}

function appendOfflineQueue(event: Record<string, any>, eventTimeMs?: number) {
  localStore.enqueue(event, eventTimeMs);
}

async function flushQueue() {
  if (!config.tenantId && !config.deviceToken) return;
  const ordered = localStore.peekPending(250);
  if (ordered.length === 0) return;

  // Prefer active WebSocket stream; await sync:ack before clearing persisted queue
  if (
    wsClient &&
    wsConnected &&
    wsClient.readyState === globalThis.WebSocket.OPEN &&
    inFlightWsEventIds.size === 0
  ) {
    try {
      inFlightWsEventIds = new Set(ordered.map((e) => String(e.event_id)));
      pendingWsAckTimer = setTimeout(() => {
        clearPendingWsAck();
      }, 6000);
      wsClient.send(
        JSON.stringify({
          type: 'sync:batch',
          tenantId: config.tenantId,
          userId: config.userId,
          deviceId: config.deviceId,
          events: ordered,
        })
      );
      return;
    } catch {
      clearPendingWsAck();
      wsConnected = false;
    }
  }

  try {
    const sentIds = new Set(ordered.map((e) => String(e.event_id)));
    const res = await fetch(`${config.serverUrl}/api/engine/sync`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        tenantId: config.tenantId,
        userId: config.userId,
        deviceId: config.deviceId,
        events: ordered,
      }),
    });
    if (res.ok) {
      acknowledgeEventIds(sentIds);
    }
  } catch {
    // Remain buffered in local SQLite until connectivity resumes
  }
}

function scheduleActivityFlush() {
  if (activityFlushTimer) return;
  activityFlushTimer = setTimeout(() => {
    activityFlushTimer = null;
    void flushQueue();
  }, 120);
}

function emitLivePulse(force = false) {
  if (!wsClient || !wsConnected || wsClient.readyState !== globalThis.WebSocket.OPEN) return;
  if (!config.tenantId && !config.deviceToken) return;
  const controls = runtime.getControls();
  if (!controls.allowedNow) return;
  const open = runtime.getOpenState();
  if (!open) return;
  if (isExcluded(open.payload as Record<string, any>)) return;

  const nowMs = Date.now();
  const pulseKey = `${open.key}|${open.startMs}`;
  if (!force && pulseKey === lastLivePulseKey && nowMs - lastLivePulseAtMs < 4_000) {
    return;
  }

  lastLivePulseKey = pulseKey;
  lastLivePulseAtMs = nowMs;

  const appName = String(open.payload.app || 'Workstation');
  const documentTitle = String(
    open.payload.document_name || open.payload.window_title || appName
  );
  const domainOrPath = open.payload.domain
    ? String(open.payload.domain)
    : open.payload.file_path
    ? String(open.payload.file_path)
    : null;

  try {
    wsClient.send(
      JSON.stringify({
        type: 'live:pulse',
        tenantId: config.tenantId,
        userId: config.userId,
        deviceId: config.deviceId,
        liveActivity: {
          appName,
          documentTitle,
          domainOrPath,
          state: open.state,
          startedAtUtc: new Date(open.startMs + clockSkewMs).toISOString(),
          source: 'agent',
        },
      })
    );
  } catch {
    // Ignore transient WS send error; queue flush handles persisted segments
  }
}

function enqueueEvent(
  type: string,
  priority: 'state' | 'activity',
  payload: Record<string, any>,
  eventTimeMs?: number
): boolean {
  if (isExcluded(payload)) {
    return false;
  }
  const timeMs = eventTimeMs ?? Date.now();
  const calibratedTime = new Date(timeMs + clockSkewMs).toISOString();
  const event = {
    event_id: crypto.randomUUID(),
    schema_version: 1,
    tenant_id: config.tenantId,
    user_id: config.userId,
    device_id: config.deviceId,
    seq: nextSeq(),
    type,
    priority,
    event_time_utc: calibratedTime,
    received_at: null,
    payload,
  };
  appendOfflineQueue(event, timeMs);
  if (type !== 'activity.heartbeat') {
    runtime.recordQueued(type, timeMs, payload);
    if (priority === 'activity') {
      scheduleActivityFlush();
    }
  }
  if (priority === 'state') {
    void flushQueue();
  }
  return true;
}

function enqueueCaptured(events: CapturedEvent[]) {
  for (const ev of events) {
    enqueueEvent(ev.type, ev.priority, ev.payload as Record<string, any>, ev.eventTimeMs);
  }
}

// Local Native Messaging / HTTP Bridge (127.0.0.1:47621)
const bridgeServer = http.createServer(
  createBridgeRequestHandler({
    getSecret: () => config.bridgeSecret,
    getAllowedOrigins: () => {
      try {
        return config.serverUrl ? [new URL(config.serverUrl).origin] : [];
      } catch {
        return [];
      }
    },
    getConfigInfo: () => ({
      excludedDomains: config.exclusions.domains,
      idleThresholdSeconds: config.idleThresholdSeconds,
      deviceId: config.deviceId,
    }),
    getHealthInfo: () => {
      const storeStats = localStore.getStats();
      return {
        deviceId: config.deviceId,
        tenantId: config.tenantId,
        seq: localStore.getSeq(),
        wsConnected,
        clockSkewMs,
        extensionConnected: Date.now() - lastBrowserPingMs < 45000,
        localStore: {
          engine: 'sqlite',
          pendingCount: storeStats.pendingCount,
          syncedPendingPurgeCount: storeStats.syncedPendingPurgeCount,
          dbBytes: storeStats.dbBytes,
          lastCleanupAtMs: storeStats.lastCleanupAtMs,
        },
        // The health endpoint needs no secret, so it never includes window titles or file names.
        latestSample: latestSample
          ? { app: latestSample.app, idleSeconds: latestSample.idleSeconds, osPlatform: latestSample.osPlatform }
          : null,
      };
    },
    getControls: () => runtime.getControls(),
    applyControl: (msg) => runtime.applyControl(msg),
    getCaptureHealth: () => {
      const storeStats = localStore.getStats();
      return {
        ...runtime.getHealth(Date.now() - lastBrowserPingMs < 45000),
        localStore: {
          engine: 'sqlite',
          pendingCount: storeStats.pendingCount,
          syncedPendingPurgeCount: storeStats.syncedPendingPurgeCount,
          dbBytes: storeStats.dbBytes,
          lastCleanupAtMs: storeStats.lastCleanupAtMs,
        },
      };
    },
    getRecentEvents: (limit) => runtime.getRecentEvents(limit) as unknown as Record<string, unknown>[],
    onBrowserEvent: (msg) => {
      lastBrowserPingMs = Date.now();
      const controls = runtime.getControls();
      if (!controls.allowedNow) {
        return false;
      }
      return enqueueEvent('activity.browser', 'activity', {
        app: msg.browser || 'Google Chrome',
        window_title: msg.pageTitle || 'Browser Tab',
        url: msg.url || null,
        domain: msg.domain || null,
        file_path: msg.downloadFilename || null,
        duration_ms: msg.durationMs || 10000,
        idle: false,
        incognito: Boolean(msg.incognito),
        os_platform: msg.osPlatform || os.platform(),
        extension_connected: true,
      });
    },
  })
);

bridgeServer.listen(config.bridgePort, '127.0.0.1', () => {
  console.log(
    `[OnTrack Agent] Bridge on http://127.0.0.1:${config.bridgePort} · Pairing: ${
      config.deviceToken ? 'ENROLLED' : 'UNPAIRED'
    }`
  );
  if (hasEphemeralBridgeSecret) {
    console.log(
      `[OnTrack Agent] Generated runtime bridge secret (paste into Browser Extension popup): ${config.bridgeSecret}`
    );
  }
  void syncBootstrapFromServer().then(() => {
    connectWebSocket();
  });
});

// Refresh dynamic privacy policy from server every 60s
setInterval(() => {
  void syncBootstrapFromServer();
}, 60_000);

// OS Collector
function toCaptureSample(
  sample: WindowSample,
  source: CaptureSample['source']
): CaptureSample {
  return {
    atMs: Date.now(),
    app: sample.app,
    windowTitle: sample.windowTitle,
    filePath: sample.filePath,
    idleSeconds: sample.idleSeconds,
    sessionLocked: sample.sessionLocked,
    systemSleeping: sample.systemSleeping ?? false,
    meetingActive: sample.meetingActive,
    mediaInUse: sample.mediaInUse,
    osPlatform: sample.osPlatform,
    virtualDesktopId: sample.virtualDesktopId,
    source,
  };
}

const extensionIsConnected = () => Date.now() - lastBrowserPingMs < 45000;

function startPolling(mode: 'polling' | 'fallback') {
  runtime.setCollectorMode(mode);
  setInterval(async () => {
    try {
      const sample = await captureForegroundMetadata();
      latestSample = sample;
      runtime.setPlatformFacts({
        accessibilityGranted: sample.accessibilityGranted,
        linuxSession: sample.linuxSession,
      });
      if (sample.collectorFailed) {
        // Do not record a placeholder window as real activity.
        runtime.recordCollectorError();
        return;
      }
      enqueueCaptured(runtime.handleSample(toCaptureSample(sample, mode), extensionIsConnected()));
      emitLivePulse();
    } catch {
      runtime.recordCollectorError();
    }
  }, config.pollSampleMs);
}

function startCollector() {
  if (os.platform() !== 'win32') {
    startPolling('polling');
    return;
  }
  const watcher = new WinFocusWatcher({
    onSample: (w: WatcherSample) => {
      latestSample = {
        app: w.app,
        windowTitle: w.windowTitle,
        filePath: null,
        idleSeconds: w.idleSeconds,
        meetingActive: w.meetingActive,
        osPlatform: AGENT_PLATFORM,
        isVirtualDesktop: false,
        sessionLocked: w.sessionLocked,
        mediaInUse: w.mediaInUse,
        virtualDesktopId: w.virtualDesktopId,
        collectorFailed: false,
      };
      enqueueCaptured(
        runtime.handleSample(
          {
            atMs: w.atMs,
            app: w.app,
            windowTitle: w.windowTitle,
            filePath: null,
            idleSeconds: w.idleSeconds,
            sessionLocked: w.sessionLocked,
            systemSleeping: w.systemSleeping,
            meetingActive: w.meetingActive,
            mediaInUse: w.mediaInUse,
            osPlatform: AGENT_PLATFORM,
            virtualDesktopId: w.virtualDesktopId,
            source: 'native_events',
          },
          extensionIsConnected()
        )
      );
      emitLivePulse();
    },
    onError: (message) => {
      console.warn(`[OnTrack Agent] focus watcher: ${message}`);
      runtime.recordCollectorError();
    },
    onGiveUp: (reason) => {
      console.warn(`[OnTrack Agent] ${reason}; using the fallback collector.`);
      startPolling('fallback');
    },
  });
  void watcher.start().then((started) => {
    if (started) {
      runtime.setCollectorMode('native_events');
    } else {
      console.warn('[OnTrack Agent] Could not start the native focus watcher; using the fallback collector.');
      startPolling('fallback');
    }
  });
  process.on('exit', () => watcher.stop());
}

startCollector();

// Flush the open segment and compact local SQLite on shutdown so the last stretch of work is not lost.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    enqueueCaptured(runtime.shutdown());
    localStore.close();
    process.exit(0);
  });
}

function emitHeartbeat() {
  const extensionConnected = Date.now() - lastBrowserPingMs < 45000;
  enqueueEvent('activity.heartbeat', 'activity', {
    app: 'ontrack-agent',
    window_title: 'Agent Heartbeat',
    extension_connected: extensionConnected,
    os_platform:
      os.platform() === 'win32'
        ? 'windows'
        : os.platform() === 'darwin'
        ? 'macos'
        : 'linux',
  });
  void flushQueue();
}

// Initial immediate heartbeat so newly paired devices appear live on Timeline right away
setTimeout(() => {
  emitHeartbeat();
}, 1500);

// Heartbeat + Flush Loop (12s) + Live Presence Pulse (4s)
setInterval(emitHeartbeat, config.heartbeatSeconds * 1000);
setInterval(() => {
  emitLivePulse();
}, 4_000);

// Periodic local SQLite cleanup & WAL compaction so the agent never bogs down the user's machine
const cleanupMs = Math.max(1, config.localCleanupMinutes) * 60_000;
setInterval(() => {
  try {
    localStore.runPeriodicCleanup();
  } catch {
    // ignore transient cleanup failure
  }
}, cleanupMs).unref();
