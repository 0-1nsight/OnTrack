import {
  AuditLogEntry,
  DeviceFreshnessRecord,
  FleetFreshnessSummary,
  PortalAccentTheme,
  PortalBrandingConfig,
  ShiftPattern,
  TaskTemplate,
  UserRole,
} from '../engine/types';

export type PortalRequestStage =
  | 'Documents received'
  | 'In review'
  | 'Awaiting your approval'
  | 'Complete';

export interface StaffCapacityRow {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  teamId: string;
  shiftPattern: ShiftPattern;
  onLeave: boolean;
  canDrilldownTimeline: boolean;
  availableHoursWeek: number;
  assignedHoursWeek: number;
  trackedHoursWeek: number;
  utilizationPercent: number;
  deviceStatus: 'live' | 'delayed' | 'offline' | 'off_shift' | 'unpaired';
}

export interface ShiftHeatmapCell {
  dayLabel: string;
  dayIndex: number;
  assignedHours: number;
  availableHoursNetLeave: number;
  utilizationPercent: number;
}

export interface ShiftHeatmapRow {
  shiftPattern: ShiftPattern;
  shiftLabel: string;
  staffCount: number;
  onLeaveCount: number;
  weeklyAvailableHoursNetLeave: number;
  weeklyAssignedHours: number;
  days: ShiftHeatmapCell[];
}

export interface DeadlineRiskItem {
  taskId: string;
  title: string;
  clientId: string;
  clientName: string;
  period: string;
  assignedUserId: string;
  assignedUserName: string;
  dueDateUtc: string;
  status: string;
  estimatedHours: number;
  confirmedHours: number;
  detectedHours: number;
  trackedHours: number;
  remainingHours: number;
  hoursUntilDue: number;
  availableHoursBeforeDue: number;
  focusFactor: number;
  riskLevel: 'high' | 'medium' | 'low';
}

export interface ClientProfitabilityRow {
  clientId: string;
  clientName: string;
  taskCount: number;
  completedCount: number;
  estimatedHours: number;
  trackedHours: number;
  billableHours: number;
  estimatedFeeUsd: number;
  realizationPercent: number;
}

export interface RecurringForecastBucket {
  weekLabel: string;
  projectedRecurringHours: number;
  teamAvailableHours: number;
  leaveDeductedHours: number;
  capacityDeltaHours: number;
  status: 'balanced' | 'tight' | 'overallocated';
}

export interface EnrichedShiftHandoff {
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
  assignedUserId: string;
  assignedUserName: string;
  shiftPattern: ShiftPattern;
}

export interface RoleOverviewData {
  role: UserRole;
  viewerUserId: string;
  tenantName: string;
  focusFactor: number;
  freshnessSummary: FleetFreshnessSummary;
  staffCapacity: StaffCapacityRow[];
  shiftHeatmap: ShiftHeatmapRow[];
  deadlineRisks: DeadlineRiskItem[];
  clientProfitability: ClientProfitabilityRow[];
  recurringForecast: RecurringForecastBucket[];
  handoffs: EnrichedShiftHandoff[];
  devices: DeviceFreshnessRecord[];
  auditLogs: AuditLogEntry[];
  adminAlerts: {
    delayedDevicesCount: number;
    offlineDevicesCount: number;
    aiReportsEnabled: boolean;
    retentionDays: number;
    delayedThresholdSeconds: number;
    focusFactor: number;
    monitoringPolicy: 'mandatory' | 'opt_in';
    itDelayedDevices: {
      deviceId: string;
      userName: string;
      shiftPattern: ShiftPattern;
      delayedSeconds: number;
      status: 'delayed' | 'offline';
    }[];
  } | null;
}

export interface PortalOverviewData {
  lastUpdatedUtc: string;
  firmName: string;
  branding: PortalBrandingConfig;
  clientId: string;
  clientName: string;
  availableClients: { id: string; legalName: string }[];
  templates: { id: string; name: string; milestoneNames: string[] }[];
  requests: {
    id: string;
    tenantId: string;
    clientId: string;
    clientName: string;
    templateId: string | null;
    engineTaskId: string | null;
    title: string;
    period: string;
    stage: PortalRequestStage;
    expectedDueUtc: string;
    notes: string | null;
    approvalStatus: 'pending' | 'approved';
    approvedBy: string | null;
    signatureName: string | null;
    approvalNotes: string | null;
    approvedAtUtc: string | null;
    createdAtUtc: string;
    updatedAtUtc: string;
  }[];
  milestones: {
    id: string;
    tenantId: string;
    clientId: string;
    requestId: string;
    title: string;
    status: 'confirmed' | 'withdrawn';
    confirmedAtUtc: string;
    confirmedBy: string;
    withdrawnAtUtc: string | null;
    withdrawalReason: string | null;
    updatedAtUtc: string;
  }[];
  documentRequests: {
    id: string;
    tenantId: string;
    clientId: string;
    requestId: string;
    title: string;
    status: 'pending' | 'uploaded' | 'verified';
    dueDateUtc: string;
    reminderSentAtUtc: string | null;
    isOverdue: boolean;
    uploadedFileId: string | null;
    uploadedFileName: string | null;
    updatedAtUtc: string;
  }[];
  messages: {
    id: string;
    tenantId: string;
    clientId: string;
    requestId: string;
    senderName: string;
    senderRole: UserRole;
    body: string;
    createdAtUtc: string;
  }[];
}

export interface InviteRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  teamId: string;
  shiftPattern: ShiftPattern;
  expiresAtUtc: string;
  acceptedAtUtc: string | null;
  createdAtUtc: string;
}

export class PortalApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  constructor(message: string, status: number, code = 'PORTAL_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function fetchRoleOverviewApi(params: {
  tenantId: string;
  viewerRole: UserRole;
}): Promise<RoleOverviewData> {
  const qs = new URLSearchParams({
    tenantId: params.tenantId,
    previewRole: params.viewerRole,
  });
  const res = await fetch(`/api/engine/role-overview?${qs.toString()}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Role overview failed (${res.status})`);
  }
  return res.json();
}

export async function fetchPortalOverviewApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  previewUserId?: string;
  clientId?: string;
}): Promise<PortalOverviewData> {
  const qs = new URLSearchParams({
    tenantId: params.tenantId,
    previewRole: params.viewerRole,
  });
  if (params.previewUserId) qs.set('previewUserId', params.previewUserId);
  if (params.clientId) qs.set('clientId', params.clientId);
  const res = await fetch(`/api/portal/overview?${qs.toString()}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new PortalApiError(
      err.error || `Portal load failed (${res.status})`,
      res.status,
      err.code || 'PORTAL_LOAD_FAILED'
    );
  }
  return res.json();
}

export async function createPortalRequestApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  title: string;
  period: string;
  templateId?: string | null;
  expectedDueUtc?: string;
  notes?: string;
  clientId?: string;
}) {
  const res = await fetch('/api/portal/requests', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      title: params.title,
      period: params.period,
      templateId: params.templateId || null,
      expectedDueUtc: params.expectedDueUtc,
      notes: params.notes,
      clientId: params.clientId,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create portal request');
  }
  return res.json();
}

export async function updatePortalRequestStageApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  requestId: string;
  stage: PortalRequestStage;
}) {
  const res = await fetch(`/api/portal/requests/${encodeURIComponent(params.requestId)}/stage`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      stage: params.stage,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update stage');
  }
  return res.json();
}

export async function approvePortalRequestApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  requestId: string;
  signatureName?: string;
  approvalNotes?: string;
}) {
  const res = await fetch(`/api/portal/requests/${encodeURIComponent(params.requestId)}/approve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      signatureName: params.signatureName,
      approvalNotes: params.approvalNotes,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to record approval');
  }
  return res.json();
}

export async function confirmPortalMilestoneApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  requestId: string;
  title: string;
}) {
  const res = await fetch('/api/portal/milestones/confirm', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      requestId: params.requestId,
      title: params.title,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to publish milestone');
  }
  return res.json();
}

export async function withdrawPortalMilestoneApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  milestoneId: string;
  reason: string;
}) {
  const res = await fetch(
    `/api/portal/milestones/${encodeURIComponent(params.milestoneId)}/withdraw`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: params.tenantId,
        previewRole: params.viewerRole,
        reason: params.reason,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to withdraw milestone');
  }
  return res.json();
}

export async function postPortalMessageApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  requestId: string;
  body: string;
}) {
  const res = await fetch(`/api/portal/requests/${encodeURIComponent(params.requestId)}/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      body: params.body,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send message');
  }
  return res.json();
}

export async function createPortalDocRequestApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  requestId: string;
  title: string;
  dueDateUtc?: string;
}) {
  const res = await fetch('/api/portal/document-requests', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      requestId: params.requestId,
      title: params.title,
      dueDateUtc: params.dueDateUtc,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create document request');
  }
  return res.json();
}

export async function sendPortalDocReminderApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  docReqId: string;
}) {
  const res = await fetch(
    `/api/portal/document-requests/${encodeURIComponent(params.docReqId)}/remind`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: params.tenantId,
        previewRole: params.viewerRole,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send document reminder');
  }
  return res.json();
}

export async function verifyPortalDocUploadApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  docReqId: string;
}) {
  const res = await fetch(
    `/api/portal/document-requests/${encodeURIComponent(params.docReqId)}/verify`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: params.tenantId,
        previewRole: params.viewerRole,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to verify uploaded document');
  }
  return res.json();
}

export async function uploadPortalDocumentApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  docReqId: string;
  originalName: string;
  mimeType: string;
  contentBase64: string;
}) {
  const res = await fetch(
    `/api/portal/document-requests/${encodeURIComponent(params.docReqId)}/upload`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: params.tenantId,
        previewRole: params.viewerRole,
        originalName: params.originalName,
        mimeType: params.mimeType,
        contentBase64: params.contentBase64,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Document upload failed');
  }
  return res.json();
}

export function getPortalFileDownloadUrl(params: {
  fileId: string;
  tenantId: string;
  viewerRole: UserRole;
}): string {
  const qs = new URLSearchParams({
    tenantId: params.tenantId,
    previewRole: params.viewerRole,
  });
  return `/api/portal/files/${encodeURIComponent(params.fileId)}/download?${qs.toString()}`;
}

export async function fetchBrandingAndTemplatesApi(params: {
  tenantId: string;
  viewerRole: UserRole;
}): Promise<{ branding: PortalBrandingConfig; templates: TaskTemplate[] }> {
  const qs = new URLSearchParams({
    tenantId: params.tenantId,
    previewRole: params.viewerRole,
  });
  const res = await fetch(`/api/engine/branding?${qs.toString()}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load portal branding config');
  }
  return res.json();
}

export async function updatePortalBrandingApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  updates: {
    accentTheme?: PortalAccentTheme;
    portalTitle?: string;
    customDomain?: string;
    supportNotice?: string;
    welcomeMessage?: string;
    logoText?: string;
    logoFileId?: string | null;
  };
}): Promise<{ branding: PortalBrandingConfig }> {
  const res = await fetch('/api/engine/branding', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      ...params.updates,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update portal branding');
  }
  return res.json();
}

export async function updateTemplateMilestonesApi(params: {
  tenantId: string;
  viewerRole: UserRole;
  templateId: string;
  name?: string;
  milestoneNames: string[];
}): Promise<{ template: TaskTemplate }> {
  const res = await fetch(`/api/engine/templates/${encodeURIComponent(params.templateId)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: params.tenantId,
      previewRole: params.viewerRole,
      name: params.name,
      milestoneNames: params.milestoneNames,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to update template milestones');
  }
  return res.json();
}

export async function listInvitesApi(): Promise<{ invites: InviteRecord[] }> {
  const res = await fetch('/api/auth/invites', { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to fetch invitations');
  }
  return res.json();
}

export async function createInviteApi(params: {
  email: string;
  name: string;
  role: UserRole;
  teamId?: string;
  shiftPattern?: ShiftPattern;
  canDrilldownTimeline?: boolean;
}) {
  const res = await fetch('/api/auth/invites', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create invite');
  }
  return res.json();
}
