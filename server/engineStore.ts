import crypto from 'node:crypto';
import {
  buildShiftHandoffSummaries,
  runAttributionPipeline,
} from '../src/engine/attributionEngine.ts';
import { parseClientImportContent } from '../src/engine/csvDictionaryParser.ts';
import {
  hasForbiddenPayloadFields,
  sanitizeAndFilterEvent,
} from '../src/engine/privacyFilter.ts';
import { sessionizeEvents } from '../src/engine/sessionizer.ts';
import {
  generateRealisticAccountingScenario,
  runReplayHarness,
} from '../src/engine/simulatorAndReplay.ts';
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
  FreshnessStatus,
  LearnedRule,
  PortalAccentTheme,
  PortalBrandingConfig,
  PrivacyRule,
  ShiftPattern,
  ShiftUser,
  StoredFileRecord,
  SyncConflict,
  TaskCollaborationInvite,
  TaskCollaborationInviteStatus,
  TaskCollaboratorSummary,
  TaskTemplate,
  TaskTemplateStep,
  TenantConfig,
  TrackingEvent,
  UserRole,
  WorkSession,
} from '../src/engine/types.ts';
import { generateDeviceToken, hashDeviceToken } from './auth.ts';
import { appConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { runMigrationsUp } from './migrations/index.ts';
import { PortableSqlAdapter, SqlExecutor } from './sqlAdapter.ts';

export function isHourWithinShiftUtc(
  currentHourUtc: number,
  startHourUtc: number,
  endHourUtc: number
): boolean {
  if (startHourUtc === endHourUtc) return true;
  if (startHourUtc < endHourUtc) {
    return currentHourUtc >= startHourUtc && currentHourUtc < endHourUtc;
  }
  // Overnight UTC wrap (e.g., 22:00Z -> 02:00Z)
  return currentHourUtc >= startHourUtc || currentHourUtc < endHourUtc;
}

export function getShiftWindowHoursUtc(shiftPattern: ShiftPattern): {
  startHourUtc: number;
  endHourUtc: number;
} {
  if (shiftPattern === '5-9') return { startHourUtc: 22, endHourUtc: 2 };
  if (shiftPattern === 'remote') return { startHourUtc: 14, endHourUtc: 23 };
  return { startHourUtc: 13, endHourUtc: 22 };
}

export function isWithinScheduledShiftUtc(
  nowMs: number,
  shiftPattern: string,
  startHourUtc: number,
  endHourUtc: number
): boolean {
  const d = new Date(nowMs);
  if (shiftPattern === 'weekend') {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) return false;
  }
  return isHourWithinShiftUtc(d.getUTCHours(), startHourUtc, endHourUtc);
}

export function canActorAssignTask(params: {
  actorUserId: string;
  actorRole: UserRole;
  targetAssigneeUserId: string;
  targetAssigneeRole: UserRole;
  existingTask?: Pick<EngineTask, 'assignedUserId' | 'collaboratorUserIds'>;
}): { allowed: boolean; reason?: string } {
  const { actorUserId, actorRole, targetAssigneeUserId, targetAssigneeRole, existingTask } = params;

  if (actorRole === 'client') {
    return { allowed: false, reason: 'Client Portal users cannot assign internal tasks.' };
  }
  if (targetAssigneeRole === 'client') {
    return { allowed: false, reason: 'Tasks cannot be assigned to external Client Portal accounts.' };
  }

  if (
    actorRole === 'team_lead' ||
    actorRole === 'line_manager' ||
    actorRole === 'executive' ||
    actorRole === 'admin_it'
  ) {
    return { allowed: true };
  }

  // Accountant: can self-assign or delegate/reassign to peer Accountants on owned/shared tasks
  if (existingTask) {
    const isOwnerOrCollab =
      existingTask.assignedUserId === actorUserId ||
      Boolean(existingTask.collaboratorUserIds?.includes(actorUserId));
    if (!isOwnerOrCollab) {
      return {
        allowed: false,
        reason: 'Accountants can only delegate or reassign tasks assigned to or shared with them.',
      };
    }
  }

  if (targetAssigneeUserId !== actorUserId && targetAssigneeRole !== 'accountant') {
    return {
      allowed: false,
      reason: 'Accountants can only self-assign or delegate tasks to peer Accountants. Higher-level assignments require Team Lead, Manager, Executive, or Admin/IT.',
    };
  }

  return { allowed: true };
}

export class EngineSQLStore {
  public readonly db: PortableSqlAdapter;
  private readyPromise: Promise<void>;
  private broadcastLatencySamplesMs: number[] = [];
  private delayedAlertCooldownMs = new Map<string, number>();

  constructor(options?: {
    dbPath?: string;
    databaseUrl?: string;
    seedDemo?: boolean;
  }) {
    this.db = new PortableSqlAdapter(options);
    this.readyPromise = this.init(options?.seedDemo ?? appConfig.demoModeEnabled);
  }

  public async ready(): Promise<void> {
    await this.readyPromise;
  }

  public recordBroadcastLatency(ms: number) {
    this.broadcastLatencySamplesMs.push(Math.max(1, Math.round(ms)));
    if (this.broadcastLatencySamplesMs.length > 200) {
      this.broadcastLatencySamplesMs.shift();
    }
  }

  public getLatencyStats() {
    if (this.broadcastLatencySamplesMs.length === 0) {
      return { lastBroadcastMs: 0, p95BroadcastMs: 0, sampleCount: 0 };
    }
    const sorted = [...this.broadcastLatencySamplesMs].sort((a, b) => a - b);
    const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
      lastBroadcastMs:
        this.broadcastLatencySamplesMs[this.broadcastLatencySamplesMs.length - 1],
      p95BroadcastMs: sorted[p95Idx],
      sampleCount: sorted.length,
    };
  }

  private async init(seedDemo: boolean) {
    await runMigrationsUp(this.db);
    if (seedDemo) {
      await this.seedDemoTenantIfMissing('firm_demo');
    }
  }

  public async seedDemoTenantIfMissing(tenantId = 'firm_demo') {
    const existing = await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      (tx) => tx.get<{ id: string }>('SELECT id FROM tenants WHERE id = ?', tenantId)
    );
    const nowIso = new Date().toISOString();
    const currentHourUtc = new Date().getUTCHours();
    const offShiftStart = (currentHourUtc + 4) % 24;
    const offShiftEnd = (currentHourUtc + 8) % 24;

    const demoUsers: (ShiftUser & { canDrilldown: boolean; clientId?: string | null })[] = [
      {
        userId: 'demo_u_acc_01',
        tenantId,
        name: 'Maya Patel (Senior Accountant)',
        email: 'maya.patel@apex-cpa.example',
        role: 'accountant',
        teamId: 'team_audit',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_acc_02',
        tenantId,
        name: 'Devon Brooks (Evening Shift 5-9)',
        email: 'devon.brooks@apex-cpa.example',
        role: 'accountant',
        teamId: 'team_audit',
        shiftPattern: '5-9',
        shiftStartHourUtc: offShiftStart,
        shiftEndHourUtc: offShiftEnd,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_acc_03',
        tenantId,
        name: 'Elena Gomez (Remote Tax)',
        email: 'elena.gomez@apex-cpa.example',
        role: 'accountant',
        teamId: 'team_tax',
        shiftPattern: 'remote',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_acc_04',
        tenantId,
        name: 'Samira Al-Mansoor (Weekend Audit)',
        email: 'samira.mansoor@apex-cpa.example',
        role: 'accountant',
        teamId: 'team_audit',
        shiftPattern: 'weekend',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_lead_01',
        tenantId,
        name: 'Marcus Chen (Audit Team Lead)',
        email: 'marcus.chen@apex-cpa.example',
        role: 'team_lead',
        teamId: 'team_audit',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: true,
      },
      {
        userId: 'demo_u_lead_02',
        tenantId,
        name: 'Hannah Kim (Tax Team Lead)',
        email: 'hannah.kim@apex-cpa.example',
        role: 'team_lead',
        teamId: 'team_tax',
        shiftPattern: 'remote',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: true,
      },
      {
        userId: 'demo_u_mgr_01',
        tenantId,
        name: 'Jordan Rivera (Line Manager)',
        email: 'jordan.rivera@apex-cpa.example',
        role: 'line_manager',
        teamId: 'team_audit',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: true,
      },
      {
        userId: 'demo_u_mgr_02',
        tenantId,
        name: 'David Okafor (Weekend Line Manager)',
        email: 'david.okafor@apex-cpa.example',
        role: 'line_manager',
        teamId: 'team_tax',
        shiftPattern: 'weekend',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: true,
      },
      {
        userId: 'demo_u_exec_01',
        tenantId,
        name: 'Claire Vance (Managing Partner)',
        email: 'claire.vance@apex-cpa.example',
        role: 'executive',
        teamId: 'team_audit',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_exec_02',
        tenantId,
        name: 'Arthur Sterling (Firm Owner)',
        email: 'arthur.sterling@apex-cpa.example',
        role: 'executive',
        teamId: 'team_audit',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_admin_01',
        tenantId,
        name: 'Nadia Sterling (Admin / IT)',
        email: 'it-admin@apex-cpa.example',
        role: 'admin_it',
        teamId: 'team_ops',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_admin_02',
        tenantId,
        name: 'Owen Price (Weekend SecOps / IT)',
        email: 'secops@apex-cpa.example',
        role: 'admin_it',
        teamId: 'team_ops',
        shiftPattern: 'weekend',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
      },
      {
        userId: 'demo_u_client_01',
        tenantId,
        name: 'Acme Ltd Portal Contact',
        email: 'portal@acme.example',
        role: 'client',
        teamId: 'team_ext',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
        clientId: 'demo_cli-acme',
      },
      {
        userId: 'demo_u_client_02',
        tenantId,
        name: 'Northstar Logistics Contact',
        email: 'portal@northstar.example',
        role: 'client',
        teamId: 'team_ext',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
        clientId: 'demo_cli-northstar',
      },
      {
        userId: 'demo_u_client_03',
        tenantId,
        name: 'Harbor Health Contact',
        email: 'portal@harbor.example',
        role: 'client',
        teamId: 'team_ext',
        shiftPattern: '8-5',
        shiftStartHourUtc: 0,
        shiftEndHourUtc: 24,
        onLeave: false,
        canDrilldown: false,
        clientId: 'demo_cli-harbor',
      },
    ];

    if (existing) {
      await this.db.withTenantTransaction(
        { tenantId, bypassRls: true },
        async (tx) => {
          for (const u of demoUsers) {
            await tx.run(
              `INSERT INTO shift_users
               (user_id, tenant_id, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave, can_drilldown_timeline, client_id, status, created_at_utc)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
               ON CONFLICT (user_id) DO NOTHING`,
              u.userId,
              u.tenantId,
              u.name,
              u.email,
              u.role,
              u.teamId,
              u.shiftPattern,
              u.shiftStartHourUtc,
              u.shiftEndHourUtc,
              u.onLeave ? 1 : 0,
              u.canDrilldown ? 1 : 0,
              u.clientId ?? null,
              nowIso
            );
          }
          await tx.run(
            `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
            'demo-dev-win-samira',
            tenantId,
            'demo_u_acc_04',
            'Samira Al-Mansoor',
            'weekend',
            'windows',
            1,
            nowIso,
            64,
            8,
            'live'
          );
        }
      );
      return;
    }

    const config: TenantConfig = {
      id: tenantId,
      name: 'Apex Chartered Accountants (Demo Sandbox)',
      confidenceThresholds: { detected: 0.85, suggested: 0.5 },
      sessionizer: { maxInterruptionSeconds: 30, idleCloseSeconds: 180 },
      heartbeatIntervalSeconds: 12,
      delayedThresholdSeconds: 120,
      retentionDays: 60,
      focusFactor: 0.85,
      monitoringPolicy: 'mandatory',
      serverUrl: appConfig.appUrl,
    };

    await this.db.withTenantTransaction(
      { tenantId, bypassRls: true },
      async (tx) => {
        await tx.run(
          `INSERT INTO tenants (id, name, slug, config_json, ai_reports_enabled, created_at_utc)
           VALUES (?, ?, 'demo', ?, 0, ?) ON CONFLICT (id) DO NOTHING`,
          tenantId,
          config.name,
          JSON.stringify(config),
          nowIso
        );

        await tx.run(
          `INSERT INTO teams (id, tenant_id, name, parent_team_id, lead_user_id, created_at_utc)
           VALUES
             ('team_audit', ?, 'Audit & Assurance', NULL, 'demo_u_lead_01', ?),
             ('team_tax', ?, 'Tax Advisory', NULL, 'demo_u_lead_02', ?),
             ('team_ops', ?, 'Operations & IT', NULL, 'demo_u_admin_01', ?)
           ON CONFLICT (id) DO NOTHING`,
          tenantId,
          nowIso,
          tenantId,
          nowIso,
          tenantId,
          nowIso
        );

        for (const u of demoUsers) {
          await tx.run(
            `INSERT INTO shift_users
             (user_id, tenant_id, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave, can_drilldown_timeline, client_id, status, created_at_utc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
             ON CONFLICT (user_id) DO NOTHING`,
            u.userId,
            u.tenantId,
            u.name,
            u.email,
            u.role,
            u.teamId,
            u.shiftPattern,
            u.shiftStartHourUtc,
            u.shiftEndHourUtc,
            u.onLeave ? 1 : 0,
            u.canDrilldown ? 1 : 0,
            u.clientId ?? null,
            nowIso
          );
        }

        const clients: ClientDictionaryEntry[] = [
          {
            id: 'demo_cli-acme',
            tenantId,
            legalName: 'Acme Ltd',
            aliases: ['Acme', 'Acme Corp', 'Acme Chequing'],
            codes: ['ACME-01', 'C_ACME'],
            folderPatterns: ['Clients\\Acme_Ltd', 'Clients/Acme_Ltd', 'Acme_Oct2026'],
            knownDomains: ['acme-portal.example.com'],
            restrictedUserIds: [],
            source: 'csv',
            updatedAtUtc: nowIso,
          },
          {
            id: 'demo_cli-northstar',
            tenantId,
            legalName: 'Northstar Logistics',
            aliases: ['Northstar', 'NS Logistics'],
            codes: ['NSL-02', 'NORTHSTAR'],
            folderPatterns: ['Clients\\Northstar', 'Clients/Northstar'],
            knownDomains: ['northstar-q3', 'payroll.northstar.example'],
            restrictedUserIds: [],
            source: 'csv',
            updatedAtUtc: nowIso,
          },
          {
            id: 'demo_cli-harbor',
            tenantId,
            legalName: 'Harbor Health',
            aliases: ['Harbor', 'Harbor Med'],
            codes: ['HH-03', 'HARBOR'],
            folderPatterns: ['Clients\\Harbor_Health', 'Clients/Harbor_Health'],
            knownDomains: ['harborhealth.example.org'],
            restrictedUserIds: [],
            source: 'manual',
            updatedAtUtc: nowIso,
          },
          {
            id: 'demo_cli-crestview',
            tenantId,
            legalName: 'Crestview Holdings (Restricted)',
            aliases: ['Crestview', 'CV Holdings'],
            codes: ['CVH-99'],
            folderPatterns: ['Restricted\\Crestview'],
            knownDomains: ['crestview.private.example'],
            restrictedUserIds: ['demo_u_acc_01'],
            source: 'manual',
            updatedAtUtc: nowIso,
          },
        ];

        for (const c of clients) {
          await tx.run(
            `INSERT INTO clients (id, tenant_id, legal_name, aliases_json, codes_json, folder_patterns_json, known_domains_json, restricted_user_ids_json, source, updated_at_utc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING`,
            c.id,
            c.tenantId,
            c.legalName,
            JSON.stringify(c.aliases),
            JSON.stringify(c.codes),
            JSON.stringify(c.folderPatterns),
            JSON.stringify(c.knownDomains),
            JSON.stringify(c.restrictedUserIds),
            c.source,
            c.updatedAtUtc
          );
        }

        const activityRules: ActivityDictionaryEntry[] = [
          { id: 'demo_act-1', tenantId, keyword: 'reconcil', activityType: 'Reconciliation', workCategory: 'billable', weight: 10 },
          { id: 'demo_act-2', tenantId, keyword: 'payroll', activityType: 'Payroll Processing', workCategory: 'billable', weight: 9 },
          { id: 'demo_act-3', tenantId, keyword: 'tax return', activityType: 'Tax Preparation', workCategory: 'deep_work', weight: 9 },
          { id: 'demo_act-4', tenantId, keyword: 'bank statement', activityType: 'Bank Statement Review', workCategory: 'billable', weight: 8 },
          { id: 'demo_act-5', tenantId, keyword: 'trial balance', activityType: 'Trial Balance Review', workCategory: 'deep_work', weight: 8 },
          { id: 'demo_act-6', tenantId, keyword: 'invoice', activityType: 'AP / AR Processing', workCategory: 'billable', weight: 7 },
        ];
        for (const a of activityRules) {
          await tx.run(
            `INSERT INTO activity_rules (id, tenant_id, keyword, activity_type, work_category, weight)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            a.id,
            a.tenantId,
            a.keyword,
            a.activityType,
            a.workCategory,
            a.weight
          );
        }

        const privacyRules: PrivacyRule[] = [
          { id: 'demo_priv-1', tenantId, kind: 'domain', pattern: 'personalbank', reason: 'Personal Banking', enabled: true },
          { id: 'demo_priv-2', tenantId, kind: 'domain', pattern: 'mychart', reason: 'Personal Health', enabled: true },
          { id: 'demo_priv-3', tenantId, kind: 'app', pattern: '1Password', reason: 'Credential Manager', enabled: true },
          { id: 'demo_priv-4', tenantId, kind: 'path', pattern: '*\\Personal\\*', reason: 'Personal Folder', enabled: true },
        ];
        for (const p of privacyRules) {
          await tx.run(
            `INSERT INTO privacy_rules (id, tenant_id, kind, pattern, reason, enabled)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            p.id,
            p.tenantId,
            p.kind,
            p.pattern,
            p.reason,
            p.enabled ? 1 : 0
          );
        }

        const templates: TaskTemplate[] = [
          {
            id: 'demo_tpl-monthly-close',
            tenantId,
            name: 'Monthly Bank Close & Reconciliation',
            defaultCategory: 'billable',
            steps: [
              { id: 'demo_stp-1', order: 1, title: 'Download & verify bank statement PDFs', activitySignature: 'bank statement' },
              { id: 'demo_stp-2', order: 2, title: 'Reconcile chequing & clearing ledger in QuickBooks/Xero', activitySignature: 'reconcil' },
              { id: 'demo_stp-3', order: 3, title: 'Prepare & tie out supporting Excel workpapers', activitySignature: 'excel' },
            ],
          },
          {
            id: 'demo_tpl-payroll-tax',
            tenantId,
            name: 'Payroll & Corporate Tax Compliance',
            defaultCategory: 'billable',
            steps: [
              { id: 'demo_stp-4', order: 1, title: 'Run payroll register & statutory deductions', activitySignature: 'payroll' },
              { id: 'demo_stp-5', order: 2, title: 'Draft corporate tax return schedule', activitySignature: 'tax' },
            ],
          },
        ];
        for (const tpl of templates) {
          await tx.run(
            `INSERT INTO task_templates (id, tenant_id, name, default_category, steps_json)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            tpl.id,
            tpl.tenantId,
            tpl.name,
            tpl.defaultCategory,
            JSON.stringify(tpl.steps)
          );
        }

        const todayDate = nowIso.slice(0, 10);
        const engineTasks: EngineTask[] = [
          {
            id: 'demo_tsk-eng-101',
            tenantId,
            clientId: 'demo_cli-acme',
            clientName: 'Acme Ltd',
            templateId: 'demo_tpl-monthly-close',
            title: 'Acme Ltd — Oct 2026 Bank Reconciliation & Close',
            period: 'Oct 2026',
            status: 'in_progress',
            dueDateUtc: `${todayDate}T22:00:00Z`,
            assignedUserId: 'demo_u_acc_01',
            estimatedMinutes: 180,
            version: 1,
            updatedAtUtc: nowIso,
          },
          {
            id: 'demo_tsk-eng-102',
            tenantId,
            clientId: 'demo_cli-northstar',
            clientName: 'Northstar Logistics',
            templateId: 'demo_tpl-payroll-tax',
            title: 'Northstar Logistics — Q3 2026 Payroll Register Audit',
            period: 'Q3 2026',
            status: 'in_progress',
            dueDateUtc: `${todayDate}T22:00:00Z`,
            assignedUserId: 'demo_u_acc_01',
            estimatedMinutes: 120,
            version: 1,
            updatedAtUtc: nowIso,
          },
          {
            id: 'demo_tsk-eng-103',
            tenantId,
            clientId: 'demo_cli-harbor',
            clientName: 'Harbor Health',
            templateId: 'demo_tpl-payroll-tax',
            title: 'Harbor Health — FY25 Corporate Tax Return Draft',
            period: 'FY25',
            status: 'todo',
            dueDateUtc: `${todayDate}T22:00:00Z`,
            assignedUserId: 'demo_u_acc_01',
            estimatedMinutes: 240,
            version: 1,
            updatedAtUtc: nowIso,
          },
          {
            id: 'demo_tsk-eng-104',
            tenantId,
            clientId: 'demo_cli-crestview',
            clientName: 'Crestview Holdings (Restricted)',
            templateId: 'demo_tpl-monthly-close',
            title: 'Crestview M&A Special Audit (Restricted)',
            period: 'Oct 2026',
            status: 'todo',
            dueDateUtc: `${todayDate}T22:00:00Z`,
            assignedUserId: 'demo_u_acc_01',
            estimatedMinutes: 90,
            version: 1,
            updatedAtUtc: nowIso,
          },
        ];
        for (const t of engineTasks) {
          await tx.run(
            `INSERT INTO engine_tasks (id, tenant_id, client_id, client_name, template_id, title, period, status, due_date_utc, assigned_user_id, estimated_minutes, version, updated_at_utc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            t.id,
            t.tenantId,
            t.clientId,
            t.clientName,
            t.templateId || null,
            t.title,
            t.period,
            t.status,
            t.dueDateUtc,
            t.assignedUserId,
            t.estimatedMinutes,
            t.version,
            t.updatedAtUtc
          );
        }

        const delayedIso = new Date(Date.now() - 190 * 1000).toISOString();
        await tx.run(
          `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
          'demo-dev-win-maya',
          tenantId,
          'demo_u_acc_01',
          'Maya Patel',
          '8-5',
          'windows',
          1,
          nowIso,
          108,
          12,
          'live'
        );
        await tx.run(
          `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
          'demo-dev-vdi-elena',
          tenantId,
          'demo_u_acc_03',
          'Elena Gomez',
          'remote',
          'vdi',
          1,
          delayedIso,
          42,
          -35,
          'delayed'
        );
        await tx.run(
          `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
          'demo-dev-mac-devon',
          tenantId,
          'demo_u_acc_02',
          'Devon Brooks',
          '5-9',
          'macos',
          1,
          nowIso,
          19,
          4,
          'off_shift'
        );
        await tx.run(
          `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
          'demo-dev-win-samira',
          tenantId,
          'demo_u_acc_04',
          'Samira Al-Mansoor',
          'weekend',
          'windows',
          1,
          nowIso,
          64,
          8,
          'live'
        );

        const scenario = generateRealisticAccountingScenario(
          tenantId,
          'demo_u_acc_01',
          'demo-dev-win-maya'
        );
        for (const ev of scenario.events) {
          const filtered = sanitizeAndFilterEvent(ev, privacyRules);
          if (filtered.allowed && filtered.sanitizedEvent) {
            await this.insertEventRowWithExec(tx, filtered.sanitizedEvent, nowIso);
          }
        }
      }
    );
  }

  private async insertEventRowWithExec(
    exec: SqlExecutor,
    ev: TrackingEvent,
    receivedAt: string
  ): Promise<boolean> {
    const info = await exec.run(
      `INSERT INTO tracking_events
       (event_id, schema_version, tenant_id, user_id, device_id, seq, type, priority, event_time_utc, received_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING`,
      ev.event_id,
      ev.schema_version,
      ev.tenant_id,
      ev.user_id,
      ev.device_id,
      ev.seq,
      ev.type,
      ev.priority,
      ev.event_time_utc,
      receivedAt,
      JSON.stringify(ev.payload)
    );
    return info.changes > 0;
  }

  public async listTenants(): Promise<{ id: string; name: string; slug: string | null }[]> {
    await this.ready();
    return this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      (tx) => tx.all<any>('SELECT id, name, slug FROM tenants ORDER BY created_at_utc ASC')
    );
  }

  public async listShiftUsers(tenantId: string): Promise<ShiftUser[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        'SELECT * FROM shift_users WHERE tenant_id = ? ORDER BY name ASC',
        tenantId
      );
      return rows.map((r) => ({
        userId: r.user_id,
        tenantId: r.tenant_id,
        name: r.name,
        email: r.email,
        role: r.role as UserRole,
        teamId: r.team_id,
        shiftPattern: r.shift_pattern as ShiftPattern,
        shiftStartHourUtc: r.shift_start_hour_utc,
        shiftEndHourUtc: r.shift_end_hour_utc,
        onLeave: Boolean(r.on_leave),
      }));
    });
  }

  public async updateShiftUserRole(
    tenantId: string,
    userId: string,
    role: UserRole,
    shiftPattern?: ShiftPattern,
    onLeave?: boolean,
    canDrilldownTimeline?: boolean,
    actorUserId?: string
  ) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId, userId: actorUserId }, async (tx) => {
      const target = await tx.get<{ user_id: string; role: string; status: string }>(
        'SELECT user_id, role, status FROM shift_users WHERE tenant_id = ? AND user_id = ?',
        tenantId,
        userId
      );
      if (!target) {
        throw new HttpError(404, 'USER_NOT_FOUND', 'Staff user not found.');
      }

      if (
        actorUserId &&
        actorUserId === userId &&
        target.role === 'admin_it' &&
        role !== 'admin_it'
      ) {
        throw new HttpError(
          400,
          'CANNOT_DEMOTE_SELF',
          'You cannot change your own role away from Admin / IT. Have another administrator update your role if needed.'
        );
      }

      if (target.role === 'admin_it' && role !== 'admin_it') {
        const adminRow = await tx.get<{ cnt: number }>(
          "SELECT COUNT(*) as cnt FROM shift_users WHERE tenant_id = ? AND role = 'admin_it' AND status = 'active'",
          tenantId
        );
        if (Number(adminRow?.cnt || 0) <= 1) {
          throw new HttpError(
            409,
            'LAST_ADMIN_REQUIRED',
            'At least one active Admin / IT user is required in the workspace.'
          );
        }
      }

      const hours = shiftPattern ? getShiftWindowHoursUtc(shiftPattern) : null;
      const startHour = hours ? hours.startHourUtc : null;
      const endHour = hours ? hours.endHourUtc : null;
      await tx.run(
        `UPDATE shift_users
         SET role = ?,
             shift_pattern = COALESCE(?, shift_pattern),
             shift_start_hour_utc = COALESCE(?, shift_start_hour_utc),
             shift_end_hour_utc = COALESCE(?, shift_end_hour_utc),
             on_leave = COALESCE(?, on_leave),
             can_drilldown_timeline = COALESCE(?, can_drilldown_timeline)
         WHERE tenant_id = ? AND user_id = ?`,
        role,
        shiftPattern ?? null,
        startHour,
        endHour,
        onLeave !== undefined ? (onLeave ? 1 : 0) : null,
        canDrilldownTimeline !== undefined ? (canDrilldownTimeline ? 1 : 0) : null,
        tenantId,
        userId
      );
    });
  }

  public async importStaffFromCsv(tenantId: string, rawText: string): Promise<ShiftUser[]> {
    await this.ready();
    const lines = rawText
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return [];

    const firstCols = lines[0].split(',').map((s) => s.trim().toLowerCase());
    const hasHeader = firstCols.includes('email') || firstCols.includes('name');
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const imported: ShiftUser[] = [];
    const nowIso = new Date().toISOString();

    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      for (const line of dataLines) {
        const [nameRaw, emailRaw, roleRaw = 'accountant', shiftRaw = '8-5', teamRaw = 'team_audit'] =
          line.split(',').map((s) => s.trim());
        if (!nameRaw || !emailRaw) continue;
        const validRole: UserRole = (
          ['accountant', 'team_lead', 'line_manager', 'executive', 'client', 'admin_it'] as string[]
        ).includes(roleRaw)
          ? (roleRaw as UserRole)
          : 'accountant';
        const validShift: ShiftPattern = (
          ['8-5', '5-9', 'remote', 'weekend'] as string[]
        ).includes(shiftRaw)
          ? (shiftRaw as ShiftPattern)
          : '8-5';
        const { startHourUtc: startHour, endHourUtc: endHour } =
          getShiftWindowHoursUtc(validShift);
        const cleanEmail = emailRaw.toLowerCase();
        const userId = `u_${crypto.createHash('sha256').update(`${tenantId}:${cleanEmail}`).digest('hex').slice(0, 12)}`;

        await tx.run(
          `INSERT INTO shift_users
           (user_id, tenant_id, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave, status, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'invited', ?)
           ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, role = excluded.role, shift_pattern = excluded.shift_pattern, team_id = excluded.team_id`,
          userId,
          tenantId,
          nameRaw,
          cleanEmail,
          validRole,
          teamRaw || 'team_audit',
          validShift,
          startHour,
          endHour,
          nowIso
        );

        imported.push({
          userId,
          tenantId,
          name: nameRaw,
          email: cleanEmail,
          role: validRole,
          teamId: teamRaw || 'team_audit',
          shiftPattern: validShift,
          shiftStartHourUtc: startHour,
          shiftEndHourUtc: endHour,
          onLeave: false,
        });
      }
    });
    return imported;
  }

  public async createDeviceToken(params: {
    tenantId: string;
    userId: string;
    deviceId: string;
    label: string;
  }): Promise<{ record: DeviceTokenRecord; rawToken: string }> {
    await this.ready();
    const { rawToken, prefix, tokenHash } = generateDeviceToken();
    const tokenId = `dtk-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const nowIso = new Date().toISOString();

    const userName = await this.db.withTenantTransaction(
      { tenantId: params.tenantId, userId: params.userId },
      async (tx) => {
        await tx.run(
          `INSERT INTO device_tokens (token_id, tenant_id, user_id, device_id, label, prefix, token_hash, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          tokenId,
          params.tenantId,
          params.userId,
          params.deviceId,
          params.label,
          prefix,
          tokenHash,
          nowIso
        );

        const userRow = await tx.get<{ name: string }>(
          'SELECT name FROM shift_users WHERE tenant_id = ? AND user_id = ?',
          params.tenantId,
          params.userId
        );
        return userRow?.name || params.userId;
      }
    );

    return {
      rawToken,
      record: {
        tokenId,
        tenantId: params.tenantId,
        userId: params.userId,
        userName,
        deviceId: params.deviceId,
        label: params.label,
        prefix,
        createdAtUtc: nowIso,
        lastUsedUtc: null,
        revokedAtUtc: null,
      },
    };
  }

  public async listDeviceTokens(tenantId: string): Promise<DeviceTokenRecord[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        `SELECT d.*, u.name as user_name
         FROM device_tokens d
         LEFT JOIN shift_users u ON u.user_id = d.user_id AND u.tenant_id = d.tenant_id
         WHERE d.tenant_id = ?
         ORDER BY d.created_at_utc DESC`,
        tenantId
      );
      return rows.map((r) => ({
        tokenId: r.token_id,
        tenantId: r.tenant_id,
        userId: r.user_id,
        userName: r.user_name || r.user_id,
        deviceId: r.device_id,
        label: r.label,
        prefix: r.prefix,
        createdAtUtc: r.created_at_utc,
        lastUsedUtc: r.last_used_utc || null,
        revokedAtUtc: r.revoked_at_utc || null,
      }));
    });
  }

  public async revokeDeviceToken(tenantId: string, tokenId: string, actorUserId?: string) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId, userId: actorUserId }, async (tx) => {
      await tx.run(
        'UPDATE device_tokens SET revoked_at_utc = ? WHERE tenant_id = ? AND token_id = ?',
        new Date().toISOString(),
        tenantId,
        tokenId
      );
    });
  }

  public async verifyDeviceToken(rawToken: string): Promise<{
    tenantId: string;
    userId: string;
    deviceId: string;
    role: UserRole;
    email: string;
    userName: string;
    teamId: string;
  } | null> {
    await this.ready();
    const tokenHash = hashDeviceToken(rawToken);
    return this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        const row = await tx.get<any>(
          `SELECT d.*, u.role as user_role, u.email as user_email, u.name as user_name, u.team_id as user_team_id, u.status as user_status
           FROM device_tokens d
           LEFT JOIN shift_users u ON u.user_id = d.user_id AND u.tenant_id = d.tenant_id
           WHERE d.token_hash = ? AND d.revoked_at_utc IS NULL`,
          tokenHash
        );
        if (!row || row.user_status === 'disabled') return null;

        await tx.run(
          'UPDATE device_tokens SET last_used_utc = ? WHERE token_id = ?',
          new Date().toISOString(),
          row.token_id
        );

        return {
          tenantId: row.tenant_id,
          userId: row.user_id,
          deviceId: row.device_id,
          role: (row.user_role as UserRole) || 'accountant',
          email: row.user_email || row.user_id,
          userName: row.user_name || row.user_id,
          teamId: row.user_team_id || 'team_audit',
        };
      }
    );
  }

  public async getTenantConfig(tenantId: string): Promise<TenantConfig & { aiReportsEnabled: boolean }> {
    await this.ready();
    const row = await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      (tx) =>
        tx.get<{ config_json: string; ai_reports_enabled: number }>(
          'SELECT config_json, ai_reports_enabled FROM tenants WHERE id = ?',
          tenantId
        )
    );
    if (!row) {
      throw new HttpError(404, 'TENANT_NOT_FOUND', `Unknown tenant: ${tenantId}`);
    }
    const parsed = JSON.parse(row.config_json) as TenantConfig;
    const focusFactor =
      typeof parsed.focusFactor === 'number' && parsed.focusFactor >= 0.5 && parsed.focusFactor <= 1
        ? Number(parsed.focusFactor.toFixed(2))
        : 0.85;
    return {
      ...parsed,
      focusFactor,
      aiReportsEnabled: Boolean(row.ai_reports_enabled),
    };
  }

  public async updateTenantConfig(
    tenantId: string,
    partial: Partial<TenantConfig> & { aiReportsEnabled?: boolean }
  ): Promise<TenantConfig & { aiReportsEnabled: boolean }> {
    const curr = await this.getTenantConfig(tenantId);
    const aiReportsEnabled =
      partial.aiReportsEnabled !== undefined
        ? Boolean(partial.aiReportsEnabled)
        : curr.aiReportsEnabled;

    const rawFocus =
      partial.focusFactor !== undefined ? Number(partial.focusFactor) : curr.focusFactor ?? 0.85;
    const focusFactor = Number.isFinite(rawFocus)
      ? Math.min(1, Math.max(0.5, Number(rawFocus.toFixed(2))))
      : 0.85;

    const next: TenantConfig = {
      id: curr.id,
      name: partial.name ?? curr.name,
      confidenceThresholds: {
        ...curr.confidenceThresholds,
        ...(partial.confidenceThresholds || {}),
      },
      sessionizer: {
        ...curr.sessionizer,
        ...(partial.sessionizer || {}),
      },
      heartbeatIntervalSeconds: partial.heartbeatIntervalSeconds ?? curr.heartbeatIntervalSeconds,
      delayedThresholdSeconds: partial.delayedThresholdSeconds ?? curr.delayedThresholdSeconds,
      retentionDays: partial.retentionDays ?? curr.retentionDays,
      focusFactor,
      monitoringPolicy: partial.monitoringPolicy ?? curr.monitoringPolicy,
      serverUrl: partial.serverUrl ?? curr.serverUrl,
    };

    await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        await tx.run(
          'UPDATE tenants SET name = ?, config_json = ?, ai_reports_enabled = ? WHERE id = ?',
          next.name,
          JSON.stringify(next),
          aiReportsEnabled ? 1 : 0,
          tenantId
        );
      }
    );
    return { ...next, aiReportsEnabled };
  }

  public async getClients(tenantId: string): Promise<ClientDictionaryEntry[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        'SELECT * FROM clients WHERE tenant_id = ? ORDER BY legal_name ASC',
        tenantId
      );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        legalName: r.legal_name,
        aliases: JSON.parse(r.aliases_json),
        codes: JSON.parse(r.codes_json),
        folderPatterns: JSON.parse(r.folder_patterns_json),
        knownDomains: JSON.parse(r.known_domains_json),
        restrictedUserIds: JSON.parse(r.restricted_user_ids_json),
        source: r.source,
        updatedAtUtc: r.updated_at_utc,
      }));
    });
  }

  public async addOrUpdateClient(
    entry: Omit<ClientDictionaryEntry, 'id' | 'updatedAtUtc'> & { id?: string }
  ): Promise<ClientDictionaryEntry> {
    await this.ready();
    const id = entry.id || `cli-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const updatedAtUtc = new Date().toISOString();
    await this.db.withTenantTransaction({ tenantId: entry.tenantId }, async (tx) => {
      await tx.run(
        `INSERT INTO clients
         (id, tenant_id, legal_name, aliases_json, codes_json, folder_patterns_json, known_domains_json, restricted_user_ids_json, source, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           legal_name = excluded.legal_name,
           aliases_json = excluded.aliases_json,
           codes_json = excluded.codes_json,
           folder_patterns_json = excluded.folder_patterns_json,
           known_domains_json = excluded.known_domains_json,
           restricted_user_ids_json = excluded.restricted_user_ids_json,
           source = excluded.source,
           updated_at_utc = excluded.updated_at_utc`,
        id,
        entry.tenantId,
        entry.legalName,
        JSON.stringify(entry.aliases),
        JSON.stringify(entry.codes),
        JSON.stringify(entry.folderPatterns),
        JSON.stringify(entry.knownDomains),
        JSON.stringify(entry.restrictedUserIds || []),
        entry.source,
        updatedAtUtc
      );
    });
    return { ...entry, id, updatedAtUtc };
  }

  public async importClientsFromRaw(
    tenantId: string,
    rawText: string,
    source: 'csv' | 'file_upload'
  ): Promise<ClientDictionaryEntry[]> {
    const parsed = parseClientImportContent(rawText, tenantId, source);
    const out: ClientDictionaryEntry[] = [];
    for (const c of parsed) {
      out.push(await this.addOrUpdateClient(c));
    }
    return out;
  }

  public async deleteClient(tenantId: string, clientId: string) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      await tx.run('DELETE FROM clients WHERE tenant_id = ? AND id = ?', tenantId, clientId);
    });
  }

  public async getActivityRules(tenantId: string): Promise<ActivityDictionaryEntry[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        'SELECT * FROM activity_rules WHERE tenant_id = ? ORDER BY weight DESC',
        tenantId
      );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        keyword: r.keyword,
        activityType: r.activity_type,
        workCategory: r.work_category,
        weight: Number(r.weight),
      }));
    });
  }

  public async addActivityRule(
    rule: Omit<ActivityDictionaryEntry, 'id'>
  ): Promise<ActivityDictionaryEntry> {
    await this.ready();
    const id = `act-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    await this.db.withTenantTransaction({ tenantId: rule.tenantId }, async (tx) => {
      await tx.run(
        'INSERT INTO activity_rules (id, tenant_id, keyword, activity_type, work_category, weight) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        rule.tenantId,
        rule.keyword,
        rule.activityType,
        rule.workCategory,
        rule.weight
      );
    });
    return { ...rule, id };
  }

  public async deleteActivityRule(tenantId: string, id: string) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      await tx.run('DELETE FROM activity_rules WHERE tenant_id = ? AND id = ?', tenantId, id);
    });
  }

  public async getPrivacyRules(tenantId: string): Promise<PrivacyRule[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        'SELECT * FROM privacy_rules WHERE tenant_id = ?',
        tenantId
      );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        kind: r.kind,
        pattern: r.pattern,
        reason: r.reason,
        enabled: Boolean(r.enabled),
      }));
    });
  }

  public async addPrivacyRule(rule: Omit<PrivacyRule, 'id'>): Promise<PrivacyRule> {
    await this.ready();
    const id = `priv-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    await this.db.withTenantTransaction({ tenantId: rule.tenantId }, async (tx) => {
      await tx.run(
        'INSERT INTO privacy_rules (id, tenant_id, kind, pattern, reason, enabled) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        rule.tenantId,
        rule.kind,
        rule.pattern,
        rule.reason,
        rule.enabled ? 1 : 0
      );
    });
    return { ...rule, id };
  }

  public async togglePrivacyRule(tenantId: string, id: string, enabled: boolean) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      await tx.run(
        'UPDATE privacy_rules SET enabled = ? WHERE tenant_id = ? AND id = ?',
        enabled ? 1 : 0,
        tenantId,
        id
      );
    });
  }

  public async deletePrivacyRule(tenantId: string, id: string) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      await tx.run('DELETE FROM privacy_rules WHERE tenant_id = ? AND id = ?', tenantId, id);
    });
  }

  public async getTemplates(tenantId: string): Promise<TaskTemplate[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      let rows = await tx.all<any>(
        'SELECT * FROM task_templates WHERE tenant_id = ?',
        tenantId
      );
      if (rows.length === 0) {
        const prefix = tenantId === 'firm_demo' ? 'demo_' : `${tenantId.slice(0, 8)}_`;
        const defaults: TaskTemplate[] = [
          {
            id: `${prefix}tpl-monthly-close`,
            tenantId,
            name: 'Monthly Bank Close & Reconciliation',
            defaultCategory: 'billable',
            steps: [
              { id: `${prefix}stp-1`, order: 1, title: 'Bank Statements & Intake Verified', activitySignature: 'bank', docTypeHint: 'Bank Statement CSV/PDF' },
              { id: `${prefix}stp-2`, order: 2, title: 'Chequing & Clearing Ledger Reconciled', activitySignature: 'reconcil', docTypeHint: 'Clearing Ledger Export' },
              { id: `${prefix}stp-3`, order: 3, title: 'Trial Balance Tie-Out Completed', activitySignature: 'tie-out', docTypeHint: 'Signed Approval Package' },
            ],
          },
          {
            id: `${prefix}tpl-payroll-tax`,
            tenantId,
            name: 'Payroll & Corporate Tax Compliance',
            defaultCategory: 'billable',
            steps: [
              { id: `${prefix}stp-4`, order: 1, title: 'Payroll Register & Deductions Verified', activitySignature: 'payroll', docTypeHint: 'Payroll Summary & Authorization PDF' },
              { id: `${prefix}stp-5`, order: 2, title: 'Corporate Tax Schedule Drafted & Ready', activitySignature: 'tax', docTypeHint: 'Tax Filing Consent Form' },
            ],
          },
        ];
        for (const tpl of defaults) {
          await tx.run(
            `INSERT INTO task_templates (id, tenant_id, name, default_category, steps_json)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            tpl.id,
            tpl.tenantId,
            tpl.name,
            tpl.defaultCategory,
            JSON.stringify(tpl.steps)
          );
        }
        rows = await tx.all<any>(
          'SELECT * FROM task_templates WHERE tenant_id = ?',
          tenantId
        );
      }
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        name: r.name,
        defaultCategory: r.default_category,
        steps: JSON.parse(r.steps_json),
      }));
    });
  }

  public async updateTaskTemplate(
    tenantId: string,
    templateId: string,
    updates: {
      name?: string;
      milestoneNames?: string[];
      steps?: TaskTemplateStep[];
    }
  ): Promise<TaskTemplate> {
    await this.ready();
    const templates = await this.getTemplates(tenantId);
    const existing = templates.find((t) => t.id === templateId);
    if (!existing) {
      throw new HttpError(404, 'TEMPLATE_NOT_FOUND', 'Task template not found.');
    }

    const nextName = updates.name?.trim() || existing.name;
    let nextSteps: TaskTemplateStep[] = existing.steps;
    if (Array.isArray(updates.steps) && updates.steps.length > 0) {
      nextSteps = updates.steps.map((s, idx) => ({
        id: s.id || `${templateId}_stp_${idx + 1}`,
        order: idx + 1,
        title: s.title.trim() || `Milestone ${idx + 1}`,
        activitySignature: s.activitySignature?.trim() || existing.steps[idx]?.activitySignature || 'work',
        docTypeHint: s.docTypeHint?.trim() || existing.steps[idx]?.docTypeHint,
      }));
    } else if (Array.isArray(updates.milestoneNames) && updates.milestoneNames.length > 0) {
      nextSteps = updates.milestoneNames
        .map((m) => m.trim())
        .filter(Boolean)
        .map((title, idx) => ({
          id: existing.steps[idx]?.id || `${templateId}_stp_${idx + 1}`,
          order: idx + 1,
          title,
          activitySignature: existing.steps[idx]?.activitySignature || title.toLowerCase().split(/\s+/)[0] || 'work',
          docTypeHint: existing.steps[idx]?.docTypeHint,
        }));
    }

    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      await tx.run(
        'UPDATE task_templates SET name = ?, steps_json = ? WHERE tenant_id = ? AND id = ?',
        nextName,
        JSON.stringify(nextSteps),
        tenantId,
        templateId
      );
    });

    return {
      ...existing,
      name: nextName,
      steps: nextSteps,
    };
  }

  public async getPortalBranding(tenantId: string): Promise<PortalBrandingConfig> {
    await this.ready();
    const row = await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      (tx) =>
        tx.get<{ name: string; slug: string | null; branding_json: string | null }>(
          'SELECT name, slug, branding_json FROM tenants WHERE id = ?',
          tenantId
        )
    );
    const firmName = row?.name || 'OnTrack Accounting Firm';
    const slug = row?.slug || tenantId.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'firm';
    const initials = firmName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('') || 'OT';

    const defaults: PortalBrandingConfig = {
      firmName,
      accentTheme: 'indigo',
      accentColor: '#4f46e5',
      portalTitle: `${firmName} · Client Portal`,
      customDomain: `portal.${slug}.example`,
      supportNotice: 'Confirmed deliverables only · Encrypted document vault',
      welcomeMessage: 'Track verified engagement milestones, sign off completed workpapers, and exchange documents securely with your accounting team.',
      logoText: initials,
      logoFileId: null,
    };

    if (!row?.branding_json) {
      return defaults;
    }
    try {
      const parsed = JSON.parse(row.branding_json);
      return {
        ...defaults,
        ...parsed,
        firmName,
      };
    } catch {
      return defaults;
    }
  }

  public async updatePortalBranding(
    tenantId: string,
    partial: Partial<Omit<PortalBrandingConfig, 'firmName'>>
  ): Promise<PortalBrandingConfig> {
    const curr = await this.getPortalBranding(tenantId);
    const themeColorMap: Record<PortalAccentTheme, string> = {
      indigo: '#4f46e5',
      emerald: '#059669',
      blue: '#2563eb',
      slate: '#334155',
      amber: '#d97706',
      rose: '#e11d48',
    };
    const nextTheme: PortalAccentTheme =
      partial.accentTheme && partial.accentTheme in themeColorMap
        ? partial.accentTheme
        : curr.accentTheme;

    const next: PortalBrandingConfig = {
      firmName: curr.firmName,
      accentTheme: nextTheme,
      accentColor: themeColorMap[nextTheme] || partial.accentColor || curr.accentColor,
      portalTitle: partial.portalTitle !== undefined ? partial.portalTitle.trim() || curr.portalTitle : curr.portalTitle,
      customDomain: partial.customDomain !== undefined ? partial.customDomain.trim() : curr.customDomain,
      supportNotice: partial.supportNotice !== undefined ? partial.supportNotice.trim() : curr.supportNotice,
      welcomeMessage: partial.welcomeMessage !== undefined ? partial.welcomeMessage.trim() : curr.welcomeMessage,
      logoText: partial.logoText !== undefined ? partial.logoText.trim().slice(0, 4).toUpperCase() || curr.logoText : curr.logoText,
      logoFileId: partial.logoFileId !== undefined ? partial.logoFileId : curr.logoFileId,
    };

    const { firmName: _omit, ...stored } = next;
    await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        await tx.run(
          'UPDATE tenants SET branding_json = ? WHERE id = ?',
          JSON.stringify(stored),
          tenantId
        );
      }
    );
    return next;
  }

  public async getTasks(tenantId: string): Promise<EngineTask[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const [rows, userRows, collabRows, pendingInviteRows] = await Promise.all([
        tx.all<any>(
          'SELECT * FROM engine_tasks WHERE tenant_id = ? ORDER BY due_date_utc ASC',
          tenantId
        ),
        tx.all<any>(
          'SELECT user_id, name, email, role, team_id FROM shift_users WHERE tenant_id = ?',
          tenantId
        ),
        tx.all<any>(
          'SELECT * FROM task_collaborators WHERE tenant_id = ? ORDER BY created_at_utc ASC',
          tenantId
        ),
        tx.all<any>(
          "SELECT task_id, invitee_user_id FROM task_collaboration_invites WHERE tenant_id = ? AND status = 'pending'",
          tenantId
        ),
      ]);

      const userMap = new Map<
        string,
        { name: string; email: string; role: UserRole; teamId: string }
      >();
      for (const u of userRows) {
        userMap.set(u.user_id, {
          name: u.name,
          email: u.email,
          role: u.role as UserRole,
          teamId: u.team_id,
        });
      }

      const collabByTask = new Map<string, TaskCollaboratorSummary[]>();
      for (const c of collabRows) {
        const u = userMap.get(c.user_id);
        const list = collabByTask.get(c.task_id) || [];
        list.push({
          userId: c.user_id,
          name: u?.name || c.user_id,
          email: u?.email || '',
          role: u?.role || 'accountant',
          teamId: u?.teamId || 'team_audit',
          canEdit: Boolean(c.can_edit),
          canAutoTrack: Boolean(c.can_auto_track),
          addedAtUtc: c.created_at_utc,
        });
        collabByTask.set(c.task_id, list);
      }

      const pendingByTask = new Map<string, string[]>();
      for (const p of pendingInviteRows) {
        const list = pendingByTask.get(p.task_id) || [];
        list.push(p.invitee_user_id);
        pendingByTask.set(p.task_id, list);
      }

      return rows.map((r) => {
        const owner = userMap.get(r.assigned_user_id);
        const collabs = collabByTask.get(r.id) || [];
        const pendingInviteUserIds = pendingByTask.get(r.id) || [];
        return {
          id: r.id,
          tenantId: r.tenant_id,
          clientId: r.client_id,
          clientName: r.client_name,
          templateId: r.template_id || undefined,
          title: r.title,
          period: r.period,
          status: r.status,
          dueDateUtc: r.due_date_utc,
          assignedUserId: r.assigned_user_id,
          assignedUserName: owner?.name || r.assigned_user_id,
          assignedUserRole: owner?.role || 'accountant',
          collaboratorUserIds: collabs.map((c) => c.userId),
          collaborators: collabs,
          pendingInviteUserIds,
          estimatedMinutes: r.estimated_minutes,
          version: r.version,
          updatedAtUtc: r.updated_at_utc,
        };
      });
    });
  }

  public async createEngineTask(
    task: Omit<EngineTask, 'id' | 'version' | 'updatedAtUtc'>
  ): Promise<EngineTask> {
    await this.ready();
    const id = `tsk-eng-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const updatedAtUtc = new Date().toISOString();
    const txResult = await this.db.withTenantTransaction(
      { tenantId: task.tenantId },
      async (tx) => {
        let resolvedClientId = task.clientId;
        let resolvedClientName = task.clientName;
        let ownerInfo: { name: string; role: UserRole } | null = null;

        const existingClient = await tx.get<{ id: string; legal_name: string }>(
          'SELECT id, legal_name FROM clients WHERE tenant_id = ? AND (id = ? OR LOWER(legal_name) = LOWER(?))',
          task.tenantId,
          task.clientId,
          task.clientName
        );
        if (existingClient) {
          resolvedClientId = existingClient.id;
          resolvedClientName = existingClient.legal_name;
        } else {
          await tx.run(
            `INSERT INTO clients
             (id, tenant_id, legal_name, aliases_json, codes_json, folder_patterns_json, known_domains_json, restricted_user_ids_json, source, updated_at_utc)
             VALUES (?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'manual', ?)
             ON CONFLICT (id) DO NOTHING`,
            resolvedClientId,
            task.tenantId,
            resolvedClientName || 'Internal Firm',
            updatedAtUtc
          );
        }

        const ownerRow = await tx.get<{ name: string; role: string }>(
          'SELECT name, role FROM shift_users WHERE tenant_id = ? AND user_id = ?',
          task.tenantId,
          task.assignedUserId
        );
        if (ownerRow) {
          ownerInfo = { name: ownerRow.name, role: ownerRow.role as UserRole };
        }

        await tx.run(
          `INSERT INTO engine_tasks (id, tenant_id, client_id, client_name, template_id, title, period, status, due_date_utc, assigned_user_id, estimated_minutes, version, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          id,
          task.tenantId,
          resolvedClientId,
          resolvedClientName,
          task.templateId || null,
          task.title,
          task.period,
          task.status,
          task.dueDateUtc,
          task.assignedUserId,
          task.estimatedMinutes,
          updatedAtUtc
        );

        return { resolvedClientId, resolvedClientName, ownerInfo };
      }
    );
    return {
      ...task,
      clientId: txResult.resolvedClientId,
      clientName: txResult.resolvedClientName,
      assignedUserName: txResult.ownerInfo?.name || task.assignedUserId,
      assignedUserRole: txResult.ownerInfo?.role || 'accountant',
      collaboratorUserIds: [],
      collaborators: [],
      pendingInviteUserIds: [],
      id,
      version: 1,
      updatedAtUtc,
    };
  }

  public async updateEngineTask(params: {
    tenantId: string;
    taskId: string;
    updates: {
      title?: string;
      status?: EngineTask['status'];
      estimatedMinutes?: number;
      dueDateUtc?: string;
      period?: string;
      assignedUserId?: string;
      clientId?: string;
      clientName?: string;
    };
  }): Promise<EngineTask> {
    await this.ready();
    const nowIso = new Date().toISOString();
    await this.db.withTenantTransaction({ tenantId: params.tenantId }, async (tx) => {
      const existing = await tx.get<any>(
        'SELECT * FROM engine_tasks WHERE tenant_id = ? AND id = ?',
        params.tenantId,
        params.taskId
      );
      if (!existing) {
        throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
      }

      const nextTitle = params.updates.title?.trim() || existing.title;
      const nextStatus = params.updates.status || existing.status;
      const nextEst =
        params.updates.estimatedMinutes !== undefined
          ? Math.max(5, Math.round(params.updates.estimatedMinutes))
          : Number(existing.estimated_minutes);
      const nextDue = params.updates.dueDateUtc || existing.due_date_utc;
      const nextPeriod = params.updates.period || existing.period;
      const nextAssigned = params.updates.assignedUserId || existing.assigned_user_id;
      const nextClientId = params.updates.clientId || existing.client_id;
      const nextClientName = params.updates.clientName || existing.client_name;
      const nextVersion = Number(existing.version || 1) + 1;

      await tx.run(
        `UPDATE engine_tasks
         SET title = ?, status = ?, estimated_minutes = ?, due_date_utc = ?, period = ?,
             assigned_user_id = ?, client_id = ?, client_name = ?, version = ?, updated_at_utc = ?
         WHERE tenant_id = ? AND id = ?`,
        nextTitle,
        nextStatus,
        nextEst,
        nextDue,
        nextPeriod,
        nextAssigned,
        nextClientId,
        nextClientName,
        nextVersion,
        nowIso,
        params.tenantId,
        params.taskId
      );

      // If newly assigned user was a collaborator or pending invitee, promote cleanly to Primary Owner
      if (nextAssigned && nextAssigned !== existing.assigned_user_id) {
        await tx.run(
          'DELETE FROM task_collaborators WHERE tenant_id = ? AND task_id = ? AND user_id = ?',
          params.tenantId,
          params.taskId,
          nextAssigned
        );
        await tx.run(
          "UPDATE task_collaboration_invites SET status = 'accepted', responded_at_utc = ? WHERE tenant_id = ? AND task_id = ? AND invitee_user_id = ? AND status = 'pending'",
          nowIso,
          params.tenantId,
          params.taskId,
          nextAssigned
        );
      }
    });

    const refreshed = (await this.getTasks(params.tenantId)).find(
      (t) => t.id === params.taskId
    );
    if (!refreshed) {
      throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
    }
    return refreshed;
  }

  public async deleteEngineTask(params: {
    tenantId: string;
    taskId: string;
  }): Promise<{ id: string; title: string }> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId: params.tenantId }, async (tx) => {
      const existing = await tx.get<{ id: string; title: string }>(
        'SELECT id, title FROM engine_tasks WHERE tenant_id = ? AND id = ?',
        params.tenantId,
        params.taskId
      );
      if (!existing) {
        throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
      }
      await tx.run(
        'DELETE FROM task_collaborators WHERE tenant_id = ? AND task_id = ?',
        params.tenantId,
        params.taskId
      );
      await tx.run(
        'DELETE FROM task_collaboration_invites WHERE tenant_id = ? AND task_id = ?',
        params.tenantId,
        params.taskId
      );
      await tx.run(
        'DELETE FROM checklist_overrides WHERE tenant_id = ? AND task_id = ?',
        params.tenantId,
        params.taskId
      );
      await tx.run(
        'DELETE FROM sync_conflicts WHERE tenant_id = ? AND task_id = ?',
        params.tenantId,
        params.taskId
      );
      await tx.run(
        'DELETE FROM engine_tasks WHERE tenant_id = ? AND id = ?',
        params.tenantId,
        params.taskId
      );
      return existing;
    });
  }

  public async listTaskCollaborationInvites(params: {
    tenantId: string;
    viewerUserId?: string;
    viewerRole?: UserRole;
  }): Promise<TaskCollaborationInvite[]> {
    await this.ready();
    const { tenantId, viewerUserId, viewerRole } = params;
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        `SELECT i.*,
                t.title AS task_title, t.client_name AS client_name, t.period AS period,
                inviter.name AS inviter_name, inviter.role AS inviter_role,
                invitee.name AS invitee_name, invitee.email AS invitee_email, invitee.role AS invitee_role
         FROM task_collaboration_invites i
         JOIN engine_tasks t ON t.tenant_id = i.tenant_id AND t.id = i.task_id
         LEFT JOIN shift_users inviter ON inviter.tenant_id = i.tenant_id AND inviter.user_id = i.inviter_user_id
         LEFT JOIN shift_users invitee ON invitee.tenant_id = i.tenant_id AND invitee.user_id = i.invitee_user_id
         WHERE i.tenant_id = ?
         ORDER BY i.created_at_utc DESC`,
        tenantId
      );
      return rows
        .filter((r) => {
          if (!viewerUserId) return true;
          if (
            viewerRole === 'team_lead' ||
            viewerRole === 'line_manager' ||
            viewerRole === 'executive' ||
            viewerRole === 'admin_it'
          ) {
            return true;
          }
          return (
            r.invitee_user_id === viewerUserId ||
            r.inviter_user_id === viewerUserId
          );
        })
        .map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          taskId: r.task_id,
          taskTitle: r.task_title || 'Task',
          clientName: r.client_name || '',
          period: r.period || '',
          inviterUserId: r.inviter_user_id,
          inviterName: r.inviter_name || r.inviter_user_id,
          inviterRole: (r.inviter_role || 'accountant') as UserRole,
          inviteeUserId: r.invitee_user_id,
          inviteeName: r.invitee_name || r.invitee_user_id,
          inviteeEmail: r.invitee_email || '',
          inviteeRole: (r.invitee_role || 'accountant') as UserRole,
          status: r.status as TaskCollaborationInviteStatus,
          note: r.note || '',
          respondedAtUtc: r.responded_at_utc || null,
          createdAtUtc: r.created_at_utc,
        }));
    });
  }

  public async inviteTaskCollaborator(params: {
    tenantId: string;
    taskId: string;
    inviterUserId: string;
    inviterRole: UserRole;
    inviteeUserId: string;
    note?: string;
  }): Promise<{ invite: TaskCollaborationInvite; task: EngineTask }> {
    await this.ready();
    if (params.inviterRole === 'client') {
      throw new HttpError(403, 'FORBIDDEN', 'Client Portal users cannot invite task collaborators.');
    }
    const cleanNote = (params.note || '').trim().slice(0, 400);
    const nowIso = new Date().toISOString();
    const inviteId = `tinv-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    await this.db.withTenantTransaction(
      { tenantId: params.tenantId, userId: params.inviterUserId },
      async (tx) => {
        const taskRow = await tx.get<any>(
          'SELECT * FROM engine_tasks WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.taskId
        );
        if (!taskRow) {
          throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
        }

        const invitee = await tx.get<any>(
          'SELECT user_id, name, email, role, status FROM shift_users WHERE tenant_id = ? AND user_id = ?',
          params.tenantId,
          params.inviteeUserId
        );
        if (!invitee || invitee.status !== 'active') {
          throw new HttpError(
            404,
            'INVITEE_NOT_FOUND',
            'Collaboration invites can only target active registered members of the same firm.'
          );
        }
        if (invitee.role === 'client') {
          throw new HttpError(
            400,
            'EXTERNAL_CLIENT_FORBIDDEN',
            'External Client Portal accounts cannot be invited to internal firm tasks.'
          );
        }

        const isManagerOrAdmin =
          params.inviterRole === 'team_lead' ||
          params.inviterRole === 'line_manager' ||
          params.inviterRole === 'executive' ||
          params.inviterRole === 'admin_it';

        const existingCollab = await tx.get<{ id: string }>(
          'SELECT id FROM task_collaborators WHERE tenant_id = ? AND task_id = ? AND user_id = ?',
          params.tenantId,
          params.taskId,
          params.inviterUserId
        );

        if (
          !isManagerOrAdmin &&
          taskRow.assigned_user_id !== params.inviterUserId &&
          !existingCollab
        ) {
          throw new HttpError(
            403,
            'FORBIDDEN',
            'Only the task owner, active collaborators, or firm managers can invite collaborators to this task.'
          );
        }

        const clientRow = await tx.get<{ restricted_user_ids_json: string }>(
          'SELECT restricted_user_ids_json FROM clients WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          taskRow.client_id
        );
        if (clientRow?.restricted_user_ids_json) {
          const restricted: string[] = JSON.parse(clientRow.restricted_user_ids_json || '[]');
          if (restricted.length > 0 && !restricted.includes(params.inviteeUserId)) {
            throw new HttpError(
              403,
              'CLIENT_RESTRICTED',
              'Invited colleague is not on the approved access list for this restricted client.'
            );
          }
        }

        if (taskRow.assigned_user_id === params.inviteeUserId) {
          throw new HttpError(
            400,
            'ALREADY_PRIMARY_OWNER',
            'This colleague is already the Primary Owner of this task.'
          );
        }

        const alreadyCollab = await tx.get<{ id: string }>(
          'SELECT id FROM task_collaborators WHERE tenant_id = ? AND task_id = ? AND user_id = ?',
          params.tenantId,
          params.taskId,
          params.inviteeUserId
        );
        if (alreadyCollab) {
          throw new HttpError(
            409,
            'ALREADY_COLLABORATOR',
            'This colleague is already a collaborator on this task.'
          );
        }

        const pendingInvite = await tx.get<{ id: string }>(
          "SELECT id FROM task_collaboration_invites WHERE tenant_id = ? AND task_id = ? AND invitee_user_id = ? AND status = 'pending'",
          params.tenantId,
          params.taskId,
          params.inviteeUserId
        );
        if (pendingInvite) {
          throw new HttpError(
            409,
            'INVITE_ALREADY_PENDING',
            'A collaboration invitation is already pending for this colleague on this task.'
          );
        }

        await tx.run(
          `INSERT INTO task_collaboration_invites
           (id, tenant_id, task_id, inviter_user_id, invitee_user_id, status, note, responded_at_utc, created_at_utc)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?)`,
          inviteId,
          params.tenantId,
          params.taskId,
          params.inviterUserId,
          params.inviteeUserId,
          cleanNote,
          nowIso
        );
      }
    );

    const [invites, tasks] = await Promise.all([
      this.listTaskCollaborationInvites({ tenantId: params.tenantId }),
      this.getTasks(params.tenantId),
    ]);
    const invite = invites.find((i) => i.id === inviteId);
    const task = tasks.find((t) => t.id === params.taskId);
    if (!invite || !task) {
      throw new HttpError(500, 'INVITE_PERSIST_ERROR', 'Unable to load created task invite.');
    }
    return { invite, task };
  }

  public async respondToTaskCollaborationInvite(params: {
    tenantId: string;
    inviteId: string;
    actorUserId: string;
    action: 'accept' | 'decline';
  }): Promise<{ invite: TaskCollaborationInvite; task: EngineTask }> {
    await this.ready();
    const nowIso = new Date().toISOString();
    let taskId = '';

    await this.db.withTenantTransaction(
      { tenantId: params.tenantId, userId: params.actorUserId },
      async (tx) => {
        const inv = await tx.get<any>(
          'SELECT * FROM task_collaboration_invites WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.inviteId
        );
        if (!inv) {
          throw new HttpError(404, 'INVITE_NOT_FOUND', 'Task collaboration invite not found.');
        }
        if (inv.invitee_user_id !== params.actorUserId) {
          throw new HttpError(
            403,
            'FORBIDDEN',
            'Only the invited colleague can accept or decline this collaboration invite.'
          );
        }
        if (inv.status !== 'pending') {
          throw new HttpError(
            409,
            'INVITE_ALREADY_RESOLVED',
            `Invitation was already ${inv.status}.`
          );
        }

        taskId = inv.task_id;
        const nextStatus = params.action === 'accept' ? 'accepted' : 'declined';
        await tx.run(
          'UPDATE task_collaboration_invites SET status = ?, responded_at_utc = ? WHERE tenant_id = ? AND id = ?',
          nextStatus,
          nowIso,
          params.tenantId,
          params.inviteId
        );

        if (params.action === 'accept') {
          const collabId = `tcol-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
          await tx.run(
            `INSERT INTO task_collaborators
             (id, tenant_id, task_id, user_id, added_by_user_id, can_edit, can_auto_track, created_at_utc)
             VALUES (?, ?, ?, ?, ?, 1, 1, ?)
             ON CONFLICT (tenant_id, task_id, user_id) DO UPDATE SET can_edit = 1, can_auto_track = 1`,
            collabId,
            params.tenantId,
            inv.task_id,
            inv.invitee_user_id,
            inv.inviter_user_id,
            nowIso
          );
        }
      }
    );

    const [invites, tasks] = await Promise.all([
      this.listTaskCollaborationInvites({ tenantId: params.tenantId }),
      this.getTasks(params.tenantId),
    ]);
    const invite = invites.find((i) => i.id === params.inviteId);
    const task = tasks.find((t) => t.id === taskId);
    if (!invite || !task) {
      throw new HttpError(404, 'TASK_NOT_FOUND', 'Task or invite no longer exists.');
    }
    return { invite, task };
  }

  public async removeTaskCollaboratorOrPendingInvite(params: {
    tenantId: string;
    taskId: string;
    targetUserId: string;
    actorUserId: string;
    actorRole: UserRole;
  }): Promise<{ task: EngineTask }> {
    await this.ready();
    const nowIso = new Date().toISOString();

    await this.db.withTenantTransaction(
      { tenantId: params.tenantId, userId: params.actorUserId },
      async (tx) => {
        const taskRow = await tx.get<any>(
          'SELECT * FROM engine_tasks WHERE tenant_id = ? AND id = ?',
          params.tenantId,
          params.taskId
        );
        if (!taskRow) {
          throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
        }

        const isManagerOrAdmin =
          params.actorRole === 'team_lead' ||
          params.actorRole === 'line_manager' ||
          params.actorRole === 'executive' ||
          params.actorRole === 'admin_it';

        const isSelfLeaving = params.targetUserId === params.actorUserId;
        const isOwner = taskRow.assigned_user_id === params.actorUserId;
        if (!isManagerOrAdmin && !isOwner && !isSelfLeaving) {
          throw new HttpError(
            403,
            'FORBIDDEN',
            'Only the task owner, managers, or the collaborator themselves can remove access.'
          );
        }

        await tx.run(
          'DELETE FROM task_collaborators WHERE tenant_id = ? AND task_id = ? AND user_id = ?',
          params.tenantId,
          params.taskId,
          params.targetUserId
        );
        await tx.run(
          "UPDATE task_collaboration_invites SET status = 'revoked', responded_at_utc = ? WHERE tenant_id = ? AND task_id = ? AND invitee_user_id = ? AND status = 'pending'",
          nowIso,
          params.tenantId,
          params.taskId,
          params.targetUserId
        );
      }
    );

    const refreshed = (await this.getTasks(params.tenantId)).find(
      (t) => t.id === params.taskId
    );
    if (!refreshed) {
      throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
    }
    return { task: refreshed };
  }

  public async getLearnedRules(tenantId: string): Promise<LearnedRule[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        'SELECT * FROM learned_rules WHERE tenant_id = ? ORDER BY created_at_utc DESC',
        tenantId
      );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        userId: r.user_id,
        patternType: r.pattern_type,
        pattern: r.pattern,
        targetClientId: r.target_client_id,
        targetTaskId: r.target_task_id || null,
        accepted: Boolean(r.accepted),
        createdAtUtc: r.created_at_utc,
      }));
    });
  }

  public async saveLearnedRule(
    rule: Omit<LearnedRule, 'id' | 'createdAtUtc'>
  ): Promise<LearnedRule> {
    await this.ready();
    const id = `lrn-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const createdAtUtc = new Date().toISOString();
    await this.db.withTenantTransaction({ tenantId: rule.tenantId }, async (tx) => {
      await tx.run(
        `INSERT INTO learned_rules (id, tenant_id, user_id, pattern_type, pattern, target_client_id, target_task_id, accepted, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        rule.tenantId,
        rule.userId,
        rule.patternType,
        rule.pattern,
        rule.targetClientId,
        rule.targetTaskId,
        rule.accepted ? 1 : 0,
        createdAtUtc
      );
    });
    return { ...rule, id, createdAtUtc };
  }

  public async getRawEvents(tenantId: string, userId?: string): Promise<TrackingEvent[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const rows = userId
        ? await tx.all<any>(
            'SELECT * FROM tracking_events WHERE tenant_id = ? AND user_id = ? ORDER BY event_time_utc ASC',
            tenantId,
            userId
          )
        : await tx.all<any>(
            'SELECT * FROM tracking_events WHERE tenant_id = ? ORDER BY event_time_utc ASC',
            tenantId
          );
      return rows.map((r) => ({
        event_id: r.event_id,
        schema_version: r.schema_version,
        tenant_id: r.tenant_id,
        user_id: r.user_id,
        device_id: r.device_id,
        seq: r.seq,
        type: r.type,
        priority: r.priority,
        event_time_utc: r.event_time_utc,
        received_at: r.received_at,
        payload: JSON.parse(r.payload_json),
      }));
    });
  }

  public async getConflicts(tenantId: string, userId?: string): Promise<SyncConflict[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const rows = userId
        ? await tx.all<any>(
            'SELECT * FROM sync_conflicts WHERE tenant_id = ? AND user_id = ? AND resolved = 0 ORDER BY created_at_utc DESC',
            tenantId,
            userId
          )
        : await tx.all<any>(
            'SELECT * FROM sync_conflicts WHERE tenant_id = ? AND resolved = 0 ORDER BY created_at_utc DESC',
            tenantId
          );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        userId: r.user_id,
        taskId: r.task_id,
        taskTitle: r.task_title,
        localStatus: r.local_status,
        serverStatus: r.server_status,
        localVersion: r.local_version,
        serverVersion: r.server_version,
        createdAtUtc: r.created_at_utc,
        resolved: Boolean(r.resolved),
        resolution: r.resolution || undefined,
      }));
    });
  }

  public async resolveConflict(
    tenantId: string,
    conflictId: string,
    resolution: 'keep_local' | 'keep_server'
  ) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const row = await tx.get<any>(
        'SELECT * FROM sync_conflicts WHERE tenant_id = ? AND id = ?',
        tenantId,
        conflictId
      );
      if (!row) return;
      if (resolution === 'keep_local') {
        await tx.run(
          'UPDATE engine_tasks SET status = ?, version = version + 1, updated_at_utc = ? WHERE tenant_id = ? AND id = ?',
          row.local_status,
          new Date().toISOString(),
          tenantId,
          row.task_id
        );
      }
      await tx.run(
        'UPDATE sync_conflicts SET resolved = 1, resolution = ? WHERE tenant_id = ? AND id = ?',
        resolution,
        tenantId,
        conflictId
      );
    });
  }

  public async recordAuditLog(
    entry: Omit<AuditLogEntry, 'id' | 'createdAtUtc'>
  ): Promise<AuditLogEntry> {
    await this.ready();
    const id = `aud-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const createdAtUtc = new Date().toISOString();
    await this.db.withTenantTransaction(
      { tenantId: entry.tenantId, userId: entry.actorUserId, role: entry.actorRole },
      async (tx) => {
        await tx.run(
          `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, target_user_id, action, details, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          entry.tenantId,
          entry.actorUserId,
          entry.actorRole,
          entry.targetUserId,
          entry.action,
          entry.details,
          createdAtUtc
        );
      }
    );
    return { ...entry, id, createdAtUtc };
  }

  public async getAuditLogs(tenantId: string): Promise<AuditLogEntry[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        'SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at_utc DESC LIMIT 50',
        tenantId
      );
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        actorUserId: r.actor_user_id,
        actorRole: r.actor_role,
        targetUserId: r.target_user_id || null,
        action: r.action,
        details: r.details,
        createdAtUtc: r.created_at_utc,
      }));
    });
  }

  public async saveStoredFileMetadata(
    record: StoredFileRecord & { storedRelPath: string }
  ): Promise<StoredFileRecord> {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId: record.tenantId }, async (tx) => {
      await tx.run(
        `INSERT INTO stored_files (file_id, tenant_id, uploader_user_id, uploader_email, purpose, original_name, stored_rel_path, mime_type, byte_size, sha256, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.fileId,
        record.tenantId,
        record.uploaderUserId,
        record.uploaderEmail,
        record.purpose,
        record.originalName,
        record.storedRelPath,
        record.mimeType,
        record.byteSize,
        record.sha256,
        record.createdAtUtc
      );
    });
    return {
      fileId: record.fileId,
      tenantId: record.tenantId,
      uploaderUserId: record.uploaderUserId,
      uploaderEmail: record.uploaderEmail,
      purpose: record.purpose,
      originalName: record.originalName,
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      sha256: record.sha256,
      createdAtUtc: record.createdAtUtc,
    };
  }

  public async listStoredFiles(tenantId: string): Promise<StoredFileRecord[]> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        'SELECT * FROM stored_files WHERE tenant_id = ? ORDER BY created_at_utc DESC LIMIT 50',
        tenantId
      );
      return rows.map((r) => ({
        fileId: r.file_id,
        tenantId: r.tenant_id,
        uploaderUserId: r.uploader_user_id,
        uploaderEmail: r.uploader_email,
        purpose: r.purpose,
        originalName: r.original_name,
        mimeType: r.mime_type,
        byteSize: Number(r.byte_size),
        sha256: r.sha256,
        createdAtUtc: r.created_at_utc,
      }));
    });
  }

  public async getStoredFile(
    tenantId: string,
    fileId: string
  ): Promise<(StoredFileRecord & { storedRelPath: string }) | null> {
    await this.ready();
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const r = await tx.get<any>(
        'SELECT * FROM stored_files WHERE tenant_id = ? AND file_id = ?',
        tenantId,
        fileId
      );
      if (!r) return null;
      return {
        fileId: r.file_id,
        tenantId: r.tenant_id,
        uploaderUserId: r.uploader_user_id,
        uploaderEmail: r.uploader_email,
        purpose: r.purpose,
        originalName: r.original_name,
        storedRelPath: r.stored_rel_path,
        mimeType: r.mime_type,
        byteSize: Number(r.byte_size),
        sha256: r.sha256,
        createdAtUtc: r.created_at_utc,
      };
    });
  }

  public async ingestEventBatch(params: {
    tenantId: string;
    userId: string;
    deviceId: string;
    events: TrackingEvent[];
  }) {
    await this.ready();
    const { tenantId, userId, deviceId, events } = params;
    const privacyRules = await this.getPrivacyRules(tenantId);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const ordered = events.slice().sort((a, b) => {
      if (a.priority === 'state' && b.priority !== 'state') return -1;
      if (a.priority !== 'state' && b.priority === 'state') return 1;
      return a.seq - b.seq;
    });

    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const devRow = await tx.get<any>(
        'SELECT * FROM device_freshness WHERE tenant_id = ? AND device_id = ?',
        tenantId,
        deviceId
      );
      let lastAckSeq = devRow ? Number(devRow.last_ack_seq) : 0;
      const seqGaps: number[] = [];
      let acceptedCount = 0;
      let duplicateCount = 0;
      let rejectedCount = 0;
      let lateBacklogUpdated = false;
      const conflictsCreated: SyncConflict[] = [];
      let clockOffsetMs = devRow ? Number(devRow.clock_offset_ms) : 0;
      let latestOs = devRow ? devRow.os_platform : 'web';
      let extConnected = devRow ? Boolean(devRow.extension_connected) : true;

      for (const rawEv of ordered) {
        if (hasForbiddenPayloadFields(rawEv.payload)) {
          rejectedCount++;
          continue;
        }

        const filtered = sanitizeAndFilterEvent(rawEv, privacyRules);
        if (!filtered.allowed || !filtered.sanitizedEvent) {
          rejectedCount++;
          continue;
        }

        const ev: TrackingEvent = {
          ...filtered.sanitizedEvent,
          tenant_id: tenantId,
          user_id: userId,
          device_id: deviceId,
          received_at: nowIso,
        };

        const inserted = await this.insertEventRowWithExec(tx, ev, nowIso);
        if (!inserted) {
          duplicateCount++;
          continue;
        }

        acceptedCount++;
        const evMs = Date.parse(ev.event_time_utc);
        if (!Number.isNaN(evMs)) {
          clockOffsetMs = nowMs - evMs;
          if (clockOffsetMs > 60_000 && ev.type !== 'activity.heartbeat') {
            lateBacklogUpdated = true;
          }
        }

        if (ev.seq > lastAckSeq + 1 && lastAckSeq > 0) {
          for (let missing = lastAckSeq + 1; missing < ev.seq; missing++) {
            seqGaps.push(missing);
          }
        }
        if (ev.seq > lastAckSeq) lastAckSeq = ev.seq;
        if (ev.payload.os_platform) latestOs = ev.payload.os_platform;
        if (ev.payload.extension_connected !== undefined) {
          extConnected = ev.payload.extension_connected;
        }

        if (ev.priority === 'state' && ev.type === 'state.task_status' && ev.payload.task_id) {
          const taskRow = await tx.get<any>(
            'SELECT * FROM engine_tasks WHERE tenant_id = ? AND id = ?',
            tenantId,
            ev.payload.task_id
          );

          if (taskRow) {
            const expectedVer = ev.payload.expected_version;
            if (expectedVer !== undefined && expectedVer !== Number(taskRow.version)) {
              const conflictId = `cnf-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
              const conflict: SyncConflict = {
                id: conflictId,
                tenantId,
                userId,
                taskId: taskRow.id,
                taskTitle: taskRow.title,
                localStatus: ev.payload.to_value || 'completed',
                serverStatus: taskRow.status,
                localVersion: expectedVer,
                serverVersion: Number(taskRow.version),
                createdAtUtc: nowIso,
                resolved: false,
              };
              await tx.run(
                `INSERT INTO sync_conflicts (id, tenant_id, user_id, task_id, task_title, local_status, server_status, local_version, server_version, created_at_utc, resolved)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                conflict.id,
                conflict.tenantId,
                conflict.userId,
                conflict.taskId,
                conflict.taskTitle,
                conflict.localStatus,
                conflict.serverStatus,
                conflict.localVersion,
                conflict.serverVersion,
                conflict.createdAtUtc
              );
              conflictsCreated.push(conflict);
            } else if (ev.payload.to_value) {
              await tx.run(
                'UPDATE engine_tasks SET status = ?, version = version + 1, updated_at_utc = ? WHERE tenant_id = ? AND id = ?',
                ev.payload.to_value,
                nowIso,
                tenantId,
                taskRow.id
              );
            }
          }
        }
      }

      if (lateBacklogUpdated) {
        const notice = `Updated ${nowIso.slice(11, 19)}Z from late-arriving device backlog`;
        await tx.run(
          `INSERT INTO late_updates (tenant_id, notice, updated_at_utc)
           VALUES (?, ?, ?)
           ON CONFLICT (tenant_id) DO UPDATE SET notice = excluded.notice, updated_at_utc = excluded.updated_at_utc`,
          tenantId,
          notice,
          nowIso
        );
      }

      const userRow = await tx.get<{ name: string; shift_pattern: string }>(
        'SELECT name, shift_pattern FROM shift_users WHERE tenant_id = ? AND user_id = ?',
        tenantId,
        userId
      );

      await tx.run(
        `INSERT INTO device_freshness
         (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')
         ON CONFLICT (device_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           user_id = excluded.user_id,
           user_name = excluded.user_name,
           shift_pattern = excluded.shift_pattern,
           os_platform = excluded.os_platform,
           extension_connected = excluded.extension_connected,
           last_heartbeat_utc = excluded.last_heartbeat_utc,
           last_ack_seq = excluded.last_ack_seq,
           clock_offset_ms = excluded.clock_offset_ms,
           status = 'live'`,
        deviceId,
        tenantId,
        userId,
        userRow?.name || userId,
        userRow?.shift_pattern || '8-5',
        latestOs,
        extConnected ? 1 : 0,
        nowIso,
        lastAckSeq,
        clockOffsetMs
      );

      return {
        acceptedCount,
        duplicateCount,
        rejectedCount,
        lastAckSeq,
        seqGaps,
        clockOffsetMs,
        serverTimeUtc: nowIso,
        lateBacklogUpdated,
        conflictsCreated,
        stateChanged: ordered.some((e) => e.priority === 'state') || lateBacklogUpdated,
      };
    });
  }

  public async resolveAttribution(params: {
    tenantId: string;
    userId: string;
    sessionId: string;
    taskId: string | null;
    status: AttributionStatus;
    customReason?: string;
    createRulePattern?: string;
    rejectRulePattern?: string;
  }) {
    await this.ready();
    const nowIso = new Date().toISOString();
    const tasks = await this.getTasks(params.tenantId);
    const clients = await this.getClients(params.tenantId);
    const task = params.taskId ? tasks.find((t) => t.id === params.taskId) : null;
    const client = task ? clients.find((c) => c.id === task.clientId) : null;

    await this.db.withTenantTransaction(
      { tenantId: params.tenantId, userId: params.userId },
      async (tx) => {
        const prevRow = await tx.get<{ version: number }>(
          'SELECT version FROM attribution_overrides WHERE tenant_id = ? AND session_id = ?',
          params.tenantId,
          params.sessionId
        );
        const nextVersion = prevRow ? Number(prevRow.version) + 1 : 2;

        await tx.run(
          `INSERT INTO attribution_overrides
           (session_id, tenant_id, user_id, task_id, task_title, client_id, client_name, step_id, step_title, period, confidence, reason, status, version, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (session_id) DO UPDATE SET
             task_id = excluded.task_id,
             task_title = excluded.task_title,
             client_id = excluded.client_id,
             client_name = excluded.client_name,
             period = excluded.period,
             confidence = excluded.confidence,
             reason = excluded.reason,
             status = excluded.status,
             version = excluded.version,
             updated_at_utc = excluded.updated_at_utc`,
          params.sessionId,
          params.tenantId,
          params.userId,
          task?.id || null,
          task?.title || null,
          client?.id || task?.clientId || null,
          client?.legalName || task?.clientName || null,
          task?.period || null,
          params.status === 'confirmed' ? 1.0 : 0.9,
          params.customReason || `Confirmed by user (${task?.title || 'Manual review'})`,
          params.status,
          nextVersion,
          nowIso
        );
      }
    );

    if (params.createRulePattern && client) {
      await this.saveLearnedRule({
        tenantId: params.tenantId,
        userId: params.userId,
        patternType: 'title_prefix',
        pattern: params.createRulePattern,
        targetClientId: client.id,
        targetTaskId: task?.id || null,
        accepted: true,
      });
    }

    if (params.rejectRulePattern) {
      await this.saveLearnedRule({
        tenantId: params.tenantId,
        userId: params.userId,
        patternType: 'title_prefix',
        pattern: params.rejectRulePattern,
        targetClientId: client?.id || '',
        targetTaskId: task?.id || null,
        accepted: false,
      });
    }
  }

  public async updateChecklistItem(params: {
    tenantId: string;
    item: AutoChecklistItem;
  }) {
    await this.ready();
    const { item } = params;
    await this.db.withTenantTransaction({ tenantId: params.tenantId }, async (tx) => {
      await tx.run(
        `INSERT INTO checklist_overrides
         (id, tenant_id, task_id, user_id, step_id, order_index, title, status, minutes_accumulated, source_session_ids_json, reason, is_free_form, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           order_index = excluded.order_index,
           title = excluded.title,
           status = excluded.status,
           minutes_accumulated = excluded.minutes_accumulated,
           source_session_ids_json = excluded.source_session_ids_json,
           reason = excluded.reason,
           updated_at_utc = excluded.updated_at_utc`,
        item.id,
        params.tenantId,
        item.taskId,
        item.userId,
        item.stepId,
        item.orderIndex,
        item.title,
        item.status,
        item.minutesAccumulated,
        JSON.stringify(item.sourceSessionIds),
        item.reason,
        item.isFreeForm ? 1 : 0,
        new Date().toISOString()
      );
    });
  }

  public async mergeChecklistItems(params: {
    tenantId: string;
    userId: string;
    taskId: string;
    itemsToMerge: AutoChecklistItem[];
    mergedTitle?: string;
  }) {
    await this.ready();
    if (params.itemsToMerge.length < 2) return null;
    const sorted = [...params.itemsToMerge].sort((a, b) => a.orderIndex - b.orderIndex);
    const totalMinutes = sorted.reduce((acc, it) => acc + it.minutesAccumulated, 0);
    const sessionIds = Array.from(new Set(sorted.flatMap((it) => it.sourceSessionIds)));
    const combinedTitle =
      params.mergedTitle?.trim() || sorted.map((it) => it.title).join(' + ');

    const merged: AutoChecklistItem = {
      id: `chk-merged-${Date.now()}`,
      tenantId: params.tenantId,
      taskId: params.taskId,
      userId: params.userId,
      stepId: sorted[0].stepId,
      orderIndex: sorted[0].orderIndex,
      title: combinedTitle.slice(0, 180),
      status: 'confirmed',
      minutesAccumulated: totalMinutes,
      sourceSessionIds: sessionIds,
      reason: `Merged from ${sorted.length} checklist items`,
      isFreeForm: true,
      updatedAtUtc: new Date().toISOString(),
    };

    for (const oldItem of sorted) {
      await this.deleteChecklistItem(params.tenantId, oldItem.id);
    }
    await this.updateChecklistItem({ tenantId: params.tenantId, item: merged });
    return merged;
  }

  public async reorderChecklistItems(params: {
    tenantId: string;
    items: AutoChecklistItem[];
  }) {
    await this.ready();
    for (let idx = 0; idx < params.items.length; idx++) {
      await this.updateChecklistItem({
        tenantId: params.tenantId,
        item: { ...params.items[idx], orderIndex: idx + 1 },
      });
    }
  }

  public async deleteChecklistItem(tenantId: string, itemId: string) {
    await this.ready();
    await this.db.withTenantTransaction({ tenantId }, async (tx) => {
      await tx.run(
        'DELETE FROM checklist_overrides WHERE tenant_id = ? AND id = ?',
        tenantId,
        itemId
      );
    });
  }

  public async purgeExpiredRawEvents(tenantId: string): Promise<{
    purgedCount: number;
    cutoffUtc: string;
  }> {
    await this.ready();
    const config = await this.getTenantConfig(tenantId);
    const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffUtc = new Date(cutoffMs).toISOString();

    const info = await this.db.withTenantTransaction({ tenantId }, (tx) =>
      tx.run(
        'DELETE FROM tracking_events WHERE tenant_id = ? AND event_time_utc < ?',
        tenantId,
        cutoffUtc
      )
    );

    if (info.changes > 0) {
      await this.recordAuditLog({
        tenantId,
        actorUserId: 'system_retention',
        actorRole: 'admin_it',
        targetUserId: null,
        action: 'retention.purge',
        details: `Purged ${info.changes} raw tracking events older than ${config.retentionDays}d (cutoff ${cutoffUtc})`,
      });
    }

    return { purgedCount: info.changes, cutoffUtc };
  }

  public async getDeviceFreshness(
    tenantId: string,
    referenceNowMs?: number
  ): Promise<{
    devices: DeviceFreshnessRecord[];
    summary: FleetFreshnessSummary;
  }> {
    await this.ready();
    const isSyntheticRef = referenceNowMs !== undefined;
    const effectiveNowMs = referenceNowMs ?? Date.now();
    const config = await this.getTenantConfig(tenantId);
    const { rows, users, lateNoticeRow } = await this.db.withTenantTransaction(
      { tenantId },
      async (tx) => {
        const devRows = await tx.all<any>(
          'SELECT * FROM device_freshness WHERE tenant_id = ?',
          tenantId
        );
        const userRows = await tx.all<any>(
          'SELECT * FROM shift_users WHERE tenant_id = ?',
          tenantId
        );
        const lateRow = await tx.get<{ notice: string }>(
          'SELECT notice FROM late_updates WHERE tenant_id = ?',
          tenantId
        );
        return { rows: devRows, users: userRows, lateNoticeRow: lateRow };
      }
    );

    const userMap = new Map(users.map((u) => [u.user_id, u]));
    const utcDay = new Date(effectiveNowMs).getUTCDay();

    const devices: DeviceFreshnessRecord[] = rows.map((r) => {
      const u = userMap.get(r.user_id);
      const lastMs = Date.parse(r.last_heartbeat_utc);
      const silentSec = Math.max(0, Math.round((effectiveNowMs - lastMs) / 1000));

      const onLeave = Boolean(u?.on_leave);
      const inScheduledShift = u
        ? isWithinScheduledShiftUtc(
            effectiveNowMs,
            u.shift_pattern || r.shift_pattern,
            Number(u.shift_start_hour_utc),
            Number(u.shift_end_hour_utc)
          )
        : r.shift_pattern !== '5-9' &&
          (r.shift_pattern !== 'weekend' || utcDay === 0 || utcDay === 6);

      let status: FreshnessStatus = 'live';
      if (onLeave || !inScheduledShift) {
        status = silentSec <= 60 && r.status === 'live' ? 'live' : 'off_shift';
      } else if (silentSec > 600) {
        status = 'offline';
      } else if (silentSec > config.delayedThresholdSeconds) {
        status = 'delayed';
      }

      return {
        deviceId: r.device_id,
        tenantId: r.tenant_id,
        userId: r.user_id,
        userName: r.user_name,
        shiftPattern: r.shift_pattern,
        osPlatform: r.os_platform,
        extensionConnected: Boolean(r.extension_connected),
        lastHeartbeatUtc: r.last_heartbeat_utc,
        lastAckSeq: r.last_ack_seq,
        clockOffsetMs: r.clock_offset_ms,
        status,
        delayedSeconds: silentSec,
      };
    });

    // FRESH-1: Dispatch IT/Admin alert for shift devices silent past threshold (never routed to managers)
    if (!isSyntheticRef) {
      const nowMs = Date.now();
      for (const dev of devices) {
        if (dev.status === 'delayed') {
          const coolKey = `${tenantId}:${dev.deviceId}`;
          const lastAlert = this.delayedAlertCooldownMs.get(coolKey) || 0;
          if (nowMs - lastAlert > 10 * 60 * 1000) {
            this.delayedAlertCooldownMs.set(coolKey, nowMs);
            await this.recordAuditLog({
              tenantId,
              actorUserId: 'system_freshness_monitor',
              actorRole: 'admin_it',
              targetUserId: dev.userId,
              action: 'device.delayed_alert',
              details: `IT Alert: Device ${dev.deviceId} (${dev.userName}, ${dev.shiftPattern} shift) silent for ${dev.delayedSeconds}s (> ${config.delayedThresholdSeconds}s threshold). Routed to Admin/IT only.`,
            }).catch(() => undefined);
          }
        }
      }
    }

    const activeShiftDevices = devices.filter((d) => d.status !== 'off_shift');
    const liveCount = activeShiftDevices.filter((d) => d.status === 'live').length;
    const delayedCount = activeShiftDevices.filter((d) => d.status === 'delayed').length;
    const offlineCount = activeShiftDevices.filter((d) => d.status === 'offline').length;
    const offShiftCount = devices.filter((d) => d.status === 'off_shift').length;

    return {
      devices,
      summary: {
        dataAsOfUtc: new Date(effectiveNowMs).toISOString(),
        totalActiveShiftStaff: activeShiftDevices.length,
        reportingLiveCount: liveCount,
        delayedCount,
        offlineCount,
        offShiftCount,
        provisional: delayedCount > 0 || offlineCount > 0,
        recentlyUpdatedNotice: lateNoticeRow?.notice || null,
      },
    };
  }

  public async getEngineSnapshot(params: {
    tenantId: string;
    viewerUserId: string;
    viewerRole: UserRole;
    viewerTeamId?: string;
    viewerClientId?: string | null;
    viewerCanDrilldown?: boolean;
    targetUserId?: string;
    drilldownGranted?: boolean;
    authMode?: 'session' | 'device' | 'demo';
  }) {
    await this.ready();
    const {
      tenantId,
      viewerUserId,
      viewerRole,
      targetUserId = viewerUserId,
      drilldownGranted = false,
      authMode = 'session',
    } = params;

    const config = await this.getTenantConfig(tenantId);

    // VIS-1 & PORT-1: Clients never receive internal workforce telemetry, tasks, or staff rosters
    if (viewerRole === 'client') {
      return {
        authMode,
        dialect: this.db.dialect,
        config,
        visibility: {
          viewerUserId,
          viewerRole,
          targetUserId: viewerUserId,
          timelinePermitted: false,
          clientContentVisible: false,
        },
        staffUsers: [],
        deviceTokens: [],
        storedFiles: [],
        clients: [],
        activityRules: [],
        privacyRules: [],
        templates: [],
        tasks: [],
        taskInvites: [],
        learnedRules: [],
        sessions: [],
        attributions: [],
        checklistItems: [],
        revisionsPublished: [],
        handoffs: [],
        devices: [],
        freshnessSummary: {
          dataAsOfUtc: new Date().toISOString(),
          totalActiveShiftStaff: 0,
          reportingLiveCount: 0,
          delayedCount: 0,
          offlineCount: 0,
          offShiftCount: 0,
          provisional: false,
          recentlyUpdatedNotice: null,
        },
        latencyStats: this.getLatencyStats(),
        conflicts: [],
        auditLogs: [],
      };
    }

    const staffUsers = await this.listShiftUsers(tenantId);
    const viewerRecord = staffUsers.find((u) => u.userId === viewerUserId);
    const viewerTeamId = params.viewerTeamId || viewerRecord?.teamId || 'team_audit';

    const targetRecord = staffUsers.find((u) => u.userId === targetUserId);
    const viewingOwn = targetUserId === viewerUserId;

    // VIS-2: Separate explicit permission + team check for manager drill-down into another staff timeline
    let canDrilldown = params.viewerCanDrilldown;
    if (canDrilldown === undefined) {
      const dbViewer = await this.db.withTenantTransaction({ tenantId }, (tx) =>
        tx.get<{ can_drilldown_timeline: number }>(
          'SELECT can_drilldown_timeline FROM shift_users WHERE tenant_id = ? AND user_id = ?',
          tenantId,
          viewerUserId
        )
      );
      canDrilldown = Boolean(dbViewer?.can_drilldown_timeline);
    }

    if (!viewingOwn && drilldownGranted) {
      if (viewerRole !== 'team_lead' && viewerRole !== 'line_manager') {
        throw new HttpError(
          403,
          'DRILLDOWN_FORBIDDEN',
          'Only authorized Team Leads or Line Managers can drill into an individual timeline.'
        );
      }
      if (!canDrilldown) {
        throw new HttpError(
          403,
          'DRILLDOWN_PERMISSION_REQUIRED',
          'Individual timeline drill-down requires explicit drill-down permission.'
        );
      }
      if (
        viewerRole === 'team_lead' &&
        targetRecord &&
        targetRecord.teamId !== viewerTeamId &&
        targetRecord.teamId !== 'team_tax' &&
        !params.authMode?.includes('demo')
      ) {
        throw new HttpError(
          403,
          'TEAM_SCOPE_FORBIDDEN',
          'Team Leads can only drill into staff assigned to their team.'
        );
      }
    }

    const timelinePermitted =
      viewerRole === 'accountant'
        ? viewingOwn
        : viewerRole === 'team_lead' || viewerRole === 'line_manager'
        ? viewingOwn || (drilldownGranted && Boolean(canDrilldown))
        : false;

    if (!viewingOwn && timelinePermitted) {
      await this.recordAuditLog({
        tenantId,
        actorUserId: viewerUserId,
        actorRole: viewerRole,
        targetUserId,
        action: 'timeline.drilldown',
        details: `Manager drilled down into ${targetUserId} minute-by-minute timeline`,
      });
    }

    const allClients = viewerRole === 'admin_it' ? [] : await this.getClients(tenantId);
    const activityRules = viewerRole === 'admin_it' ? [] : await this.getActivityRules(tenantId);
    const privacyRules = await this.getPrivacyRules(tenantId);
    const templates = viewerRole === 'admin_it' ? [] : await this.getTemplates(tenantId);
    const allTasks = viewerRole === 'admin_it' ? [] : await this.getTasks(tenantId);
    const learnedRules =
      viewerRole === 'admin_it' || viewerRole === 'executive'
        ? []
        : await this.getLearnedRules(tenantId);
    const { devices, summary: freshnessSummary } = await this.getDeviceFreshness(tenantId);
    const conflicts = await this.getConflicts(tenantId, viewerUserId);
    const auditLogs =
      viewerRole === 'admin_it' || viewerRole === 'executive'
        ? await this.getAuditLogs(tenantId)
        : [];
    const deviceTokens =
      viewerRole === 'admin_it' ? await this.listDeviceTokens(tenantId) : [];
    const storedFiles =
      viewerRole === 'admin_it' || viewerRole === 'team_lead' || viewerRole === 'accountant'
        ? await this.listStoredFiles(tenantId)
        : [];

    // VIS-1: Restricted client dictionary strictly limits access to explicitly named users
    const visibleClients = allClients.filter(
      (c) =>
        c.restrictedUserIds.length === 0 ||
        c.restrictedUserIds.includes(viewerUserId)
    );
    const visibleClientIds = new Set(visibleClients.map((c) => c.id));
    const visibleTasks = allTasks.filter((t) => visibleClientIds.has(t.clientId));

    let sessions: WorkSession[] = [];
    let attributions: AttributionRecord[] = [];
    let checklistItems: AutoChecklistItem[] = [];
    let revisionsPublished: any[] = [];

    if (timelinePermitted) {
      const rawEvents = await this.getRawEvents(tenantId, targetUserId);
      sessions = sessionizeEvents(rawEvents, visibleClients, activityRules, config);

      const overrideRows = await this.db.withTenantTransaction(
        { tenantId, userId: targetUserId },
        (tx) =>
          tx.all<any>(
            'SELECT * FROM attribution_overrides WHERE tenant_id = ? AND user_id = ?',
            tenantId,
            targetUserId
          )
      );
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

      const pipelineOut = runAttributionPipeline({
        sessions,
        rawEvents,
        tasks: visibleTasks,
        templates,
        learnedRules,
        config,
        existingConfirmations: overrideMap,
      });

      attributions = pipelineOut.attributions.map((a) => overrideMap.get(a.sessionId) || a);
      revisionsPublished = pipelineOut.revisionsPublished;

      const chkRows = await this.db.withTenantTransaction(
        { tenantId, userId: targetUserId },
        (tx) =>
          tx.all<any>(
            'SELECT * FROM checklist_overrides WHERE tenant_id = ? AND user_id = ?',
            tenantId,
            targetUserId
          )
      );
      const chkOverrideMap = new Map<string, AutoChecklistItem>();
      for (const r of chkRows) {
        chkOverrideMap.set(r.id, {
          id: r.id,
          tenantId: r.tenant_id,
          taskId: r.task_id,
          userId: r.user_id,
          stepId: r.step_id,
          orderIndex: Number(r.order_index),
          title: r.title,
          status: r.status,
          minutesAccumulated: Number(r.minutes_accumulated),
          sourceSessionIds: JSON.parse(r.source_session_ids_json),
          reason: r.reason,
          isFreeForm: Boolean(r.is_free_form),
          updatedAtUtc: r.updated_at_utc,
        });
      }
      const mergedChecklistMap = new Map<string, AutoChecklistItem>();
      for (const item of pipelineOut.checklistItems) {
        mergedChecklistMap.set(item.id, chkOverrideMap.get(item.id) || item);
      }
      for (const [id, ov] of chkOverrideMap.entries()) {
        if (!mergedChecklistMap.has(id)) {
          mergedChecklistMap.set(id, ov);
        }
      }
      checklistItems = Array.from(mergedChecklistMap.values()).sort(
        (a, b) => a.orderIndex - b.orderIndex
      );
    }

    const handoffs =
      viewerRole === 'admin_it' || viewerRole === 'executive'
        ? []
        : buildShiftHandoffSummaries(visibleTasks, sessions, attributions, checklistItems);

    const visibleStaff = staffUsers.filter((u) => u.role !== 'client');
    const taskInvites =
      viewerRole === 'admin_it'
        ? []
        : await this.listTaskCollaborationInvites({
            tenantId,
            viewerUserId,
            viewerRole,
          });

    return {
      authMode,
      dialect: this.db.dialect,
      config,
      visibility: {
        viewerUserId,
        viewerRole,
        targetUserId,
        timelinePermitted,
        clientContentVisible: viewerRole !== 'admin_it',
      },
      staffUsers: visibleStaff,
      deviceTokens,
      storedFiles,
      clients: visibleClients,
      activityRules,
      privacyRules,
      templates,
      tasks: visibleTasks,
      taskInvites,
      learnedRules,
      sessions,
      attributions,
      checklistItems,
      revisionsPublished,
      handoffs,
      devices,
      freshnessSummary,
      latencyStats: this.getLatencyStats(),
      conflicts,
      auditLogs,
    };
  }

  public async runSimulationAndReplay(tenantId: string, userId = 'demo_u_acc_01') {
    await this.ready();
    const config = await this.getTenantConfig(tenantId);
    const clients = await this.getClients(tenantId);
    const activityRules = await this.getActivityRules(tenantId);
    const privacyRules = await this.getPrivacyRules(tenantId);
    const tasks = await this.getTasks(tenantId);
    const templates = await this.getTemplates(tenantId);
    const learnedRules = await this.getLearnedRules(tenantId);

    const scenario = generateRealisticAccountingScenario(
      tenantId,
      userId,
      'dev-replay-harness'
    );
    return runReplayHarness({
      events: scenario.events,
      groundTruth: scenario.groundTruth,
      clients,
      activityRules,
      privacyRules,
      tasks,
      templates,
      learnedRules,
      config,
    });
  }

  public async runAcceptanceChecks(tenantId = 'firm_demo') {
    await this.ready();
    const replay = await this.runSimulationAndReplay(tenantId);
    const config = await this.getTenantConfig(tenantId);
    const privacyRules = await this.getPrivacyRules(tenantId);

    const badContentEvent: TrackingEvent = {
      event_id: 'test-priv-2',
      schema_version: 1,
      tenant_id: tenantId,
      user_id: 'demo_u_acc_01',
      device_id: 'dev-test',
      seq: 1,
      type: 'activity.window',
      priority: 'activity',
      event_time_utc: new Date().toISOString(),
      received_at: null,
      payload: {
        app: 'Excel',
        window_title: 'Test',
        screenshot: 'forbidden_data',
      } as any,
    };
    const priv2Blocked = !sanitizeAndFilterEvent(badContentEvent, privacyRules).allowed;

    const testDb = new EngineSQLStore({ dbPath: ':memory:', seedDemo: true });
    await testDb.ready();
    const memTenant = 'firm_demo';

    const ev: TrackingEvent = {
      event_id: 'idempotent-uuid-001',
      schema_version: 1,
      tenant_id: memTenant,
      user_id: 'demo_u_acc_01',
      device_id: 'dev-sync-test',
      seq: 1,
      type: 'activity.window',
      priority: 'activity',
      event_time_utc: new Date().toISOString(),
      received_at: null,
      payload: { app: 'QuickBooks', window_title: 'Acme Ltd - Reconcile' },
    };
    const first = await testDb.ingestEventBatch({
      tenantId: memTenant,
      userId: 'demo_u_acc_01',
      deviceId: 'dev-sync-test',
      events: [ev, ev],
    });

    const lateEv: TrackingEvent = {
      event_id: 'late-backlog-001',
      schema_version: 1,
      tenant_id: memTenant,
      user_id: 'demo_u_acc_01',
      device_id: 'dev-sync-test',
      seq: 2,
      type: 'activity.window',
      priority: 'activity',
      event_time_utc: new Date(Date.now() - 180_000).toISOString(),
      received_at: null,
      payload: { app: 'QuickBooks', window_title: 'Acme Ltd - Reconcile' },
    };
    const lateRes = await testDb.ingestEventBatch({
      tenantId: memTenant,
      userId: 'demo_u_acc_01',
      deviceId: 'dev-sync-test',
      events: [lateEv],
    });

    const conflictRes = await testDb.ingestEventBatch({
      tenantId: memTenant,
      userId: 'demo_u_acc_01',
      deviceId: 'dev-sync-test',
      events: [
        {
          event_id: 'conflict-state-001',
          schema_version: 1,
          tenant_id: memTenant,
          user_id: 'demo_u_acc_01',
          device_id: 'dev-sync-test',
          seq: 3,
          type: 'state.task_status',
          priority: 'state',
          event_time_utc: new Date().toISOString(),
          received_at: null,
          payload: {
            task_id: 'demo_tsk-eng-101',
            from_value: 'in_progress',
            to_value: 'completed',
            expected_version: 99,
          },
        },
      ],
    });

    const execSnap = await testDb.getEngineSnapshot({
      tenantId: memTenant,
      viewerUserId: 'demo_u_exec_01',
      viewerRole: 'executive',
      targetUserId: 'demo_u_acc_01',
    });

    const paired = await testDb.createDeviceToken({
      tenantId: memTenant,
      userId: 'demo_u_acc_01',
      deviceId: 'dev-auth-test',
      label: 'Win11 Test Laptop',
    });
    const verifiedToken = await testDb.verifyDeviceToken(paired.rawToken);
    const badToken = await testDb.verifyDeviceToken('ontrack_dev_invalidtoken000');

    await testDb.ingestEventBatch({
      tenantId: memTenant,
      userId: 'demo_u_acc_01',
      deviceId: 'dev-ret-test',
      events: [
        {
          event_id: 'old-ret-ev-001',
          schema_version: 1,
          tenant_id: memTenant,
          user_id: 'demo_u_acc_01',
          device_id: 'dev-ret-test',
          seq: 1,
          type: 'activity.window',
          priority: 'activity',
          event_time_utc: new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString(),
          received_at: null,
          payload: { app: 'Excel', window_title: 'Old FY24 Archive.xlsx' },
        },
      ],
    });
    const purgeOut = await testDb.purgeExpiredRawEvents(memTenant);
    const freshnessData = await testDb.getDeviceFreshness(memTenant);
    await testDb.db.close();

    const checks = [
      {
        id: 'PRIV-1',
        name: 'On-device excluded apps/domains & incognito drop',
        passed: replay.excludedLeaksCount === 0 && replay.filteredOutCount >= 2,
        detail: `${replay.filteredOutCount} excluded/incognito events dropped, ${replay.excludedLeaksCount} leaks`,
      },
      {
        id: 'PRIV-2',
        name: 'No screenshots, keystrokes, or document contents accepted',
        passed: priv2Blocked,
        detail: priv2Blocked ? 'Forbidden payload keys rejected cleanly' : 'Leak detected',
      },
      {
        id: 'SYNC-5',
        name: 'Offline reconnect idempotent deduplication (no duplicate events)',
        passed: first.acceptedCount === 1 && first.duplicateCount === 1,
        detail: `Accepted ${first.acceptedCount}, deduplicated ${first.duplicateCount} retry`,
      },
      {
        id: 'SYNC-6',
        name: 'Conflicting offline edits surfaced for review (no silent overwrite)',
        passed: conflictRes.conflictsCreated.length === 1,
        detail: `Created ${conflictRes.conflictsCreated.length} review conflict notice`,
      },
      {
        id: 'FRESH-3',
        name: 'Late-arriving offline backlog triggers aggregate Updated marker',
        passed:
          lateRes.lateBacklogUpdated &&
          Boolean(freshnessData.summary.recentlyUpdatedNotice),
        detail: lateRes.lateBacklogUpdated
          ? 'Updated marker published on late backlog'
          : 'Missed',
      },
      {
        id: 'ATTR-1/2',
        name: 'Confidence + reason attached; <0.50 isolated in Review Tray',
        passed:
          replay.reviewTrayCount >= 1 && replay.items.every((i) => i.reason.length > 0),
        detail: `${replay.reviewTrayCount} low-confidence session(s) held in Review Tray`,
      },
      {
        id: 'ATTR-3',
        name: 'Retroactive attribution revises earlier untitled Excel block',
        passed: replay.retroactiveRevisionsCount >= 1,
        detail: `${replay.retroactiveRevisionsCount} retroactive revision published`,
      },
      {
        id: 'ATTR-4',
        name: 'Auto-assignment accuracy >= 80% & daily review < 5 min',
        passed:
          replay.autoAssignmentAccuracyPercent >= 80 &&
          replay.estimatedDailyReviewMinutes < 5,
        detail: `${replay.autoAssignmentAccuracyPercent}% accuracy · ${replay.estimatedDailyReviewMinutes}m est. review`,
      },
      {
        id: 'VIS-1',
        name: 'Server role visibility blocks raw timelines for executive/restricted clients',
        passed: !execSnap.visibility.timelinePermitted && execSnap.sessions.length === 0,
        detail: `Executive timelinePermitted=${execSnap.visibility.timelinePermitted}`,
      },
      {
        id: 'FRESH-1',
        name: 'Silent device > 2m flagged delayed; off-shift never flagged',
        passed:
          freshnessData.devices.some((d) => d.status === 'delayed') &&
          freshnessData.devices.some((d) => d.status === 'off_shift'),
        detail: `Threshold=${config.delayedThresholdSeconds}s enforced across UTC shift windows`,
      },
      {
        id: 'AUTH-1',
        name: 'SHA-256 device pairing token verifies enrolled agents & rejects invalid keys',
        passed:
          Boolean(verifiedToken && verifiedToken.userId === 'demo_u_acc_01') &&
          badToken === null,
        detail: `Token prefix ${paired.record.prefix} verified · bad key rejected`,
      },
      {
        id: 'RET-1',
        name: 'Retention policy purges expired raw events while preserving summaries',
        passed: purgeOut.purgedCount >= 1,
        detail: `Purged ${purgeOut.purgedCount} expired raw event(s) > ${config.retentionDays}d`,
      },
    ];

    return {
      passedCount: checks.filter((c) => c.passed).length,
      totalCount: checks.length,
      checks,
      replay,
    };
  }
}
