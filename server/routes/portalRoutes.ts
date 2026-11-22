import { Router } from 'express';
import { z } from 'zod';
import { AuthStore } from '../authStore.ts';
import { EngineSQLStore } from '../engineStore.ts';
import { asyncHandler, HttpError } from '../errors.ts';
import { readPortableFileFromDisk, savePortableFileToDisk } from '../fileStorage.ts';
import { PortalRequestStage, PortalSQLStore } from '../portalStore.ts';
import { EngineWsGateway } from '../wsGateway.ts';
import { resolveHttpAuthContext } from './authMiddleware.ts';

const CreatePortalRequestSchema = z.object({
  clientId: z.string().trim().optional(),
  title: z.string().trim().min(2).max(200),
  period: z.string().trim().min(1).max(40).default('Nov 2026'),
  templateId: z.string().trim().nullable().optional(),
  expectedDueUtc: z.string().trim().optional(),
  notes: z.string().trim().max(1000).optional(),
});

const ApproveRequestSchema = z.object({
  signatureName: z.string().trim().min(2).max(160).optional(),
  approvalNotes: z.string().trim().max(500).optional(),
});

const UpdateStageSchema = z.object({
  stage: z.enum([
    'Documents received',
    'In review',
    'Awaiting your approval',
    'Complete',
  ]),
});

const PostPortalMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

const CreateDocRequestSchema = z.object({
  requestId: z.string().trim().min(1),
  title: z.string().trim().min(2).max(200),
  dueDateUtc: z.string().trim().optional(),
});

const DocUploadSchema = z.object({
  originalName: z.string().trim().min(1).max(160),
  mimeType: z.string().trim().default('application/octet-stream'),
  contentBase64: z.string().min(1),
});

const ConfirmMilestoneSchema = z.object({
  requestId: z.string().trim().min(1),
  title: z.string().trim().min(2).max(200),
});

const WithdrawMilestoneSchema = z.object({
  reason: z.string().trim().min(2).max(400),
});

export function createPortalRouter(deps: {
  authStore: AuthStore;
  engineStore: EngineSQLStore;
  portalStore: PortalSQLStore;
  wsGateway: EngineWsGateway;
}) {
  const router = Router();

  const requirePortalAccess = async (req: any) => {
    const authCtx = await resolveHttpAuthContext(req, deps);
    if (authCtx.role === 'admin_it') {
      throw new HttpError(
        403,
        'ADMIN_NO_CLIENT_CONTENT',
        'Admin/IT accounts cannot view or modify client work content.'
      );
    }
    return authCtx;
  };

  const requireFirmStaffForPortal = async (req: any) => {
    const authCtx = await requirePortalAccess(req);
    if (authCtx.role === 'client') {
      throw new HttpError(
        403,
        'FORBIDDEN',
        'Only firm accounting staff can manage deliverables, stages, and milestones.'
      );
    }
    return authCtx;
  };

  router.get(
    '/overview',
    asyncHandler(async (req, res) => {
      const authCtx = await requirePortalAccess(req);
      const requestedClientId =
        typeof req.query.clientId === 'string' && req.query.clientId.trim()
          ? req.query.clientId.trim()
          : null;

      const overview = await deps.portalStore.getPortalOverview({
        tenantId: authCtx.tenantId,
        viewerRole: authCtx.role,
        viewerClientId: authCtx.clientId,
        requestedClientId,
      });
      res.json(overview);
    })
  );

  router.get(
    '/branding/logo/:fileId',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      const record = await deps.engineStore.getStoredFile(
        authCtx.tenantId,
        req.params.fileId
      );
      if (!record || record.purpose !== 'branding_asset') {
        throw new HttpError(404, 'FILE_NOT_FOUND', 'Branding logo not found.');
      }
      const buffer = readPortableFileFromDisk(record.storedRelPath);
      res.setHeader('Content-Type', record.mimeType || 'image/png');
      res.send(buffer);
    })
  );

  router.post(
    '/requests',
    asyncHandler(async (req, res) => {
      const authCtx = await requirePortalAccess(req);
      const input = CreatePortalRequestSchema.parse(req.body);
      const targetClientId =
        authCtx.role === 'client'
          ? authCtx.clientId || 'demo_cli-acme'
          : input.clientId || authCtx.clientId || 'demo_cli-acme';

      const created = await deps.portalStore.createPortalRequest({
        tenantId: authCtx.tenantId,
        clientId: targetClientId,
        title: input.title,
        period: input.period,
        templateId: input.templateId || null,
        expectedDueUtc: input.expectedDueUtc,
        notes: input.notes,
        requesterName: authCtx.userName,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: targetClientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'request_created',
          requestId: created.id,
          title: created.title,
        },
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        eventType: 'state:updated',
        meta: { reason: 'portal_request_created', requestId: created.id },
      });

      res.status(201).json({ request: created });
    })
  );

  router.patch(
    '/requests/:requestId/stage',
    asyncHandler(async (req, res) => {
      const authCtx = await requireFirmStaffForPortal(req);
      const input = UpdateStageSchema.parse(req.body);
      const result = await deps.portalStore.updateRequestStage({
        tenantId: authCtx.tenantId,
        requestId: req.params.requestId,
        stage: input.stage as PortalRequestStage,
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'portal.stage_updated',
        details: `Updated request ${req.params.requestId} stage to "${input.stage}"`,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: result.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'stage_updated',
          requestId: result.requestId,
          stage: result.stage,
        },
      });

      res.json(result);
    })
  );

  router.post(
    '/requests/:requestId/approve',
    asyncHandler(async (req, res) => {
      const authCtx = await requirePortalAccess(req);
      const input = ApproveRequestSchema.parse(req.body || {});
      const result = await deps.portalStore.approvePortalRequest({
        tenantId: authCtx.tenantId,
        requestId: req.params.requestId,
        scopedClientId: authCtx.role === 'client' ? authCtx.clientId || 'demo_cli-acme' : null,
        approverName: authCtx.userName,
        signatureName: input.signatureName,
        approvalNotes: input.approvalNotes,
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'portal.request_approved',
        details: `Approved portal request ${req.params.requestId} (signed as "${result.signatureName}")`,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: result.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'milestone_confirmed',
          requestId: req.params.requestId,
          title: `Client Sign-Off (${result.signatureName})`,
        },
      });

      res.json(result);
    })
  );

  router.post(
    '/requests/:requestId/messages',
    asyncHandler(async (req, res) => {
      const authCtx = await requirePortalAccess(req);
      const input = PostPortalMessageSchema.parse(req.body);
      const msg = await deps.portalStore.postPortalMessage({
        tenantId: authCtx.tenantId,
        requestId: req.params.requestId,
        scopedClientId: authCtx.role === 'client' ? authCtx.clientId || 'demo_cli-acme' : null,
        senderName: authCtx.userName,
        senderRole: authCtx.role,
        body: input.body,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: msg.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'message_posted',
          requestId: req.params.requestId,
        },
      });

      res.status(201).json({ message: msg });
    })
  );

  router.post(
    '/document-requests',
    asyncHandler(async (req, res) => {
      const authCtx = await requireFirmStaffForPortal(req);
      const input = CreateDocRequestSchema.parse(req.body);
      const docRequest = await deps.portalStore.createDocumentRequest({
        tenantId: authCtx.tenantId,
        requestId: input.requestId,
        title: input.title,
        dueDateUtc: input.dueDateUtc,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: docRequest.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'document_requested',
          docReqId: docRequest.id,
          title: docRequest.title,
        },
      });

      res.status(201).json({ documentRequest: docRequest });
    })
  );

  router.post(
    '/document-requests/:docReqId/remind',
    asyncHandler(async (req, res) => {
      const authCtx = await requireFirmStaffForPortal(req);
      const out = await deps.portalStore.sendDocumentReminder({
        tenantId: authCtx.tenantId,
        docReqId: req.params.docReqId,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: out.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'document_reminder',
          docReqId: out.docReqId,
        },
      });

      res.json(out);
    })
  );

  router.post(
    '/document-requests/:docReqId/verify',
    asyncHandler(async (req, res) => {
      const authCtx = await requireFirmStaffForPortal(req);
      const out = await deps.portalStore.verifyDocumentUpload({
        tenantId: authCtx.tenantId,
        docReqId: req.params.docReqId,
        verifiedBy: authCtx.userName,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: out.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'milestone_confirmed',
          docReqId: out.docReqId,
          title: 'Client document verified',
        },
      });

      res.json(out);
    })
  );

  router.post(
    '/document-requests/:docReqId/upload',
    asyncHandler(async (req, res) => {
      const authCtx = await requirePortalAccess(req);
      const parsed = DocUploadSchema.parse(req.body);
      const scopedClientId = authCtx.role === 'client' ? authCtx.clientId || 'demo_cli-acme' : null;
      await deps.portalStore.assertDocumentRequestUploadAccess({
        tenantId: authCtx.tenantId,
        docReqId: req.params.docReqId,
        scopedClientId,
      });

      const buffer = Buffer.from(parsed.contentBase64, 'base64');
      const saved = savePortableFileToDisk({
        tenantId: authCtx.tenantId,
        originalName: parsed.originalName,
        contentBuffer: buffer,
      });

      const fileRecord = await deps.engineStore.saveStoredFileMetadata({
        fileId: saved.fileId,
        tenantId: authCtx.tenantId,
        uploaderUserId: authCtx.userId,
        uploaderEmail: authCtx.userEmail,
        purpose: 'portal_document',
        originalName: saved.safeOriginalName,
        storedRelPath: saved.storedRelPath,
        mimeType: parsed.mimeType,
        byteSize: saved.byteSize,
        sha256: saved.sha256,
        createdAtUtc: new Date().toISOString(),
      });

      const out = await deps.portalStore.attachDocumentUpload({
        tenantId: authCtx.tenantId,
        docReqId: req.params.docReqId,
        scopedClientId,
        fileId: fileRecord.fileId,
        fileName: fileRecord.originalName,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: out.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'document_uploaded',
          docReqId: req.params.docReqId,
        },
      });

      res.json({ ok: true, file: fileRecord, ...out });
    })
  );

  router.get(
    '/files/:fileId/download',
    asyncHandler(async (req, res) => {
      const authCtx = await requirePortalAccess(req);
      if (authCtx.role === 'client') {
        const permitted = await deps.portalStore.verifyPortalFileAccess({
          tenantId: authCtx.tenantId,
          fileId: req.params.fileId,
          scopedClientId: authCtx.clientId || 'demo_cli-acme',
        });
        if (!permitted) {
          throw new HttpError(
            403,
            'FORBIDDEN',
            'You are not authorized to download documents belonging to another client.'
          );
        }
      }

      const record = await deps.engineStore.getStoredFile(
        authCtx.tenantId,
        req.params.fileId
      );
      if (!record || record.purpose !== 'portal_document') {
        throw new HttpError(404, 'FILE_NOT_FOUND', 'Portal document not found.');
      }
      const buffer = readPortableFileFromDisk(record.storedRelPath);
      res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${record.originalName}"`
      );
      res.send(buffer);
    })
  );

  router.post(
    '/milestones/confirm',
    asyncHandler(async (req, res) => {
      const authCtx = await requireFirmStaffForPortal(req);
      const input = ConfirmMilestoneSchema.parse(req.body);
      const milestone = await deps.portalStore.confirmMilestone({
        tenantId: authCtx.tenantId,
        requestId: input.requestId,
        title: input.title,
        confirmedBy: authCtx.userName,
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'portal.milestone_confirmed',
        details: `Published confirmed milestone "${milestone.title}" on ${milestone.requestId}`,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: milestone.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'milestone_confirmed',
          milestoneId: milestone.id,
          requestId: milestone.requestId,
          title: milestone.title,
        },
      });

      res.status(201).json({ milestone });
    })
  );

  router.post(
    '/milestones/:milestoneId/withdraw',
    asyncHandler(async (req, res) => {
      const authCtx = await requireFirmStaffForPortal(req);
      const input = WithdrawMilestoneSchema.parse(req.body);
      const out = await deps.portalStore.withdrawMilestone({
        tenantId: authCtx.tenantId,
        milestoneId: req.params.milestoneId,
        reason: input.reason,
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'portal.milestone_withdrawn',
        details: `Withdrew milestone ${req.params.milestoneId}: ${input.reason}`,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: authCtx.userId,
        affectedClientId: out.clientId,
        eventType: 'portal:updated',
        meta: {
          portalVisible: true,
          kind: 'milestone_withdrawn',
          milestoneId: out.milestoneId,
          reason: input.reason,
        },
      });

      res.json(out);
    })
  );

  return router;
}
