import fs from 'node:fs';
import path from 'node:path';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-stabilization-${Date.now()}`;
  process.env.DEMO_MODE = 'false';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';
import { buildWindowsInstallerArtifact } from '../server/installerBuilder.ts';
import { WorkspaceBoard } from '../src/types.ts';
import { mapEngineTaskToWorkspaceTask } from '../src/utils/engineWorkspaceAdapter.ts';

function generateTotpToken(secretBase32: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

describe('Stabilization Fixes: Validation Gates, Onboarding Audit Role, Tasks Done Placement & Installer Prefill', () => {
  let ctx: Awaited<ReturnType<typeof createOnTrackServer>>;

  beforeAll(async () => {
    ctx = await createOnTrackServer({
      dbPath: ':memory:',
      seedDemo: false,
      disableVite: true,
    });
  });

  afterAll(async () => {
    await ctx?.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('rejects malformed /sync, /tasks, /activity-rules, /privacy-rules, and /config payloads with HTTP 400 and preserves real onboarding actor role in audit logs', async () => {
    // 1. Bootstrap initial Admin & verify MFA
    const bootRes = await request(ctx.app).post('/api/auth/bootstrap').send({
      firmName: 'Cedarbrook CPA Group',
      slug: 'cedarbrook',
      name: 'Taylor Brooks',
      email: 'taylor@cedarbrook.example',
      password: 'CedarAdminPassword!2026',
    });
    expect(bootRes.status).toBe(201);
    const adminCookie = bootRes.headers['set-cookie'];

    const adminEnroll = await request(ctx.app)
      .post('/api/auth/mfa/enroll')
      .set('Cookie', adminCookie);
    expect(adminEnroll.status).toBe(200);
    const adminConfirm = await request(ctx.app)
      .post('/api/auth/mfa/confirm')
      .set('Cookie', adminCookie)
      .send({ code: generateTotpToken(adminEnroll.body.secretBase32) });
    expect(adminConfirm.status).toBe(200);

    // 2. Malformed /api/engine/sync payloads return 400 (never 500)
    const badSyncMissingEvents = await request(ctx.app)
      .post('/api/engine/sync')
      .set('Cookie', adminCookie)
      .send({ deviceId: 'dev-bad-01' });
    expect(badSyncMissingEvents.status).toBe(400);

    const badSyncEventShape = await request(ctx.app)
      .post('/api/engine/sync')
      .set('Cookie', adminCookie)
      .send({
        deviceId: 'dev-bad-01',
        events: [
          {
            event_id: '',
            seq: -5,
            type: 'activity.unknown',
            priority: 'activity',
            event_time_utc: new Date().toISOString(),
            payload: {},
          },
        ],
      });
    expect(badSyncEventShape.status).toBe(400);
    expect(badSyncEventShape.body.code).toBe('VALIDATION_ERROR');

    // 3. Malformed /tasks, /activity-rules, /privacy-rules, /config return 400 cleanly
    const badTask = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', adminCookie)
      .send({ title: '   ', status: 'invalid_status' });
    expect(badTask.status).toBe(400);

    const badActivityRule = await request(ctx.app)
      .post('/api/engine/activity-rules')
      .set('Cookie', adminCookie)
      .send({ keyword: '', activityType: 'Audit', weight: 999 });
    expect(badActivityRule.status).toBe(400);

    const badPrivacyRule = await request(ctx.app)
      .post('/api/engine/privacy-rules')
      .set('Cookie', adminCookie)
      .send({ kind: 'invalid_kind', pattern: '' });
    expect(badPrivacyRule.status).toBe(400);

    const badPrivacyToggle = await request(ctx.app)
      .patch('/api/engine/privacy-rules/priv-missing')
      .set('Cookie', adminCookie)
      .send({ enabled: 'yes' });
    expect(badPrivacyToggle.status).toBe(400);

    const badConfigPatch = await request(ctx.app)
      .patch('/api/engine/config')
      .set('Cookie', adminCookie)
      .send({ retentionDays: 2, focusFactor: 5 });
    expect(badConfigPatch.status).toBe(400);

    // 4. Provision a Team Lead with Access Key -> verify password setup logs true actorRole 'team_lead'
    const provLead = await request(ctx.app)
      .post('/api/auth/provision-user')
      .set('Cookie', adminCookie)
      .send({
        name: 'Jordan Patel',
        email: 'jordan.patel@cedarbrook.example',
        role: 'team_lead',
        shiftPattern: '8-5',
      });
    expect(provLead.status).toBe(201);
    const leadUserId = provLead.body.user.userId as string;

    const leadKeyLogin = await request(ctx.app).post('/api/auth/key-login').send({
      email: 'jordan.patel@cedarbrook.example',
      accessKey: provLead.body.accountAccessKey,
    });
    expect(leadKeyLogin.status).toBe(200);
    const leadCookie = leadKeyLogin.headers['set-cookie'];

    const leadSetPw = await request(ctx.app)
      .post('/api/auth/onboarding/set-password')
      .set('Cookie', leadCookie)
      .send({ newPassword: 'JordanLeadPass!2026' });
    expect(leadSetPw.status).toBe(200);
    expect(leadSetPw.body.user.role).toBe('team_lead');

    const leadEnroll = await request(ctx.app)
      .post('/api/auth/mfa/enroll')
      .set('Cookie', leadCookie);
    expect(leadEnroll.status).toBe(200);

    const leadConfirm = await request(ctx.app)
      .post('/api/auth/mfa/confirm')
      .set('Cookie', leadCookie)
      .send({ code: generateTotpToken(leadEnroll.body.secretBase32) });
    expect(leadConfirm.status).toBe(200);
    expect(leadConfirm.body.user.mfaVerified).toBe(true);

    const snap = await request(ctx.app)
      .get('/api/engine/snapshot')
      .set('Cookie', adminCookie);
    expect(snap.status).toBe(200);
    const pwAudit = snap.body.auditLogs.find(
      (a: any) =>
        a.action === 'user.onboarding_password_set' && a.targetUserId === leadUserId
    );
    expect(pwAudit).toBeTruthy();
    expect(pwAudit.actorRole).toBe('team_lead');

    // 5. Creating a completed task ("Tasks Done" section) preserves completed status, completedAt, and exact section placement
    const customCompletedTaskRes = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', leadCookie)
      .send({
        project: 'Tax & Close',
        clientName: 'Tax & Close',
        title: 'Finalize Q3 VAT Filing Sign-off',
        status: 'completed',
        estimatedMinutes: 60,
        assignedUserId: leadUserId,
      });
    expect(customCompletedTaskRes.status).toBe(200);
    expect(customCompletedTaskRes.body.task.status).toBe('completed');

    const boards: WorkspaceBoard[] = [
      {
        id: 'brd-tax',
        spaceId: 'spc-1',
        folderId: 'fld-1',
        name: 'Tax & Close',
        description: 'Tax workflows',
        projectTag: 'Tax & Close',
        createdAt: '2026-10-01',
        sections: [
          {
            id: 'sec-todo',
            name: 'To Do',
            description: '',
            color: 'slate',
            mappedStatus: 'todo',
          },
          {
            id: 'sec-done',
            name: 'Tasks Done',
            description: 'Completed items',
            color: 'emerald',
            mappedStatus: 'completed',
          },
        ],
      },
    ];

    const mappedDone = mapEngineTaskToWorkspaceTask(
      customCompletedTaskRes.body.task,
      {
        id: 'temp-1',
        title: 'Finalize Q3 VAT Filing Sign-off',
        description: 'Added to Tasks Done on Tax & Close.',
        project: 'Tax & Close',
        boardId: 'brd-tax',
        sectionId: 'sec-done',
        status: 'completed',
        priority: 'medium',
        category: 'billable',
        tags: ['board'],
        estimatedMinutes: 60,
        subtasks: [],
        createdAt: '2026-10-01',
        completedAt: '2026-10-01',
        assignedUserId: leadUserId,
      },
      boards
    );
    expect(mappedDone.status).toBe('completed');
    expect(mappedDone.boardId).toBe('brd-tax');
    expect(mappedDone.sectionId).toBe('sec-done');
    expect(mappedDone.completedAt).toBe('2026-10-01');
  });

  it('maintains strict C# 5 syntax and email prefill in Windows installer and builds onboarding kit', async () => {
    const csPath = path.resolve(process.cwd(), 'packages/installer/windows/OnTrackSetup.cs');
    const csSource = fs.readFileSync(csPath, 'utf8');
    expect(csSource).toContain('public sealed class InstallMeta');
    expect(csSource).toContain('TryFindSiblingCredentialsEmail');
    expect(csSource).not.toMatch(/(?:^|[\s(=+:,])\$"/m);
    expect(csSource).not.toMatch(/\?\./);

    const artifact = await buildWindowsInstallerArtifact({
      tenantId: 'firm_test',
      userId: 'usr_test',
      serverUrl: 'https://ontrack.example.com',
      bridgeSecret: 'secret_bridge_value_123456',
      credentialsText: 'Account Email       : test.staff@firm.example\r\nInstallation Key: ontrack_dev_abc123456789\r\n',
      credentialsFilename: 'OnTrack-Credentials-test-staff.txt',
      bundleAsKit: true,
    });
    expect(artifact.buffer.byteLength).toBeGreaterThan(1000);
    expect(artifact.filename).toBe('OnTrack-Onboarding-Kit-Windows.zip');
  });
});
