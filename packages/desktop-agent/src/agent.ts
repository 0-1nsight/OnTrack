import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { captureForegroundMetadata, WindowSample } from './adapters/osCollector.ts';

interface AgentConfig {
  serverUrl: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  deviceToken: string;
  bridgePort: number;
  heartbeatSeconds: number;
  pollSampleMs: number;
  idleThresholdSeconds: number;
  exclusions: {
    apps: string[];
    domains: string[];
    paths: string[];
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  serverUrl: process.env.ONTRACK_SERVER_URL || process.env.CHRONOFLOW_SERVER_URL || 'http://localhost:3000',
  tenantId: process.env.ONTRACK_TENANT_ID || process.env.CHRONOFLOW_TENANT_ID || 'firm_apex',
  userId: process.env.ONTRACK_USER_ID || process.env.CHRONOFLOW_USER_ID || 'u_acc_01',
  deviceId: process.env.ONTRACK_DEVICE_ID || process.env.CHRONOFLOW_DEVICE_ID || `dev-${os.hostname()}`,
  deviceToken: process.env.ONTRACK_DEVICE_TOKEN || process.env.CHRONOFLOW_DEVICE_TOKEN || '',
  bridgePort: Number(process.env.ONTRACK_BRIDGE_PORT || process.env.CHRONOFLOW_BRIDGE_PORT || 47621),
  heartbeatSeconds: 12,
  pollSampleMs: 5000,
  idleThresholdSeconds: 180,
  exclusions: {
    apps: ['1Password', 'Bitwarden', 'KeePass'],
    domains: ['personalbank', 'chase.com', 'health', 'mychart'],
    paths: ['Private', 'Personal'],
  },
};

function loadConfig(): AgentConfig {
  const cfgPath = path.resolve(process.cwd(), 'agent.config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return {
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
  return DEFAULT_CONFIG;
}

const config = loadConfig();
const QUEUE_FILE = path.resolve(process.cwd(), '.ontrack-offline-queue.jsonl');
const SEQ_FILE = path.resolve(process.cwd(), '.ontrack-seq.json');

let seq = 0;
try {
  if (fs.existsSync(SEQ_FILE)) {
    seq = Number(JSON.parse(fs.readFileSync(SEQ_FILE, 'utf8')).seq || 0);
  }
} catch {
  seq = 0;
}

function nextSeq(): number {
  seq += 1;
  fs.writeFileSync(SEQ_FILE, JSON.stringify({ seq }), 'utf8');
  return seq;
}

let clockSkewMs = 0;
let lastBrowserPingMs = 0;
let latestSample: WindowSample | null = null;
let wsClient: WebSocket | null = null;
let wsConnected = false;

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.deviceToken) {
    headers.Authorization = `Bearer ${config.deviceToken}`;
  }
  return headers;
}

async function syncBootstrapFromServer() {
  try {
    const qs = new URLSearchParams({ tenantId: config.tenantId });
    const res = await fetch(`${config.serverUrl}/api/engine/agent/bootstrap?${qs.toString()}`, {
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

function connectWebSocket() {
  if (typeof globalThis.WebSocket !== 'function') return;
  try {
    const baseWs = config.serverUrl.replace(/^http/i, 'ws');
    const qs = new URLSearchParams({
      tenantId: config.tenantId,
      userId: config.userId,
      role: 'accountant',
    });
    if (config.deviceToken) {
      qs.set('token', config.deviceToken);
    }
    const ws = new globalThis.WebSocket(`${baseWs}/ws/engine?${qs.toString()}`);
    wsClient = ws;

    ws.onopen = () => {
      wsConnected = true;
      void flushQueue();
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.type === 'sync:ack' && msg.acceptedCount > 0) {
          // Acknowledged
        } else if (msg.type === 'state:updated') {
          void syncBootstrapFromServer();
        }
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      wsConnected = false;
      setTimeout(connectWebSocket, 10000);
    };
    ws.onerror = () => {
      wsConnected = false;
    };
  } catch {
    wsConnected = false;
  }
}

function isExcluded(payload: Record<string, any>): boolean {
  if (payload.incognito === true) return true;
  const app = String(payload.app || '').toLowerCase();
  const title = String(payload.window_title || '').toLowerCase();
  const url = String(payload.url || '').toLowerCase();
  const filePath = String(payload.file_path || '').toLowerCase();

  for (const p of config.exclusions.apps) {
    if (app.includes(p.toLowerCase()) || title.includes(p.toLowerCase())) return true;
  }
  for (const d of config.exclusions.domains) {
    if (url.includes(d.toLowerCase()) || title.includes(d.toLowerCase())) return true;
  }
  for (const fp of config.exclusions.paths) {
    const clean = fp.replace(/\*/g, '').toLowerCase();
    if (clean && filePath.includes(clean)) return true;
  }
  return false;
}

function appendOfflineQueue(event: Record<string, any>) {
  fs.appendFileSync(QUEUE_FILE, `${JSON.stringify(event)}\n`, 'utf8');
}

function readOfflineQueue(): Record<string, any>[] {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  const lines = fs.readFileSync(QUEUE_FILE, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

function writeOfflineQueue(events: Record<string, any>[]) {
  if (events.length === 0) {
    if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
    return;
  }
  fs.writeFileSync(
    QUEUE_FILE,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
}

async function flushQueue() {
  const queued = readOfflineQueue();
  if (queued.length === 0) return;

  const ordered = [
    ...queued.filter((e) => e.priority === 'state'),
    ...queued.filter((e) => e.priority !== 'state'),
  ];

  // Prefer active WebSocket stream; fall back to HTTP POST
  if (wsClient && wsConnected && wsClient.readyState === globalThis.WebSocket.OPEN) {
    try {
      wsClient.send(
        JSON.stringify({
          type: 'sync:batch',
          tenantId: config.tenantId,
          userId: config.userId,
          deviceId: config.deviceId,
          events: ordered,
        })
      );
      writeOfflineQueue([]);
      return;
    } catch {
      wsConnected = false;
    }
  }

  try {
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
      writeOfflineQueue([]);
    }
  } catch {
    // Remain buffered offline until connectivity resumes
  }
}

function enqueueEvent(
  type: string,
  priority: 'state' | 'activity',
  payload: Record<string, any>
) {
  if (isExcluded(payload)) {
    return;
  }
  const calibratedTime = new Date(Date.now() + clockSkewMs).toISOString();
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
  appendOfflineQueue(event);
  if (priority === 'state') {
    void flushQueue();
  }
}

// Local Native Messaging / HTTP Bridge (127.0.0.1:47621)
const bridgeServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/browser-event') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body || '{}');
        lastBrowserPingMs = Date.now();
        enqueueEvent('activity.browser', 'activity', {
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end('Invalid payload');
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        excludedDomains: config.exclusions.domains,
        idleThresholdSeconds: config.idleThresholdSeconds,
        deviceId: config.deviceId,
      })
    );
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        deviceId: config.deviceId,
        tenantId: config.tenantId,
        seq,
        wsConnected,
        clockSkewMs,
        extensionConnected: Date.now() - lastBrowserPingMs < 45000,
        latestSample,
      })
    );
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

bridgeServer.listen(config.bridgePort, '127.0.0.1', () => {
  console.log(
    `[onTrack Agent] Bridge on http://127.0.0.1:${config.bridgePort} · Pairing: ${
      config.deviceToken ? 'ENROLLED' : 'UNPAIRED'
    }`
  );
  void syncBootstrapFromServer();
  connectWebSocket();
});

// Refresh dynamic privacy policy from server every 60s
setInterval(() => {
  void syncBootstrapFromServer();
}, 60_000);

// OS Collector Loop
let lastSignature = '';
setInterval(async () => {
  const sample = await captureForegroundMetadata();
  latestSample = sample;
  const isIdle = sample.idleSeconds >= config.idleThresholdSeconds;
  const extensionConnected = Date.now() - lastBrowserPingMs < 45000;
  const signature = `${sample.app}|${sample.windowTitle}|${isIdle}`;

  if (signature !== lastSignature) {
    lastSignature = signature;
    enqueueEvent(
      isIdle ? 'activity.idle' : sample.meetingActive ? 'activity.meeting' : 'activity.window',
      'activity',
      {
        app: sample.app,
        window_title: sample.windowTitle,
        file_path: sample.filePath,
        duration_ms: config.pollSampleMs,
        idle: isIdle,
        meeting_active: sample.meetingActive,
        os_platform: sample.osPlatform,
        extension_connected: extensionConnected,
      }
    );
  }
}, config.pollSampleMs);

// Heartbeat + Flush Loop (12s)
setInterval(() => {
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
}, config.heartbeatSeconds * 1000);
