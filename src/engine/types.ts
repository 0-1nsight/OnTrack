export type UserRole =
  | 'accountant'
  | 'team_lead'
  | 'line_manager'
  | 'executive'
  | 'client'
  | 'admin_it';

export type ShiftPattern = '8-5' | '5-9' | 'remote' | 'weekend';
export type OSPlatform = 'windows' | 'macos' | 'linux' | 'vdi' | 'web';

export type EventPriority = 'state' | 'activity';

export type ActivityEventType =
  | 'activity.window'
  | 'activity.browser'
  | 'activity.file'
  | 'activity.idle'
  | 'activity.meeting'
  | 'activity.heartbeat';

export type StateEventType =
  | 'state.task_status'
  | 'state.step_confirmed'
  | 'state.milestone_confirmed'
  | 'state.session_attributed';

export type TrackingEventType = ActivityEventType | StateEventType;

export interface ProvisionalMatch {
  client_id: string;
  confidence: number;
  reason: string;
}

export interface TrackingEventPayload {
  // Activity fields (metadata only — never screenshots, keystrokes, clipboard, or content)
  app?: string;
  window_title?: string;
  file_path?: string | null;
  url?: string | null;
  domain?: string | null;
  duration_ms?: number;
  idle?: boolean;
  incognito?: boolean;
  meeting_active?: boolean;
  os_platform?: OSPlatform;
  extension_connected?: boolean;
  // Capture detail added by the document adapters, activity state machine and collectors.
  document_kind?: string | null;
  document_name?: string | null;
  document_section?: string | null;
  activity_state?: 'active' | 'idle' | 'away' | 'meeting' | 'locked' | 'sleeping';
  virtual_desktop_id?: string | null;
  capture_source?: 'native_events' | 'polling' | 'fallback';
  active_task_id?: string | null;
  entry_source?: 'manual' | 'timer' | 'reconciled';
  entry_project?: string;
  entry_category?: 'deep_work' | 'collaborative' | 'billable' | 'admin';
  entry_title?: string;
  provisional_match?: ProvisionalMatch;

  // State change fields (high-priority, never batched)
  entity_id?: string;
  task_id?: string;
  step_id?: string;
  from_value?: string;
  to_value?: string;
  expected_version?: number;
  actor_role?: UserRole;
}

export interface TrackingEvent {
  event_id: string;
  schema_version: 1;
  tenant_id: string;
  user_id: string;
  device_id: string;
  seq: number;
  type: TrackingEventType;
  priority: EventPriority;
  event_time_utc: string; // ISO-8601 UTC
  received_at: string | null; // ISO-8601 UTC stamped by server
  payload: TrackingEventPayload;
}

export interface TenantConfig {
  id: string;
  name: string;
  confidenceThresholds: {
    detected: number; // default 0.85
    suggested: number; // default 0.50
  };
  sessionizer: {
    maxInterruptionSeconds: number; // default 30
    idleCloseSeconds: number; // default 180
  };
  heartbeatIntervalSeconds: number; // default 12
  delayedThresholdSeconds: number; // default 120
  retentionDays: number; // default 60 (30-90)
  focusFactor?: number; // default 0.85 (effective productive hours ratio)
  monitoringPolicy: 'mandatory' | 'opt_in';
  serverUrl: string;
}

export type PortalAccentTheme = 'indigo' | 'emerald' | 'blue' | 'slate' | 'amber' | 'rose';

export interface PortalBrandingConfig {
  firmName: string;
  accentTheme: PortalAccentTheme;
  accentColor: string;
  portalTitle: string;
  customDomain: string;
  supportNotice: string;
  welcomeMessage: string;
  logoText: string;
  logoFileId: string | null;
}

export interface ShiftUser {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  teamId: string;
  shiftPattern: ShiftPattern;
  shiftStartHourUtc: number;
  shiftEndHourUtc: number;
  onLeave: boolean;
}

export interface ClientDictionaryEntry {
  id: string;
  tenantId: string;
  legalName: string;
  aliases: string[];
  codes: string[];
  folderPatterns: string[];
  knownDomains: string[];
  restrictedUserIds: string[]; // empty = unrestricted
  source: 'csv' | 'file_upload' | 'manual';
  updatedAtUtc: string;
}

export interface ActivityDictionaryEntry {
  id: string;
  tenantId: string;
  keyword: string;
  activityType: string; // e.g., 'Reconciliation', 'Tax Prep', 'Payroll', 'Audit', 'Review'
  workCategory: 'deep_work' | 'collaborative' | 'billable' | 'admin';
  weight: number;
}

export interface PrivacyRule {
  id: string;
  tenantId: string;
  kind: 'app' | 'domain' | 'path';
  pattern: string;
  reason: string;
  enabled: boolean;
}

export interface TaskTemplateStep {
  id: string;
  order: number;
  title: string;
  activitySignature: string; // e.g., 'reconcil'
  docTypeHint?: string;
}

export interface TaskTemplate {
  id: string;
  tenantId: string;
  name: string;
  defaultCategory: 'deep_work' | 'collaborative' | 'billable' | 'admin';
  steps: TaskTemplateStep[];
}

export interface EngineTask {
  id: string;
  tenantId: string;
  clientId: string;
  clientName: string;
  templateId?: string;
  title: string;
  period: string; // e.g., 'Oct 2026', 'Q3 2026', 'FY25'
  status: 'todo' | 'in_progress' | 'blocked' | 'completed';
  dueDateUtc: string;
  assignedUserId: string;
  estimatedMinutes: number;
  version: number;
  updatedAtUtc: string;
}

export interface ExtractedEntities {
  clientId: string | null;
  clientName: string | null;
  period: string | null;
  docType: string | null;
  activityType: string | null;
  signals: string[];
}

export interface WorkSession {
  id: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  startTimeUtc: string;
  endTimeUtc: string;
  durationSeconds: number;
  primaryApp: string;
  primaryTitle: string;
  primaryPath: string | null;
  primaryUrl: string | null;
  isIdle: boolean;
  extensionConnected: boolean;
  osPlatform: OSPlatform;
  entities: ExtractedEntities;
  eventIds: string[];
}

export type AttributionStatus =
  | 'detected'
  | 'suggested'
  | 'confirmed'
  | 'review_tray';

export interface AttributionRecord {
  id: string;
  sessionId: string;
  tenantId: string;
  userId: string;
  taskId: string | null;
  taskTitle: string | null;
  clientId: string | null;
  clientName: string | null;
  stepId: string | null;
  stepTitle: string | null;
  period: string | null;
  confidence: number; // 0..1
  reason: string;
  status: AttributionStatus;
  version: number;
  retroactiveRevision: boolean;
  revisedFromReason?: string;
  updatedAtUtc: string;
}

export interface AutoChecklistItem {
  id: string;
  tenantId: string;
  taskId: string;
  userId: string;
  stepId: string | null;
  orderIndex: number;
  title: string;
  status: 'detected' | 'suggested' | 'confirmed';
  minutesAccumulated: number;
  sourceSessionIds: string[];
  reason: string;
  isFreeForm: boolean;
  updatedAtUtc: string;
}

export interface LearnedRule {
  id: string;
  tenantId: string;
  userId: string;
  patternType: 'title_prefix' | 'file_pattern' | 'domain' | 'app_title';
  pattern: string;
  targetClientId: string;
  targetTaskId: string | null;
  accepted: boolean; // false = user explicitly rejected generalization
  createdAtUtc: string;
}

export type FreshnessStatus = 'live' | 'delayed' | 'offline' | 'off_shift';

export interface DeviceFreshnessRecord {
  deviceId: string;
  tenantId: string;
  userId: string;
  userName: string;
  shiftPattern: ShiftPattern;
  osPlatform: OSPlatform;
  extensionConnected: boolean;
  lastHeartbeatUtc: string;
  lastAckSeq: number;
  clockOffsetMs: number;
  status: FreshnessStatus;
  delayedSeconds: number;
}

export interface SyncConflict {
  id: string;
  tenantId: string;
  userId: string;
  taskId: string;
  taskTitle: string;
  localStatus: string;
  serverStatus: string;
  localVersion: number;
  serverVersion: number;
  createdAtUtc: string;
  resolved: boolean;
  resolution?: 'keep_local' | 'keep_server';
}

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  actorUserId: string;
  actorRole: UserRole;
  targetUserId: string | null;
  action: string;
  details: string;
  createdAtUtc: string;
}

export interface FleetFreshnessSummary {
  dataAsOfUtc: string;
  totalActiveShiftStaff: number;
  reportingLiveCount: number;
  delayedCount: number;
  offlineCount: number;
  offShiftCount: number;
  provisional: boolean;
  recentlyUpdatedNotice: string | null;
}

export interface ReplayGroundTruthItem {
  event_id: string;
  expectedClientId: string | null;
  expectedTaskId: string | null;
  isExcluded?: boolean;
}

export interface ReplayMetricsResult {
  totalEventsInput: number;
  filteredOutCount: number;
  excludedLeaksCount: number;
  sessionCount: number;
  autoAssignedCount: number;
  suggestedCount: number;
  reviewTrayCount: number;
  retroactiveRevisionsCount: number;
  autoAssignmentAccuracyPercent: number;
  coveragePercent: number;
  estimatedDailyReviewMinutes: number;
  items: {
    sessionId: string;
    primaryTitle: string;
    primaryApp: string;
    durationMinutes: number;
    expectedClientId: string | null;
    predictedClientId: string | null;
    predictedTaskId: string | null;
    confidence: number;
    status: AttributionStatus;
    reason: string;
    correct: boolean;
  }[];
}

export interface DeviceTokenRecord {
  tokenId: string;
  tenantId: string;
  userId: string;
  userName: string;
  deviceId: string;
  label: string;
  prefix: string;
  createdAtUtc: string;
  lastUsedUtc: string | null;
  revokedAtUtc: string | null;
}

export interface StoredFileRecord {
  fileId: string;
  tenantId: string;
  uploaderUserId: string;
  uploaderEmail: string;
  purpose: 'dictionary_import' | 'branding_asset' | 'portal_document' | 'policy_doc';
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  createdAtUtc: string;
}

export interface ShiftHandoffItem {
  taskId: string;
  taskTitle: string;
  clientName: string;
  period: string;
  lastUpdatedUtc: string;
  totalMinutes: number;
  lastDocuments: string[];
  confirmedSteps: string[];
  pendingSteps: string[];
  handoffNote: string;
}

export interface LatencyStats {
  lastBroadcastMs: number;
  p95BroadcastMs: number;
  sampleCount: number;
}

