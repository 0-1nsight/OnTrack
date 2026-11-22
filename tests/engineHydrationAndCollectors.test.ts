import fs from 'node:fs';
import http from 'node:http';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-hydration-collectors-${Date.now()}`;
  process.env.DEMO_MODE = 'true';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';
import { createBridgeRequestHandler } from '../packages/desktop-agent/src/bridge.ts';
import { createDemoWorkspaceDataset } from '../src/utils/demoWorkspaceSeed.ts';
import {
  adaptEngineSnapshotToWorkspace,
  mapEngineTaskToWorkspaceTask,
  toLocalDateString,
} from '../src/utils/engineWorkspaceAdapter.ts';
import { EngineSnapshot } from '../src/services/engineClient.ts';

async function readZipBuffer(res: request.Response): Promise<Buffer> {
  if (Buffer.isBuffer(res.body)) return res.body;
  if (typeof res.text === 'string') return Buffer.from(res.text, 'binary');
  throw new Error('Expected binary response body');
}

describe('Engine Hydration, Task CRUD, Package Bundles & Authenticated Loopback Bridge', () => {
  let ctx: Awaited<ReturnType<typeof createOnTrackServer>>;

  beforeAll(async () => {
    ctx = await createOnTrackServer({
      dbPath: ':memory:',
      seedDemo: true,
      disableVite: true,
    });
  });

  afterAll(async () => {
    await ctx?.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('persists EngineSQLStore task CRUD cleanly and enforces tenant isolation', async () => {
    const created = await ctx.engineStore.createEngineTask({
      tenantId: 'tenant_alpha',
      clientId: 'cli_custom_alpha',
      clientName: 'Alpha Holdings LLC',
      title: 'Q3 Sales Tax Filing',
      period: 'Q3 2026',
      status: 'todo',
      dueDateUtc: '2026-11-30T17:00:00.000Z',
      assignedUserId: 'u_alpha_1',
      estimatedMinutes: 90,
    });

    expect(created.id).toBeTruthy();
    expect(created.tenantId).toBe('tenant_alpha');
    expect(created.version).toBe(1);

    // Cross-tenant update/delete must fail cleanly
    await expect(
      ctx.engineStore.updateEngineTask({
        tenantId: 'tenant_beta',
        taskId: created.id,
        updates: { title: 'Tampered Title' },
      })
    ).rejects.toThrow(/Task not found/);

    const updated = await ctx.engineStore.updateEngineTask({
      tenantId: 'tenant_alpha',
      taskId: created.id,
      updates: {
        title: 'Q3 Sales Tax Filing (Amended)',
        status: 'in_progress',
        estimatedMinutes: 120,
      },
    });
    expect(updated.title).toBe('Q3 Sales Tax Filing (Amended)');
    expect(updated.status).toBe('in_progress');
    expect(updated.estimatedMinutes).toBe(120);
    expect(updated.version).toBe(2);

    const alphaTasks = await ctx.engineStore.getTasks('tenant_alpha');
    expect(alphaTasks.some((t) => t.id === created.id)).toBe(true);
    const betaTasks = await ctx.engineStore.getTasks('tenant_beta');
    expect(betaTasks.some((t) => t.id === created.id)).toBe(false);

    await expect(
      ctx.engineStore.deleteEngineTask({
        tenantId: 'tenant_beta',
        taskId: created.id,
      })
    ).rejects.toThrow(/Task not found/);

    await ctx.engineStore.deleteEngineTask({
      tenantId: 'tenant_alpha',
      taskId: created.id,
    });

    const alphaTasksAfterDelete = await ctx.engineStore.getTasks('tenant_alpha');
    expect(alphaTasksAfterDelete.some((t) => t.id === created.id)).toBe(false);
  });

  it('supports live HTTP task CRUD & /api/engine/sync round-trip into /api/engine/snapshot', async () => {
    const loginRes = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_acc_01' });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers['set-cookie'];

    const createRes = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', cookie)
      .send({
        project: 'Harbor Health',
        title: 'Monthly Payroll Reconciliation',
        period: 'Nov 2026',
        estimatedMinutes: 75,
      });
    expect(createRes.status).toBe(200);
    const taskId = createRes.body.task.id as string;
    expect(createRes.body.task.status).toBe('todo');
    expect(createRes.body.task.assignedUserId).toBe('demo_u_acc_01');

    const patchRes = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(taskId)}`)
      .set('Cookie', cookie)
      .send({ status: 'in_progress', estimatedMinutes: 105 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.task.status).toBe('in_progress');
    expect(patchRes.body.task.estimatedMinutes).toBe(105);

    const eventIso = new Date().toISOString();
    const syncRes = await request(ctx.app)
      .post('/api/engine/sync')
      .set('Cookie', cookie)
      .send({
        deviceId: 'dev-hydration-test',
        events: [
          {
            event_id: `ev-win-${Date.now()}`,
            schema_version: 1,
            tenant_id: 'firm_demo',
            user_id: 'demo_u_acc_01',
            device_id: 'dev-hydration-test',
            seq: 1,
            type: 'activity.window',
            priority: 'activity',
            event_time_utc: eventIso,
            received_at: null,
            payload: {
              app: 'Microsoft Excel',
              window_title: 'Harbor_Health_Payroll_Nov2026.xlsx',
              file_path: 'Clients/Harbor_Health/Payroll_Nov2026.xlsx',
              duration_ms: 900000,
            },
          },
        ],
      });
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.acceptedCount).toBe(1);

    const snapRes = await request(ctx.app)
      .get('/api/engine/snapshot')
      .set('Cookie', cookie);
    expect(snapRes.status).toBe(200);
    const snap = snapRes.body as EngineSnapshot;
    expect(snap.tasks.some((t) => t.id === taskId && t.status === 'in_progress')).toBe(true);
    expect(
      snap.sessions.some((s) => s.primaryTitle === 'Harbor_Health_Payroll_Nov2026.xlsx')
    ).toBe(true);

    // Adapter turns sessions + tasks cleanly into Timeline/Tasks workspace state
    const adapted = adaptEngineSnapshotToWorkspace({
      snapshot: snap,
      existingTasks: [],
      existingBlocks: [],
      existingActivity: [],
      existingApps: [],
      existingDocs: [],
      boards: [],
      includeAllSessionBlocks: true,
    });
    expect(adapted.tasks.some((t) => t.id === taskId && t.status === 'in_progress')).toBe(true);
    expect(adapted.timeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(adapted.appSegments.length + adapted.documentSegments.length).toBeGreaterThanOrEqual(1);

    const deleteRes = await request(ctx.app)
      .delete(`/api/engine/tasks/${encodeURIComponent(taskId)}`)
      .set('Cookie', cookie);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);
  });

  it('builds valid EngineTask and demo dataset objects in engineWorkspaceAdapter & demoWorkspaceSeed', () => {
    const mapped = mapEngineTaskToWorkspaceTask({
      id: 'tsk-sample-1',
      tenantId: 'firm_demo',
      clientId: 'cli_acme',
      clientName: 'Acme Ltd',
      title: 'VAT Quarterly Return',
      period: 'Q4 2026',
      status: 'blocked',
      dueDateUtc: '2026-12-15T17:00:00.000Z',
      assignedUserId: 'demo_u_acc_01',
      estimatedMinutes: 120,
      version: 1,
      updatedAtUtc: '2026-11-22T12:00:00.000Z',
    });
    expect(mapped.status).toBe('blocked');
    expect(mapped.project).toBe('Client Portal');
    expect(toLocalDateString(new Date('2026-11-22T12:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const demo = createDemoWorkspaceDataset(['2026-11-16', '2026-11-17', '2026-11-22']);
    expect(demo.tasks.length).toBeGreaterThanOrEqual(4);
    expect(demo.timeBlocks.some((b) => b.date === '2026-11-22')).toBe(true);
    expect(demo.activitySegments.length).toBeGreaterThan(0);
    expect(demo.appSegments.length).toBeGreaterThan(0);
    expect(demo.documentSegments.length).toBeGreaterThan(0);
    expect(demo.reports.length).toBeGreaterThan(0);
  });

  it('packages paired desktop-agent and browser-extension ZIP archives with matching bridgeSecret & launcher scripts', async () => {
    const loginRes = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_acc_01' });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers['set-cookie'];

    const sharedSecret = 'paired-bridge-secret-test-9942';

    const agentRes = await request(ctx.app)
      .post('/api/engine/package/desktop-agent')
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .send({
        serverUrl: 'https://ontrack.firm.example',
        bridgeSecret: sharedSecret,
      });
    expect(agentRes.status).toBe(200);
    const agentZip = await JSZip.loadAsync(await readZipBuffer(agentRes));
    expect(agentZip.file('agent.config.json')).toBeTruthy();
    expect(agentZip.file('start-agent.sh')).toBeTruthy();
    expect(agentZip.file('start-agent.bat')).toBeTruthy();
    const agentCfg = JSON.parse(await agentZip.file('agent.config.json')!.async('string'));
    expect(agentCfg.bridgeSecret).toBe(sharedSecret);
    expect(agentCfg.serverUrl).toBe('https://ontrack.firm.example');
    expect(agentCfg.tenantId).toBe('firm_demo');

    const extRes = await request(ctx.app)
      .post('/api/engine/package/browser-extension')
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .send({
        bridgeSecret: sharedSecret,
      });
    expect(extRes.status).toBe(200);
    const extZip = await JSZip.loadAsync(await readZipBuffer(extRes));
    expect(extZip.file('config.defaults.json')).toBeTruthy();
    expect(extZip.file('popup.html')).toBeTruthy();
    expect(extZip.file('popup.js')).toBeTruthy();
    expect(extZip.file('manifest.json')).toBeTruthy();

    const extCfg = JSON.parse(await extZip.file('config.defaults.json')!.async('string'));
    expect(extCfg.bridgeSecret).toBe(sharedSecret);
    expect(extCfg.bridgeUrl).toBe('http://127.0.0.1:47621/browser-event');

    const manifest = JSON.parse(await extZip.file('manifest.json')!.async('string'));
    expect(manifest.action?.default_popup).toBe('popup.html');

    // GET route still works and generates its own random non-empty secret without crashing
    const getExtRes = await request(ctx.app)
      .get('/api/engine/package/browser-extension')
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(getExtRes.status).toBe(200);
    const getExtZip = await JSZip.loadAsync(await readZipBuffer(getExtRes));
    const getExtCfg = JSON.parse(await getExtZip.file('config.defaults.json')!.async('string'));
    expect(typeof getExtCfg.bridgeSecret).toBe('string');
    expect(getExtCfg.bridgeSecret.length).toBeGreaterThanOrEqual(20);
  });

  it('enforces X-OnTrack-Bridge-Secret and Origin allowlist on the desktop agent loopback bridge', async () => {
    const receivedEvents: Record<string, unknown>[] = [];
    const secret = 'ephemeral-test-bridge-secret-xyz';

    const handler = createBridgeRequestHandler({
      getSecret: () => secret,
      getConfigInfo: () => ({
        excludedDomains: ['personalbank', 'chase.com'],
        idleThresholdSeconds: 180,
        deviceId: 'dev-test-bridge',
      }),
      getHealthInfo: () => ({
        deviceId: 'dev-test-bridge',
        userId: 'u_test',
        queueDepth: 0,
      }),
      onBrowserEvent: (msg) => {
        receivedEvents.push(msg);
        return true;
      },
    });

    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind ephemeral bridge port');
    }
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. /health works without secret and never exposes secret
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      const healthBody = await healthRes.json();
      expect(healthBody.ok).toBe(true);
      expect(healthBody.bridgeAuthRequired).toBe(true);
      expect(JSON.stringify(healthBody)).not.toContain(secret);

      // 2. Unauthenticated /config and /browser-event are rejected with 401
      const unauthCfg = await fetch(`${baseUrl}/config`);
      expect(unauthCfg.status).toBe(401);

      const wrongSecretEvt = await fetch(`${baseUrl}/browser-event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OnTrack-Bridge-Secret': 'wrong-secret',
        },
        body: JSON.stringify({ domain: 'qbo.intuit.com', pageTitle: 'Acme' }),
      });
      expect(wrongSecretEvt.status).toBe(401);
      expect(receivedEvents).toHaveLength(0);

      // 3. Untrusted web origin is rejected with 403 even with secret
      const evilOriginRes = await fetch(`${baseUrl}/config`, {
        headers: {
          Origin: 'https://untrusted-site.example',
          'X-OnTrack-Bridge-Secret': secret,
        },
      });
      expect(evilOriginRes.status).toBe(403);

      // 4. Valid chrome-extension Origin + matching X-OnTrack-Bridge-Secret succeeds
      const authCfgRes = await fetch(`${baseUrl}/config`, {
        headers: {
          Origin: 'chrome-extension://ontrackcollector123',
          'X-OnTrack-Bridge-Secret': secret,
        },
      });
      expect(authCfgRes.status).toBe(200);
      expect(authCfgRes.headers.get('access-control-allow-origin')).toBe(
        'chrome-extension://ontrackcollector123'
      );
      expect(authCfgRes.headers.get('access-control-allow-headers')).toContain(
        'X-OnTrack-Bridge-Secret'
      );
      const authCfg = await authCfgRes.json();
      expect(authCfg.excludedDomains).toEqual(['personalbank', 'chase.com']);

      const authEvtRes = await fetch(`${baseUrl}/browser-event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'chrome-extension://ontrackcollector123',
          'X-OnTrack-Bridge-Secret': secret,
        },
        body: JSON.stringify({
          browser: 'Google Chrome',
          domain: 'qbo.intuit.com',
          url: 'https://qbo.intuit.com/app/reconcile',
          pageTitle: 'Acme Ltd Ledger',
          incognito: false,
        }),
      });
      expect(authEvtRes.status).toBe(200);
      const evtOut = await authEvtRes.json();
      expect(evtOut.accepted).toBe(true);
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].domain).toBe('qbo.intuit.com');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
