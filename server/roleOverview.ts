import {
  buildShiftHandoffSummaries,
  runAttributionPipeline,
  ShiftHandoffSummary,
} from '../src/engine/attributionEngine.ts';
import { sessionizeEvents } from '../src/engine/sessionizer.ts';
import {
  AttributionRecord,
  AuditLogEntry,
  DeviceFreshnessRecord,
  FleetFreshnessSummary,
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

export interface ShiftHeatmapCell {
  dayLabel: string; // Mon, Tue, Wed, Thu, Fri, Sat
  dayIndex: number; // 1..6
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
  collaboratorCount: number;
  collaboratorNames: string[];
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

export interface EnrichedShiftHandoff extends ShiftHandoffSummary {
  assignedUserId: string;
  assignedUserName: string;
  shiftPattern: ShiftPattern;
}

export interface RoleOverviewResponse {
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

function shiftAvailableHours(pattern: ShiftPattern, onLeave: boolean): number {
  if (onLeave) return 0;
  if (pattern === '5-9') return 20;
  if (pattern === 'weekend') return 16;
  return 40;
}

function shiftDailyHours(pattern: ShiftPattern, dayIndex: number): number {
  if (pattern === 'weekend') {
    return dayIndex === 6 || dayIndex === 0 ? 8 : 0;
  }
  if (dayIndex < 1 || dayIndex > 5) return 0;
  return pattern === '5-9' ? 4 : 8;
}

function computeAvailableShiftHoursBeforeDue(
  nowMs: number,
  dueMs: number,
  pattern: ShiftPattern,
  onLeave: boolean,
  focusFactor: number
): number {
  if (onLeave || dueMs <= nowMs) return 0;
  const maxDays = Math.min(28, Math.ceil((dueMs - nowMs) / 86_400_000) + 1);
  let rawHours = 0;

  // Walk day buckets from today to due date using the staff shift schedule
  const startDay = new Date(nowMs);
  for (let offset = 0; offset < maxDays; offset++) {
    const d = new Date(
      Date.UTC(
        startDay.getUTCFullYear(),
        startDay.getUTCMonth(),
        startDay.getUTCDate() + offset
      )
    );
    const dayStartMs = d.getTime();
    const dayEndMs = dayStartMs + 86_400_000;
    if (dayStartMs >= dueMs) break;

    const dailyCap = shiftDailyHours(pattern, d.getUTCDay());
    if (dailyCap <= 0) continue;

    const effectiveStart = Math.max(nowMs, dayStartMs);
    const effectiveEnd = Math.min(dueMs, dayEndMs);
    const fractionOfDay = Math.max(0, (effectiveEnd - effectiveStart) / 86_400_000);
    // Scale proportionally when partial day remains
    rawHours += Math.min(dailyCap, dailyCap * fractionOfDay * 1.6);
  }

  return Number((rawHours * focusFactor).toFixed(1));
}

const SHIFT_META: { pattern: ShiftPattern; label: string }[] = [
  { pattern: '8-5', label: 'Day Shift (8–5)' },
  { pattern: '5-9', label: 'Evening Shift (5–9)' },
  { pattern: 'remote', label: 'Remote Flex' },
  { pattern: 'weekend', label: 'Weekend Shift' },
];

const HEATMAP_DAYS = [
  { dayIndex: 1, dayLabel: 'Mon' },
  { dayIndex: 2, dayLabel: 'Tue' },
  { dayIndex: 3, dayLabel: 'Wed' },
  { dayIndex: 4, dayLabel: 'Thu' },
  { dayIndex: 5, dayLabel: 'Fri' },
  { dayIndex: 6, dayLabel: 'Sat' },
];

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
  const focusFactor = config.focusFactor ?? 0.85;
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

    const itDelayedDevices = devices
      .filter((d) => d.status === 'delayed' || d.status === 'offline')
      .map((d) => ({
        deviceId: d.deviceId,
        userName: d.userName,
        shiftPattern: d.shiftPattern,
        delayedSeconds: d.delayedSeconds,
        status: d.status as 'delayed' | 'offline',
      }));

    return {
      role: params.viewerRole,
      viewerUserId: params.viewerUserId,
      tenantName: config.name,
      focusFactor,
      freshnessSummary,
      staffCapacity,
      shiftHeatmap: [],
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
        delayedThresholdSeconds: config.delayedThresholdSeconds,
        focusFactor,
        monitoringPolicy: config.monitoringPolicy,
        itDelayedDevices,
      },
    };
  }

  const [allTasks, allClients, activityRules, templates, learnedRules, rawEvents, overrideRows] =
    await Promise.all([
      params.engineStore.getTasks(params.tenantId),
      params.engineStore.getClients(params.tenantId),
      params.engineStore.getActivityRules(params.tenantId),
      params.engineStore.getTemplates(params.tenantId),
      params.engineStore.getLearnedRules(params.tenantId),
      params.engineStore.getRawEvents(params.tenantId),
      params.engineStore.db.withTenantTransaction({ tenantId: params.tenantId }, (tx) =>
        tx.all<any>(
          'SELECT * FROM attribution_overrides WHERE tenant_id = ?',
          params.tenantId
        )
      ),
    ]);

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

  const userNameMap = new Map(staffRows.map((u) => [String(u.user_id), String(u.name)]));
  const userRowMap = new Map(staffRows.map((u) => [String(u.user_id), u]));
  const scopedUserIds = new Set(scopedStaff.map((u) => String(u.user_id)));

  // Build override map keyed by session_id
  const overrideMap = new Map<string, AttributionRecord>();
  for (const r of overrideRows) {
    overrideMap.set(r.session_id, {
      id: `attr-${r.session_id}`,
      sessionId: r.session_id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      taskId: r.task_id,
      taskTitle: r.task_title,
      clientId: r.client_id,
      clientName: r.client_name,
      stepId: r.step_id,
      stepTitle: r.step_title,
      period: r.period,
      confidence: Number(r.confidence),
      reason: r.reason,
      status: r.status,
      version: Number(r.version),
      retroactiveRevision: false,
      updatedAtUtc: r.updated_at_utc,
    });
  }

  // Run real 7-stage attribution per scoped user so task confirmed vs detected progress is exact
  const confirmedMinutesByTask = new Map<string, number>();
  const detectedMinutesByTask = new Map<string, number>();
  const trackedMinutesByUser = new Map<string, number>();
  const allHandoffs: EnrichedShiftHandoff[] = [];

  for (const staff of scopedStaff) {
    const uid = String(staff.user_id);
    const userEvents = rawEvents.filter((ev) => ev.user_id === uid);
    const userSessions = sessionizeEvents(userEvents, visibleClients, activityRules, config);

    let activeMinutes = 0;
    for (const s of userSessions) {
      if (!s.isIdle) {
        activeMinutes += Math.max(1, Math.round(s.durationSeconds / 60));
      }
    }
    trackedMinutesByUser.set(uid, activeMinutes);

    const userTasks = visibleTasks.filter(
      (t) =>
        t.assignedUserId === uid ||
        Boolean(t.collaboratorUserIds?.includes(uid))
    );
    const pipelineOut = runAttributionPipeline({
      sessions: userSessions,
      rawEvents: userEvents,
      tasks: userTasks,
      templates,
      learnedRules,
      config,
      existingConfirmations: overrideMap,
    });

    const mergedAttributions = pipelineOut.attributions.map(
      (a) => overrideMap.get(a.sessionId) || a
    );
    const sessionById = new Map(userSessions.map((s) => [s.id, s]));

    for (const attr of mergedAttributions) {
      if (!attr.taskId) continue;
      const ses = sessionById.get(attr.sessionId);
      const mins = ses ? Math.max(1, Math.round(ses.durationSeconds / 60)) : 5;
      if (attr.status === 'confirmed') {
        confirmedMinutesByTask.set(
          attr.taskId,
          (confirmedMinutesByTask.get(attr.taskId) || 0) + mins
        );
      } else if (attr.status === 'detected' || attr.status === 'suggested') {
        detectedMinutesByTask.set(
          attr.taskId,
          (detectedMinutesByTask.get(attr.taskId) || 0) + mins
        );
      }
    }

    if (
      params.viewerRole === 'accountant' ||
      params.viewerRole === 'team_lead' ||
      params.viewerRole === 'line_manager'
    ) {
      const userHandoffs = buildShiftHandoffSummaries(
        userTasks,
        userSessions,
        mergedAttributions,
        pipelineOut.checklistItems
      );
      for (const h of userHandoffs) {
        allHandoffs.push({
          ...h,
          assignedUserId: uid,
          assignedUserName: String(staff.name),
          shiftPattern: (staff.shift_pattern as ShiftPattern) || '8-5',
        });
      }
    }
  }

  const staffCapacity: StaffCapacityRow[] = scopedStaff.map((u) => {
    const pattern = (u.shift_pattern as ShiftPattern) || '8-5';
    const onLeave = Boolean(u.on_leave);
    const availableHours = Number((shiftAvailableHours(pattern, onLeave) * focusFactor).toFixed(1));
    const userTasks = visibleTasks.filter((t) => t.assignedUserId === u.user_id);
    const assignedHours = Number(
      (userTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0) / 60).toFixed(1)
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

  // Shift-by-Day Workload Heatmap (Mon..Sat, net of leave & focus factor)
  const shiftHeatmap: ShiftHeatmapRow[] = SHIFT_META.map(({ pattern, label }) => {
    const members = staffCapacity.filter((s) => s.shiftPattern === pattern);
    const onLeaveCount = members.filter((m) => m.onLeave).length;
    const weeklyAssignedHours = Number(
      members.reduce((sum, m) => sum + m.assignedHoursWeek, 0).toFixed(1)
    );
    const weeklyAvailableHoursNetLeave = Number(
      members.reduce((sum, m) => sum + m.availableHoursWeek, 0).toFixed(1)
    );

    const totalScheduledDailyWeight = HEATMAP_DAYS.reduce(
      (sum, d) => sum + shiftDailyHours(pattern, d.dayIndex),
      0
    );

    const days: ShiftHeatmapCell[] = HEATMAP_DAYS.map((d) => {
      const perPersonDayHours = shiftDailyHours(pattern, d.dayIndex);
      const activeMembers = Math.max(0, members.length - onLeaveCount);
      const dayAvail = Number((activeMembers * perPersonDayHours * focusFactor).toFixed(1));
      const share =
        totalScheduledDailyWeight > 0 ? perPersonDayHours / totalScheduledDailyWeight : 0;
      const dayAssigned = Number((weeklyAssignedHours * share).toFixed(1));
      const util = dayAvail > 0 ? Math.round((dayAssigned / dayAvail) * 100) : 0;
      return {
        dayLabel: d.dayLabel,
        dayIndex: d.dayIndex,
        assignedHours: dayAssigned,
        availableHoursNetLeave: dayAvail,
        utilizationPercent: util,
      };
    });

    return {
      shiftPattern: pattern,
      shiftLabel: label,
      staffCount: members.length,
      onLeaveCount,
      weeklyAvailableHoursNetLeave,
      weeklyAssignedHours,
      days,
    };
  }).filter((row) => row.staffCount > 0);

  const scopedTasks = visibleTasks.filter((t) =>
    params.viewerRole === 'accountant'
      ? t.assignedUserId === params.viewerUserId ||
        Boolean(t.collaboratorUserIds?.includes(params.viewerUserId))
      : scopedUserIds.has(t.assignedUserId) ||
        Boolean(t.collaboratorUserIds?.some((cid) => scopedUserIds.has(cid))) ||
        params.viewerRole === 'line_manager' ||
        params.viewerRole === 'executive'
  );

  const nowMs = Date.now();
  const deadlineRisks: DeadlineRiskItem[] = scopedTasks.map((t) => {
    const estimatedHours = Number((t.estimatedMinutes / 60).toFixed(1));
    const confirmedRaw = Number(
      ((confirmedMinutesByTask.get(t.id) || 0) / 60).toFixed(1)
    );
    const detectedRaw = Number(
      ((detectedMinutesByTask.get(t.id) || 0) / 60).toFixed(1)
    );

    const confirmedHours =
      t.status === 'completed' ? estimatedHours : Math.min(estimatedHours, confirmedRaw);
    const detectedHours =
      t.status === 'completed'
        ? 0
        : Number(Math.min(Math.max(0, estimatedHours - confirmedHours), detectedRaw).toFixed(1));
    const trackedHours = Number((confirmedHours + detectedHours).toFixed(1));
    const remainingHours = Number(Math.max(0, estimatedHours - trackedHours).toFixed(1));

    const dueMs = Date.parse(t.dueDateUtc);
    const hoursUntilDue = Number(((dueMs - nowMs) / 3_600_000).toFixed(1));
    const assignee = userRowMap.get(t.assignedUserId);
    const assigneePattern = (assignee?.shift_pattern as ShiftPattern) || '8-5';
    const assigneeLeave = Boolean(assignee?.on_leave);
    const availableHoursBeforeDue =
      t.status === 'completed'
        ? 0
        : computeAvailableShiftHoursBeforeDue(
            nowMs,
            dueMs,
            assigneePattern,
            assigneeLeave,
            focusFactor
          );

    const riskLevel: 'high' | 'medium' | 'low' =
      t.status === 'completed'
        ? 'low'
        : t.status === 'blocked' ||
          remainingHours > availableHoursBeforeDue ||
          hoursUntilDue <= 0
        ? 'high'
        : remainingHours > availableHoursBeforeDue * 0.75 || hoursUntilDue <= 24
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
      collaboratorCount: t.collaborators?.length || 0,
      collaboratorNames: (t.collaborators || []).map((c) => c.name),
      dueDateUtc: t.dueDateUtc,
      status: t.status,
      estimatedHours,
      confirmedHours,
      detectedHours,
      trackedHours,
      remainingHours,
      hoursUntilDue,
      availableHoursBeforeDue,
      focusFactor,
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
              ? Math.min(
                  125,
                  Math.round(
                    (Math.max(trackedHours, estimatedHours * 0.65) / estimatedHours) * 100
                  )
                )
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

  // 4-Week Recurring Close & Filing Forecast driven by actual scheduled tasks + template recurring obligations + leave deductions
  const totalWeeklyCapacityNetLeave = Number(
    staffCapacity.reduce((sum, s) => sum + s.availableHoursWeek, 0).toFixed(1)
  );
  const grossPotentialCapacity = Number(
    scopedStaff
      .reduce(
        (sum, u) =>
          sum + shiftAvailableHours((u.shift_pattern as ShiftPattern) || '8-5', false) * focusFactor,
        0
      )
      .toFixed(1)
  );
  const leaveDeductedHours = Number(
    Math.max(0, grossPotentialCapacity - totalWeeklyCapacityNetLeave).toFixed(1)
  );

  // Recurring monthly cadence workload inferred from tenant task templates across active visible clients
  const recurringCloseHoursPerMonth = Number(
    Math.max(
      12,
      templates.length * Math.max(1, visibleClients.length) * 3.5
    ).toFixed(1)
  );

  const recurringForecast: RecurringForecastBucket[] =
    params.viewerRole === 'line_manager' ||
    params.viewerRole === 'executive' ||
    params.viewerRole === 'team_lead'
      ? [0, 1, 2, 3].map((wkIdx) => {
          const wkStartMs = nowMs + wkIdx * 7 * 86_400_000;
          const wkEndMs = wkStartMs + 7 * 86_400_000;
          const scheduledInWeekHours = deadlineRisks
            .filter((t) => {
              if (t.status === 'completed') return false;
              const dMs = Date.parse(t.dueDateUtc);
              return wkIdx === 0 ? dMs <= wkEndMs : dMs > wkStartMs && dMs <= wkEndMs;
            })
            .reduce((sum, t) => sum + t.remainingHours, 0);

          // Month-end close spike occurs around Wk +1; statutory payroll/tax filings around Wk +3
          const recurringBase =
            wkIdx === 0
              ? recurringCloseHoursPerMonth * 0.25
              : wkIdx === 1
              ? recurringCloseHoursPerMonth * 0.45
              : wkIdx === 2
              ? recurringCloseHoursPerMonth * 0.22
              : recurringCloseHoursPerMonth * 0.35;

          const projected = Number((scheduledInWeekHours + recurringBase).toFixed(1));
          const delta = Number((totalWeeklyCapacityNetLeave - projected).toFixed(1));
          const status: RecurringForecastBucket['status'] =
            delta < 0
              ? 'overallocated'
              : delta < totalWeeklyCapacityNetLeave * 0.15
              ? 'tight'
              : 'balanced';

          const weekLabel =
            wkIdx === 0
              ? 'This Week (Scheduled + Recurring)'
              : wkIdx === 1
              ? 'Wk +1 (Month-End Close Cycle)'
              : wkIdx === 2
              ? 'Wk +2 (Standard Recurring)'
              : 'Wk +3 (Statutory Tax & Payroll)';

          return {
            weekLabel,
            projectedRecurringHours: projected,
            teamAvailableHours: totalWeeklyCapacityNetLeave,
            leaveDeductedHours,
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
    focusFactor,
    freshnessSummary,
    staffCapacity,
    shiftHeatmap,
    deadlineRisks,
    clientProfitability,
    recurringForecast,
    handoffs: params.viewerRole === 'executive' ? [] : allHandoffs,
    devices: params.viewerRole === 'executive' ? [] : devices,
    auditLogs,
    adminAlerts: null,
  };
}
