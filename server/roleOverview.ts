import {
  AuditLogEntry,
  DeviceFreshnessRecord,
  FleetFreshnessSummary,
  ShiftHandoffItem,
  ShiftPattern,
  UserRole,
} from '../src/engine/types.ts';
import { EngineSQLStore } from './engineStore.ts';
import { HttpError } from './errors.ts';

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
  trackedHours: number;
  remainingHours: number;
  hoursUntilDue: number;
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
  capacityDeltaHours: number;
  status: 'balanced' | 'tight' | 'overallocated';
}

export interface RoleOverviewResponse {
  role: UserRole;
  viewerUserId: string;
  tenantName: string;
  freshnessSummary: FleetFreshnessSummary;
  staffCapacity: StaffCapacityRow[];
  deadlineRisks: DeadlineRiskItem[];
  clientProfitability: ClientProfitabilityRow[];
  recurringForecast: RecurringForecastBucket[];
  handoffs: ShiftHandoffItem[];
  devices: DeviceFreshnessRecord[];
  auditLogs: AuditLogEntry[];
  adminAlerts: {
    delayedDevicesCount: number;
    offlineDevicesCount: number;
    aiReportsEnabled: boolean;
    retentionDays: number;
    monitoringPolicy: 'mandatory' | 'opt_in';
  } | null;
}

function shiftAvailableHours(pattern: ShiftPattern, onLeave: boolean): number {
  if (onLeave) return 0;
  if (pattern === '5-9') return 20;
  if (pattern === 'weekend') return 16;
  return 40;
}

export async function buildRoleOverview(params: {
  engineStore: EngineSQLStore;
  tenantId: string;
  viewerUserId: string;
  viewerRole: UserRole;
  viewerTeamId: string;
}): Promise<RoleOverviewResponse> {
  if (params.viewerRole === 'client') {
    throw new HttpError(
      403,
      'CLIENT_PORTAL_ONLY',
      'Client principals cannot access internal role operational dashboards.'
    );
  }

  await params.engineStore.ready();
  const config = await params.engineStore.getTenantConfig(params.tenantId);
  const { devices, summary: freshnessSummary } =
    await params.engineStore.getDeviceFreshness(params.tenantId);

  const shiftRows = await params.engineStore.db.withTenantTransaction(
    { tenantId: params.tenantId },
    (tx) =>
      tx.all<any>(
        'SELECT * FROM shift_users WHERE tenant_id = ? ORDER BY name ASC',
        params.tenantId
      )
  );

  const staffRows = shiftRows.filter((u) => u.role !== 'client');
  const deviceByUser = new Map<string, DeviceFreshnessRecord>();
  for (const d of devices) {
    deviceByUser.set(d.userId, d);
  }

  // Admin / IT sees device sync health, roster permissions, and audit logs — NEVER client work content
  if (params.viewerRole === 'admin_it') {
    const auditLogs = await params.engineStore.getAuditLogs(params.tenantId);
    const staffCapacity: StaffCapacityRow[] = staffRows.map((u) => {
      const pattern = (u.shift_pattern as ShiftPattern) || '8-5';
      const onLeave = Boolean(u.on_leave);
      const dev = deviceByUser.get(u.user_id);
      return {
        userId: u.user_id,
        name: u.name,
        email: u.email,
        role: u.role as UserRole,
        teamId: u.team_id,
        shiftPattern: pattern,
        onLeave,
        canDrilldownTimeline: Boolean(u.can_drilldown_timeline),
        availableHoursWeek: shiftAvailableHours(pattern, onLeave),
        assignedHoursWeek: 0,
        trackedHoursWeek: 0,
        utilizationPercent: 0,
        deviceStatus: dev ? dev.status : 'unpaired',
      };
    });

    return {
      role: params.viewerRole,
      viewerUserId: params.viewerUserId,
      tenantName: config.name,
      freshnessSummary,
      staffCapacity,
      deadlineRisks: [],
      clientProfitability: [],
      recurringForecast: [],
      handoffs: [],
      devices,
      auditLogs,
      adminAlerts: {
        delayedDevicesCount: freshnessSummary.delayedCount,
        offlineDevicesCount: freshnessSummary.offlineCount,
        aiReportsEnabled: config.aiReportsEnabled,
        retentionDays: config.retentionDays,
        monitoringPolicy: config.monitoringPolicy,
      },
    };
  }

  const allTasks = await params.engineStore.getTasks(params.tenantId);
  const allClients = await params.engineStore.getClients(params.tenantId);
  const visibleClients = allClients.filter(
    (c) =>
      c.restrictedUserIds.length === 0 ||
      c.restrictedUserIds.includes(params.viewerUserId)
  );
  const visibleClientIds = new Set(visibleClients.map((c) => c.id));
  const visibleTasks = allTasks.filter((t) => visibleClientIds.has(t.clientId));

  // Scope visible staff according to hierarchy
  const scopedStaff = staffRows.filter((u) => {
    if (params.viewerRole === 'accountant') {
      return u.user_id === params.viewerUserId;
    }
    if (params.viewerRole === 'team_lead') {
      return u.team_id === params.viewerTeamId || u.team_id === 'team_tax';
    }
    return true;
  });

  // Aggregate tracked activity minutes per user (never exposing raw timeline events)
  const rawEvents = await params.engineStore.getRawEvents(params.tenantId);
  const trackedMinutesByUser = new Map<string, number>();
  for (const ev of rawEvents) {
    if (ev.type.startsWith('activity.') && !ev.payload.idle) {
      const mins = Math.max(1, Math.round((ev.payload.duration_ms || 300_000) / 60_000));
      trackedMinutesByUser.set(
        ev.user_id,
        (trackedMinutesByUser.get(ev.user_id) || 0) + mins
      );
    }
  }

  const userNameMap = new Map(staffRows.map((u) => [u.user_id, String(u.name)]));
  const scopedUserIds = new Set(scopedStaff.map((u) => String(u.user_id)));

  const staffCapacity: StaffCapacityRow[] = scopedStaff.map((u) => {
    const pattern = (u.shift_pattern as ShiftPattern) || '8-5';
    const onLeave = Boolean(u.on_leave);
    const availableHours = shiftAvailableHours(pattern, onLeave);
    const userTasks = visibleTasks.filter((t) => t.assignedUserId === u.user_id);
    const assignedHours = Number(
      (
        userTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0) / 60
      ).toFixed(1)
    );
    const trackedHours = Number(
      ((trackedMinutesByUser.get(u.user_id) || 0) / 60).toFixed(1)
    );
    const effectiveLoad = Math.max(assignedHours, trackedHours);
    const utilizationPercent =
      availableHours > 0 ? Math.round((effectiveLoad / availableHours) * 100) : 0;
    const dev = deviceByUser.get(u.user_id);

    return {
      userId: u.user_id,
      name: u.name,
      email: u.email,
      role: u.role as UserRole,
      teamId: u.team_id,
      shiftPattern: pattern,
      onLeave,
      canDrilldownTimeline: Boolean(u.can_drilldown_timeline),
      availableHoursWeek: availableHours,
      assignedHoursWeek: assignedHours,
      trackedHoursWeek: trackedHours,
      utilizationPercent,
      deviceStatus: dev ? dev.status : 'unpaired',
    };
  });

  const scopedTasks = visibleTasks.filter((t) =>
    params.viewerRole === 'accountant'
      ? t.assignedUserId === params.viewerUserId
      : scopedUserIds.has(t.assignedUserId) ||
        params.viewerRole === 'line_manager' ||
        params.viewerRole === 'executive'
  );

  const nowMs = Date.now();
  const deadlineRisks: DeadlineRiskItem[] = scopedTasks.map((t) => {
    const estimatedHours = Number((t.estimatedMinutes / 60).toFixed(1));
    const userTrackedHrs = Number(
      ((trackedMinutesByUser.get(t.assignedUserId) || 0) / 60).toFixed(1)
    );
    const trackedHours =
      t.status === 'completed'
        ? estimatedHours
        : Number(Math.min(estimatedHours, userTrackedHrs * 0.4).toFixed(1));
    const remainingHours = Number(
      Math.max(0, estimatedHours - trackedHours).toFixed(1)
    );
    const hoursUntilDue = Number(
      ((Date.parse(t.dueDateUtc) - nowMs) / 3_600_000).toFixed(1)
    );
    const riskLevel: 'high' | 'medium' | 'low' =
      t.status === 'blocked' ||
      (t.status !== 'completed' && remainingHours > Math.max(0, hoursUntilDue))
        ? 'high'
        : t.status !== 'completed' && hoursUntilDue <= 24
        ? 'medium'
        : 'low';

    return {
      taskId: t.id,
      title: t.title,
      clientId: t.clientId,
      clientName: t.clientName,
      period: t.period,
      assignedUserId: t.assignedUserId,
      assignedUserName: userNameMap.get(t.assignedUserId) || t.assignedUserId,
      dueDateUtc: t.dueDateUtc,
      status: t.status,
      estimatedHours,
      trackedHours,
      remainingHours,
      hoursUntilDue,
      riskLevel,
    };
  });

  const clientProfitability: ClientProfitabilityRow[] =
    params.viewerRole === 'accountant'
      ? []
      : visibleClients.map((c) => {
          const cTasks = scopedTasks.filter((t) => t.clientId === c.id);
          const estimatedHours = Number(
            (cTasks.reduce((s, t) => s + t.estimatedMinutes, 0) / 60).toFixed(1)
          );
          const trackedHours = Number(
            cTasks
              .reduce((s, t) => {
                const match = deadlineRisks.find((r) => r.taskId === t.id);
                return s + (match?.trackedHours || 0);
              }, 0)
              .toFixed(1)
          );
          const billableHours = Number((trackedHours * 0.92).toFixed(1));
          const estimatedFeeUsd = Math.round(estimatedHours * 185);
          const realizationPercent =
            estimatedHours > 0
              ? Math.min(125, Math.round((Math.max(trackedHours, estimatedHours * 0.65) / estimatedHours) * 100))
              : 100;

          return {
            clientId: c.id,
            clientName: c.legalName,
            taskCount: cTasks.length,
            completedCount: cTasks.filter((t) => t.status === 'completed').length,
            estimatedHours,
            trackedHours,
            billableHours,
            estimatedFeeUsd,
            realizationPercent,
          };
        });

  const totalWeeklyCapacity = staffCapacity.reduce(
    (sum, s) => sum + s.availableHoursWeek,
    0
  );
  const baseAssigned = staffCapacity.reduce(
    (sum, s) => sum + s.assignedHoursWeek,
    0
  );
  const recurringForecast: RecurringForecastBucket[] =
    params.viewerRole === 'line_manager' ||
    params.viewerRole === 'executive' ||
    params.viewerRole === 'team_lead'
      ? [1, 2, 3, 4].map((wk) => {
          const multiplier = wk === 1 ? 1.0 : wk === 2 ? 1.35 : wk === 3 ? 0.95 : 1.15;
          const projected = Number(
            Math.max(8, baseAssigned * multiplier).toFixed(1)
          );
          const delta = Number((totalWeeklyCapacity - projected).toFixed(1));
          const status: RecurringForecastBucket['status'] =
            delta < 0 ? 'overallocated' : delta < totalWeeklyCapacity * 0.15 ? 'tight' : 'balanced';
          return {
            weekLabel: wk === 1 ? 'This Week' : wk === 2 ? 'Month-End Close (Wk +1)' : wk === 3 ? 'Wk +2 Standard' : 'Statutory Filings (Wk +3)',
            projectedRecurringHours: projected,
            teamAvailableHours: totalWeeklyCapacity,
            capacityDeltaHours: delta,
            status,
          };
        })
      : [];

  const auditLogs =
    params.viewerRole === 'executive'
      ? (await params.engineStore.getAuditLogs(params.tenantId)).slice(0, 20)
      : [];

  return {
    role: params.viewerRole,
    viewerUserId: params.viewerUserId,
    tenantName: config.name,
    freshnessSummary,
    staffCapacity,
    deadlineRisks,
    clientProfitability,
    recurringForecast,
    handoffs: [],
    devices: params.viewerRole === 'executive' ? [] : devices,
    auditLogs,
    adminAlerts: null,
  };
}
