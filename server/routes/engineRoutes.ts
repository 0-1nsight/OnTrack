import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Router } from 'express';
import JSZip from 'jszip';
import { z } from 'zod';
import { AuthStore } from '../authStore.ts';
import { appConfig } from '../config.ts';
import { EngineSQLStore } from '../engineStore.ts';
import { asyncHandler, HttpError } from '../errors.ts';
import {
  readPortableFileFromDisk,
  savePortableFileToDisk,
} from '../fileStorage.ts';
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
      const { deviceId = 'dev-web-client', events = [] } = req.body || {};

      if (!Array.isArray(events)) {
        throw new HttpError(400, 'INVALID_EVENTS', 'events array is required.');
      }

      const targetUserId =
        authCtx.mode === 'device'
          ? authCtx.userId
          : authCtx.isDemoSandbox && typeof req.body?.userId === 'string'
          ? String(req.body.userId)
          : authCtx.userId;

      const t0 = performance.now();
      const result = await deps.engineStore.ingestEventBatch({
        tenantId: authCtx.tenantId,
        userId: targetUserId,
        deviceId: authCtx.deviceId || String(deviceId),
        events,
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
      if (
        authCtx.role !== 'admin_it' &&
        authCtx.role !== 'team_lead' &&
        authCtx.role !== 'line_manager' &&
        authCtx.role !== 'executive'
      ) {
        throw new HttpError(403, 'FORBIDDEN', 'Insufficient role permissions.');
      }
      const staff = await deps.engineStore.listShiftUsers(authCtx.tenantId);
      const scoped =
        authCtx.role === 'team_lead'
          ? staff.filter((s) => s.teamId === authCtx.teamId)
          : staff;
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
      const rawText = String(req.body?.rawText || '');
      if (!rawText.trim()) {
        throw new HttpError(400, 'EMPTY_CSV', 'CSV content is empty.');
      }
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
        parsed.canDrilldownTimeline
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
      const requestedUserId = String(req.body?.userId || authCtx.userId);
      const targetUserId =
        authCtx.role === 'admin_it' ? requestedUserId : authCtx.userId;
      const deviceId =
        String(req.body?.deviceId || '').trim() ||
        `dev-${targetUserId}-${Date.now().toString(36)}`;
      const label = String(req.body?.label || 'Workstation Agent').trim();

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
      const { rawText = '', source = 'csv' } = req.body || {};
      if (typeof rawText !== 'string' || !rawText.trim()) {
        throw new HttpError(400, 'EMPTY_IMPORT', 'Import file content is empty.');
      }
      const imported = await deps.engineStore.importClientsFromRaw(
        authCtx.tenantId,
        rawText,
        source === 'file_upload' ? 'file_upload' : 'csv'
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
      const {
        keyword,
        activityType,
        workCategory = 'billable',
        weight = 8,
      } = req.body || {};
      if (!keyword || !activityType) {
        throw new HttpError(400, 'MISSING_FIELDS', 'keyword and activityType are required.');
      }
      const created = await deps.engineStore.addActivityRule({
        tenantId: authCtx.tenantId,
        keyword: String(keyword),
        activityType: String(activityType),
        workCategory,
        weight: Number(weight) || 8,
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
      const { kind = 'domain', pattern, reason = 'Custom Exclusion' } = req.body || {};
      if (!pattern) {
        throw new HttpError(400, 'MISSING_PATTERN', 'pattern is required.');
      }
      const rule = await deps.engineStore.addPrivacyRule({
        tenantId: authCtx.tenantId,
        kind,
        pattern: String(pattern),
        reason: String(reason),
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
      await deps.engineStore.togglePrivacyRule(
        authCtx.tenantId,
        req.params.id,
        Boolean(req.body?.enabled)
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
      const updated = await deps.engineStore.updateTenantConfig(
        authCtx.tenantId,
        req.body || {}
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

  router.post(
    '/tasks',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const b = req.body || {};
      if (!b.title || !b.clientId) {
        throw new HttpError(400, 'MISSING_FIELDS', 'title and clientId are required.');
      }
      const created = await deps.engineStore.createEngineTask({
        tenantId: authCtx.tenantId,
        clientId: String(b.clientId),
        clientName: String(b.clientName || 'Client'),
        templateId:
          b.templateId ||
          `${authCtx.tenantId === 'firm_demo' ? 'demo_' : ''}tpl-monthly-close`,
        title: String(b.title),
        period: String(b.period || 'Oct 2026'),
        status: b.status || 'todo',
        dueDateUtc: b.dueDateUtc || new Date().toISOString(),
        assignedUserId: String(b.assignedUserId || authCtx.userId),
        estimatedMinutes: Number(b.estimatedMinutes) || 120,
      });
      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: created.assignedUserId,
        affectedTeamId: authCtx.teamId,
        eventType: 'state:updated',
      });
      res.json({ task: created });
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

  router.get(
    '/package/:kind',
    asyncHandler(async (req, res) => {
      const authCtx = await requireStaff(req);
      const kind = req.params.kind;
      if (kind !== 'desktop-agent' && kind !== 'browser-extension') {
        throw new HttpError(400, 'INVALID_PACKAGE_KIND', 'Invalid package kind.');
      }

      const packagesRoot = path.resolve(appConfig.projectRoot, 'packages');
      const targetDir = path.resolve(packagesRoot, kind);
      if (!targetDir.startsWith(packagesRoot + path.sep) || !fs.existsSync(targetDir)) {
        throw new HttpError(404, 'PACKAGE_NOT_FOUND', 'Requested agent package not found.');
      }

      const targetUserId =
        authCtx.role === 'admin_it' && typeof req.query.userId === 'string' && req.query.userId.trim()
          ? req.query.userId.trim()
          : authCtx.userId;

      const serverUrl = String(req.query.serverUrl || appConfig.appUrl || 'http://localhost:3000');

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
              tenantId: authCtx.tenantId,
              userId: targetUserId,
              deviceId: `dev-${targetUserId}`,
              deviceToken: '<PASTE_ONTRACK_DEV_TOKEN_HERE>',
              bridgePort: 47621,
              heartbeatSeconds: 12,
              pollSampleMs: 5000,
              idleThresholdSeconds: 180,
            },
            null,
            2
          )
        );
      }

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="ontrack-${kind}.zip"`
      );
      res.send(buffer);
    })
  );

  return router;
}
