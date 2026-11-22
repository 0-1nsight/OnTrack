import fs from 'node:fs';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-auth-test-${Date.now()}`;
  process.env.DEMO_MODE = 'false';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';

function generateTotpToken(secretBase32: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

describe('Self-Hosted Auth, TOTP MFA, Invites, Sessions, Password Reset & Strict AI Reports (DEMO_MODE=false)', () => {
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

  it('disables demo-accounts and rejects demo-login when DEMO_MODE is false', async () => {
    const listRes = await request(ctx.app).get('/api/auth/demo-accounts');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual({ demoModeEnabled: false, accounts: [] });

    const loginRes = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_exec_01' });
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.code).toBe('DEMO_DISABLED');
  });

  it('bootstraps initial tenant admin once, enforces TOTP MFA, supports invites, sessions, reset, and opt-in strict AI schema', async () => {
    const statusBefore = await request(ctx.app).get('/api/auth/bootstrap-status');
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.body.needsInitialSetup).toBe(true);
    expect(statusBefore.body.demoModeEnabled).toBe(false);

    // 1. Bootstrap first firm + Admin/IT user
    const bootRes = await request(ctx.app).post('/api/auth/bootstrap').send({
      firmName: 'Sterling & Vance LLP',
      slug: 'sterling-vance',
      name: 'Nadia Sterling',
      email: 'nadia@sterling.example',
      password: 'StrongAdminPassword!2026',
    });
    expect(bootRes.status).toBe(201);
    expect(bootRes.body.user.role).toBe('admin_it');
    expect(bootRes.body.user.mustEnrollMfa).toBe(true);
    expect(bootRes.body.user.mfaVerified).toBe(false);
    const adminCookie = bootRes.headers['set-cookie'];
    expect(adminCookie).toBeTruthy();

    // Repeat bootstrap must fail with 409 ALREADY_INITIALIZED
    const repeatBoot = await request(ctx.app).post('/api/auth/bootstrap').send({
      firmName: 'Duplicate Firm',
      name: 'Other Admin',
      email: 'other@dup.example',
      password: 'AnotherStrongPassword!2026',
    });
    expect(repeatBoot.status).toBe(409);
    expect(repeatBoot.body.code).toBe('ALREADY_INITIALIZED');

    // 2. Unverified MFA session is blocked from protected engine routes until TOTP is enrolled & confirmed
    const blockedBeforeMfa = await request(ctx.app)
      .get('/api/engine/role-overview')
      .set('Cookie', adminCookie);
    expect(blockedBeforeMfa.status).toBe(403);
    expect(blockedBeforeMfa.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const enrollRes = await request(ctx.app)
      .post('/api/auth/mfa/enroll')
      .set('Cookie', adminCookie);
    expect(enrollRes.status).toBe(200);
    expect(enrollRes.body.secretBase32).toBeTruthy();
    expect(Array.isArray(enrollRes.body.backupCodes)).toBe(true);

    const adminTotp = generateTotpToken(enrollRes.body.secretBase32);
    const confirmRes = await request(ctx.app)
      .post('/api/auth/mfa/confirm')
      .set('Cookie', adminCookie)
      .send({ code: adminTotp });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.ok).toBe(true);
    expect(confirmRes.body.user.mfaVerified).toBe(true);

    const allowedAfterMfa = await request(ctx.app)
      .get('/api/engine/role-overview')
      .set('Cookie', adminCookie);
    expect(allowedAfterMfa.status).toBe(200);
    expect(allowedAfterMfa.body.adminAlerts.aiReportsEnabled).toBe(false);

    // 3. Invite an Executive user -> accepts invite -> enforces MFA enrollment -> signs in cleanly
    const inviteRes = await request(ctx.app)
      .post('/api/auth/invites')
      .set('Cookie', adminCookie)
      .send({
        email: 'claire.vance@sterling.example',
        name: 'Claire Vance',
        role: 'executive',
        teamId: 'team_audit',
        shiftPattern: '8-5',
      });
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.inviteToken).toBeTruthy();

    const acceptRes = await request(ctx.app)
      .post('/api/auth/invites/accept')
      .send({
        token: inviteRes.body.inviteToken,
        password: 'ExecutiveSecretPass!2026',
      });
    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body.mustEnrollMfa).toBe(true);
    expect(acceptRes.body.user.role).toBe('executive');
    let execCookie = acceptRes.headers['set-cookie'];

    const execBlocked = await request(ctx.app)
      .get('/api/engine/role-overview')
      .set('Cookie', execCookie);
    expect(execBlocked.status).toBe(403);
    expect(execBlocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

    const execEnroll = await request(ctx.app)
      .post('/api/auth/mfa/enroll')
      .set('Cookie', execCookie);
    expect(execEnroll.status).toBe(200);

    const execSecret = execEnroll.body.secretBase32;
    const execConfirm = await request(ctx.app)
      .post('/api/auth/mfa/confirm')
      .set('Cookie', execCookie)
      .send({ code: generateTotpToken(execSecret) });
    expect(execConfirm.status).toBe(200);
    expect(execConfirm.body.user.mfaVerified).toBe(true);

    // Executive now reads role-overview without raw drilldown
    const execOverview = await request(ctx.app)
      .get('/api/engine/role-overview')
      .set('Cookie', execCookie);
    expect(execOverview.status).toBe(200);
    expect(execOverview.body.role).toBe('executive');
    expect(execOverview.body.devices).toEqual([]);

    // Sign out executive -> cookie cleared and session revoked
    const logoutRes = await request(ctx.app)
      .post('/api/auth/logout')
      .set('Cookie', execCookie);
    expect(logoutRes.status).toBe(200);

    const meAfterLogout = await request(ctx.app)
      .get('/api/auth/me')
      .set('Cookie', execCookie);
    expect(meAfterLogout.status).toBe(200);
    expect(meAfterLogout.body).toEqual({ authenticated: false, user: null });

    // Executive password login requires TOTP code once enrolled
    const pwWithoutTotp = await request(ctx.app).post('/api/auth/login').send({
      email: 'claire.vance@sterling.example',
      password: 'ExecutiveSecretPass!2026',
    });
    expect(pwWithoutTotp.status).toBe(401);
    expect(pwWithoutTotp.body.code).toBe('MFA_CODE_REQUIRED');

    const pwWithTotp = await request(ctx.app).post('/api/auth/login').send({
      email: 'claire.vance@sterling.example',
      password: 'ExecutiveSecretPass!2026',
      totpCode: generateTotpToken(execSecret),
    });
    expect(pwWithTotp.status).toBe(200);
    execCookie = pwWithTotp.headers['set-cookie'];

    // 4. AI Reports disabled by default; when enabled by Admin, rejects raw titles/notes via strict schema
    const aiDisabled = await request(ctx.app)
      .post('/api/reports/generate')
      .set('Cookie', execCookie)
      .send({
        weekStartDate: '2026-11-16',
        weekEndDate: '2026-11-22',
        tone: 'executive',
        metrics: {
          totalHours: 120,
          totalMinutes: 7200,
          plannedHours: 140,
          deepWorkPercent: 64,
          billablePercent: 82,
          completedCount: 14,
          totalTasksCount: 18,
        },
      });
    expect(aiDisabled.status).toBe(403);
    expect(aiDisabled.body.code).toBe('AI_REPORTS_DISABLED');

    const enableAi = await request(ctx.app)
      .patch('/api/engine/config')
      .set('Cookie', adminCookie)
      .send({ aiReportsEnabled: true });
    expect(enableAi.status).toBe(200);
    expect(enableAi.body.config.aiReportsEnabled).toBe(true);

    const aiRawReject = await request(ctx.app)
      .post('/api/reports/generate')
      .set('Cookie', execCookie)
      .send({
        weekStartDate: '2026-11-16',
        weekEndDate: '2026-11-22',
        tone: 'executive',
        taskTitles: ['Secret Client M&A File.xlsx'],
        metrics: {
          totalHours: 120,
          totalMinutes: 7200,
          plannedHours: 140,
          deepWorkPercent: 64,
          billablePercent: 82,
          completedCount: 14,
          totalTasksCount: 18,
        },
      });
    expect(aiRawReject.status).toBe(400);
    expect(aiRawReject.body.code).toBe('VALIDATION_ERROR');

    // 5. Session list + Password Reset invalidates active sessions
    const sessionsRes = await request(ctx.app)
      .get('/api/auth/sessions')
      .set('Cookie', execCookie);
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body.sessions.length).toBeGreaterThanOrEqual(1);

    const rstReq = await request(ctx.app)
      .post('/api/auth/password-reset/request')
      .send({ email: 'claire.vance@sterling.example' });
    expect(rstReq.status).toBe(200);
    expect(rstReq.body.accepted).toBe(true);
    expect(rstReq.body.devToken).toBeTruthy();

    const rstConfirm = await request(ctx.app)
      .post('/api/auth/password-reset/confirm')
      .send({
        token: rstReq.body.devToken,
        newPassword: 'UpdatedExecPassword!2026',
      });
    expect(rstConfirm.status).toBe(200);

    // Previous active session must now be revoked
    const meAfterReset = await request(ctx.app)
      .get('/api/auth/me')
      .set('Cookie', execCookie);
    expect(meAfterReset.status).toBe(200);
    expect(meAfterReset.body.authenticated).toBe(false);
  });
});
