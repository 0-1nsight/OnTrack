import fs from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-exec-demo-test-${Date.now()}`;
  process.env.DEMO_MODE = 'true';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';
import { isSubscriberPermittedForEvent } from '../server/wsGateway.ts';

describe('Demo Executive Accounts Lifecycle, Aggregate Visibility & Sign-Out', () => {
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

  it('exposes both demo executive accounts (Claire Vance & Arthur Sterling) and enforces full server-side security boundaries', async () => {
    const demoList = await request(ctx.app).get('/api/auth/demo-accounts');
    expect(demoList.status).toBe(200);
    expect(demoList.body.demoModeEnabled).toBe(true);

    const execAccounts = demoList.body.accounts.filter(
      (a: any) => a.role === 'executive'
    );
    expect(execAccounts.map((a: any) => a.userId)).toEqual([
      'demo_u_exec_01',
      'demo_u_exec_02',
    ]);

    for (const execUserId of ['demo_u_exec_01', 'demo_u_exec_02']) {
      // 1. Sign in via demo-login and obtain httpOnly cookie session
      const loginRes = await request(ctx.app)
        .post('/api/auth/demo-login')
        .send({ userId: execUserId });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.user.userId).toBe(execUserId);
      expect(loginRes.body.user.role).toBe('executive');
      expect(loginRes.body.user.isDemoSandbox).toBe(true);
      expect(loginRes.body.user.mfaVerified).toBe(true);

      const cookie = loginRes.headers['set-cookie'];
      expect(cookie).toBeTruthy();

      // 2. Verify /api/auth/me resolves the signed-in executive session
      const meRes = await request(ctx.app)
        .get('/api/auth/me')
        .set('Cookie', cookie);
      expect(meRes.status).toBe(200);
      expect(meRes.body.authenticated).toBe(true);
      expect(meRes.body.user.userId).toBe(execUserId);

      // 3. Executive Role Overview returns firm capacity rollup, profitability, forecast, & governance auditLogs
      const overviewRes = await request(ctx.app)
        .get('/api/engine/role-overview')
        .set('Cookie', cookie);
      expect(overviewRes.status).toBe(200);
      expect(overviewRes.body.role).toBe('executive');
      expect(overviewRes.body.staffCapacity.length).toBeGreaterThanOrEqual(4);
      expect(overviewRes.body.clientProfitability.length).toBeGreaterThan(0);
      expect(overviewRes.body.recurringForecast).toHaveLength(4);
      expect(overviewRes.body.freshnessSummary.dataAsOfUtc).toBeTruthy();
      expect(overviewRes.body.devices).toEqual([]);
      expect(overviewRes.body.adminAlerts).toBeNull();
      expect(Array.isArray(overviewRes.body.auditLogs)).toBe(true);

      // 4. Raw individual timeline is strictly withheld (and drilldown=true returns 403)
      const snapRes = await request(ctx.app)
        .get('/api/engine/snapshot?targetUserId=demo_u_acc_01')
        .set('Cookie', cookie);
      expect(snapRes.status).toBe(200);
      expect(snapRes.body.visibility.timelinePermitted).toBe(false);
      expect(snapRes.body.sessions).toEqual([]);
      expect(snapRes.body.attributions).toEqual([]);

      const drillRes = await request(ctx.app)
        .get('/api/engine/snapshot?targetUserId=demo_u_acc_01&drilldown=true')
        .set('Cookie', cookie);
      expect(drillRes.status).toBe(403);
      expect(drillRes.body.code).toBe('DRILLDOWN_FORBIDDEN');

      // 5. Client Portal confirmed milestone oversight works for executives
      const portalRes = await request(ctx.app)
        .get('/api/portal/overview')
        .set('Cookie', cookie);
      expect(portalRes.status).toBe(200);
      expect(portalRes.body.milestones.length).toBeGreaterThan(0);

      // 6. WebSocket gateway suppresses raw activity updates while forwarding state/portal summaries
      expect(
        isSubscriberPermittedForEvent(
          {
            tenantId: 'firm_demo',
            userId: execUserId,
            role: 'executive',
            teamId: 'team_audit',
          },
          {
            tenantId: 'firm_demo',
            affectedUserId: 'demo_u_acc_01',
            affectedTeamId: 'team_audit',
            eventType: 'activity:updated',
          }
        )
      ).toBe(false);
      expect(
        isSubscriberPermittedForEvent(
          {
            tenantId: 'firm_demo',
            userId: execUserId,
            role: 'executive',
            teamId: 'team_audit',
          },
          {
            tenantId: 'firm_demo',
            affectedUserId: 'demo_u_acc_01',
            affectedTeamId: 'team_audit',
            eventType: 'state:updated',
          }
        )
      ).toBe(true);

      // 7. Sign Out cleanly revokes cookie session so subsequent checks return unauthenticated
      const logoutRes = await request(ctx.app)
        .post('/api/auth/logout')
        .set('Cookie', cookie);
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.ok).toBe(true);

      const postLogoutMe = await request(ctx.app)
        .get('/api/auth/me')
        .set('Cookie', cookie);
      expect(postLogoutMe.status).toBe(200);
      expect(postLogoutMe.body).toEqual({ authenticated: false, user: null });
    }
  });
});
