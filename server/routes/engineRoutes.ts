import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Router } from 'express';
import JSZip from 'jszip';
import { z } from 'zod';
import { AuthStore } from '../authStore.ts';
import { appConfig } from '../config.ts';
import { canActorAssignTask, EngineSQLStore } from '../engineStore.ts';
import { asyncHandler, HttpError } from '../errors.ts';
import {
  readPortableFileFromDisk,
  savePortableFileToDisk,
} from '../fileStorage.ts';
import {
  buildUnixInstallerArtifact,
  buildWindowsInstallerArtifact,
  getInstallerCapabilities,
} from '../installerBuilder.ts';
import { buildRoleOverview } from '../roleOverview.ts';
import { EngineWsGateway } from '../wsGateway.ts';
import { normalizeRole, resolveHttpAuthContext } from './authMiddleware.ts';

const StaffRolePatchSchema = z.object({
  role: z.enum([
    'accountant',
    'team_lead',
    'line_manager',
    'executive',
    'client',
    'admin_it',
  ]),
  shiftPattern: z.enum(['8-5', '5-9', 'remote', 'weekend']).optional(),
  onLeave: z.boolean().optional(),
  canDrilldownTimeline: z.boolean().optional(),
});

const ClientUpsertSchema = z.object({
  id: z.string().trim().optional(),
  legalName: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().trim()).default([]),
  codes: z.array(z.string().trim()).default([]),
  folderPatterns: z.array(z.string().trim()).default([]),
  knownDomains: z.array(z.string().trim()).default([]),
  restrictedUserIds: z.array(z.string().trim()).default([]),
  source: z.enum(['csv', 'file_upload', 'manual']).default('manual'),
});

const FileUploadSchema = z.object({
  originalName: z.string().trim().min(1).max(160),
  mimeType: z.string().trim().default('application/octet-stream'),
  purpose: z
    .enum(['dictionary_import', 'branding_asset', 'portal_document', 'policy_doc'])
    .default('portal_document'),
  contentBase64: z.string().min(1),
});

const PortalBrandingPatchSchema = z.object({
  accentTheme: z.enum(['indigo', 'emerald', 'blue', 'slate', 'amber', 'rose']).optional(),
  portalTitle: z.string().trim().min(2).max(120).optional(),
  customDomain: z.string().trim().max(120).optional(),
  supportNotice: z.string().trim().max(240).optional(),
  welcomeMessage: z.string().trim().max(400).optional(),
  logoText: z.string().trim().max(6).optional(),
  logoFileId: z.string().trim().nullable().optional(),
});

const TemplateUpdateSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  milestoneNames: z.array(z.string().trim().min(1).max(200)).min(1).max(12).optional(),
});

const TaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'completed']).optional(),
  estimatedMinutes: z.number().int().min(5).max(10000).optional(),
  dueDateUtc: z.string().trim().min(1).max(64).optional(),
  period: z.string().trim().min(1).max(64).optional(),
  assignedUserId: z.string().trim().min(1).max(120).optional(),
  clientId: z.string().trim().min(1).max(120).optional(),
  clientName: z.string().trim().min(1).max(160).optional(),
});

const TaskCollaboratorInviteSchema = z.object({
  inviteeUserId: z.string().trim().min(1).max(120),
  note: z.string().trim().max(400).optional(),
});

const TaskCollaboratorRespondSchema = z.object({
  action: z.enum(['accept', 'decline']),
});

const PackageBuildBodySchema = z.object({
  serverUrl: z.string().trim().url().optional(),
  userId: z.string().trim().min(1).max(120).optional(),
  bridgeSecret: z.string().trim().min(16).max(128).optional(),
  credentialsText: z.string().max(12000).optional(),
  credentialsFilename: z.string().trim().max(120).optional(),
});

const SyncEventItemSchema = z.object({
  event_id: z.string().trim().min(1).max(160),
  schema_version: z.literal(1).optional().default(1),
  tenant_id: z.string().trim().optional(),
  user_id: z.string().trim().optional(),
  device_id: z.string().trim().optional(),
  seq: z.number().int().min(0),
  type: z.enum([
    'activity.window',
    'activity.app',
    'activity.browser',
    'activity.file',
    'activity.idle',
    'activity.meeting',
    'activity.heartbeat',
    'state.task_status',
    'state.step_confirmed',
    'state.milestone_confirmed',
    'state.session_attributed',
  ]),
  priority: z.enum(['state', 'activity']),
  event_time_utc: z.string().trim().min(10).max(64),
  received_at: z.string().nullable().optional().default(null),
  payload: z.record(z.string(), z.unknown()),
});

const SyncBatchSchema = z.object({
  deviceId: z.string().trim().min(1).max(160).optional().default('dev-web-client'),
  userId: z.string().trim().min(1).max(120).optional(),
  events: z.array(SyncEventItemSchema).max(500),
});

const RawCsvImportSchema = z.object({
  rawText: z.string().trim().min(1, 'CSV content is empty.').max(500_000),
});

const ClientImportSchema = z.object({
  rawText: z.string().trim().min(1, 'Import file content is empty.').max(500_000),
  source: z.enum(['csv', 'file_upload']).optional().default('csv'),
});

const DevicePairSchema = z.object({
  userId: z.string().trim().min(1).max(120).optional(),
  deviceId: z.string().trim().min(1).max(120).optional(),
  label: z.string().trim().min(1).max(120).optional(),
});

const ActivityRuleCreateSchema = z.object({
  keyword: z.string().trim().min(1).max(120),
  activityType: z.string().trim().min(1).max(120),
  workCategory: z
    .enum(['deep_work', 'collaborative', 'billable', 'admin'])
    .optional()
    .default('billable'),
  weight: z.number().finite().min(1).max(100).optional().default(8),
});

const PrivacyRuleCreateSchema = z.object({
  kind: z.enum(['app', 'domain', 'path']).optional().default('domain'),
  pattern: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(240).optional().default('Custom Exclusion'),
});

const PrivacyRuleToggleSchema = z.object({
  enabled: z.boolean(),
});

const VALID_APP_COLOR_PRESET_IDS = new Set([
  'sky', 'emerald', 'teal', 'indigo', 'slate', 'fuchsia',
  'violet', 'rose', 'amber', 'orange', 'cyan', 'blue',
  'lime', 'crimson', 'ochre', 'plum', 'cobalt', 'mint',
]);
const HEX_COLOR_VALUE_REGEX = /^#[0-9a-fA-F]{6}$/;

const AppColorValueSchema = z
  .string()
  .trim()
  .refine(
    (v) => VALID_APP_COLOR_PRESET_IDS.has(v) || HEX_COLOR_VALUE_REGEX.test(v),
    'Color must be a valid palette preset ID or #RRGGBB hex code.'
  );

const AppColorsMapSchema = z
  .record(z.string().trim().min(1).max(120), AppColorValueSchema)
  .refine((obj) => Object.keys(obj).length <= 200, 'Maximum 200 custom app color entries.');

const AppColorsPatchSchema = z.object({
  appColors: AppColorsMapSchema.optional(),
  appName: z.string().trim().min(1).max(120).optional(),
  color: AppColorValueSchema.nullable().optional(),
});

const TenantConfigPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  aiReportsEnabled: z.boolean().optional(),
  focusFactor: z.number().finite().min(0.5).max(1).optional(),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300).optional(),
  delayedThresholdSeconds: z.number().int().min(30).max(3600).optional(),
  retentionDays: z.number().int().min(7).max(365).optional(),
  monitoringPolicy: z.enum(['mandatory', 'opt_in']).optional(),
  serverUrl: z.string().trim().url().optional(),
  appColors: AppColorsMapSchema.optional(),
  confidenceThresholds: z
    .object({
      detected: z.number().finite().min(0.1).max(1).optional(),
      suggested: z.number().finite().min(0.1).max(1).optional(),
    })
    .optional(),
  sessionizer: z
    .object({
      maxInterruptionSeconds: z.number().int().min(5).max(600).optional(),
      idleCloseSeconds: z.number().int().min(30).max(3600).optional(),
    })
    .optional(),
});

const TaskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  clientId: z.string().trim().max(120).optional(),
  project: z.string().trim().max(160).optional(),
  clientName: z.string().trim().max(160).optional(),
  templateId: z.string().trim().max(120).optional(),
  period: z.string().trim().max(64).optional(),
  status: z.enum(['todo', 'in_progress', 'blocked', 'completed']).optional().default('todo'),
  dueDateUtc: z.string().trim().max(64).optional(),
  assignedUserId: z.string().trim().max(120).optional(),
  estimatedMinutes: z.coerce.number().int().min(5).max(10000).optional().default(120),
});

export function createEngineRouter(deps: {
  authStore: AuthStore;
  engineStore: EngineSQLStore;
  wsGateway: EngineWsGateway;
}) {
  const router = Router();

  const requireStaff = async (req: any) => {
    const authCtx = await resolveHttpAuthContext(req, deps);
    if (authCtx.role === 'client') {
      throw new HttpError(
        403,
        'CLIENT_PORTAL_ONLY',
        'Client portal principals cannot access internal workforce engine endpoints.'
      );
    }
    return authCtx;
  };

  router.get(
    '/snapshot',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const targetUserId = String(req.query.targetUserId || authCtx.userId);
      const drilldownGranted =
        req.query.drilldown === 'true' || req.query.drilldownGranted === 'true';

      const snapshot = await deps.engineStore.getEngineSnapshot({
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
        viewerTeamId: authCtx.teamId,
        viewerClientId: authCtx.clientId,
        viewerCanDrilldown: authCtx.canDrilldownTimeline,
        targetUserId,
        drilldownGranted,
        authMode: authCtx.mode,
      });
      res.json(snapshot);
    })
  );

  router.get(
    '/poll',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const targetUserId = String(req.query.targetUserId || authCtx.userId);
      const drilldownGranted =
        req.query.drilldown === 'true' || req.query.drilldownGranted === 'true';

      const snapshot = await deps.engineStore.getEngineSnapshot({
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
        viewerTeamId: authCtx.teamId,
        viewerClientId: authCtx.clientId,
        viewerCanDrilldown: authCtx.canDrilldownTimeline,
        targetUserId,
        drilldownGranted,
        authMode: authCtx.mode,
      });
      res.json({
        transport: 'https-poll',
        serverTimeUtc: new Date().toISOString(),
        ...snapshot,
      });
    })
  );

  router.get(
    '/role-overview',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const overview = await buildRoleOverview({
        engineStore: deps.engineStore,
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
        viewerTeamId: authCtx.teamId,
      });
      res.json(overview);
    })
  );

  router.get(
    '/agent/bootstrap',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const config = await deps.engineStore.getTenantConfig(authCtx.tenantId);
      const privacyRules = await deps.engineStore.getPrivacyRules(authCtx.tenantId);
      res.json({
        serverTimeUtc: new Date().toISOString(),
        tenantId: authCtx.tenantId,
        userId: authCtx.userId,
        deviceId: authCtx.deviceId || null,
        config,
        privacyRules: privacyRules.filter((r) => r.enabled),
      });
    })
  );

  router.post(
    '/sync',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = SyncBatchSchema.parse(req.body || {});
      const { deviceId, events } = parsed;

      const targetUserId =
        authCtx.mode === 'device'
          ? authCtx.userId
          : authCtx.isDemoSandbox && parsed.userId
          ? parsed.userId
          : authCtx.userId;

      const t0 = performance.now();
      const result = await deps.engineStore.ingestEventBatch({
        tenantId: authCtx.tenantId,
        userId: targetUserId,
        deviceId: authCtx.deviceId || deviceId,
        events: events as any,
      });
      deps.engineStore.recordBroadcastLatency(performance.now() - t0);

      if (result.stateChanged) {
        await deps.wsGateway.publish({
          tenantId: authCtx.tenantId,
          affectedUserId: targetUserId,
          affectedTeamId: authCtx.teamId,
          eventType: 'state:updated',
          meta: {
            lastAckSeq: result.lastAckSeq,
            lateBacklogUpdated: result.lateBacklogUpdated,
            ...(result.liveActivity ? { liveActivity: result.liveActivity } : {}),
          },
        });
      } else if (result.acceptedCount > 0) {
        await deps.wsGateway.publish({
          tenantId: authCtx.tenantId,
          affectedUserId: targetUserId,
          affectedTeamId: authCtx.teamId,
          eventType: 'activity:updated',
          meta: {
            lastAckSeq: result.lastAckSeq,
            ...(result.liveActivity ? { liveActivity: result.liveActivity } : {}),
          },
        });
      }

      res.json(result);
    })
  );

  router.get(
    '/staff',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const staff = await deps.engineStore.listShiftUsers(authCtx.tenantId);
      // Internal firm directory excludes external Client Portal principals for non-Admin pickers
      const scoped =
        authCtx.role === 'admin_it'
          ? staff
          : staff.filter((s) => s.role !== 'client');
      res.json({ staff: scoped });
    })
  );

  router.post(
    '/staff/import',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can import staff roster CSV.');
      }
      const { rawText } = RawCsvImportSchema.parse(req.body || {});
      const staff = await deps.engineStore.importStaffFromCsv(authCtx.tenantId, rawText);
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'staff.import',
        details: `Imported/updated ${staff.length} staff roster entries via CSV`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ importedCount: staff.length, staff });
    })
  );

  router.patch(
    '/staff/:userId/role',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can update staff roles and permissions.');
      }
      const parsed = StaffRolePatchSchema.parse(req.body);
      await deps.engineStore.updateShiftUserRole(
        authCtx.tenantId,
        req.params.userId,
        normalizeRole(parsed.role),
        parsed.shiftPattern,
        parsed.onLeave,
        parsed.canDrilldownTimeline,
        authCtx.userId
      );
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: req.params.userId,
        action: 'staff.role_updated',
        details: `Updated role for ${req.params.userId} to ${parsed.role}`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.get(
    '/devices',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const tokens = await deps.engineStore.listDeviceTokens(authCtx.tenantId);
      const filtered =
        authCtx.role === 'admin_it'
          ? tokens
          : tokens.filter((t) => t.userId === authCtx.userId);
      res.json({ tokens: filtered });
    })
  );

  router.post(
    '/devices/pair',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = DevicePairSchema.parse(req.body || {});
      const requestedUserId = parsed.userId || authCtx.userId;
      const targetUserId =
        authCtx.role === 'admin_it' ? requestedUserId : authCtx.userId;
      const deviceId =
        parsed.deviceId || `dev-${targetUserId}-${Date.now().toString(36)}`;
      const label = parsed.label || 'Workstation Agent';

      const created = await deps.engineStore.createDeviceToken({
        tenantId: authCtx.tenantId,
        userId: targetUserId,
        deviceId,
        label,
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId,
        action: 'device.paired',
        details: `Issued SHA-256 pairing token ${created.record.prefix}... for ${deviceId}`,
      });

      res.json(created);
    })
  );

  router.delete(
    '/devices/:tokenId',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const tokens = await deps.engineStore.listDeviceTokens(authCtx.tenantId);
      const target = tokens.find((t) => t.tokenId === req.params.tokenId);
      if (!target) {
        throw new HttpError(404, 'TOKEN_NOT_FOUND', 'Device token not found.');
      }
      if (authCtx.role !== 'admin_it' && target.userId !== authCtx.userId) {
        throw new HttpError(403, 'FORBIDDEN', 'Cannot revoke another user device token.');
      }
      await deps.engineStore.revokeDeviceToken(
        authCtx.tenantId,
        req.params.tokenId,
        authCtx.userId
      );
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: target.userId,
        action: 'device.revoked',
        details: `Revoked device pairing token ${req.params.tokenId}`,
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/clients',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = ClientUpsertSchema.parse(req.body);
      const created = await deps.engineStore.addOrUpdateClient({
        id: parsed.id,
        tenantId: authCtx.tenantId,
        legalName: parsed.legalName,
        aliases: parsed.aliases,
        codes: parsed.codes,
        folderPatterns: parsed.folderPatterns,
        knownDomains: parsed.knownDomains,
        restrictedUserIds: parsed.restrictedUserIds,
        source: parsed.source,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ client: created });
    })
  );

  router.post(
    '/clients/import',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const { rawText, source } = ClientImportSchema.parse(req.body || {});
      const imported = await deps.engineStore.importClientsFromRaw(
        authCtx.tenantId,
        rawText,
        source
      );
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ importedCount: imported.length, clients: imported });
    })
  );

  router.delete(
    '/clients/:id',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it' && authCtx.role !== 'team_lead' && authCtx.role !== 'line_manager') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Managers or Admin/IT can delete client dictionary entries.');
      }
      await deps.engineStore.deleteClient(authCtx.tenantId, req.params.id);
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/activity-rules',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = ActivityRuleCreateSchema.parse(req.body || {});
      const created = await deps.engineStore.addActivityRule({
        tenantId: authCtx.tenantId,
        keyword: parsed.keyword,
        activityType: parsed.activityType,
        workCategory: parsed.workCategory,
        weight: parsed.weight,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ rule: created });
    })
  );

  router.delete(
    '/activity-rules/:id',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      await deps.engineStore.deleteActivityRule(authCtx.tenantId, req.params.id);
      res.json({ ok: true });
    })
  );

  router.post(
    '/privacy-rules',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it' && !authCtx.isDemoSandbox) {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can add privacy rules.');
      }
      const parsed = PrivacyRuleCreateSchema.parse(req.body || {});
      const rule = await deps.engineStore.addPrivacyRule({
        tenantId: authCtx.tenantId,
        kind: parsed.kind,
        pattern: parsed.pattern,
        reason: parsed.reason,
        enabled: true,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ rule });
    })
  );

  router.patch(
    '/privacy-rules/:id',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it' && !authCtx.isDemoSandbox) {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can toggle privacy rules.');
      }
      const { enabled } = PrivacyRuleToggleSchema.parse(req.body || {});
      await deps.engineStore.togglePrivacyRule(
        authCtx.tenantId,
        req.params.id,
        enabled
      );
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.delete(
    '/privacy-rules/:id',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it' && !authCtx.isDemoSandbox) {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can remove privacy rules.');
      }
      await deps.engineStore.deletePrivacyRule(authCtx.tenantId, req.params.id);
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.patch(
    '/config',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can update tenant settings.');
      }
      const parsed = TenantConfigPatchSchema.parse(req.body || {});
      const updated = await deps.engineStore.updateTenantConfig(
        authCtx.tenantId,
        parsed as any
      );
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'tenant.config_updated',
        details: `Updated tenant engine/AI configuration (aiReportsEnabled=${updated.aiReportsEnabled})`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
        meta: { broadcastTenantConfig: true, kind: 'tenant_config_updated' },
      });
      res.json({ config: updated });
    })
  );

  router.patch(
    '/app-colors',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it' && authCtx.role !== 'team_lead') {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Only Admin/IT or Team Leads can customize firm application colors.'
        );
      }
      const parsed = AppColorsPatchSchema.parse(req.body || {});
      const current = await deps.engineStore.getTenantConfig(authCtx.tenantId);
      const nextColors: Record<string, string> = parsed.appColors
        ? { ...parsed.appColors }
        : { ...(current.appColors || {}) };

      if (parsed.appName) {
        if (parsed.color === null || parsed.color === undefined) {
          delete nextColors[parsed.appName];
        } else {
          nextColors[parsed.appName] = parsed.color;
        }
      }

      const updated = await deps.engineStore.updateTenantConfig(authCtx.tenantId, {
        appColors: nextColors,
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'tenant.app_colors_updated',
        details: parsed.appName
          ? `Updated firm color for "${parsed.appName}" to ${parsed.color ?? 'auto'}`
          : `Updated firm application palette (${Object.keys(updated.appColors || {}).length} overrides)`,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
        meta: { broadcastTenantConfig: true, kind: 'app_colors_updated' },
      });
      res.json({ config: updated });
    })
  );

  router.get(
    '/branding',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const [branding, templates] = await Promise.all([
        deps.engineStore.getPortalBranding(authCtx.tenantId),
        deps.engineStore.getTemplates(authCtx.tenantId),
      ]);
      res.json({ branding, templates });
    })
  );

  router.put(
    '/branding',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can update client portal branding.');
      }
      const parsed = PortalBrandingPatchSchema.parse(req.body || {});
      const branding = await deps.engineStore.updatePortalBranding(authCtx.tenantId, parsed);
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'portal.branding_updated',
        details: `Updated portal branding (title="${branding.portalTitle}", theme=${branding.accentTheme})`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'portal:updated',
        meta: { portalVisible: true, broadcastTenantBranding: true, kind: 'branding_updated' },
      });
      res.json({ branding });
    })
  );

  router.put(
    '/templates/:templateId',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it' && authCtx.role !== 'line_manager') {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Only Admin/IT or Line Manager can edit template milestone names.'
        );
      }
      const parsed = TemplateUpdateSchema.parse(req.body || {});
      const template = await deps.engineStore.updateTaskTemplate(
        authCtx.tenantId,
        req.params.templateId,
        parsed
      );
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'portal.template_milestones_updated',
        details: `Updated template "${template.name}" (${template.steps.length} milestone names)`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'portal:updated',
        meta: { portalVisible: true, broadcastTenantBranding: true, kind: 'template_updated' },
      });
      res.json({ template });
    })
  );

  router.get(
    '/tasks',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const [tasks, clients] = await Promise.all([
        deps.engineStore.getTasks(authCtx.tenantId),
        deps.engineStore.getClients(authCtx.tenantId),
      ]);
      const clientMap = new Map(clients.map((c) => [c.id, c]));
      const visibleTasks = tasks.filter((t) => {
        if (authCtx.role === 'admin_it') return true;
        const c = clientMap.get(t.clientId);
        if (!c || c.restrictedUserIds.length === 0) return true;
        return (
          c.restrictedUserIds.includes(authCtx.userId) ||
          t.assignedUserId === authCtx.userId ||
          Boolean(t.collaboratorUserIds?.includes(authCtx.userId))
        );
      });
      res.json({ tasks: visibleTasks });
    })
  );

  router.post(
    '/tasks',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const b = TaskCreateSchema.parse(req.body || {});
      const title = b.title;
      const rawClientId = b.clientId || '';
      const rawProject = b.project || '';
      const slug = (rawClientId || rawProject)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'internal';
      const clientId = rawClientId || `cli-${slug}`;
      const clientName = String(b.clientName || rawProject || 'Internal Firm');

      const requestedAssigneeId = b.assignedUserId || authCtx.userId;

      const [staff, clients] = await Promise.all([
        deps.engineStore.listShiftUsers(authCtx.tenantId),
        deps.engineStore.getClients(authCtx.tenantId),
      ]);
      const assigneeUser = staff.find((u) => u.userId === requestedAssigneeId);
      if (assigneeUser) {
        const perm = canActorAssignTask({
          actorUserId: authCtx.userId,
          actorRole: authCtx.role,
          targetAssigneeUserId: assigneeUser.userId,
          targetAssigneeRole: assigneeUser.role,
        });
        if (!perm.allowed) {
          throw new HttpError(403, 'FORBIDDEN', perm.reason || 'Not permitted to assign this task.');
        }
      } else if (requestedAssigneeId !== authCtx.userId) {
        throw new HttpError(404, 'ASSIGNEE_NOT_FOUND', 'Assignee user was not found in this firm.');
      }

      const targetClient = clients.find(
        (c) => c.id === clientId || c.legalName.toLowerCase() === clientName.toLowerCase()
      );
      if (
        targetClient &&
        targetClient.restrictedUserIds.length > 0 &&
        !targetClient.restrictedUserIds.includes(requestedAssigneeId)
      ) {
        throw new HttpError(
          403,
          'CLIENT_RESTRICTED',
          'Assignee does not have clearance for this restricted client engagement.'
        );
      }

      const created = await deps.engineStore.createEngineTask({
        tenantId: authCtx.tenantId,
        clientId,
        clientName,
        templateId:
          b.templateId ||
          `${authCtx.tenantId === 'firm_demo' ? 'demo_' : ''}tpl-monthly-close`,
        title,
        period: String(b.period || 'Oct 2026'),
        status: b.status,
        dueDateUtc: b.dueDateUtc || new Date().toISOString(),
        assignedUserId: requestedAssigneeId,
        estimatedMinutes: b.estimatedMinutes,
      });

      if (created.assignedUserId !== authCtx.userId) {
        await deps.engineStore.recordAuditLog({
          tenantId: authCtx.tenantId,
          actorUserId: authCtx.userId,
          actorRole: authCtx.role,
          targetUserId: created.assignedUserId,
          action: 'task.assigned',
          details: `Created task "${created.title}" assigned to ${created.assignedUserName || created.assignedUserId}`,
        });
      }

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: created.assignedUserId,
        affectedUserIds: Array.from(new Set([authCtx.userId, created.assignedUserId])),
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ task: created });
    })
  );

  router.patch(
    '/tasks/:taskId',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = TaskUpdateSchema.parse(req.body || {});
      const existingTasks = await deps.engineStore.getTasks(authCtx.tenantId);
      const target = existingTasks.find((t) => t.id === req.params.taskId);
      if (!target) {
        throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
      }

      const isOwnerOrCollab =
        target.assignedUserId === authCtx.userId ||
        Boolean(target.collaboratorUserIds?.includes(authCtx.userId));

      if (authCtx.role === 'accountant' && !isOwnerOrCollab) {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Accountants can only update tasks assigned to or shared with them.'
        );
      }

      if (parsed.assignedUserId && parsed.assignedUserId !== target.assignedUserId) {
        const [staff, clients] = await Promise.all([
          deps.engineStore.listShiftUsers(authCtx.tenantId),
          deps.engineStore.getClients(authCtx.tenantId),
        ]);
        const targetAssignee = staff.find((u) => u.userId === parsed.assignedUserId);
        if (!targetAssignee) {
          throw new HttpError(
            404,
            'ASSIGNEE_NOT_FOUND',
            'Task assignee must be an active member of this firm.'
          );
        }
        const perm = canActorAssignTask({
          actorUserId: authCtx.userId,
          actorRole: authCtx.role,
          targetAssigneeUserId: targetAssignee.userId,
          targetAssigneeRole: targetAssignee.role,
          existingTask: target,
        });
        if (!perm.allowed) {
          throw new HttpError(
            403,
            'FORBIDDEN',
            perm.reason || 'Insufficient permissions to reassign this task.'
          );
        }

        const targetClient = clients.find((c) => c.id === (parsed.clientId || target.clientId));
        if (
          targetClient &&
          targetClient.restrictedUserIds.length > 0 &&
          !targetClient.restrictedUserIds.includes(targetAssignee.userId)
        ) {
          throw new HttpError(
            403,
            'CLIENT_RESTRICTED',
            'Assignee does not have clearance for this restricted client engagement.'
          );
        }
      }

      const updated = await deps.engineStore.updateEngineTask({
        tenantId: authCtx.tenantId,
        taskId: req.params.taskId,
        updates: parsed,
      });

      if (parsed.assignedUserId && parsed.assignedUserId !== target.assignedUserId) {
        await deps.engineStore.recordAuditLog({
          tenantId: authCtx.tenantId,
          actorUserId: authCtx.userId,
          actorRole: authCtx.role,
          targetUserId: updated.assignedUserId,
          action: 'task.reassigned',
          details: `Reassigned "${updated.title}" from ${target.assignedUserName || target.assignedUserId} to ${updated.assignedUserName || updated.assignedUserId}`,
        });
      }

      const affectedUserIds = Array.from(
        new Set([
          authCtx.userId,
          target.assignedUserId,
          updated.assignedUserId,
          ...(target.collaboratorUserIds || []),
          ...(updated.collaboratorUserIds || []),
        ])
      );

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: updated.assignedUserId,
        affectedUserIds,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ task: updated });
    })
  );

  router.delete(
    '/tasks/:taskId',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const existingTasks = await deps.engineStore.getTasks(authCtx.tenantId);
      const target = existingTasks.find((t) => t.id === req.params.taskId);
      if (!target) {
        throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found.');
      }
      if (
        authCtx.role === 'accountant' &&
        target.assignedUserId !== authCtx.userId
      ) {
        throw new HttpError(403, 'FORBIDDEN', 'Accountants can only delete tasks they own.');
      }
      const deleted = await deps.engineStore.deleteEngineTask({
        tenantId: authCtx.tenantId,
        taskId: req.params.taskId,
      });
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: target.assignedUserId,
        action: 'task.deleted',
        details: `Deleted task "${deleted.title}" (${deleted.id})`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: target.assignedUserId,
        affectedUserIds: Array.from(
          new Set([authCtx.userId, target.assignedUserId, ...(target.collaboratorUserIds || [])])
        ),
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.get(
    '/task-invites',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const invites = await deps.engineStore.listTaskCollaborationInvites({
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
      });
      res.json({ invites });
    })
  );

  router.post(
    '/tasks/:taskId/invites',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = TaskCollaboratorInviteSchema.parse(req.body || {});
      const { invite, task } = await deps.engineStore.inviteTaskCollaborator({
        tenantId: authCtx.tenantId,
        taskId: req.params.taskId,
        inviterUserId: authCtx.userId,
        inviterRole: authCtx.role,
        inviteeUserId: parsed.inviteeUserId,
        note: parsed.note,
      });
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: parsed.inviteeUserId,
        action: 'task.collab_invited',
        details: `Invited ${invite.inviteeName} (${invite.inviteeRole}) to collaborate on "${task.title}"`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: parsed.inviteeUserId,
        affectedUserIds: Array.from(
          new Set([
            authCtx.userId,
            parsed.inviteeUserId,
            task.assignedUserId,
            ...(task.collaboratorUserIds || []),
          ])
        ),
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.status(201).json({ invite, task });
    })
  );

  router.post(
    '/task-invites/:inviteId/respond',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = TaskCollaboratorRespondSchema.parse(req.body || {});
      const { invite, task } = await deps.engineStore.respondToTaskCollaborationInvite({
        tenantId: authCtx.tenantId,
        inviteId: req.params.inviteId,
        actorUserId: authCtx.userId,
        action: parsed.action,
      });
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: invite.inviterUserId,
        action: parsed.action === 'accept' ? 'task.collab_accepted' : 'task.collab_declined',
        details: `${invite.inviteeName} ${parsed.action}ed collaboration invite for "${task.title}"`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: task.assignedUserId,
        affectedUserIds: Array.from(
          new Set([
            authCtx.userId,
            invite.inviterUserId,
            task.assignedUserId,
            ...(task.collaboratorUserIds || []),
          ])
        ),
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ invite, task });
    })
  );

  router.delete(
    '/tasks/:taskId/collaborators/:userId',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const { task } = await deps.engineStore.removeTaskCollaboratorOrPendingInvite({
        tenantId: authCtx.tenantId,
        taskId: req.params.taskId,
        targetUserId: req.params.userId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
      });
      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: req.params.userId,
        action: 'task.collab_removed',
        details: `Removed collaborator / revoked pending invite for ${req.params.userId} on "${task.title}"`,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: req.params.userId,
        affectedUserIds: Array.from(
          new Set([
            authCtx.userId,
            req.params.userId,
            task.assignedUserId,
            ...(task.collaboratorUserIds || []),
          ])
        ),
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ task });
    })
  );

  router.post(
    '/attributions/:sessionId/resolve',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const {
        userId = authCtx.userId,
        taskId = null,
        status = 'confirmed',
        customReason,
        createRulePattern,
        rejectRulePattern,
      } = req.body || {};

      const resolvedUserId =
        authCtx.isDemoSandbox || authCtx.role === 'team_lead' || authCtx.role === 'admin_it'
          ? String(userId)
          : authCtx.userId;

      await deps.engineStore.resolveAttribution({
        tenantId: authCtx.tenantId,
        userId: resolvedUserId,
        sessionId: req.params.sessionId,
        taskId,
        status,
        customReason,
        createRulePattern,
        rejectRulePattern,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: resolvedUserId,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/checklists',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const { item } = req.body || {};
      if (!item || !item.id) {
        throw new HttpError(400, 'MISSING_ITEM', 'checklist item is required.');
      }
      await deps.engineStore.updateChecklistItem({ tenantId: authCtx.tenantId, item });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: item.userId || authCtx.userId,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/checklists/merge',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const { taskId, itemsToMerge = [], mergedTitle } = req.body || {};
      if (!taskId || !Array.isArray(itemsToMerge) || itemsToMerge.length < 2) {
        throw new HttpError(
          400,
          'INVALID_MERGE',
          'taskId and at least 2 checklist items are required.'
        );
      }
      const merged = await deps.engineStore.mergeChecklistItems({
        tenantId: authCtx.tenantId,
        userId: String(itemsToMerge[0].userId || authCtx.userId),
        taskId: String(taskId),
        itemsToMerge,
        mergedTitle,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ item: merged });
    })
  );

  router.post(
    '/checklists/reorder',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const { items = [] } = req.body || {};
      if (!Array.isArray(items)) {
        throw new HttpError(400, 'INVALID_ITEMS', 'items array is required.');
      }
      await deps.engineStore.reorderChecklistItems({ tenantId: authCtx.tenantId, items });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.delete(
    '/checklists/:id',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      await deps.engineStore.deleteChecklistItem(authCtx.tenantId, req.params.id);
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/conflicts/:id/resolve',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const { resolution = 'keep_local' } = req.body || {};
      await deps.engineStore.resolveConflict(
        authCtx.tenantId,
        req.params.id,
        resolution === 'keep_server' ? 'keep_server' : 'keep_local'
      );
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ ok: true });
    })
  );

  router.post(
    '/retention/purge',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      if (authCtx.role !== 'admin_it' && !authCtx.isDemoSandbox) {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can run retention purges.');
      }
      const out = await deps.engineStore.purgeExpiredRawEvents(authCtx.tenantId);
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json(out);
    })
  );

  router.get(
    '/files',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const files = await deps.engineStore.listStoredFiles(authCtx.tenantId);
      res.json({ files });
    })
  );

  router.post(
    '/files',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = FileUploadSchema.parse(req.body);
      const buffer = Buffer.from(parsed.contentBase64, 'base64');
      const saved = savePortableFileToDisk({
        tenantId: authCtx.tenantId,
        originalName: parsed.originalName,
        contentBuffer: buffer,
      });

      const created = await deps.engineStore.saveStoredFileMetadata({
        fileId: saved.fileId,
        tenantId: authCtx.tenantId,
        uploaderUserId: authCtx.userId,
        uploaderEmail: authCtx.userEmail,
        purpose: parsed.purpose,
        originalName: saved.safeOriginalName,
        storedRelPath: saved.storedRelPath,
        mimeType: parsed.mimeType,
        byteSize: saved.byteSize,
        sha256: saved.sha256,
        createdAtUtc: new Date().toISOString(),
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'file.uploaded',
        details: `Stored ${created.originalName} (${created.byteSize} bytes · sha256:${created.sha256.slice(0, 12)})`,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
      });
      res.json({ file: created });
    })
  );

  router.get(
    '/files/:fileId/download',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const record = await deps.engineStore.getStoredFile(
        authCtx.tenantId,
        req.params.fileId
      );
      if (!record) {
        throw new HttpError(404, 'FILE_NOT_FOUND', 'Stored file not found.');
      }
      const buffer = readPortableFileFromDisk(record.storedRelPath);

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'file.downloaded',
        details: `Downloaded ${record.originalName} (${record.fileId})`,
      });

      res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${record.originalName}"`
      );
      res.send(buffer);
    })
  );

  router.post(
    '/replay',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const userId = String(req.body?.userId || authCtx.userId);
      const replay = await deps.engineStore.runSimulationAndReplay(authCtx.tenantId, userId);
      res.json(replay);
    })
  );

  router.get(
    '/acceptance',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const report = await deps.engineStore.runAcceptanceChecks(authCtx.tenantId);
      res.json(report);
    })
  );

  const buildPackageZipResponse = async (params: {
    kind: string;
    tenantId: string;
    viewerUserId: string;
    viewerRole: string;
    requestedUserId?: string;
    serverUrl?: string;
    bridgeSecret?: string;
  }): Promise<{ buffer: Buffer; filename: string }> => {
    const { kind } = params;
    if (kind !== 'desktop-agent' && kind !== 'browser-extension') {
      throw new HttpError(400, 'INVALID_PACKAGE_KIND', 'Invalid package kind.');
    }

    const packagesRoot = path.resolve(appConfig.projectRoot, 'packages');
    const targetDir = path.resolve(packagesRoot, kind);
    if (!targetDir.startsWith(packagesRoot + path.sep) || !fs.existsSync(targetDir)) {
      throw new HttpError(404, 'PACKAGE_NOT_FOUND', 'Requested agent package not found.');
    }

    const targetUserId =
      params.viewerRole === 'admin_it' && params.requestedUserId?.trim()
        ? params.requestedUserId.trim()
        : params.viewerUserId;

    const serverUrl = params.serverUrl || appConfig.appUrl || 'http://localhost:3000';
    const bridgeSecret =
      params.bridgeSecret?.trim() || crypto.randomBytes(24).toString('base64url');

    const zip = new JSZip();
    const addDir = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          addDir(full, rel);
        } else {
          zip.file(rel, fs.readFileSync(full));
        }
      }
    };
    addDir(targetDir, '');

    if (kind === 'desktop-agent') {
      zip.file(
        'agent.config.json',
        JSON.stringify(
          {
            serverUrl,
            tenantId: params.tenantId,
            userId: targetUserId,
            deviceId: `dev-${targetUserId}`,
            deviceToken: '<PASTE_ONTRACK_DEV_TOKEN_HERE>',
            bridgePort: 47621,
            bridgeSecret,
            heartbeatSeconds: 12,
            pollSampleMs: 2000,
            idleThresholdSeconds: 180,
          },
          null,
          2
        )
      );
      zip.file(
        'start-agent.sh',
        '#!/usr/bin/env bash\nset -e\ncd "$(dirname "$0")"\nnpm start\n',
        { unixPermissions: '755' }
      );
      zip.file(
        'start-agent.bat',
        '@echo off\r\ncd /d "%~dp0"\r\nnpm start\r\n'
      );
    } else {
      zip.file(
        'config.defaults.json',
        JSON.stringify(
          {
            bridgeUrl: 'http://127.0.0.1:47621/browser-event',
            bridgeSecret,
            excludedDomains: ['personalbank', 'mychart', 'chase.com'],
          },
          null,
          2
        )
      );
    }

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      platform: 'UNIX',
    });
    return { buffer, filename: `ontrack-${kind}.zip` };
  };

  router.get(
    '/package/installer-info',
    asyncHandler(async (req, res) => {
      await requireStaff(req);
      const info = await getInstallerCapabilities();
      res.json(info);
    })
  );

  const buildPackageArtifactResponse = async (params: {
    kind: string;
    tenantId: string;
    viewerUserId: string;
    viewerRole: string;
    requestedUserId?: string;
    serverUrl?: string;
    bridgeSecret?: string;
    credentialsText?: string;
    credentialsFilename?: string;
  }): Promise<{
    buffer: Buffer;
    filename: string;
    contentType: string;
    format: string;
  }> => {
    const { kind } = params;
    const targetUserId =
      params.viewerRole === 'admin_it' && params.requestedUserId?.trim()
        ? params.requestedUserId.trim()
        : params.viewerUserId;
    const serverUrl = params.serverUrl || appConfig.appUrl || 'http://localhost:3000';
    const bridgeSecret =
      params.bridgeSecret?.trim() || crypto.randomBytes(24).toString('base64url');

    if (kind === 'windows-installer' || kind === 'windows-kit') {
      return buildWindowsInstallerArtifact({
        tenantId: params.tenantId,
        userId: targetUserId,
        serverUrl,
        bridgeSecret,
        credentialsText: params.credentialsText,
        credentialsFilename: params.credentialsFilename,
        bundleAsKit: kind === 'windows-kit',
      });
    }

    if (kind === 'unix-installer' || kind === 'unix-kit') {
      return buildUnixInstallerArtifact({
        tenantId: params.tenantId,
        userId: targetUserId,
        serverUrl,
        bridgeSecret,
        credentialsText: params.credentialsText,
        credentialsFilename: params.credentialsFilename,
        bundleAsKit: kind === 'unix-kit',
      });
    }

    const zipOut = await buildPackageZipResponse({
      kind,
      tenantId: params.tenantId,
      viewerUserId: params.viewerUserId,
      viewerRole: params.viewerRole,
      requestedUserId: params.requestedUserId,
      serverUrl,
      bridgeSecret,
    });
    return {
      ...zipOut,
      contentType: 'application/zip',
      format: 'zip',
    };
  };

  router.get(
    '/package/:kind',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const out = await buildPackageArtifactResponse({
        kind: req.params.kind,
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
        requestedUserId:
          typeof req.query.userId === 'string' ? req.query.userId : undefined,
        serverUrl:
          typeof req.query.serverUrl === 'string' && req.query.serverUrl.trim()
            ? req.query.serverUrl.trim()
            : undefined,
      });
      res.setHeader('Content-Type', out.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.setHeader('X-OnTrack-Installer-Format', out.format);
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Disposition, X-OnTrack-Installer-Format'
      );
      res.send(out.buffer);
    })
  );

  router.post(
    '/package/:kind',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const parsed = PackageBuildBodySchema.parse(req.body || {});
      const out = await buildPackageArtifactResponse({
        kind: req.params.kind,
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
        requestedUserId: parsed.userId,
        serverUrl: parsed.serverUrl,
        bridgeSecret: parsed.bridgeSecret,
        credentialsText: parsed.credentialsText,
        credentialsFilename: parsed.credentialsFilename,
      });
      res.setHeader('Content-Type', out.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      res.setHeader('X-OnTrack-Installer-Format', out.format);
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Disposition, X-OnTrack-Installer-Format'
      );
      res.send(out.buffer);
    })
  );

  return router;
}
