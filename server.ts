import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import JSZip from 'jszip';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import {
  extractBearerToken,
  RequestAuthContext,
  verifyFirebaseIdToken,
} from './server/auth.ts';
import { EngineSQLStore } from './server/engineStore.ts';
import {
  readPortableFileFromDisk,
  savePortableFileToDisk,
} from './server/fileStorage.ts';
import { ShiftPattern, UserRole } from './src/engine/types.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class HttpAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const VALID_ROLES = new Set<UserRole>([
  'accountant',
  'team_lead',
  'line_manager',
  'executive',
  'client',
  'admin_it',
]);

function normalizeRole(raw: unknown, fallback: UserRole = 'accountant'): UserRole {
  return typeof raw === 'string' && VALID_ROLES.has(raw as UserRole)
    ? (raw as UserRole)
    : fallback;
}

interface EngineSubscriber {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  role: UserRole;
}

async function resolveAuthContext(params: {
  engineStore: EngineSQLStore;
  authHeader?: string | string[];
  queryToken?: string | string[];
  requestedTenantId?: string;
  previewRole?: unknown;
  previewUserId?: unknown;
}): Promise<RequestAuthContext> {
  const {
    engineStore,
    authHeader,
    queryToken,
    requestedTenantId,
    previewRole,
    previewUserId,
  } = params;
  const token = extractBearerToken(authHeader, queryToken);
  const reqTenant =
    requestedTenantId === 'firm_demo'
      ? 'firm_demo'
      : requestedTenantId === 'firm_apex'
      ? 'firm_apex'
      : requestedTenantId || 'firm_apex';

  // 1. Enrolled Desktop Agent Device Token (cf_dev_*)
  if (token && token.startsWith('cf_dev_')) {
    const verified = await engineStore.verifyDeviceToken(token);
    if (!verified) {
      throw new HttpAuthError(401, 'Invalid or revoked device pairing token');
    }
    return {
      mode: 'device',
      tenantId: verified.tenantId,
      userId: verified.userId,
      userEmail: verified.email,
      role: verified.role,
      deviceId: verified.deviceId,
      isDemoSandbox: verified.tenantId === 'firm_demo',
    };
  }

  // 2. Firebase Auth ID Token (RS256 verified against Google JWKS)
  if (token) {
    let claims;
    try {
      claims = await verifyFirebaseIdToken(token);
    } catch (err: any) {
      throw new HttpAuthError(
        401,
        err?.message || 'Invalid Firebase authentication token'
      );
    }

    if (!claims.emailVerified) {
      throw new HttpAuthError(403, 'Verified email required for live firm access');
    }

    if (reqTenant === 'firm_demo') {
      const demoRole = normalizeRole(previewRole, 'accountant');
      const demoUser =
        typeof previewUserId === 'string' && previewUserId.startsWith('demo_')
          ? previewUserId
          : 'demo_u_acc_01';
      return {
        mode: 'demo',
        tenantId: 'firm_demo',
        userId: demoUser,
        userEmail: claims.email,
        role: demoRole,
        isDemoSandbox: true,
      };
    }

    const shiftUser = await engineStore.ensureFirebaseShiftUser({
      tenantId: 'firm_apex',
      uid: claims.uid,
      email: claims.email,
      name: claims.name,
    });

    // Only Admin/IT in the live firm can optionally inspect VIS-1 role views via previewRole
    const effectiveRole =
      shiftUser.role === 'admin_it' && typeof previewRole === 'string'
        ? normalizeRole(previewRole, shiftUser.role)
        : shiftUser.role;
    const effectiveUserId =
      shiftUser.role === 'admin_it' &&
      typeof previewUserId === 'string' &&
      previewUserId.trim()
        ? previewUserId.trim()
        : shiftUser.userId;

    return {
      mode: 'firebase',
      tenantId: 'firm_apex',
      userId: effectiveUserId,
      userEmail: shiftUser.email,
      role: effectiveRole,
      isDemoSandbox: false,
    };
  }

  // 3. Unauthenticated Demo Sandbox (strictly isolated to firm_demo)
  if (reqTenant === 'firm_demo') {
    const demoRole = normalizeRole(previewRole, 'accountant');
    const demoUser =
      typeof previewUserId === 'string' && previewUserId.startsWith('demo_')
        ? previewUserId
        : 'demo_u_acc_01';
    return {
      mode: 'demo',
      tenantId: 'firm_demo',
      userId: demoUser,
      userEmail: 'demo@apex-cpa.example',
      role: demoRole,
      isDemoSandbox: true,
    };
  }

  throw new HttpAuthError(
    401,
    'Authentication required for live firm tenant (firm_apex). Sign in or switch to Demo Sandbox (firm_demo).'
  );
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = Number(process.env.PORT || 3000);
  const engineStore = new EngineSQLStore();
  await engineStore.ready();

  // Hourly background raw event retention sweep (30-90d policy)
  const retentionTimer = setInterval(() => {
    void engineStore.purgeExpiredRawEvents('firm_apex');
    void engineStore.purgeExpiredRawEvents('firm_demo');
  }, 60 * 60 * 1000);
  retentionTimer.unref();

  const subscribers = new Set<EngineSubscriber>();
  const wss = new WebSocketServer({ server, path: '/ws/engine' });

  const broadcastEngineUpdate = (
    tenantId: string,
    affectedUserId: string,
    eventType: 'state:updated' | 'activity:updated' | 'freshness:updated',
    meta: Record<string, unknown> = {}
  ) => {
    const startedMs = performance.now();
    const sentAt = new Date().toISOString();
    let sentCount = 0;

    for (const sub of subscribers) {
      if (sub.ws.readyState !== WebSocket.OPEN) continue;
      if (sub.tenantId !== tenantId) continue;

      // VIS-1: Enforce row-level visibility on real-time WebSocket push
      const isSelf = sub.userId === affectedUserId;
      if (sub.role === 'accountant' && !isSelf) continue;
      if (sub.role === 'client' && eventType === 'activity:updated') continue;
      if (sub.role === 'admin_it' && eventType === 'activity:updated') continue;

      sub.ws.send(
        JSON.stringify({
          channel: 'engine',
          type: eventType,
          tenantId,
          affectedUserId,
          sentAtUtc: sentAt,
          ...meta,
        })
      );
      sentCount++;
    }

    if (sentCount > 0) {
      engineStore.recordBroadcastLatency(performance.now() - startedMs);
    }
  };

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/ws/engine', 'http://localhost:3000');
    const requestedTenantId = url.searchParams.get('tenantId') || 'firm_demo';
    const previewRole = url.searchParams.get('previewRole') || url.searchParams.get('role');
    const previewUserId =
      url.searchParams.get('previewUserId') || url.searchParams.get('userId');

    let authCtx: RequestAuthContext;
    try {
      authCtx = await resolveAuthContext({
        engineStore,
        authHeader: req.headers.authorization,
        queryToken: url.searchParams.get('token') || undefined,
        requestedTenantId,
        previewRole,
        previewUserId,
      });
    } catch (err: any) {
      ws.close(4401, err?.message || 'Unauthorized WebSocket connection');
      return;
    }

    const sub: EngineSubscriber = {
      ws,
      tenantId: authCtx.tenantId,
      userId: authCtx.userId,
      role: authCtx.role,
    };
    subscribers.add(sub);

    ws.send(
      JSON.stringify({
        channel: 'engine',
        type: 'connected',
        serverTimeUtc: new Date().toISOString(),
        tenantId: authCtx.tenantId,
        userId: authCtx.userId,
        role: authCtx.role,
        authMode: authCtx.mode,
      })
    );

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'sync:batch' && Array.isArray(msg.events)) {
          const t0 = performance.now();
          const targetUserId =
            authCtx.mode === 'device'
              ? authCtx.userId
              : authCtx.isDemoSandbox && typeof msg.userId === 'string'
              ? msg.userId
              : authCtx.userId;

          const result = await engineStore.ingestEventBatch({
            tenantId: authCtx.tenantId,
            userId: targetUserId,
            deviceId: authCtx.deviceId || String(msg.deviceId || 'dev-web-client'),
            events: msg.events,
          });
          engineStore.recordBroadcastLatency(performance.now() - t0);

          ws.send(JSON.stringify({ type: 'sync:ack', ...result }));
          if (result.stateChanged) {
            broadcastEngineUpdate(authCtx.tenantId, targetUserId, 'state:updated', {
              lastAckSeq: result.lastAckSeq,
              lateBacklogUpdated: result.lateBacklogUpdated,
            });
          } else if (result.acceptedCount > 0) {
            broadcastEngineUpdate(authCtx.tenantId, targetUserId, 'activity:updated', {
              lastAckSeq: result.lastAckSeq,
            });
          }
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', serverTimeUtc: new Date().toISOString() }));
        }
      } catch {
        // Ignore malformed WS message
      }
    });

    ws.on('close', () => {
      subscribers.delete(sub);
    });
  });

  app.use(express.json({ limit: '8mb' }));

  // Helper wrapper for authenticated engine handlers
  async function authenticateRequest(
    req: express.Request,
    fallbackTenant: string = 'firm_apex'
  ): Promise<RequestAuthContext> {
    const requestedTenantId =
      (typeof req.query.tenantId === 'string' && req.query.tenantId) ||
      (typeof req.body?.tenantId === 'string' && req.body.tenantId) ||
      fallbackTenant;

    return resolveAuthContext({
      engineStore,
      authHeader: req.headers.authorization,
      queryToken: req.query.token as string | undefined,
      requestedTenantId,
      previewRole: req.query.previewRole || req.query.viewerRole || req.body?.previewRole,
      previewUserId:
        req.query.previewUserId || req.query.viewerUserId || req.body?.previewUserId,
    });
  }

  function handleRouteError(res: express.Response, err: any, fallbackMsg: string) {
    if (err instanceof HttpAuthError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(400).json({ error: err?.message || fallbackMsg });
  }

  // Server-side Gemini API endpoint for automated Weekly Progress Reports
  app.post('/api/reports/generate', async (req, res) => {
    try {
      const {
        weekStartDate,
        weekEndDate,
        tone = 'executive',
        tasks = [],
        timeBlocks = [],
        appSummary = [],
        docSummary = [],
        metrics = {},
      } = req.body;

      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
        return res.status(503).json({
          error: 'GEMINI_API_KEY is not configured on the server.',
          fallbackRecommended: true,
        });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      const toneDescriptions: Record<string, string> = {
        executive:
          'Write in a crisp, high-signal executive brief tone focusing on strategic outcomes, delivery velocity, and resource allocation.',
        standup:
          'Write in an engineering team review tone focusing on technical milestones shipped, estimation accuracy, and concrete blockers.',
        client:
          'Write in a transparent client-facing consultant tone emphasizing billable deliverables, hours invested per workstream, and upcoming milestones.',
      };

      const prompt = `Generate a comprehensive Weekly Progress Report for the week of ${weekStartDate} to ${weekEndDate}.
Tone Instruction: ${toneDescriptions[tone] || toneDescriptions.executive}

Weekly Quantitative Metrics:
- Total Logged Time: ${metrics.totalHours ?? 0} hours (${metrics.totalMinutes ?? 0} mins)
- Planned Estimate across active/completed tasks: ${metrics.plannedHours ?? 0} hours
- Deep Work Share: ${metrics.deepWorkPercent ?? 0}%
- Billable Share: ${metrics.billablePercent ?? 0}%
- Tasks Completed: ${metrics.completedCount ?? 0} of ${metrics.totalTasksCount ?? 0}

Tasks Dataset:
${JSON.stringify(
  tasks.map((t: any) => ({
    title: t.title,
    project: t.project,
    status: t.status,
    priority: t.priority,
    category: t.category,
    estimatedMinutes: t.estimatedMinutes,
    loggedMinutes: t.loggedMinutes,
    blockerNote: t.blockerNote || null,
  })),
  null,
  2
)}

Timeline Blocks Summary:
${JSON.stringify(
  timeBlocks.slice(0, 40).map((b: any) => ({
    date: b.date,
    title: b.title,
    project: b.project,
    category: b.category,
    durationMinutes: b.durationMinutes,
    tags: b.tags,
    notes: b.notes,
  })),
  null,
  2
)}

Top Applications Used (ManicTime Capture):
${JSON.stringify(appSummary.slice(0, 10), null, 2)}

Top Documents & Files Opened (ManicTime Capture):
${JSON.stringify(docSummary.slice(0, 15), null, 2)}

Synthesize this activity into a concrete, accurate weekly review without inventing fake projects. Reference actual task titles, projects, hours, applications, documents, and blockers from the provided dataset.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an analytical engineering and operations chief of staff. You turn raw daily task and ManicTime-style timeline logs into structured, high-clarity weekly progress reports.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              executiveSummary: {
                type: Type.STRING,
                description:
                  'A 2-3 sentence high-signal narrative summary of the week, highlighting total focus hours, primary deliverables, and overall momentum.',
              },
              accomplishments: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  '3 to 5 specific bullet points detailing completed tasks and major progress milestones with concrete time/project context.',
              },
              blockersAndRisks: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  '2 to 4 specific blockers, over-estimate tasks, or context-switching risks identified from the logs.',
              },
              velocityInsights: {
                type: Type.STRING,
                description:
                  'Analysis of planned vs. actual time, deep work ratio, and daily pacing across the week.',
              },
              nextWeekFocus: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  '3 to 4 recommended priority actions and carry-over tasks for next week.',
              },
            },
            required: [
              'executiveSummary',
              'accomplishments',
              'blockersAndRisks',
              'velocityInsights',
              'nextWeekFocus',
            ],
          },
        },
      });

      const rawText = response.text || '{}';
      const parsed = JSON.parse(rawText.trim());
      return res.json({ report: parsed });
    } catch (error: any) {
      console.error('Error generating weekly report via Gemini:', error);
      return res.status(500).json({
        error: error?.message || 'Failed to generate AI weekly report.',
        fallbackRecommended: true,
      });
    }
  });

  // =========================================================================
  // Automated Tracking & Attribution Engine REST + Polling Endpoints
  // =========================================================================

  app.get('/api/engine/snapshot', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const targetUserId = String(req.query.targetUserId || authCtx.userId);
      const drilldownGranted = req.query.drilldown === 'true';

      const snapshot = await engineStore.getEngineSnapshot({
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
        targetUserId,
        drilldownGranted,
        authMode: authCtx.mode,
      });
      return res.json(snapshot);
    } catch (err: any) {
      return handleRouteError(res, err, 'Snapshot error');
    }
  });

  // HTTPS Polling Fallback for restrictive proxies
  app.get('/api/engine/poll', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const targetUserId = String(req.query.targetUserId || authCtx.userId);
      const drilldownGranted = req.query.drilldown === 'true';

      const snapshot = await engineStore.getEngineSnapshot({
        tenantId: authCtx.tenantId,
        viewerUserId: authCtx.userId,
        viewerRole: authCtx.role,
        targetUserId,
        drilldownGranted,
        authMode: authCtx.mode,
      });
      return res.json({
        transport: 'https-poll',
        serverTimeUtc: new Date().toISOString(),
        ...snapshot,
      });
    } catch (err: any) {
      return handleRouteError(res, err, 'Poll error');
    }
  });

  // Desktop Agent Bootstrap: dynamic privacy rules + server time for clock skew calibration
  app.get('/api/engine/agent/bootstrap', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_apex');
      const config = await engineStore.getTenantConfig(authCtx.tenantId);
      const privacyRules = await engineStore.getPrivacyRules(authCtx.tenantId);
      return res.json({
        serverTimeUtc: new Date().toISOString(),
        tenantId: authCtx.tenantId,
        userId: authCtx.userId,
        deviceId: authCtx.deviceId || null,
        config,
        privacyRules: privacyRules.filter((r) => r.enabled),
      });
    } catch (err: any) {
      return handleRouteError(res, err, 'Agent bootstrap failed');
    }
  });

  app.post('/api/engine/sync', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const { deviceId = 'dev-web-client', events = [] } = req.body || {};

      if (!Array.isArray(events)) {
        return res.status(400).json({ error: 'events array required' });
      }

      const targetUserId =
        authCtx.mode === 'device'
          ? authCtx.userId
          : authCtx.isDemoSandbox && typeof req.body?.userId === 'string'
          ? String(req.body.userId)
          : authCtx.userId;

      const t0 = performance.now();
      const result = await engineStore.ingestEventBatch({
        tenantId: authCtx.tenantId,
        userId: targetUserId,
        deviceId: authCtx.deviceId || String(deviceId),
        events,
      });
      engineStore.recordBroadcastLatency(performance.now() - t0);

      if (result.stateChanged) {
        broadcastEngineUpdate(authCtx.tenantId, targetUserId, 'state:updated', {
          lastAckSeq: result.lastAckSeq,
          lateBacklogUpdated: result.lateBacklogUpdated,
        });
      } else if (result.acceptedCount > 0) {
        broadcastEngineUpdate(authCtx.tenantId, targetUserId, 'activity:updated', {
          lastAckSeq: result.lastAckSeq,
        });
      }

      return res.json(result);
    } catch (err: any) {
      return handleRouteError(res, err, 'Sync error');
    }
  });

  // Staff Directory & RBAC Endpoints
  app.get('/api/engine/staff', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      if (
        authCtx.role !== 'admin_it' &&
        authCtx.role !== 'team_lead' &&
        authCtx.role !== 'executive'
      ) {
        return res.status(403).json({ error: 'Insufficient role permissions' });
      }
      const staff = await engineStore.listShiftUsers(authCtx.tenantId);
      return res.json({ staff });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to load staff');
    }
  });

  app.post('/api/engine/staff/import', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      if (authCtx.role !== 'admin_it' && !authCtx.isDemoSandbox) {
        return res.status(403).json({ error: 'Only Admin/IT can import staff CSV' });
      }
      const rawText = String(req.body?.rawText || '');
      if (!rawText.trim()) {
        return res.status(400).json({ error: 'CSV content is empty' });
      }
      const staff = await engineStore.importStaffFromCsv(authCtx.tenantId, rawText);
      await engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'staff.import',
        details: `Imported/updated ${staff.length} staff roster entries via CSV`,
      });
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ importedCount: staff.length, staff });
    } catch (err: any) {
      return handleRouteError(res, err, 'Staff import failed');
    }
  });

  app.patch('/api/engine/staff/:userId/role', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      if (authCtx.role !== 'admin_it' && !authCtx.isDemoSandbox) {
        return res.status(403).json({ error: 'Only Admin/IT can update staff roles' });
      }
      const role = normalizeRole(req.body?.role);
      const shiftPattern = req.body?.shiftPattern as ShiftPattern | undefined;
      const onLeave =
        req.body?.onLeave !== undefined ? Boolean(req.body.onLeave) : undefined;
      await engineStore.updateShiftUserRole(
        authCtx.tenantId,
        req.params.userId,
        role,
        shiftPattern,
        onLeave
      );
      await engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: req.params.userId,
        action: 'staff.role_updated',
        details: `Updated role for ${req.params.userId} to ${role}`,
      });
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to update staff role');
    }
  });

  // Device Pairing Key Endpoints (AUTH-1)
  app.get('/api/engine/devices', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const tokens = await engineStore.listDeviceTokens(authCtx.tenantId);
      const filtered =
        authCtx.role === 'admin_it'
          ? tokens
          : tokens.filter((t) => t.userId === authCtx.userId);
      return res.json({ tokens: filtered });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to list device tokens');
    }
  });

  app.post('/api/engine/devices/pair', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const requestedUserId = String(req.body?.userId || authCtx.userId);
      const targetUserId =
        authCtx.role === 'admin_it' ? requestedUserId : authCtx.userId;
      const deviceId =
        String(req.body?.deviceId || '').trim() ||
        `dev-${targetUserId}-${Date.now().toString(36)}`;
      const label = String(req.body?.label || 'Workstation Agent').trim();

      const created = await engineStore.createDeviceToken({
        tenantId: authCtx.tenantId,
        userId: targetUserId,
        deviceId,
        label,
      });

      await engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId,
        action: 'device.paired',
        details: `Issued SHA-256 pairing token ${created.record.prefix}... for ${deviceId}`,
      });

      return res.json(created);
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to pair device');
    }
  });

  app.delete('/api/engine/devices/:tokenId', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      await engineStore.revokeDeviceToken(authCtx.tenantId, req.params.tokenId);
      await engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'device.revoked',
        details: `Revoked device pairing token ${req.params.tokenId}`,
      });
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to revoke device token');
    }
  });

  app.post('/api/engine/clients', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const body = req.body || {};
      if (!body.legalName || typeof body.legalName !== 'string') {
        return res.status(400).json({ error: 'legalName is required' });
      }
      const created = await engineStore.addOrUpdateClient({
        id: body.id,
        tenantId: authCtx.tenantId,
        legalName: body.legalName.trim(),
        aliases: Array.isArray(body.aliases) ? body.aliases : [],
        codes: Array.isArray(body.codes) ? body.codes : [],
        folderPatterns: Array.isArray(body.folderPatterns) ? body.folderPatterns : [],
        knownDomains: Array.isArray(body.knownDomains) ? body.knownDomains : [],
        restrictedUserIds: Array.isArray(body.restrictedUserIds)
          ? body.restrictedUserIds
          : [],
        source: body.source || 'manual',
      });
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ client: created });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to save client');
    }
  });

  app.post('/api/engine/clients/import', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const { rawText = '', source = 'csv' } = req.body || {};
      if (typeof rawText !== 'string' || !rawText.trim()) {
        return res.status(400).json({ error: 'Import file content is empty' });
      }
      const imported = await engineStore.importClientsFromRaw(
        authCtx.tenantId,
        rawText,
        source === 'file_upload' ? 'file_upload' : 'csv'
      );
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ importedCount: imported.length, clients: imported });
    } catch (err: any) {
      return handleRouteError(res, err, 'Import failed');
    }
  });

  app.delete('/api/engine/clients/:id', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      await engineStore.deleteClient(authCtx.tenantId, req.params.id);
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Delete failed');
    }
  });

  app.post('/api/engine/activity-rules', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const {
        keyword,
        activityType,
        workCategory = 'billable',
        weight = 8,
      } = req.body || {};
      if (!keyword || !activityType) {
        return res.status(400).json({ error: 'keyword and activityType required' });
      }
      const created = await engineStore.addActivityRule({
        tenantId: authCtx.tenantId,
        keyword: String(keyword),
        activityType: String(activityType),
        workCategory,
        weight: Number(weight) || 8,
      });
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ rule: created });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to add activity rule');
    }
  });

  app.delete('/api/engine/activity-rules/:id', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      await engineStore.deleteActivityRule(authCtx.tenantId, req.params.id);
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to delete activity rule');
    }
  });

  app.post('/api/engine/privacy-rules', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const { kind = 'domain', pattern, reason = 'Custom Exclusion' } = req.body || {};
      if (!pattern) {
        return res.status(400).json({ error: 'pattern required' });
      }
      const rule = await engineStore.addPrivacyRule({
        tenantId: authCtx.tenantId,
        kind,
        pattern: String(pattern),
        reason: String(reason),
        enabled: true,
      });
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ rule });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to add privacy rule');
    }
  });

  app.patch('/api/engine/privacy-rules/:id', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      await engineStore.togglePrivacyRule(
        authCtx.tenantId,
        req.params.id,
        Boolean(req.body?.enabled)
      );
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to toggle privacy rule');
    }
  });

  app.delete('/api/engine/privacy-rules/:id', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      await engineStore.deletePrivacyRule(authCtx.tenantId, req.params.id);
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to delete privacy rule');
    }
  });

  app.patch('/api/engine/config', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const updated = await engineStore.updateTenantConfig(
        authCtx.tenantId,
        req.body || {}
      );
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ config: updated });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to update config');
    }
  });

  app.post('/api/engine/tasks', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const b = req.body || {};
      if (!b.title || !b.clientId) {
        return res.status(400).json({ error: 'title and clientId required' });
      }
      const created = await engineStore.createEngineTask({
        tenantId: authCtx.tenantId,
        clientId: String(b.clientId),
        clientName: String(b.clientName || 'Client'),
        templateId: b.templateId || `${authCtx.tenantId === 'firm_demo' ? 'demo_' : ''}tpl-monthly-close`,
        title: String(b.title),
        period: String(b.period || 'Oct 2026'),
        status: b.status || 'todo',
        dueDateUtc: b.dueDateUtc || new Date().toISOString(),
        assignedUserId: String(b.assignedUserId || authCtx.userId),
        estimatedMinutes: Number(b.estimatedMinutes) || 120,
      });
      broadcastEngineUpdate(authCtx.tenantId, created.assignedUserId, 'state:updated');
      return res.json({ task: created });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to create task');
    }
  });

  app.post('/api/engine/attributions/:sessionId/resolve', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
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

      await engineStore.resolveAttribution({
        tenantId: authCtx.tenantId,
        userId: resolvedUserId,
        sessionId: req.params.sessionId,
        taskId,
        status,
        customReason,
        createRulePattern,
        rejectRulePattern,
      });
      broadcastEngineUpdate(authCtx.tenantId, resolvedUserId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to resolve attribution');
    }
  });

  app.post('/api/engine/checklists', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const { item } = req.body || {};
      if (!item || !item.id) {
        return res.status(400).json({ error: 'checklist item required' });
      }
      await engineStore.updateChecklistItem({ tenantId: authCtx.tenantId, item });
      broadcastEngineUpdate(
        authCtx.tenantId,
        item.userId || authCtx.userId,
        'state:updated'
      );
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to save checklist item');
    }
  });

  app.post('/api/engine/checklists/merge', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const { taskId, itemsToMerge = [], mergedTitle } = req.body || {};
      if (!taskId || !Array.isArray(itemsToMerge) || itemsToMerge.length < 2) {
        return res
          .status(400)
          .json({ error: 'taskId and at least 2 checklist items are required' });
      }
      const merged = await engineStore.mergeChecklistItems({
        tenantId: authCtx.tenantId,
        userId: String(itemsToMerge[0].userId || authCtx.userId),
        taskId: String(taskId),
        itemsToMerge,
        mergedTitle,
      });
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ item: merged });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to merge checklist items');
    }
  });

  app.post('/api/engine/checklists/reorder', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const { items = [] } = req.body || {};
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'items array required' });
      }
      await engineStore.reorderChecklistItems({ tenantId: authCtx.tenantId, items });
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to reorder checklist items');
    }
  });

  app.delete('/api/engine/checklists/:id', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      await engineStore.deleteChecklistItem(authCtx.tenantId, req.params.id);
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to delete checklist item');
    }
  });

  app.post('/api/engine/conflicts/:id/resolve', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const { resolution = 'keep_local' } = req.body || {};
      await engineStore.resolveConflict(
        authCtx.tenantId,
        req.params.id,
        resolution === 'keep_server' ? 'keep_server' : 'keep_local'
      );
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ ok: true });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to resolve conflict');
    }
  });

  app.post('/api/engine/retention/purge', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const out = await engineStore.purgeExpiredRawEvents(authCtx.tenantId);
      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json(out);
    } catch (err: any) {
      return handleRouteError(res, err, 'Retention purge failed');
    }
  });

  // Portable Local Server File Vault with Audit Trail
  app.get('/api/engine/files', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const files = await engineStore.listStoredFiles(authCtx.tenantId);
      return res.json({ files });
    } catch (err: any) {
      return handleRouteError(res, err, 'Failed to list files');
    }
  });

  app.post('/api/engine/files', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const {
        originalName,
        mimeType = 'application/octet-stream',
        purpose = 'client_document',
        contentBase64,
      } = req.body || {};
      if (!originalName || !contentBase64 || typeof contentBase64 !== 'string') {
        return res
          .status(400)
          .json({ error: 'originalName and contentBase64 are required' });
      }
      const buffer = Buffer.from(contentBase64, 'base64');
      const saved = savePortableFileToDisk({
        tenantId: authCtx.tenantId,
        originalName: String(originalName),
        contentBuffer: buffer,
      });

      const created = await engineStore.saveStoredFileMetadata({
        fileId: saved.fileId,
        tenantId: authCtx.tenantId,
        uploaderUserId: authCtx.userId,
        uploaderEmail: authCtx.userEmail,
        purpose:
          purpose === 'client_csv' || purpose === 'firm_branding'
            ? purpose
            : 'client_document',
        originalName: saved.safeOriginalName,
        storedRelPath: saved.storedRelPath,
        mimeType: String(mimeType),
        byteSize: saved.byteSize,
        sha256: saved.sha256,
        createdAtUtc: new Date().toISOString(),
      });

      await engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: null,
        action: 'file.uploaded',
        details: `Stored ${created.originalName} (${created.byteSize} bytes · sha256:${created.sha256.slice(0, 12)})`,
      });

      broadcastEngineUpdate(authCtx.tenantId, authCtx.userId, 'state:updated');
      return res.json({ file: created });
    } catch (err: any) {
      return handleRouteError(res, err, 'File upload failed');
    }
  });

  app.get('/api/engine/files/:fileId/download', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const record = await engineStore.getStoredFile(
        authCtx.tenantId,
        req.params.fileId
      );
      if (!record) {
        return res.status(404).json({ error: 'Stored file not found' });
      }
      const buffer = readPortableFileFromDisk(record.storedRelPath);

      await engineStore.recordAuditLog({
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
      return res.send(buffer);
    } catch (err: any) {
      return handleRouteError(res, err, 'File download failed');
    }
  });

  app.post('/api/engine/replay', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const userId = String(req.body?.userId || authCtx.userId);
      const replay = await engineStore.runSimulationAndReplay(authCtx.tenantId, userId);
      return res.json(replay);
    } catch (err: any) {
      return handleRouteError(res, err, 'Replay failed');
    }
  });

  app.get('/api/engine/acceptance', async (req, res) => {
    try {
      const authCtx = await authenticateRequest(req, 'firm_demo');
      const report = await engineStore.runAcceptanceChecks(authCtx.tenantId);
      return res.json(report);
    } catch (err: any) {
      return handleRouteError(res, err, 'Acceptance check failed');
    }
  });

  // Export configured Desktop Agent or MV3 Browser Extension as a .zip bundle
  app.get('/api/engine/package/:kind', async (req, res) => {
    try {
      const kind = req.params.kind;
      if (kind !== 'desktop-agent' && kind !== 'browser-extension') {
        return res.status(400).json({ error: 'Invalid package kind' });
      }
      const packagesRoot = path.resolve(__dirname, 'packages');
      const targetDir = path.resolve(packagesRoot, kind);
      if (!targetDir.startsWith(packagesRoot + path.sep)) {
        return res.status(403).json({ error: 'Invalid package path' });
      }

      const serverUrl = String(
        req.query.serverUrl || process.env.APP_URL || 'http://localhost:3000'
      );
      const tenantId = String(req.query.tenantId || 'firm_apex');
      const userId = String(req.query.userId || 'u_acc_01');
      const deviceToken =
        typeof req.query.deviceToken === 'string' ? req.query.deviceToken : '';

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
              tenantId,
              userId,
              deviceId: `dev-${userId}`,
              deviceToken,
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
      return res.send(buffer);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Package export failed' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(
      `onTrack server + WebSocket gateway running on http://0.0.0.0:${PORT} (dialect=${engineStore.db.dialect})`
    );
  });
}

startServer();
