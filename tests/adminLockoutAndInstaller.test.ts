import fs from 'node:fs';
import JSZip from 'jszip';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-admin-lockout-test-${Date.now()}`;
  process.env.DEMO_MODE = 'false';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';
import { appendBundleOverlayToExe } from '../server/installerBuilder.ts';

function generateTotpToken(secretBase32: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

describe('Admin Lockout Prevention & Unified Collector Installer Bundles', () => {
  let ctx: Awaited<ReturnType<typeof createOnTrackServer>>;
  let adminCookie: string[];
  let adminUserId: string;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createOnTrackServer({
      dbPath: ':memory:',
      seedDemo: false,
      disableVite: true,
    });

    // Bootstrap initial firm + Admin/IT user and enroll MFA
    const bootRes = await request(ctx.app).post('/api/auth/bootstrap').send({
      firmName: 'Lockguard CPA LLP',
      slug: 'lockguard',
      name: 'Alex Morgan',
      email: 'alex@lockguard.example',
      password: 'LockguardAdmin!2026',
    });
    expect(bootRes.status).toBe(201);
    const rawCookie = bootRes.headers['set-cookie'];
    adminCookie = Array.isArray(rawCookie) ? rawCookie : rawCookie ? [rawCookie] : [];
    adminUserId = bootRes.body.user.userId;
    tenantId = bootRes.body.user.tenantId;

    const enroll = await request(ctx.app)
      .post('/api/auth/mfa/enroll')
      .set('Cookie', adminCookie);
    expect(enroll.status).toBe(200);
    const code = generateTotpToken(enroll.body.secretBase32);
    const confirm = await request(ctx.app)
      .post('/api/auth/mfa/confirm')
      .set('Cookie', adminCookie)
      .send({ code });
    expect(confirm.status).toBe(200);
  });

  afterAll(async () => {
    await ctx?.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('prevents an admin from switching their own role to accountant or removing the last active admin', async () => {
    // 1. Self-demotion attempt must fail with 400 CANNOT_DEMOTE_SELF
    const selfDemote = await request(ctx.app)
      .patch(`/api/engine/staff/${encodeURIComponent(adminUserId)}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'accountant' });
    expect(selfDemote.status).toBe(400);
    expect(selfDemote.body.code).toBe('CANNOT_DEMOTE_SELF');

    // Confirm admin still retains admin_it role and access to /api/engine/staff
    const staffBefore = await request(ctx.app)
      .get('/api/engine/staff')
      .set('Cookie', adminCookie);
    expect(staffBefore.status).toBe(200);
    const selfRow = staffBefore.body.staff.find((u: any) => u.userId === adminUserId);
    expect(selfRow?.role).toBe('admin_it');

    // 2. Updating own shift pattern while keeping admin_it role succeeds
    const shiftUpdate = await request(ctx.app)
      .patch(`/api/engine/staff/${encodeURIComponent(adminUserId)}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'admin_it', shiftPattern: 'remote' });
    expect(shiftUpdate.status).toBe(200);

    // 3. Direct store call attempting to demote the sole remaining active admin is blocked (409 LAST_ADMIN_REQUIRED)
    await expect(
      ctx.engineStore.updateShiftUserRole(
        tenantId,
        adminUserId,
        'accountant',
        undefined,
        undefined,
        undefined,
        'u_other_system_actor'
      )
    ).rejects.toMatchObject({ code: 'LAST_ADMIN_REQUIRED', status: 409 });

    // 4. Invite a second user -> promote to admin_it -> demote second user back to accountant succeeds
    const invRes = await request(ctx.app)
      .post('/api/auth/invites')
      .set('Cookie', adminCookie)
      .send({
        email: 'second@lockguard.example',
        name: 'Jordan Patel',
        role: 'accountant',
        teamId: 'team_audit',
        shiftPattern: '8-5',
      });
    expect(invRes.status).toBe(201);
    const accRes = await request(ctx.app).post('/api/auth/invites/accept').send({
      token: invRes.body.inviteToken,
      password: 'JordanPassword!2026',
    });
    expect(accRes.status).toBe(201);
    const secondUserId = accRes.body.user.userId;

    const promote = await request(ctx.app)
      .patch(`/api/engine/staff/${encodeURIComponent(secondUserId)}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'admin_it' });
    expect(promote.status).toBe(200);

    // Demoting the second admin back to accountant works because adminUserId remains active
    const demoteSecond = await request(ctx.app)
      .patch(`/api/engine/staff/${encodeURIComponent(secondUserId)}/role`)
      .set('Cookie', adminCookie)
      .send({ role: 'accountant' });
    expect(demoteSecond.status).toBe(200);
  });

  it('builds unified Windows & Unix installer packages sharing one bridge secret and preconfigured tenant metadata', async () => {
    const infoRes = await request(ctx.app)
      .get('/api/engine/package/installer-info')
      .set('Cookie', adminCookie);
    expect(infoRes.status).toBe(200);
    expect(typeof infoRes.body.windowsExeReady).toBe('boolean');

    const sharedSecret = 'bridge_secret_unified_test_123456';
    const winRes = await request(ctx.app)
      .post('/api/engine/package/windows-installer')
      .set('Cookie', adminCookie)
      .send({
        serverUrl: 'https://ontrack.lockguard.example',
        userId: adminUserId,
        bridgeSecret: sharedSecret,
      })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(winRes.status).toBe(200);

    const payload = winRes.body as Buffer;
    let innerBundleBuf: Buffer;
    if (winRes.headers['x-ontrack-installer-format'] === 'exe') {
      expect(payload.slice(0, 2).toString('ascii')).toBe('MZ');
      expect(payload.slice(-8).toString('ascii')).toBe('OTBNDL01');
      const len = Number(payload.readBigUInt64LE(payload.length - 16));
      innerBundleBuf = payload.slice(payload.length - 16 - len, payload.length - 16);
    } else {
      const outer = await JSZip.loadAsync(payload);
      expect(Object.keys(outer.files)).toContain('OnTrack-Setup.bat');
      expect(Object.keys(outer.files)).toContain('OnTrackSetup.cs');
      expect(Object.keys(outer.files)).toContain('ontrack-bundle.zip');
      innerBundleBuf = await outer.files['ontrack-bundle.zip'].async('nodebuffer');
    }

    const inner = await JSZip.loadAsync(innerBundleBuf);
    const innerFiles = Object.keys(inner.files);
    expect(innerFiles).toContain('desktop-agent/src/agent.ts');
    expect(innerFiles).toContain('desktop-agent/native/windows/FocusWatcher.cs');
    expect(innerFiles).toContain('browser-extension/manifest.json');
    expect(innerFiles).toContain('install-meta.json');

    const meta = JSON.parse(await inner.files['install-meta.json'].async('string'));
    expect(meta.serverUrl).toBe('https://ontrack.lockguard.example');
    expect(meta.tenantId).toBe(tenantId);
    expect(meta.userId).toBe(adminUserId);
    expect(meta.bridgeSecret).toBe(sharedSecret);

    // Verify PE overlay helper layout round-trips cleanly
    const fakeStub = Buffer.from('MZfakePEstub');
    const combined = appendBundleOverlayToExe(fakeStub, innerBundleBuf);
    expect(combined.slice(-8).toString('ascii')).toBe('OTBNDL01');
    expect(Number(combined.readBigUInt64LE(combined.length - 16))).toBe(innerBundleBuf.length);

    // Verify Unix installer package
    const unixRes = await request(ctx.app)
      .post('/api/engine/package/unix-installer')
      .set('Cookie', adminCookie)
      .send({
        serverUrl: 'https://ontrack.lockguard.example',
        bridgeSecret: sharedSecret,
      })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(unixRes.status).toBe(200);
    const unixZip = await JSZip.loadAsync(unixRes.body as Buffer);
    expect(Object.keys(unixZip.files)).toContain('install.sh');
    expect(Object.keys(unixZip.files)).toContain('desktop-agent/src/agent.ts');
    expect(Object.keys(unixZip.files)).toContain('browser-extension/manifest.json');
  });
});
