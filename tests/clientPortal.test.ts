import fs from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `/tmp/ontrack-portal-test-${Date.now()}`;
  process.env.DEMO_MODE = 'true';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';
import { isSubscriberPermittedForEvent } from '../server/wsGateway.ts';

describe('Client Portal Workflows, Synchronization & Branding (PORT-1 / PORT-2)', () => {
  let ctx: Awaited<ReturnType<typeof createOnTrackServer>>;

  beforeAll(async () => {
    fs.mkdirSync(tempDataDir, { recursive: true });
    ctx = await createOnTrackServer({
      dbPath: ':memory:',
      seedDemo: true,
      disableVite: true,
    });
  });

  afterAll(async () => {
    await ctx?.close();
    try {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('creates template intake request synced to engine_tasks + starter doc requests, enforces cross-client isolation & downloads', async () => {
    const client1Login = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_client_01' });
    expect(client1Login.status).toBe(200);
    const cookie1 = client1Login.headers['set-cookie'];

    const client2Login = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_client_02' });
    expect(client2Login.status).toBe(200);
    const cookie2 = client2Login.headers['set-cookie'];

    const overview1 = await request(ctx.app)
      .get('/api/portal/overview')
      .set('Cookie', cookie1);
    expect(overview1.status).toBe(200);
    expect(overview1.body.clientId).toBe('demo_cli-acme');
    expect(overview1.body.lastUpdatedUtc).toBeTruthy();
    expect(overview1.body.branding.portalTitle).toBeTruthy();
    expect(overview1.body.templates.length).toBeGreaterThan(0);

    const templateId = overview1.body.templates[0].id;

    // 1. Client 1 submits a new template-driven portal request
    const createRes = await request(ctx.app)
      .post('/api/portal/requests')
      .set('Cookie', cookie1)
      .send({
        title: 'Q4 Sales Tax Multi-State Filing',
        period: 'Q4 2026',
        templateId,
        notes: 'Please include Nexus breakdown for CA and NY.',
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.request.clientId).toBe('demo_cli-acme');
    expect(createRes.body.request.engineTaskId).toBeTruthy();
    expect(createRes.body.request.notes).toBe('Please include Nexus breakdown for CA and NY.');

    const createdRequestId = createRes.body.request.id;

    // Verify synced engine task exists in engine snapshot for firm staff
    const staffLogin = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_lead_01' });
    expect(staffLogin.status).toBe(200);
    const staffCookie = staffLogin.headers['set-cookie'];

    const snapRes = await request(ctx.app)
      .get('/api/engine/snapshot')
      .set('Cookie', staffCookie);
    expect(snapRes.status).toBe(200);
    expect(
      snapRes.body.tasks.some((t: any) => t.id === createRes.body.request.engineTaskId)
    ).toBe(true);

    // 2. Refresh Client 1 overview -> verify starter document requests generated and automatic reminders evaluate
    const overviewAfterCreate = await request(ctx.app)
      .get('/api/portal/overview')
      .set('Cookie', cookie1);
    expect(overviewAfterCreate.status).toBe(200);
    const createdDocReqs = overviewAfterCreate.body.documentRequests.filter(
      (d: any) => d.requestId === createdRequestId
    );
    expect(createdDocReqs.length).toBeGreaterThanOrEqual(1);
    const docReqId = createdDocReqs[0].id;

    // Client 1 uploads a document
    const uploadRes = await request(ctx.app)
      .post(`/api/portal/document-requests/${docReqId}/upload`)
      .set('Cookie', cookie1)
      .send({
        originalName: 'q4_nexus_summary.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('Acme Q4 nexus sales figures').toString('base64'),
      });
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.file.fileId).toBeTruthy();
    const uploadedFileId = uploadRes.body.file.fileId;

    // Client 1 can download their own file
    const downloadOwn = await request(ctx.app)
      .get(`/api/portal/files/${uploadedFileId}/download`)
      .set('Cookie', cookie1);
    expect(downloadOwn.status).toBe(200);
    expect(downloadOwn.text).toContain('Acme Q4 nexus sales figures');

    // Client 2 CANNOT download Client 1's file, post messages, or approve Client 1's request
    const downloadOther = await request(ctx.app)
      .get(`/api/portal/files/${uploadedFileId}/download`)
      .set('Cookie', cookie2);
    expect(downloadOther.status).toBe(403);

    const msgOther = await request(ctx.app)
      .post(`/api/portal/requests/${createdRequestId}/messages`)
      .set('Cookie', cookie2)
      .send({ body: 'Unauthorized probe' });
    expect(msgOther.status).toBe(403);

    const approveOther = await request(ctx.app)
      .post(`/api/portal/requests/${createdRequestId}/approve`)
      .set('Cookie', cookie2)
      .send({ signatureName: 'Intruder' });
    expect(approveOther.status).toBe(403);

    // 3. Staff verifies doc upload, updates stage, confirms & withdraws milestone, then Client 1 e-signs approval
    const verifyRes = await request(ctx.app)
      .post(`/api/portal/document-requests/${docReqId}/verify`)
      .set('Cookie', staffCookie);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.status).toBe('verified');

    const stageRes = await request(ctx.app)
      .patch(`/api/portal/requests/${createdRequestId}/stage`)
      .set('Cookie', staffCookie)
      .send({ stage: 'Awaiting your approval' });
    expect(stageRes.status).toBe(200);
    expect(stageRes.body.stage).toBe('Awaiting your approval');

    const confirmRes = await request(ctx.app)
      .post('/api/portal/milestones/confirm')
      .set('Cookie', staffCookie)
      .send({ requestId: createdRequestId, title: 'Nexus tie-out reconciled' });
    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.milestone.status).toBe('confirmed');

    const withdrawRes = await request(ctx.app)
      .post(`/api/portal/milestones/${confirmRes.body.milestone.id}/withdraw`)
      .set('Cookie', staffCookie)
      .send({ reason: 'Corrected state tax exemption certificate received.' });
    expect(withdrawRes.status).toBe(200);
    expect(withdrawRes.body.withdrawnAtUtc).toBeTruthy();

    const approveRes = await request(ctx.app)
      .post(`/api/portal/requests/${createdRequestId}/approve`)
      .set('Cookie', cookie1)
      .send({
        signatureName: 'Elena Vance, CFO',
        approvalNotes: 'Approved for state filing submission.',
      });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.signatureName).toBe('Elena Vance, CFO');
    expect(approveRes.body.approvedAtUtc).toBeTruthy();

    const finalOverview = await request(ctx.app)
      .get('/api/portal/overview')
      .set('Cookie', cookie1);
    expect(finalOverview.status).toBe(200);
    const approvedItem = finalOverview.body.requests.find(
      (r: any) => r.id === createdRequestId
    );
    expect(approvedItem.stage).toBe('Complete');
    expect(approvedItem.approvalStatus).toBe('approved');
    expect(approvedItem.signatureName).toBe('Elena Vance, CFO');
    const withdrawnItem = finalOverview.body.milestones.find(
      (m: any) => m.id === confirmRes.body.milestone.id
    );
    expect(withdrawnItem.status).toBe('withdrawn');
    expect(withdrawnItem.withdrawalReason).toBe('Corrected state tax exemption certificate received.');
  });

  it('allows Admin/IT to customize branding & template milestone names (PORT-2) while staying blocked from client content', async () => {
    const adminLogin = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_admin_01' });
    expect(adminLogin.status).toBe(200);
    const adminCookie = adminLogin.headers['set-cookie'];

    const brandPut = await request(ctx.app)
      .put('/api/engine/branding')
      .set('Cookie', adminCookie)
      .send({
        portalTitle: 'Sterling CPA Client Desk',
        accentTheme: 'emerald',
        customDomain: 'portal.sterlingcpa.example',
        logoText: 'SCPA',
      });
    expect(brandPut.status).toBe(200);
    expect(brandPut.body.branding.portalTitle).toBe('Sterling CPA Client Desk');
    expect(brandPut.body.branding.accentTheme).toBe('emerald');

    const brandGet = await request(ctx.app)
      .get('/api/engine/branding')
      .set('Cookie', adminCookie);
    expect(brandGet.status).toBe(200);
    const firstTemplate = brandGet.body.templates[0];
    expect(firstTemplate).toBeTruthy();

    const tplPut = await request(ctx.app)
      .put(`/api/engine/templates/${firstTemplate.id}`)
      .set('Cookie', adminCookie)
      .send({
        milestoneNames: ['Bank feed verified', 'Close tie-out complete', 'Partner sign-off'],
      });
    expect(tplPut.status).toBe(200);
    expect(tplPut.body.template.steps.map((s: any) => s.title)).toEqual([
      'Bank feed verified',
      'Close tie-out complete',
      'Partner sign-off',
    ]);

    // Admin/IT remains blocked from reading client portal deliverables
    const adminPortal = await request(ctx.app)
      .get('/api/portal/overview')
      .set('Cookie', adminCookie);
    expect(adminPortal.status).toBe(403);
    expect(adminPortal.body.code).toBe('ADMIN_NO_CLIENT_CONTENT');

    // Client sees updated branding immediately in portal overview
    const clientLogin = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_client_03' });
    const clientOverview = await request(ctx.app)
      .get('/api/portal/overview')
      .set('Cookie', clientLogin.headers['set-cookie']);
    expect(clientOverview.status).toBe(200);
    expect(clientOverview.body.clientId).toBe('demo_cli-harbor');
    expect(clientOverview.body.branding.portalTitle).toBe('Sterling CPA Client Desk');
    expect(clientOverview.body.branding.accentTheme).toBe('emerald');
  });

  it('scopes portal WebSocket events to matching clientId unless broadcastTenantBranding is true', () => {
    expect(
      isSubscriberPermittedForEvent(
        {
          tenantId: 'firm_demo',
          userId: 'demo_u_client_01',
          role: 'client',
          teamId: 'external_client',
          clientId: 'demo_cli-acme',
        },
        {
          tenantId: 'firm_demo',
          affectedUserId: 'demo_u_lead_01',
          affectedClientId: 'demo_cli-northstar',
          eventType: 'portal:updated',
        }
      )
    ).toBe(false);

    expect(
      isSubscriberPermittedForEvent(
        {
          tenantId: 'firm_demo',
          userId: 'demo_u_client_01',
          role: 'client',
          teamId: 'external_client',
          clientId: 'demo_cli-acme',
        },
        {
          tenantId: 'firm_demo',
          affectedUserId: 'demo_u_admin_01',
          affectedClientId: null,
          eventType: 'portal:updated',
          meta: { broadcastTenantBranding: true },
        }
      )
    ).toBe(true);
  });
});
