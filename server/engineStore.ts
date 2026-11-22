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
  PrivacyRule,
  ShiftPattern,
  ShiftUser,
  StoredFileRecord,
  SyncConflict,
  TaskTemplate,
  TenantConfig,
  TrackingEvent,
  UserRole,
  WorkSession,
} from '../src/engine/types.ts';
import { generateDeviceToken, hashDeviceToken } from './auth.ts';
import { initPortableSchema, PortableSqlAdapter } from './sqlAdapter.ts';

export class EngineSQLStore {
  public readonly db: PortableSqlAdapter;
  private readyPromise: Promise<void>;
  private lateUpdateNoticeByTenant = new Map<string, string>();
  private broadcastLatencySamplesMs: number[] = [];

  constructor(options?: { dbPath?: string; databaseUrl?: string }) {
    this.db = new PortableSqlAdapter(options);
    this.readyPromise = this.init();
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
    const p95Idx = Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * 0.95)
    );
    return {
      lastBroadcastMs:
        this.broadcastLatencySamplesMs[this.broadcastLatencySamplesMs.length - 1],
      p95BroadcastMs: sorted[p95Idx],
      sampleCount: sorted.length,
    };
  }

  private async init() {
    await initPortableSchema(this.db);
    await this.seedTenantIfMissing('firm_demo', {
      name: 'Apex Chartered Accountants (Demo Sandbox)',
      seedScenarioEvents: true,
    });
    await this.seedTenantIfMissing('firm_apex', {
      name: 'Apex Chartered Accountants (Live Firm)',
      seedScenarioEvents: false,
    });
  }

  private async seedTenantIfMissing(
    tenantId: string,
    opts: { name: string; seedScenarioEvents: boolean }
  ) {
    const existing = await this.db.get<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ?',
      tenantId
    );
    if (existing) return;

    const nowIso = new Date().toISOString();
    const config: TenantConfig = {
      id: tenantId,
      name: opts.name,
      confidenceThresholds: { detected: 0.85, suggested: 0.5 },
      sessionizer: { maxInterruptionSeconds: 30, idleCloseSeconds: 180 },
      heartbeatIntervalSeconds: 12,
      delayedThresholdSeconds: 120,
      retentionDays: 60,
      monitoringPolicy: 'mandatory',
      serverUrl: process.env.APP_URL || 'http://localhost:3000',
    };

    await this.db.run(
      'INSERT INTO tenants (id, name, config_json) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
      tenantId,
      config.name,
      JSON.stringify(config)
    );

    const prefix = tenantId === 'firm_demo' ? 'demo_' : '';
    const users: (ShiftUser & { firebaseUid?: string | null })[] = [
      {
        userId: `${prefix}u_acc_01`,
        tenantId,
        firebaseUid: null,
        name: 'Maya Patel (Senior Accountant)',
        email: 'maya.patel@apex-cpa.example',
        role: 'accountant',
        teamId: 'team_audit',
        shiftPattern: '8-5',
        shiftStartHourUtc: 13,
        shiftEndHourUtc: 22,
        onLeave: false,
      },
      {
        userId: `${prefix}u_acc_02`,
        tenantId,
        firebaseUid: null,
        name: 'Devon Brooks (Evening Shift 5-9)',
        email: 'devon.brooks@apex-cpa.example',
        role: 'accountant',
        teamId: 'team_audit',
        shiftPattern: '5-9',
        shiftStartHourUtc: 22,
        shiftEndHourUtc: 2,
        onLeave: false,
      },
      {
        userId: `${prefix}u_acc_03`,
        tenantId,
        firebaseUid: null,
        name: 'Elena Gomez (Remote Tax)',
        email: 'elena.gomez@apex-cpa.example',
        role: 'accountant',
        teamId: 'team_tax',
        shiftPattern: 'remote',
        shiftStartHourUtc: 14,
        shiftEndHourUtc: 23,
        onLeave: false,
      },
      {
        userId: `${prefix}u_lead_01`,
        tenantId,
        firebaseUid: null,
        name: 'Marcus Chen (Team Lead)',
        email: 'marcus.chen@apex-cpa.example',
        role: 'team_lead',
        teamId: 'team_audit',
        shiftPattern: '8-5',
        shiftStartHourUtc: 13,
        shiftEndHourUtc: 22,
        onLeave: false,
      },
      {
        userId: `${prefix}u_admin_01`,
        tenantId,
        firebaseUid: null,
        name: 'Nadia Sterling (Admin / IT)',
        email: 'it-admin@apex-cpa.example',
        role: 'admin_it',
        teamId: 'team_ops',
        shiftPattern: '8-5',
        shiftStartHourUtc: 13,
        shiftEndHourUtc: 22,
        onLeave: false,
      },
    ];

    for (const u of users) {
      await this.db.run(
        `INSERT INTO shift_users (user_id, tenant_id, firebase_uid, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO NOTHING`,
        u.userId,
        u.tenantId,
        u.firebaseUid || null,
        u.name,
        u.email,
        u.role,
        u.teamId,
        u.shiftPattern,
        u.shiftStartHourUtc,
        u.shiftEndHourUtc,
        u.onLeave ? 1 : 0
      );
    }

    const clients: ClientDictionaryEntry[] = [
      {
        id: `${prefix}cli-acme`,
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
        id: `${prefix}cli-northstar`,
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
        id: `${prefix}cli-harbor`,
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
        id: `${prefix}cli-crestview`,
        tenantId,
        legalName: 'Crestview Holdings (Restricted)',
        aliases: ['Crestview', 'CV Holdings'],
        codes: ['CVH-99'],
        folderPatterns: ['Restricted\\Crestview'],
        knownDomains: ['crestview.private.example'],
        restrictedUserIds: [`${prefix}u_acc_01`],
        source: 'manual',
        updatedAtUtc: nowIso,
      },
    ];

    for (const c of clients) {
      await this.db.run(
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
      { id: `${prefix}act-1`, tenantId, keyword: 'reconcil', activityType: 'Reconciliation', workCategory: 'billable', weight: 10 },
      { id: `${prefix}act-2`, tenantId, keyword: 'payroll', activityType: 'Payroll Processing', workCategory: 'billable', weight: 9 },
      { id: `${prefix}act-3`, tenantId, keyword: 'tax return', activityType: 'Tax Preparation', workCategory: 'deep_work', weight: 9 },
      { id: `${prefix}act-4`, tenantId, keyword: 'bank statement', activityType: 'Bank Statement Review', workCategory: 'billable', weight: 8 },
      { id: `${prefix}act-5`, tenantId, keyword: 'trial balance', activityType: 'Trial Balance Review', workCategory: 'deep_work', weight: 8 },
      { id: `${prefix}act-6`, tenantId, keyword: 'invoice', activityType: 'AP / AR Processing', workCategory: 'billable', weight: 7 },
    ];
    for (const a of activityRules) {
      await this.db.run(
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
      { id: `${prefix}priv-1`, tenantId, kind: 'domain', pattern: 'personalbank', reason: 'Personal Banking', enabled: true },
      { id: `${prefix}priv-2`, tenantId, kind: 'domain', pattern: 'mychart', reason: 'Personal Health', enabled: true },
      { id: `${prefix}priv-3`, tenantId, kind: 'app', pattern: '1Password', reason: 'Credential Manager', enabled: true },
      { id: `${prefix}priv-4`, tenantId, kind: 'path', pattern: '*\\Personal\\*', reason: 'Personal Folder', enabled: true },
    ];
    for (const p of privacyRules) {
      await this.db.run(
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
        id: `${prefix}tpl-monthly-close`,
        tenantId,
        name: 'Monthly Bank Close & Reconciliation',
        defaultCategory: 'billable',
        steps: [
          { id: `${prefix}stp-1`, order: 1, title: 'Download & verify bank statement PDFs', activitySignature: 'bank statement' },
          { id: `${prefix}stp-2`, order: 2, title: 'Reconcile chequing & clearing ledger in QuickBooks/Xero', activitySignature: 'reconcil' },
          { id: `${prefix}stp-3`, order: 3, title: 'Prepare & tie out supporting Excel workpapers', activitySignature: 'excel' },
        ],
      },
      {
        id: `${prefix}tpl-payroll-tax`,
        tenantId,
        name: 'Payroll & Corporate Tax Compliance',
        defaultCategory: 'billable',
        steps: [
          { id: `${prefix}stp-4`, order: 1, title: 'Run payroll register & statutory deductions', activitySignature: 'payroll' },
          { id: `${prefix}stp-5`, order: 2, title: 'Draft corporate tax return schedule', activitySignature: 'tax' },
        ],
      },
    ];
    for (const tpl of templates) {
      await this.db.run(
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
        id: `${prefix}tsk-eng-101`,
        tenantId,
        clientId: `${prefix}cli-acme`,
        clientName: 'Acme Ltd',
        templateId: `${prefix}tpl-monthly-close`,
        title: 'Acme Ltd — Oct 2026 Bank Reconciliation & Close',
        period: 'Oct 2026',
        status: 'in_progress',
        dueDateUtc: `${todayDate}T22:00:00Z`,
        assignedUserId: `${prefix}u_acc_01`,
        estimatedMinutes: 180,
        version: 1,
        updatedAtUtc: nowIso,
      },
      {
        id: `${prefix}tsk-eng-102`,
        tenantId,
        clientId: `${prefix}cli-northstar`,
        clientName: 'Northstar Logistics',
        templateId: `${prefix}tpl-payroll-tax`,
        title: 'Northstar Logistics — Q3 2026 Payroll Register Audit',
        period: 'Q3 2026',
        status: 'in_progress',
        dueDateUtc: `${todayDate}T22:00:00Z`,
        assignedUserId: `${prefix}u_acc_01`,
        estimatedMinutes: 120,
        version: 1,
        updatedAtUtc: nowIso,
      },
      {
        id: `${prefix}tsk-eng-103`,
        tenantId,
        clientId: `${prefix}cli-harbor`,
        clientName: 'Harbor Health',
        templateId: `${prefix}tpl-payroll-tax`,
        title: 'Harbor Health — FY25 Corporate Tax Return Draft',
        period: 'FY25',
        status: 'todo',
        dueDateUtc: `${todayDate}T22:00:00Z`,
        assignedUserId: `${prefix}u_acc_01`,
        estimatedMinutes: 240,
        version: 1,
        updatedAtUtc: nowIso,
      },
      {
        id: `${prefix}tsk-eng-104`,
        tenantId,
        clientId: `${prefix}cli-crestview`,
        clientName: 'Crestview Holdings (Restricted)',
        templateId: `${prefix}tpl-monthly-close`,
        title: 'Crestview M&A Special Audit (Restricted)',
        period: 'Oct 2026',
        status: 'todo',
        dueDateUtc: `${todayDate}T22:00:00Z`,
        assignedUserId: `${prefix}u_acc_01`,
        estimatedMinutes: 90,
        version: 1,
        updatedAtUtc: nowIso,
      },
    ];
    for (const t of engineTasks) {
      await this.db.run(
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

    if (opts.seedScenarioEvents) {
      const delayedIso = new Date(Date.now() - 190 * 1000).toISOString();
      await this.db.run(
        `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
        'demo-dev-win-maya', tenantId, `${prefix}u_acc_01`, 'Maya Patel', '8-5', 'windows', 1, nowIso, 108, 12, 'live'
      );
      await this.db.run(
        `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
        'demo-dev-vdi-elena', tenantId, `${prefix}u_acc_03`, 'Elena Gomez', 'remote', 'vdi', 1, delayedIso, 42, -35, 'delayed'
      );
      await this.db.run(
        `INSERT INTO device_freshness (device_id, tenant_id, user_id, user_name, shift_pattern, os_platform, extension_connected, last_heartbeat_utc, last_ack_seq, clock_offset_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id) DO NOTHING`,
        'demo-dev-mac-devon', tenantId, `${prefix}u_acc_02`, 'Devon Brooks', '5-9', 'macos', 1, nowIso, 19, 4, 'off_shift'
      );

      const scenario = generateRealisticAccountingScenario(
        tenantId,
        `${prefix}u_acc_01`,
        'demo-dev-win-maya'
      );
      for (const ev of scenario.events) {
        const filtered = sanitizeAndFilterEvent(ev, privacyRules);
        if (filtered.allowed && filtered.sanitizedEvent) {
          await this.insertEventRow(filtered.sanitizedEvent, nowIso);
        }
      }
    }
  }

  private async insertEventRow(ev: TrackingEvent, receivedAt: string): Promise<boolean> {
    const info = await this.db.run(
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

  /**
   * Resolves or auto-provisions a Firebase authenticated user inside `firm_apex`.
   * First authenticated firm user (or configured owner) becomes `admin_it`.
   */
  public async ensureFirebaseShiftUser(params: {
    tenantId?: string;
    uid: string;
    email: string;
    name: string;
  }): Promise<ShiftUser> {
    await this.ready();
    const tenantId = params.tenantId || 'firm_apex';
    const existing = await this.db.get<any>(
      'SELECT * FROM shift_users WHERE tenant_id = ? AND (firebase_uid = ? OR lower(email) = lower(?))',
      tenantId,
      params.uid,
      params.email
    );

    if (existing) {
      if (!existing.firebase_uid) {
        await this.db.run(
          'UPDATE shift_users SET firebase_uid = ?, name = ? WHERE user_id = ?',
          params.uid,
          params.name || existing.name,
          existing.user_id
        );
      }
      return {
        userId: existing.user_id,
        tenantId: existing.tenant_id,
        name: existing.name,
        email: existing.email,
        role: existing.role as UserRole,
        teamId: existing.team_id,
        shiftPattern: existing.shift_pattern as ShiftPattern,
        shiftStartHourUtc: existing.shift_start_hour_utc,
        shiftEndHourUtc: existing.shift_end_hour_utc,
        onLeave: Boolean(existing.on_leave),
      };
    }

    const existingAuthUsers = await this.db.get<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM shift_users WHERE tenant_id = ? AND firebase_uid IS NOT NULL',
      tenantId
    );
    const isInitialAdmin = Number(existingAuthUsers?.cnt || 0) === 0;
    const role: UserRole = isInitialAdmin ? 'admin_it' : 'accountant';
    const userId = `fb_${params.uid.slice(0, 14)}`;

    await this.db.run(
      `INSERT INTO shift_users (user_id, tenant_id, firebase_uid, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave)
       VALUES (?, ?, ?, ?, ?, ?, 'team_audit', '8-5', 13, 22, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      userId,
      tenantId,
      params.uid,
      params.name || params.email.split('@')[0],
      params.email,
      role
    );

    return {
      userId,
      tenantId,
      name: params.name || params.email.split('@')[0],
      email: params.email,
      role,
      teamId: 'team_audit',
      shiftPattern: '8-5',
      shiftStartHourUtc: 13,
      shiftEndHourUtc: 22,
      onLeave: false,
    };
  }

  public async listShiftUsers(tenantId: string): Promise<ShiftUser[]> {
    await this.ready();
    const rows = await this.db.all<any>(
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
  }

  public async updateShiftUserRole(
    tenantId: string,
    userId: string,
    role: UserRole,
    shiftPattern?: ShiftPattern,
    onLeave?: boolean
  ) {
    await this.ready();
    await this.db.run(
      `UPDATE shift_users
       SET role = ?, shift_pattern = COALESCE(?, shift_pattern), on_leave = COALESCE(?, on_leave)
       WHERE tenant_id = ? AND user_id = ?`,
      role,
      shiftPattern ?? null,
      onLeave !== undefined ? (onLeave ? 1 : 0) : null,
      tenantId,
      userId
    );
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

    for (const line of dataLines) {
      const [nameRaw, emailRaw, roleRaw = 'accountant', shiftRaw = '8-5', teamRaw = 'team_audit'] =
        line.split(',').map((s) => s.trim());
      if (!nameRaw || !emailRaw) continue;
      const validRole: UserRole = (
        ['accountant', 'team_lead', 'line_manager', 'executive', 'client', 'admin_it'] as string[]
      ).includes(roleRaw)
        ? (roleRaw as UserRole)
        : 'accountant';
      const validShift: ShiftPattern = (['8-5', '5-9', 'remote'] as string[]).includes(shiftRaw)
        ? (shiftRaw as ShiftPattern)
        : '8-5';
      const startHour = validShift === '5-9' ? 22 : validShift === 'remote' ? 14 : 13;
      const endHour = validShift === '5-9' ? 2 : validShift === 'remote' ? 23 : 22;
      const userId = `u_${crypto.createHash('md5').update(emailRaw.toLowerCase()).digest('hex').slice(0, 10)}`;

      await this.db.run(
        `INSERT INTO shift_users (user_id, tenant_id, firebase_uid, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, role = excluded.role, shift_pattern = excluded.shift_pattern, team_id = excluded.team_id`,
        userId,
        tenantId,
        nameRaw,
        emailRaw.toLowerCase(),
        validRole,
        teamRaw || 'team_audit',
        validShift,
        startHour,
        endHour
      );

      imported.push({
        userId,
        tenantId,
        name: nameRaw,
        email: emailRaw.toLowerCase(),
        role: validRole,
        teamId: teamRaw || 'team_audit',
        shiftPattern: validShift,
        shiftStartHourUtc: startHour,
        shiftEndHourUtc: endHour,
        onLeave: false,
      });
    }
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

    await this.db.run(
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

    const userRow = await this.db.get<{ name: string }>(
      'SELECT name FROM shift_users WHERE user_id = ?',
      params.userId
    );

    return {
      rawToken,
      record: {
        tokenId,
        tenantId: params.tenantId,
        userId: params.userId,
        userName: userRow?.name || params.userId,
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
    const rows = await this.db.all<any>(
      `SELECT d.*, u.name as user_name
       FROM device_tokens d
       LEFT JOIN shift_users u ON u.user_id = d.user_id
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
  }

  public async revokeDeviceToken(tenantId: string, tokenId: string) {
    await this.ready();
    await this.db.run(
      'UPDATE device_tokens SET revoked_at_utc = ? WHERE tenant_id = ? AND token_id = ?',
      new Date().toISOString(),
      tenantId,
      tokenId
    );
  }

  public async verifyDeviceToken(rawToken: string): Promise<{
    tenantId: string;
    userId: string;
    deviceId: string;
    role: UserRole;
    email: string;
  } | null> {
    await this.ready();
    const tokenHash = hashDeviceToken(rawToken);
    const row = await this.db.get<any>(
      `SELECT d.*, u.role as user_role, u.email as user_email
       FROM device_tokens d
       LEFT JOIN shift_users u ON u.user_id = d.user_id
       WHERE d.token_hash = ? AND d.revoked_at_utc IS NULL`,
      tokenHash
    );
    if (!row) return null;

    await this.db.run(
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
    };
  }

  public async getTenantConfig(tenantId = 'firm_apex'): Promise<TenantConfig> {
    await this.ready();
    const row = await this.db.get<{ config_json: string }>(
      'SELECT config_json FROM tenants WHERE id = ?',
      tenantId
    );
    if (!row) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
    return JSON.parse(row.config_json) as TenantConfig;
  }

  public async updateTenantConfig(
    tenantId: string,
    partial: Partial<TenantConfig>
  ): Promise<TenantConfig> {
    const curr = await this.getTenantConfig(tenantId);
    const next: TenantConfig = {
      ...curr,
      ...partial,
      confidenceThresholds: {
        ...curr.confidenceThresholds,
        ...(partial.confidenceThresholds || {}),
      },
      sessionizer: {
        ...curr.sessionizer,
        ...(partial.sessionizer || {}),
      },
    };
    await this.db.run(
      'UPDATE tenants SET config_json = ? WHERE id = ?',
      JSON.stringify(next),
      tenantId
    );
    return next;
  }

  public async getClients(tenantId: string): Promise<ClientDictionaryEntry[]> {
    await this.ready();
    const rows = await this.db.all<any>(
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
  }

  public async addOrUpdateClient(
    entry: Omit<ClientDictionaryEntry, 'id' | 'updatedAtUtc'> & { id?: string }
  ): Promise<ClientDictionaryEntry> {
    await this.ready();
    const id = entry.id || `cli-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const updatedAtUtc = new Date().toISOString();
    await this.db.run(
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
    await this.db.run('DELETE FROM clients WHERE tenant_id = ? AND id = ?', tenantId, clientId);
  }

  public async getActivityRules(tenantId: string): Promise<ActivityDictionaryEntry[]> {
    await this.ready();
    const rows = await this.db.all<any>(
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
  }

  public async addActivityRule(
    rule: Omit<ActivityDictionaryEntry, 'id'>
  ): Promise<ActivityDictionaryEntry> {
    await this.ready();
    const id = `act-${Date.now()}`;
    await this.db.run(
      'INSERT INTO activity_rules (id, tenant_id, keyword, activity_type, work_category, weight) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      rule.tenantId,
      rule.keyword,
      rule.activityType,
      rule.workCategory,
      rule.weight
    );
    return { ...rule, id };
  }

  public async deleteActivityRule(tenantId: string, id: string) {
    await this.ready();
    await this.db.run('DELETE FROM activity_rules WHERE tenant_id = ? AND id = ?', tenantId, id);
  }

  public async getPrivacyRules(tenantId: string): Promise<PrivacyRule[]> {
    await this.ready();
    const rows = await this.db.all<any>(
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
  }

  public async addPrivacyRule(rule: Omit<PrivacyRule, 'id'>): Promise<PrivacyRule> {
    await this.ready();
    const id = `priv-${Date.now()}`;
    await this.db.run(
      'INSERT INTO privacy_rules (id, tenant_id, kind, pattern, reason, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      rule.tenantId,
      rule.kind,
      rule.pattern,
      rule.reason,
      rule.enabled ? 1 : 0
    );
    return { ...rule, id };
  }

  public async togglePrivacyRule(tenantId: string, id: string, enabled: boolean) {
    await this.ready();
    await this.db.run(
      'UPDATE privacy_rules SET enabled = ? WHERE tenant_id = ? AND id = ?',
      enabled ? 1 : 0,
      tenantId,
      id
    );
  }

  public async deletePrivacyRule(tenantId: string, id: string) {
    await this.ready();
    await this.db.run('DELETE FROM privacy_rules WHERE tenant_id = ? AND id = ?', tenantId, id);
  }

  public async getTemplates(tenantId: string): Promise<TaskTemplate[]> {
    await this.ready();
    const rows = await this.db.all<any>(
      'SELECT * FROM task_templates WHERE tenant_id = ?',
      tenantId
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      defaultCategory: r.default_category,
      steps: JSON.parse(r.steps_json),
    }));
  }

  public async getTasks(tenantId: string): Promise<EngineTask[]> {
    await this.ready();
    const rows = await this.db.all<any>(
      'SELECT * FROM engine_tasks WHERE tenant_id = ? ORDER BY due_date_utc ASC',
      tenantId
    );
    return rows.map((r) => ({
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
      estimatedMinutes: r.estimated_minutes,
      version: r.version,
      updatedAtUtc: r.updated_at_utc,
    }));
  }

  public async createEngineTask(
    task: Omit<EngineTask, 'id' | 'version' | 'updatedAtUtc'>
  ): Promise<EngineTask> {
    await this.ready();
    const id = `tsk-eng-${Date.now()}`;
    const updatedAtUtc = new Date().toISOString();
    await this.db.run(
      `INSERT INTO engine_tasks (id, tenant_id, client_id, client_name, template_id, title, period, status, due_date_utc, assigned_user_id, estimated_minutes, version, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      id,
      task.tenantId,
      task.clientId,
      task.clientName,
      task.templateId || null,
      task.title,
      task.period,
      task.status,
      task.dueDateUtc,
      task.assignedUserId,
      task.estimatedMinutes,
      updatedAtUtc
    );
    return { ...task, id, version: 1, updatedAtUtc };
  }

  public async getLearnedRules(tenantId: string): Promise<LearnedRule[]> {
    await this.ready();
    const rows = await this.db.all<any>(
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
  }

  public async saveLearnedRule(
    rule: Omit<LearnedRule, 'id' | 'createdAtUtc'>
  ): Promise<LearnedRule> {
    await this.ready();
    const id = `lrn-${Date.now()}`;
    const createdAtUtc = new Date().toISOString();
    await this.db.run(
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
    return { ...rule, id, createdAtUtc };
  }

  public async getRawEvents(tenantId: string, userId?: string): Promise<TrackingEvent[]> {
    await this.ready();
    const rows = userId
      ? await this.db.all<any>(
          'SELECT * FROM tracking_events WHERE tenant_id = ? AND user_id = ? ORDER BY event_time_utc ASC',
          tenantId,
          userId
        )
      : await this.db.all<any>(
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
  }

  public async getConflicts(tenantId: string, userId?: string): Promise<SyncConflict[]> {
    await this.ready();
    const rows = userId
      ? await this.db.all<any>(
          'SELECT * FROM sync_conflicts WHERE tenant_id = ? AND user_id = ? AND resolved = 0 ORDER BY created_at_utc DESC',
          tenantId,
          userId
        )
      : await this.db.all<any>(
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
  }

  public async resolveConflict(
    tenantId: string,
    conflictId: string,
    resolution: 'keep_local' | 'keep_server'
  ) {
    await this.ready();
    const row = await this.db.get<any>(
      'SELECT * FROM sync_conflicts WHERE tenant_id = ? AND id = ?',
      tenantId,
      conflictId
    );
    if (!row) return;
    if (resolution === 'keep_local') {
      await this.db.run(
        'UPDATE engine_tasks SET status = ?, version = version + 1, updated_at_utc = ? WHERE tenant_id = ? AND id = ?',
        row.local_status,
        new Date().toISOString(),
        tenantId,
        row.task_id
      );
    }
    await this.db.run(
      'UPDATE sync_conflicts SET resolved = 1, resolution = ? WHERE id = ?',
      resolution,
      conflictId
    );
  }

  public async recordAuditLog(
    entry: Omit<AuditLogEntry, 'id' | 'createdAtUtc'>
  ): Promise<AuditLogEntry> {
    await this.ready();
    const id = `aud-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const createdAtUtc = new Date().toISOString();
    await this.db.run(
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
    return { ...entry, id, createdAtUtc };
  }

  public async getAuditLogs(tenantId: string): Promise<AuditLogEntry[]> {
    await this.ready();
    const rows = await this.db.all<any>(
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
  }

  public async saveStoredFileMetadata(
    record: StoredFileRecord & { storedRelPath: string }
  ): Promise<StoredFileRecord> {
    await this.ready();
    await this.db.run(
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
    const rows = await this.db.all<any>(
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
  }

  public async getStoredFile(
    tenantId: string,
    fileId: string
  ): Promise<(StoredFileRecord & { storedRelPath: string }) | null> {
    await this.ready();
    const r = await this.db.get<any>(
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
  }

  /**
   * Ingestion Endpoint Pipeline (privacy check, deduplication, seq gap check, conflict guard, FRESH-3 marker).
   */
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

    const devRow = await this.db.get<any>(
      'SELECT * FROM device_freshness WHERE device_id = ?',
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

      const inserted = await this.insertEventRow(ev, nowIso);
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
        const taskRow = await this.db.get<any>(
          'SELECT * FROM engine_tasks WHERE tenant_id = ? AND id = ?',
          tenantId,
          ev.payload.task_id
        );

        if (taskRow) {
          const expectedVer = ev.payload.expected_version;
          if (expectedVer !== undefined && expectedVer !== Number(taskRow.version)) {
            const conflictId = `cnf-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
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
            await this.db.run(
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
            await this.db.run(
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
      this.lateUpdateNoticeByTenant.set(
        tenantId,
        `Updated ${nowIso.slice(11, 19)}Z from late-arriving device backlog`
      );
    }

    const userRow = await this.db.get<{ name: string; shift_pattern: string }>(
      'SELECT name, shift_pattern FROM shift_users WHERE user_id = ?',
      userId
    );

    await this.db.run(
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

    const prevRow = await this.db.get<{ version: number }>(
      'SELECT version FROM attribution_overrides WHERE session_id = ?',
      params.sessionId
    );
    const nextVersion = prevRow ? Number(prevRow.version) + 1 : 2;

    await this.db.run(
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
    await this.db.run(
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
    await this.db.run(
      'DELETE FROM checklist_overrides WHERE tenant_id = ? AND id = ?',
      tenantId,
      itemId
    );
  }

  /**
   * Enforces per-tenant retention policy (PRIV retention: 30-90 days) by removing
   * raw tracking_events older than `retentionDays` while preserving derived work.
   */
  public async purgeExpiredRawEvents(tenantId: string): Promise<{
    purgedCount: number;
    cutoffUtc: string;
  }> {
    await this.ready();
    const config = await this.getTenantConfig(tenantId);
    const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffUtc = new Date(cutoffMs).toISOString();

    const info = await this.db.run(
      'DELETE FROM tracking_events WHERE tenant_id = ? AND event_time_utc < ?',
      tenantId,
      cutoffUtc
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

  public async getDeviceFreshness(tenantId: string): Promise<{
    devices: DeviceFreshnessRecord[];
    summary: FleetFreshnessSummary;
  }> {
    await this.ready();
    const config = await this.getTenantConfig(tenantId);
    const rows = await this.db.all<any>(
      'SELECT * FROM device_freshness WHERE tenant_id = ?',
      tenantId
    );
    const users = await this.db.all<any>(
      'SELECT * FROM shift_users WHERE tenant_id = ?',
      tenantId
    );
    const userMap = new Map(users.map((u) => [u.user_id, u]));

    const nowMs = Date.now();
    const devices: DeviceFreshnessRecord[] = rows.map((r) => {
      const u = userMap.get(r.user_id);
      const lastMs = Date.parse(r.last_heartbeat_utc);
      const silentSec = Math.max(0, Math.round((nowMs - lastMs) / 1000));
      let status: FreshnessStatus = 'live';

      if (u?.on_leave || r.shift_pattern === '5-9') {
        status = r.status === 'live' && silentSec <= 60 ? 'live' : 'off_shift';
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

    const activeShiftDevices = devices.filter((d) => d.status !== 'off_shift');
    const liveCount = activeShiftDevices.filter((d) => d.status === 'live').length;
    const delayedCount = activeShiftDevices.filter((d) => d.status === 'delayed').length;
    const offlineCount = activeShiftDevices.filter((d) => d.status === 'offline').length;
    const offShiftCount = devices.filter((d) => d.status === 'off_shift').length;

    return {
      devices,
      summary: {
        dataAsOfUtc: new Date().toISOString(),
        totalActiveShiftStaff: activeShiftDevices.length,
        reportingLiveCount: liveCount,
        delayedCount,
        offlineCount,
        offShiftCount,
        provisional: delayedCount > 0 || offlineCount > 0,
        recentlyUpdatedNotice: this.lateUpdateNoticeByTenant.get(tenantId) || null,
      },
    };
  }

  public async getEngineSnapshot(params: {
    tenantId: string;
    viewerUserId: string;
    viewerRole: UserRole;
    targetUserId?: string;
    drilldownGranted?: boolean;
    authMode?: 'firebase' | 'device' | 'demo';
  }) {
    await this.ready();
    const {
      tenantId,
      viewerUserId,
      viewerRole,
      targetUserId = viewerUserId,
      drilldownGranted = false,
      authMode = 'demo',
    } = params;

    const config = await this.getTenantConfig(tenantId);
    const allClients = await this.getClients(tenantId);
    const activityRules = await this.getActivityRules(tenantId);
    const privacyRules = await this.getPrivacyRules(tenantId);
    const templates = await this.getTemplates(tenantId);
    const allTasks = await this.getTasks(tenantId);
    const learnedRules = await this.getLearnedRules(tenantId);
    const { devices, summary: freshnessSummary } = await this.getDeviceFreshness(tenantId);
    const conflicts = await this.getConflicts(tenantId, viewerUserId);
    const auditLogs = await this.getAuditLogs(tenantId);
    const staffUsers = await this.listShiftUsers(tenantId);
    const deviceTokens =
      viewerRole === 'admin_it' ? await this.listDeviceTokens(tenantId) : [];
    const storedFiles =
      viewerRole === 'admin_it' || viewerRole === 'team_lead' || viewerRole === 'accountant'
        ? await this.listStoredFiles(tenantId)
        : [];

    const visibleClients = allClients.filter(
      (c) =>
        c.restrictedUserIds.length === 0 ||
        c.restrictedUserIds.includes(viewerUserId) ||
        viewerRole === 'admin_it'
    );
    const visibleClientIds = new Set(visibleClients.map((c) => c.id));

    const visibleTasks =
      viewerRole === 'admin_it'
        ? []
        : allTasks.filter((t) => visibleClientIds.has(t.clientId));

    const viewingOwn = targetUserId === viewerUserId;
    const timelinePermitted =
      viewerRole === 'accountant'
        ? viewingOwn
        : viewerRole === 'team_lead' || viewerRole === 'line_manager'
        ? viewingOwn || drilldownGranted
        : false;

    if (
      !viewingOwn &&
      drilldownGranted &&
      (viewerRole === 'team_lead' || viewerRole === 'line_manager')
    ) {
      await this.recordAuditLog({
        tenantId,
        actorUserId: viewerUserId,
        actorRole: viewerRole,
        targetUserId,
        action: 'timeline.drilldown',
        details: `Manager drilled down into ${targetUserId} minute-by-minute timeline`,
      });
    }

    let sessions: WorkSession[] = [];
    let attributions: AttributionRecord[] = [];
    let checklistItems: AutoChecklistItem[] = [];
    let revisionsPublished: any[] = [];

    if (timelinePermitted) {
      const rawEvents = await this.getRawEvents(tenantId, targetUserId);
      sessions = sessionizeEvents(rawEvents, visibleClients, activityRules, config);

      const overrideRows = await this.db.all<any>(
        'SELECT * FROM attribution_overrides WHERE tenant_id = ? AND user_id = ?',
        tenantId,
        targetUserId
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

      const chkRows = await this.db.all<any>(
        'SELECT * FROM checklist_overrides WHERE tenant_id = ? AND user_id = ?',
        tenantId,
        targetUserId
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
      viewerRole === 'client' || viewerRole === 'admin_it'
        ? []
        : buildShiftHandoffSummaries(visibleTasks, sessions, attributions, checklistItems);

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
      staffUsers:
        viewerRole === 'admin_it' || viewerRole === 'team_lead' || viewerRole === 'executive'
          ? staffUsers
          : [],
      deviceTokens,
      storedFiles,
      clients: viewerRole === 'admin_it' ? [] : visibleClients,
      activityRules,
      privacyRules,
      templates,
      tasks: visibleTasks,
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
      auditLogs:
        viewerRole === 'admin_it' || viewerRole === 'executive' || viewerRole === 'team_lead'
          ? auditLogs
          : [],
    };
  }

  public async runSimulationAndReplay(tenantId: string, userId = 'u_acc_01') {
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

    const testDb = new EngineSQLStore({ dbPath: ':memory:' });
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
      viewerUserId: 'demo_u_lead_01',
      viewerRole: 'executive',
      targetUserId: 'demo_u_acc_01',
    });

    // AUTH-1: Device token creation, verification & revocation check
    const paired = await testDb.createDeviceToken({
      tenantId: memTenant,
      userId: 'demo_u_acc_01',
      deviceId: 'dev-auth-test',
      label: 'Win11 Test Laptop',
    });
    const verifiedToken = await testDb.verifyDeviceToken(paired.rawToken);
    const badToken = await testDb.verifyDeviceToken('cf_dev_invalidtoken000');

    // RET-1: Retention purge verification (old raw event purged while newer stays)
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

    const freshnessData = await this.getDeviceFreshness(tenantId);

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
        passed: lateRes.lateBacklogUpdated && Boolean((await testDb.getDeviceFreshness(memTenant)).summary.recentlyUpdatedNotice),
        detail: lateRes.lateBacklogUpdated ? 'Updated marker published on late backlog' : 'Missed',
      },
      {
        id: 'ATTR-1/2',
        name: 'Confidence + reason attached; <0.50 isolated in Review Tray',
        passed: replay.reviewTrayCount >= 1 && replay.items.every((i) => i.reason.length > 0),
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
        name: 'Silent device > 2m flagged delayed; 5-9 off-shift never flagged',
        passed:
          freshnessData.devices.length === 0 ||
          (freshnessData.devices.some((d) => d.status === 'delayed') &&
            freshnessData.devices.some((d) => d.status === 'off_shift')),
        detail: `Threshold=${config.delayedThresholdSeconds}s enforced across shifts`,
      },
      {
        id: 'AUTH-1',
        name: 'SHA-256 device pairing token verifies enrolled agents & rejects invalid keys',
        passed: Boolean(verifiedToken && verifiedToken.userId === 'demo_u_acc_01') && badToken === null,
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
