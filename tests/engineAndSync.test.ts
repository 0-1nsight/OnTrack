import fs from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-engine-test-${Date.now()}`;
  process.env.DEMO_MODE = 'true';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';
import { savePortableFileToDisk } from '../server/fileStorage.ts';
import { runAttributionPipeline } from '../src/engine/attributionEngine.ts';
import { sanitizeAndFilterEvent } from '../src/engine/privacyFilter.ts';
import { sessionizeEvents } from '../src/engine/sessionizer.ts';
import {
  ClientDictionaryEntry,
  EngineTask,
  PrivacyRule,
  TenantConfig,
  TrackingEvent,
} from '../src/engine/types.ts';

describe('7-Stage Engine, Privacy Filter, Offline Sync, Freshness & Portable Uploads', () => {
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

  it('passes all 12 built-in /api/engine/acceptance checks on firm_demo', async () => {
    const res = await request(ctx.app).get(
      '/api/engine/acceptance?tenantId=firm_demo&viewerRole=team_lead'
    );
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBeGreaterThanOrEqual(12);
    expect(res.body.passedCount).toBe(res.body.totalCount);
    for (const chk of res.body.checks) {
      expect(chk.passed, `${chk.id}: ${chk.detail}`).toBe(true);
    }
  });

  it('enforces PRIV-1 & PRIV-2 on-device drops for incognito, wildcard exclusions, and forbidden content keys', () => {
    const rules: PrivacyRule[] = [
      { id: 'r1', tenantId: 't1', kind: 'app', pattern: '1Password', reason: 'Vault', enabled: true },
      { id: 'r2', tenantId: 't1', kind: 'domain', pattern: '*bank*', reason: 'Banking', enabled: true },
      { id: 'r3', tenantId: 't1', kind: 'path', pattern: '*\\Personal\\*', reason: 'Private', enabled: true },
    ];

    const base: TrackingEvent = {
      event_id: 'e1',
      schema_version: 1,
      tenant_id: 't1',
      user_id: 'u1',
      device_id: 'd1',
      seq: 1,
      type: 'activity.browser',
      priority: 'activity',
      event_time_utc: '2026-11-22T15:00:00.000Z',
      received_at: null,
      payload: { app: 'Chrome', window_title: 'Acme Ledger' },
    };

    expect(
      sanitizeAndFilterEvent({ ...base, payload: { ...base.payload, incognito: true } }, rules)
        .allowed
    ).toBe(false);

    expect(
      sanitizeAndFilterEvent(
        { ...base, payload: { ...base.payload, url: 'https://mybank.example.com/checking' } },
        rules
      ).allowed
    ).toBe(false);

    expect(
      sanitizeAndFilterEvent(
        { ...base, payload: { ...base.payload, file_path: 'C:\\Users\\Maya\\Personal\\taxes.xlsx' } },
        rules
      ).allowed
    ).toBe(false);

    expect(
      sanitizeAndFilterEvent(
        { ...base, payload: { ...base.payload, keystrokes: 'secret text' } as any },
        rules
      ).allowed
    ).toBe(false);

    expect(sanitizeAndFilterEvent(base, rules).allowed).toBe(true);
  });

  it('bridges brief Slack interruptions cleanly and applies retroactive attribution thresholds', () => {
    const config: TenantConfig = {
      id: 't1',
      name: 'Test Firm',
      confidenceThresholds: { detected: 0.85, suggested: 0.5 },
      sessionizer: { maxInterruptionSeconds: 30, idleCloseSeconds: 180 },
      heartbeatIntervalSeconds: 12,
      delayedThresholdSeconds: 120,
      retentionDays: 60,
      monitoringPolicy: 'mandatory',
      serverUrl: 'http://localhost:3000',
    };

    const clients: ClientDictionaryEntry[] = [
      {
        id: 'cli-acme',
        tenantId: 't1',
        legalName: 'Acme Ltd',
        aliases: ['Acme'],
        codes: ['ACME-01'],
        folderPatterns: ['Acme_Ltd'],
        knownDomains: [],
        restrictedUserIds: [],
        source: 'manual',
        updatedAtUtc: '2026-11-22T00:00:00Z',
      },
    ];

    const tasks: EngineTask[] = [
      {
        id: 'tsk-1',
        tenantId: 't1',
        clientId: 'cli-acme',
        clientName: 'Acme Ltd',
        title: 'Acme Ltd Oct 2026 Bank Reconciliation',
        period: 'Oct 2026',
        status: 'in_progress',
        dueDateUtc: '2026-12-30T22:00:00Z',
        assignedUserId: 'u1',
        estimatedMinutes: 120,
        version: 1,
        updatedAtUtc: '2026-11-22T00:00:00Z',
      },
    ];

    const t0 = Date.parse('2026-11-20T15:00:00.000Z');
    const rawEvents: TrackingEvent[] = [
      {
        event_id: 'ev-1',
        schema_version: 1,
        tenant_id: 't1',
        user_id: 'u1',
        device_id: 'd1',
        seq: 1,
        type: 'activity.window',
        priority: 'activity',
        event_time_utc: new Date(t0).toISOString(),
        received_at: null,
        payload: {
          app: 'Microsoft Excel',
          window_title: 'Book1.xlsx - Excel',
          file_path: 'C:\\Temp\\Book1.xlsx',
          duration_ms: 6 * 60_000,
        },
      },
      {
        event_id: 'ev-2',
        schema_version: 1,
        tenant_id: 't1',
        user_id: 'u1',
        device_id: 'd1',
        seq: 2,
        type: 'activity.window',
        priority: 'activity',
        event_time_utc: new Date(t0 + 7 * 60_000).toISOString(),
        received_at: null,
        payload: {
          app: 'QuickBooks',
          window_title: 'Acme Ltd - Reconcile Chequing Oct 2026',
          file_path: 'C:\\Clients\\Acme_Ltd\\Chequing_Rec.qbw',
          duration_ms: 10 * 60_000,
        },
      },
      {
        event_id: 'ev-3',
        schema_version: 1,
        tenant_id: 't1',
        user_id: 'u1',
        device_id: 'd1',
        seq: 3,
        type: 'activity.window',
        priority: 'activity',
        event_time_utc: new Date(t0 + 17 * 60_000 + 5_000).toISOString(),
        received_at: null,
        payload: {
          app: 'Slack',
          window_title: 'Slack | #audit',
          duration_ms: 15_000,
        },
      },
      {
        event_id: 'ev-4',
        schema_version: 1,
        tenant_id: 't1',
        user_id: 'u1',
        device_id: 'd1',
        seq: 4,
        type: 'activity.file',
        priority: 'activity',
        event_time_utc: new Date(t0 + 17 * 60_000 + 25_000).toISOString(),
        received_at: null,
        payload: {
          app: 'Adobe Acrobat',
          window_title: 'Acme BankStatement Oct 2026.pdf',
          file_path: 'C:\\Clients\\Acme_Ltd\\Acme_Oct2026.pdf',
          duration_ms: 8 * 60_000,
        },
      },
      {
        event_id: 'ev-5',
        schema_version: 1,
        tenant_id: 't1',
        user_id: 'u1',
        device_id: 'd1',
        seq: 5,
        type: 'activity.window',
        priority: 'activity',
        event_time_utc: new Date(t0 + 45 * 60_000).toISOString(),
        received_at: null,
        payload: {
          app: 'Notepad',
          window_title: 'scratch.txt',
          duration_ms: 5 * 60_000,
        },
      },
    ];

    const sessions = sessionizeEvents(rawEvents, clients, [], config);
    // ev-2, ev-3 (15s Slack bridge), and ev-4 must cluster into 1 Acme session -> total 3 sessions
    expect(sessions).toHaveLength(3);

    const out = runAttributionPipeline({
      sessions,
      rawEvents,
      tasks,
      templates: [],
      learnedRules: [],
      config,
    });

    // Session 0 (Book1.xlsx) retroactively elevated to suggested from Session 1 (QuickBooks)
    expect(out.revisionsPublished.length).toBeGreaterThanOrEqual(1);
    expect(out.attributions[0].status).toBe('suggested');
    expect(out.attributions[0].clientId).toBe('cli-acme');

    // Session 1 (QuickBooks + bridged Slack + Acrobat) is high confidence detected
    expect(out.attributions[1].status).toBe('detected');
    expect(out.attributions[1].confidence).toBeGreaterThanOrEqual(0.85);

    // Session 2 (Notepad scratch) stays in review_tray (<0.50)
    expect(out.attributions[2].status).toBe('review_tray');
    expect(out.attributions[2].confidence).toBeLessThan(0.5);
  });

  it('processes state events before activity backlog, detects sequence gaps & version conflicts, and isolates client uploads', async () => {
    // 1. State-before-activity sync & sequence gap detection & conflict resolution via HTTP API
    // Seed initial seq=2 so device lastAckSeq is established, then send a batch skipping seq 3 and 4
    const seedSync = await request(ctx.app)
      .post('/api/engine/sync?tenantId=firm_demo&viewerUserId=demo_u_acc_01&viewerRole=accountant')
      .send({
        deviceId: 'dev-vitest-01',
        events: [
          {
            event_id: 'sync-act-002',
            schema_version: 1,
            tenant_id: 'firm_demo',
            user_id: 'demo_u_acc_01',
            device_id: 'dev-vitest-01',
            seq: 2,
            type: 'activity.window',
            priority: 'activity',
            event_time_utc: new Date().toISOString(),
            received_at: null,
            payload: { app: 'QuickBooks', window_title: 'Acme Ltd Ledger' },
          },
        ],
      });
    expect(seedSync.status).toBe(200);
    expect(seedSync.body.lastAckSeq).toBe(2);

    const syncRes = await request(ctx.app)
      .post('/api/engine/sync?tenantId=firm_demo&viewerUserId=demo_u_acc_01&viewerRole=accountant')
      .send({
        deviceId: 'dev-vitest-01',
        events: [
          {
            event_id: 'sync-act-006',
            schema_version: 1,
            tenant_id: 'firm_demo',
            user_id: 'demo_u_acc_01',
            device_id: 'dev-vitest-01',
            seq: 6,
            type: 'activity.window',
            priority: 'activity',
            event_time_utc: new Date().toISOString(),
            received_at: null,
            payload: { app: 'QuickBooks', window_title: 'Acme Ltd Trial Balance' },
          },
          {
            event_id: 'sync-state-005',
            schema_version: 1,
            tenant_id: 'firm_demo',
            user_id: 'demo_u_acc_01',
            device_id: 'dev-vitest-01',
            seq: 5,
            type: 'state.task_status',
            priority: 'state',
            event_time_utc: new Date().toISOString(),
            received_at: null,
            payload: {
              task_id: 'demo_tsk-eng-101',
              from_value: 'in_progress',
              to_value: 'completed',
              expected_version: 42, // Stale version triggers SYNC-6 conflict
            },
          },
        ],
      });
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.acceptedCount).toBe(2);
    expect(syncRes.body.lastAckSeq).toBe(6);
    expect(syncRes.body.stateChanged).toBe(true);
    expect(syncRes.body.conflictsCreated).toHaveLength(1);
    expect(syncRes.body.seqGaps).toEqual([3, 4]);

    const conflictId = syncRes.body.conflictsCreated[0].id;
    const resolveRes = await request(ctx.app)
      .post(`/api/engine/conflicts/${conflictId}/resolve?tenantId=firm_demo&viewerUserId=demo_u_acc_01&viewerRole=accountant`)
      .send({ resolution: 'keep_local' });
    expect(resolveRes.status).toBe(200);

    // 2. Portable file storage rejects unsafe extensions and >5MB files
    expect(() =>
      savePortableFileToDisk({
        tenantId: 'firm_demo',
        originalName: 'malware.exe',
        contentBuffer: Buffer.from('MZ'),
      })
    ).toThrow(/Unsupported file extension/);

    expect(() =>
      savePortableFileToDisk({
        tenantId: 'firm_demo',
        originalName: 'oversized.pdf',
        contentBuffer: Buffer.alloc(5 * 1024 * 1024 + 10),
      })
    ).toThrow(/exceeds 5MB limit/);

    // 3. Cross-client upload isolation: Northstar client cannot upload to Acme's document request
    const client2Login = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_client_02' });
    expect(client2Login.status).toBe(200);
    const client2Cookie = client2Login.headers['set-cookie'];

    const crossUpload = await request(ctx.app)
      .post('/api/portal/document-requests/demo_cdoc-1/upload')
      .set('Cookie', client2Cookie)
      .send({
        originalName: 'wrong-client.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
      });
    expect(crossUpload.status).toBe(403);
  });
});
