import { sanitizeAndFilterEvent } from '../engine/privacyFilter';
import {
  ActivityDictionaryEntry,
  AttributionRecord,
  AttributionStatus,
  AuditLogEntry,
  AutoChecklistItem,
  ClientDictionaryEntry,
  DeviceFreshnessRecord,
  DeviceTokenRecord,
  EngineTask,
  FleetFreshnessSummary,
  LatencyStats,
  LearnedRule,
  PrivacyRule,
  ReplayMetricsResult,
  ShiftHandoffItem,
  ShiftPattern,
  ShiftUser,
  StoredFileRecord,
  SyncConflict,
  TaskTemplate,
  TenantConfig,
  TrackingEvent,
  TrackingEventPayload,
  TrackingEventType,
  UserRole,
  WorkSession,
} from '../engine/types';

export interface EngineSnapshot {
  authMode: 'session' | 'device' | 'demo';
  dialect: 'sqlite' | 'postgres';
  config: TenantConfig;
  visibility: {
    viewerUserId: string;
    viewerRole: UserRole;
    targetUserId: string;
    timelinePermitted: boolean;
    clientContentVisible: boolean;
  };
  staffUsers: ShiftUser[];
  deviceTokens: DeviceTokenRecord[];
  storedFiles: StoredFileRecord[];
  clients: ClientDictionaryEntry[];
  activityRules: ActivityDictionaryEntry[];
  privacyRules: PrivacyRule[];
  templates: TaskTemplate[];
  tasks: EngineTask[];
  learnedRules: LearnedRule[];
  sessions: WorkSession[];
  attributions: AttributionRecord[];
  checklistItems: AutoChecklistItem[];
  revisionsPublished: {
    sessionId: string;
    previousReason: string;
    newReason: string;
    newTaskTitle: string | null;
    newConfidence: number;
  }[];
  handoffs: ShiftHandoffItem[];
  devices: DeviceFreshnessRecord[];
  freshnessSummary: FleetFreshnessSummary;
  latencyStats: LatencyStats;
  conflicts: SyncConflict[];
  auditLogs: AuditLogEntry[];
}

export interface AcceptanceCheckItem {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
}

export interface AcceptanceReport {
  passedCount: number;
  totalCount: number;
  checks: AcceptanceCheckItem[];
  replay: ReplayMetricsResult;
}

export interface LocalAgentHealth {
  online: boolean;
  deviceId?: string;
  wsConnected?: boolean;
  extensionConnected?: boolean;
  clockSkewMs?: number;
  latestSample?: {
    app: string;
    windowTitle: string;
    idleSeconds: number;
    osPlatform: string;
  } | null;
}

const QUEUE_KEY = 'ontrack_engine_queue_v1';
const SEQ_KEY = 'ontrack_engine_seq_v1';
const DEVICE_KEY = 'ontrack_engine_device_v1';

function buildAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra };
}

export function getOrCreateLocalDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) {
      return existing;
    }
    const created = `dev-web-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return 'dev-web-local';
  }
}

export function nextLocalSeq(): number {
  try {
    const prev = Number(localStorage.getItem(SEQ_KEY) ?? '200');
    const next = prev + 1;
    localStorage.setItem(SEQ_KEY, String(next));
    return next;
  } catch {
    return Date.now();
  }
}

export function loadLocalQueue(): TrackingEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocalQueue(events: TrackingEvent[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(events));
  } catch {
    // Ignore storage quota errors
  }
}

export function acknowledgeLocalEventIds(ackedIds: Set<string>): void {
  if (ackedIds.size === 0) return;
  const remaining = loadLocalQueue().filter((ev) => !ackedIds.has(ev.event_id));
  saveLocalQueue(remaining);
}

export function buildLocalTrackingEvent(params: {
  tenantId: string;
  userId: string;
  deviceId: string;
  type: TrackingEventType;
  priority: 'state' | 'activity';
  payload: TrackingEventPayload;
  eventTimeUtc?: string;
}): TrackingEvent {
  return {
    event_id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    schema_version: 1,
    tenant_id: params.tenantId,
    user_id: params.userId,
    device_id: params.deviceId,
    seq: nextLocalSeq(),
    type: params.type,
    priority: params.priority,
    event_time_utc: params.eventTimeUtc || new Date().toISOString(),
    received_at: null,
    payload: params.payload,
  };
}

/**
 * Enforces PRIV-1 & PRIV-2 on device BEFORE buffering or syncing.
 */
export function filterAndEnqueueEvent(
  ev: TrackingEvent,
  privacyRules: PrivacyRule[]
): { allowed: boolean; dropReason: string | null; queueLength: number } {
  const result = sanitizeAndFilterEvent(ev, privacyRules);
  if (!result.allowed || !result.sanitizedEvent) {
    return {
      allowed: false,
      dropReason: result.dropReason || 'Blocked by local privacy filter',
      queueLength: loadLocalQueue().length,
    };
  }
  const q = loadLocalQueue();
  q.push(result.sanitizedEvent);
  saveLocalQueue(q);
  return { allowed: true, dropReason: null, queueLength: q.length };
}

export async function probeLocalDesktopAgentBridge(): Promise<LocalAgentHealth> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 900);
    const res = await fetch('http://127.0.0.1:47621/health', {
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (!res.ok) return { online: false };
    const data = await res.json();
    return {
      online: Boolean(data.ok),
      deviceId: data.deviceId,
      wsConnected: Boolean(data.wsConnected),
      extensionConnected: Boolean(data.extensionConnected),
      clockSkewMs: Number(data.clockSkewMs || 0),
      latestSample: data.latestSample || null,
    };
  } catch {
    return { online: false };
  }
}

export async function fetchEngineSnapshot(params: {
  tenantId: string;
  viewerUserId: string;
  viewerRole: UserRole;
  targetUserId: string;
  drilldownGranted: boolean;
}): Promise<EngineSnapshot> {
  const qs = new URLSearchParams({
    tenantId: params.tenantId,
    viewerUserId: params.viewerUserId,
    viewerRole: params.viewerRole,
    targetUserId: params.targetUserId,
    drilldown: params.drilldownGranted ? 'true' : 'false',
  });
  const res = await fetch(`/api/engine/snapshot?${qs.toString()}`, {
    credentials: 'include',
    headers: buildAuthHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Snapshot failed (${res.status})`);
  }
  return res.json();
}

export async function pollEngineSnapshot(params: {
  tenantId: string;
  viewerUserId: string;
  viewerRole: UserRole;
  targetUserId: string;
  drilldownGranted: boolean;
}): Promise<EngineSnapshot & { transport: string; serverTimeUtc: string }> {
  const qs = new URLSearchParams({
    tenantId: params.tenantId,
    viewerUserId: params.viewerUserId,
    viewerRole: params.viewerRole,
    targetUserId: params.targetUserId,
    drilldown: params.drilldownGranted ? 'true' : 'false',
  });
  const res = await fetch(`/api/engine/poll?${qs.toString()}`, {
    credentials: 'include',
    headers: buildAuthHeaders(),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Polling failed (${res.status})`);
  }
  return res.json();
}

export async function flushQueuedEventsOverHttp(params: {
  tenantId: string;
  userId: string;
  deviceId: string;
}): Promise<{
  acceptedCount: number;
  duplicateCount: number;
  rejectedPrivacyCount: number;
  lastAckSeq: number;
  clockOffsetMs: number;
  conflictsCreated: SyncConflict[];
}> {
  const queue = loadLocalQueue().filter(
    (e) => e.tenant_id === params.tenantId && e.user_id === params.userId
  );
  if (queue.length === 0) {
    return {
      acceptedCount: 0,
      duplicateCount: 0,
      rejectedPrivacyCount: 0,
      lastAckSeq: 0,
      clockOffsetMs: 0,
      conflictsCreated: [],
    };
  }

  const ordered = [...queue].sort((a, b) => {
    if (a.priority === b.priority) return a.seq - b.seq;
    return a.priority === 'state' ? -1 : 1;
  });
  const sentIds = new Set(ordered.map((e) => e.event_id));

  const res = await fetch('/api/engine/sync', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      tenantId: params.tenantId,
      userId: params.userId,
      deviceId: params.deviceId,
      events: ordered,
    }),
  });

  if (!res.ok) {
    throw new Error(`Sync failed (${res.status})`);
  }

  const data = await res.json();
  acknowledgeLocalEventIds(sentIds);
  return data;
}

export async function saveManualClientApi(payload: {
  tenantId: string;
  legalName: string;
  aliases: string[];
  codes: string[];
  folderPatterns: string[];
  knownDomains: string[];
  restrictedUserIds: string[];
}): Promise<ClientDictionaryEntry> {
  const res = await fetch('/api/engine/clients', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ...payload, source: 'manual' }),
  });
  if (!res.ok) throw new Error('Failed to save client');
  const data = await res.json();
  return data.client;
}

export async function importClientsRawApi(payload: {
  tenantId: string;
  rawText: string;
  source: 'csv' | 'file_upload';
}): Promise<{ importedCount: number; clients: ClientDictionaryEntry[] }> {
  const res = await fetch('/api/engine/clients/import', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Import failed');
  return res.json();
}

export async function deleteClientApi(tenantId: string, clientId: string) {
  const res = await fetch(
    `/api/engine/clients/${encodeURIComponent(clientId)}?tenantId=${encodeURIComponent(tenantId)}`,
    { method: 'DELETE', credentials: 'include', headers: buildAuthHeaders() }
  );
  if (!res.ok) throw new Error('Delete failed');
}

export async function addActivityRuleApi(payload: {
  tenantId: string;
  keyword: string;
  activityType: string;
  workCategory: 'deep_work' | 'collaborative' | 'billable' | 'admin';
  weight: number;
}) {
  const res = await fetch('/api/engine/activity-rules', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to add activity rule');
  return res.json();
}

export async function deleteActivityRuleApi(tenantId: string, id: string) {
  await fetch(
    `/api/engine/activity-rules/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`,
    { method: 'DELETE', credentials: 'include', headers: buildAuthHeaders() }
  );
}

export async function addPrivacyRuleApi(payload: {
  tenantId: string;
  kind: 'app' | 'domain' | 'path';
  pattern: string;
  reason: string;
}) {
  const res = await fetch('/api/engine/privacy-rules', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to add privacy rule');
  return res.json();
}

export async function togglePrivacyRuleApi(
  tenantId: string,
  id: string,
  enabled: boolean
) {
  await fetch(`/api/engine/privacy-rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId, enabled }),
  });
}

export async function deletePrivacyRuleApi(tenantId: string, id: string) {
  await fetch(
    `/api/engine/privacy-rules/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`,
    { method: 'DELETE', credentials: 'include', headers: buildAuthHeaders() }
  );
}

export async function updateEngineConfigApi(
  tenantId: string,
  partial: Partial<TenantConfig> & { aiReportsEnabled?: boolean }
) {
  const res = await fetch('/api/engine/config', {
    method: 'PATCH',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId, ...partial }),
  });
  if (!res.ok) throw new Error('Failed to update config');
  return res.json();
}

export async function createEngineTaskApi(payload: {
  tenantId: string;
  clientId?: string;
  clientName?: string;
  project?: string;
  templateId?: string;
  title: string;
  period?: string;
  status?: EngineTask['status'];
  dueDateUtc?: string;
  assignedUserId?: string;
  estimatedMinutes: number;
}): Promise<{ task: EngineTask }> {
  const res = await fetch('/api/engine/tasks', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to create task');
  return res.json();
}

export async function updateEngineTaskApi(
  taskId: string,
  updates: {
    title?: string;
    status?: EngineTask['status'];
    estimatedMinutes?: number;
    dueDateUtc?: string;
    period?: string;
    assignedUserId?: string;
    clientId?: string;
    clientName?: string;
  }
): Promise<{ task: EngineTask }> {
  const res = await fetch(`/api/engine/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error('Failed to update task');
  return res.json();
}

export async function deleteEngineTaskApi(taskId: string): Promise<{ ok: boolean }> {
  const res = await fetch(`/api/engine/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: buildAuthHeaders(),
  });
  if (!res.ok) throw new Error('Failed to delete task');
  return res.json();
}

export async function resolveAttributionApi(payload: {
  tenantId: string;
  userId: string;
  sessionId: string;
  taskId: string | null;
  status: AttributionStatus;
  customReason?: string;
  createRulePattern?: string;
  rejectRulePattern?: string;
}) {
  const res = await fetch(
    `/api/engine/attributions/${encodeURIComponent(payload.sessionId)}/resolve`,
    {
      method: 'POST',
    credentials: 'include',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error('Failed to resolve attribution');
  return res.json();
}

export async function saveChecklistItemApi(
  tenantId: string,
  item: AutoChecklistItem
) {
  const res = await fetch('/api/engine/checklists', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId, item }),
  });
  if (!res.ok) throw new Error('Failed to save checklist item');
  return res.json();
}

export async function mergeChecklistItemsApi(payload: {
  tenantId: string;
  taskId: string;
  itemsToMerge: AutoChecklistItem[];
  mergedTitle?: string;
}) {
  const res = await fetch('/api/engine/checklists/merge', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to merge checklist items');
  return res.json();
}

export async function reorderChecklistItemsApi(
  tenantId: string,
  items: AutoChecklistItem[]
) {
  const res = await fetch('/api/engine/checklists/reorder', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId, items }),
  });
  if (!res.ok) throw new Error('Failed to reorder checklist items');
  return res.json();
}

export async function deleteChecklistItemApi(tenantId: string, id: string) {
  await fetch(
    `/api/engine/checklists/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`,
    { method: 'DELETE', credentials: 'include', headers: buildAuthHeaders() }
  );
}

export async function resolveConflictApi(
  tenantId: string,
  conflictId: string,
  resolution: 'keep_local' | 'keep_server'
) {
  const res = await fetch(
    `/api/engine/conflicts/${encodeURIComponent(conflictId)}/resolve`,
    {
      method: 'POST',
    credentials: 'include',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ tenantId, resolution }),
    }
  );
  if (!res.ok) throw new Error('Failed to resolve conflict');
  return res.json();
}

export async function importStaffCsvApi(tenantId: string, rawText: string) {
  const res = await fetch('/api/engine/staff/import', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId, rawText }),
  });
  if (!res.ok) throw new Error('Failed to import staff CSV');
  return res.json();
}

export async function updateStaffRoleApi(
  tenantId: string,
  userId: string,
  role: UserRole,
  shiftPattern?: ShiftPattern,
  onLeave?: boolean,
  canDrilldownTimeline?: boolean
) {
  const res = await fetch(`/api/engine/staff/${encodeURIComponent(userId)}/role`, {
    method: 'PATCH',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId, role, shiftPattern, onLeave, canDrilldownTimeline }),
  });
  if (!res.ok) throw new Error('Failed to update staff role');
  return res.json();
}

export async function pairDeviceTokenApi(payload: {
  tenantId: string;
  userId: string;
  deviceId?: string;
  label: string;
}): Promise<{ record: DeviceTokenRecord; rawToken: string }> {
  const res = await fetch('/api/engine/devices/pair', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to pair device');
  return res.json();
}

export async function revokeDeviceTokenApi(tenantId: string, tokenId: string) {
  const res = await fetch(
    `/api/engine/devices/${encodeURIComponent(tokenId)}?tenantId=${encodeURIComponent(tenantId)}`,
    { method: 'DELETE', credentials: 'include', headers: buildAuthHeaders() }
  );
  if (!res.ok) throw new Error('Failed to revoke device token');
}

export async function purgeRetentionApi(
  tenantId: string
): Promise<{ purgedCount: number; cutoffUtc: string }> {
  const res = await fetch('/api/engine/retention/purge', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId }),
  });
  if (!res.ok) throw new Error('Retention purge failed');
  return res.json();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function uploadPortableFileApi(payload: {
  tenantId: string;
  file: File;
  purpose: 'dictionary_import' | 'branding_asset' | 'portal_document' | 'policy_doc';
}): Promise<{ file: StoredFileRecord }> {
  const buf = await payload.file.arrayBuffer();
  const contentBase64 = arrayBufferToBase64(buf);
  const res = await fetch('/api/engine/files', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      tenantId: payload.tenantId,
      originalName: payload.file.name,
      mimeType: payload.file.type || 'application/octet-stream',
      purpose: payload.purpose,
      contentBase64,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'File upload failed');
  }
  return res.json();
}

export async function downloadPortableFileWithAuth(
  tenantId: string,
  fileId: string,
  filename: string
) {
  const res = await fetch(
    `/api/engine/files/${encodeURIComponent(fileId)}/download?tenantId=${encodeURIComponent(tenantId)}`,
    { credentials: 'include', headers: buildAuthHeaders() }
  );
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function runReplayApi(
  tenantId: string,
  userId: string
): Promise<ReplayMetricsResult> {
  const res = await fetch('/api/engine/replay', {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tenantId, userId }),
  });
  if (!res.ok) throw new Error('Replay failed');
  return res.json();
}

export async function runAcceptanceApi(
  tenantId: string
): Promise<AcceptanceReport> {
  const res = await fetch(
    `/api/engine/acceptance?tenantId=${encodeURIComponent(tenantId)}`,
    { credentials: 'include', headers: buildAuthHeaders() }
  );
  if (!res.ok) throw new Error('Acceptance suite failed');
  return res.json();
}

export function getPackageDownloadUrl(
  kind: 'desktop-agent' | 'browser-extension',
  tenantId: string,
  userId: string
): string {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const qs = new URLSearchParams({
    serverUrl: origin,
    tenantId,
    userId,
  });
  return `/api/engine/package/${kind}?${qs.toString()}`;
}

export async function downloadPackageZip(params: {
  kind: 'desktop-agent' | 'browser-extension';
  userId?: string;
  bridgeSecret?: string;
}): Promise<void> {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const res = await fetch(`/api/engine/package/${params.kind}`, {
    method: 'POST',
    credentials: 'include',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      serverUrl: origin,
      userId: params.userId,
      bridgeSecret: params.bridgeSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Package download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ontrack-${params.kind}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
