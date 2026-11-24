import fs from 'node:fs';
import JSZip from 'jszip';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-key-onboarding-${Date.now()}`;
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

describe('Admin Provisioning, Onboarding Kit, Access Key + Password + MFA -> Live Timeline Capture', () => {
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

  it('completes full Admin provisioning -> agent capture -> email+key -> set password -> MFA -> live Timeline + kit download', async () => {
    // 1. Admin registers firm & completes MFA
    const bootRes = await request(ctx.app).post('/api/auth/bootstrap').send({
      firmName: 'Harborview Accounting LLP',
      slug: 'harborview',
      name: 'Dana Mercer',
      email: 'dana@harborview.example',
      password: 'HarborAdminPassword!2026',
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
    expect(adminConfirm.body.user.mfaVerified).toBe(true);

    // 2. Admin provisions line staff accountant with email & receives Account Access Key + Installation Key + .txt
    const provRes = await request(ctx.app)
      .post('/api/auth/provision-user')
      .set('Cookie', adminCookie)
      .send({
        name: 'Maya Lin',
        email: 'maya.lin@harborview.example',
        role: 'accountant',
        shiftPattern: '8-5',
        workstationLabel: 'Maya Surface Laptop',
      });
    expect(provRes.status).toBe(201);
    expect(provRes.body.user.email).toBe('maya.lin@harborview.example');
    expect(provRes.body.user.role).toBe('accountant');
    expect(provRes.body.accountAccessKey).toMatch(/^ontrack_key_/);
    expect(provRes.body.installationKey).toMatch(/^ontrack_dev_/);
    expect(provRes.body.credentialsFilename).toBe('OnTrack-Credentials-maya-lin.txt');
    expect(provRes.body.credentialsText).toContain(provRes.body.installationKey);
    expect(provRes.body.credentialsText).toContain(provRes.body.accountAccessKey);
    expect(provRes.body.credentialsText).toContain('maya.lin@harborview.example');
    expect(provRes.body.credentialsText).toContain('signin=key');

    const staffUserId = provRes.body.user.userId as string;
    const deviceId = provRes.body.deviceTokenRecord.deviceId as string;
    const installationKey = provRes.body.installationKey as string;
    const accessKey = provRes.body.accountAccessKey as string;

    // 3. Download unified Windows Kit & Unix Kit containing both installer + credentials .txt
    const winKitRes = await request(ctx.app)
      .post('/api/engine/package/windows-kit')
      .set('Cookie', adminCookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .send({
        userId: staffUserId,
        credentialsText: provRes.body.credentialsText,
        credentialsFilename: provRes.body.credentialsFilename,
      });
    expect(winKitRes.status).toBe(200);
    expect(winKitRes.headers['content-disposition']).toContain('OnTrack-Onboarding-Kit-Windows.zip');
    const winZip = await JSZip.loadAsync(winKitRes.body);
    expect(winZip.file('OnTrack-Credentials-maya-lin.txt')).toBeTruthy();
    const credsInsideZip = await winZip.file('OnTrack-Credentials-maya-lin.txt')!.async('string');
    expect(credsInsideZip).toContain(installationKey);
    expect(credsInsideZip).toContain(accessKey);
    expect(
      Boolean(winZip.file('OnTrack-Setup.exe') || winZip.file('OnTrack-Setup.bat'))
    ).toBe(true);

    const unixKitRes = await request(ctx.app)
      .post('/api/engine/package/unix-kit')
      .set('Cookie', adminCookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .send({
        userId: staffUserId,
        credentialsText: provRes.body.credentialsText,
        credentialsFilename: provRes.body.credentialsFilename,
      });
    expect(unixKitRes.status).toBe(200);
    const unixZip = await JSZip.loadAsync(unixKitRes.body);
    expect(unixZip.file('install.sh')).toBeTruthy();
    expect(unixZip.file('OnTrack-Credentials-maya-lin.txt')).toBeTruthy();

    // 4. Desktop Agent starts after installer finishes and streams immediate heartbeat + window events
    const tenantId = provRes.body.user.tenantId as string;
    const nowMs = Date.now();
    const syncRes = await request(ctx.app)
      .post('/api/engine/sync')
      .set('Authorization', `Bearer ${installationKey}`)
      .send({
        deviceId,
        events: [
          {
            event_id: 'evt-hb-1',
            schema_version: 1,
            tenant_id: tenantId,
            user_id: staffUserId,
            device_id: deviceId,
            seq: 1,
            type: 'activity.heartbeat',
            priority: 'activity',
            event_time_utc: new Date(nowMs).toISOString(),
            received_at: null,
            payload: {
              app: 'ontrack-agent',
              window_title: 'Agent Heartbeat',
              extension_connected: true,
              os_platform: 'windows',
            },
          },
          {
            event_id: 'evt-win-1',
            schema_version: 1,
            tenant_id: tenantId,
            user_id: staffUserId,
            device_id: deviceId,
            seq: 2,
            type: 'activity.app',
            priority: 'activity',
            event_time_utc: new Date(nowMs - 600_000).toISOString(),
            received_at: null,
            payload: {
              app: 'Excel',
              window_title: 'Acme Corp FY26 Trial Balance.xlsx',
              os_platform: 'windows',
              extension_connected: true,
            },
          },
          {
            event_id: 'evt-win-2',
            schema_version: 1,
            tenant_id: tenantId,
            user_id: staffUserId,
            device_id: deviceId,
            seq: 3,
            type: 'activity.browser',
            priority: 'activity',
            event_time_utc: new Date(nowMs - 60_000).toISOString(),
            received_at: null,
            payload: {
              app: 'Chrome',
              window_title: 'Xero — Acme Corp Ledger',
              domain: 'go.xero.com',
              os_platform: 'windows',
              extension_connected: true,
            },
          },
        ],
      });
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.acceptedCount).toBe(3);

    // 5. Attempting password login before onboarding password setup fails cleanly
    const pwEarly = await request(ctx.app).post('/api/auth/login').send({
      email: 'maya.lin@harborview.example',
      password: 'AnyPassword123!',
    });
    expect(pwEarly.status).toBe(401);
    expect(pwEarly.body.code).toBe('PASSWORD_NOT_SET');

    // 6. Staff logs in with Email + Account Access Key -> lands in onboarding Step 1
    const keyLoginRes = await request(ctx.app).post('/api/auth/key-login').send({
      email: 'maya.lin@harborview.example',
      accessKey,
    });
    expect(keyLoginRes.status).toBe(200);
    expect(keyLoginRes.body.user.mustSetPassword).toBe(true);
    expect(keyLoginRes.body.user.mustEnrollMfa).toBe(true);
    expect(keyLoginRes.body.user.mfaVerified).toBe(false);
    const staffCookie = keyLoginRes.headers['set-cookie'];

    // Protected engine endpoints & premature MFA enrollment are blocked until password is created
    const snapBeforePw = await request(ctx.app)
      .get('/api/engine/snapshot')
      .set('Cookie', staffCookie);
    expect(snapBeforePw.status).toBe(403);
    expect(snapBeforePw.body.code).toBe('PASSWORD_SETUP_REQUIRED');

    const mfaBeforePw = await request(ctx.app)
      .post('/api/auth/mfa/enroll')
      .set('Cookie', staffCookie);
    expect(mfaBeforePw.status).toBe(403);
    expect(mfaBeforePw.body.code).toBe('PASSWORD_SETUP_REQUIRED');

    // 7. Staff creates personal password (Step 1 of 2) -> single-use access key is consumed
    const setPwRes = await request(ctx.app)
      .post('/api/auth/onboarding/set-password')
      .set('Cookie', staffCookie)
      .send({ newPassword: 'MayaPersonalPass!2026' });
    expect(setPwRes.status).toBe(200);
    expect(setPwRes.body.ok).toBe(true);
    expect(setPwRes.body.user.mustSetPassword).toBe(false);
    expect(setPwRes.body.user.mustEnrollMfa).toBe(true);
    expect(setPwRes.body.user.mfaVerified).toBe(false);

    // Reusing single-use access key is rejected
    const reuseKeyRes = await request(ctx.app).post('/api/auth/key-login').send({
      email: 'maya.lin@harborview.example',
      accessKey,
    });
    expect(reuseKeyRes.status).toBe(401);
    expect(reuseKeyRes.body.code).toBe('INVALID_ACCESS_KEY');

    // Snapshot is still blocked until Step 2 MFA completes
    const snapBeforeMfa = await request(ctx.app)
      .get('/api/engine/snapshot')
      .set('Cookie', staffCookie);
    expect(snapBeforeMfa.status).toBe(403);
    expect(snapBeforeMfa.body.code).toBe('MFA_ENROLLMENT_REQUIRED');

    // 8. Staff completes Step 2 TOTP MFA enrollment
    const staffEnroll = await request(ctx.app)
      .post('/api/auth/mfa/enroll')
      .set('Cookie', staffCookie);
    expect(staffEnroll.status).toBe(200);
    const staffSecret = staffEnroll.body.secretBase32 as string;

    const staffConfirm = await request(ctx.app)
      .post('/api/auth/mfa/confirm')
      .set('Cookie', staffCookie)
      .send({ code: generateTotpToken(staffSecret) });
    expect(staffConfirm.status).toBe(200);
    expect(staffConfirm.body.user.mustSetPassword).toBe(false);
    expect(staffConfirm.body.user.mustEnrollMfa).toBe(false);
    expect(staffConfirm.body.user.mfaVerified).toBe(true);

    // 9. Staff lands on Timeline & fetches snapshot -> sees device LIVE + captured session
    const snapAfterOnboarding = await request(ctx.app)
      .get(`/api/engine/snapshot?targetUserId=${encodeURIComponent(staffUserId)}`)
      .set('Cookie', staffCookie);
    expect(snapAfterOnboarding.status).toBe(200);
    expect(snapAfterOnboarding.body.visibility.timelinePermitted).toBe(true);

    const mayaDevice = snapAfterOnboarding.body.devices.find(
      (d: any) => d.userId === staffUserId && d.deviceId === deviceId
    );
    expect(mayaDevice).toBeTruthy();
    expect(mayaDevice.status).toBe('live');
    expect(mayaDevice.extensionConnected).toBe(true);
    expect(snapAfterOnboarding.body.sessions.length).toBeGreaterThanOrEqual(1);

    // 10. Sign out and verify regular password + TOTP sign-in works cleanly
    await request(ctx.app).post('/api/auth/logout').set('Cookie', staffCookie);
    const normalLogin = await request(ctx.app).post('/api/auth/login').send({
      email: 'maya.lin@harborview.example',
      password: 'MayaPersonalPass!2026',
      totpCode: generateTotpToken(staffSecret),
    });
    expect(normalLogin.status).toBe(200);
    expect(normalLogin.body.user.mfaVerified).toBe(true);
    expect(normalLogin.body.user.mustSetPassword).toBe(false);

    // 11. Admin can rotate onboarding keys for workstation re-provisioning
    const rotateRes = await request(ctx.app)
      .post(`/api/auth/provision-user/${encodeURIComponent(staffUserId)}/rotate-key`)
      .set('Cookie', adminCookie)
      .send({ workstationLabel: 'Maya Replacement Laptop' });
    expect(rotateRes.status).toBe(200);
    expect(rotateRes.body.accountAccessKey).toMatch(/^ontrack_key_/);
    expect(rotateRes.body.installationKey).toMatch(/^ontrack_dev_/);
    expect(rotateRes.body.accountAccessKey).not.toBe(accessKey);
    expect(rotateRes.body.installationKey).not.toBe(installationKey);
  });
});
