import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DEMO_MODE = 'true';
});

import { createOnTrackServer } from '../server.ts';
import { isSubscriberPermittedForEvent } from '../server/wsGateway.ts';
import { getRolePolicy, ROLE_OPTIONS } from '../src/utils/roleConfig.ts';

describe('Role-Based Access Control, Views & Client Portal Isolation', () => {
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
  });

  it('defines tailored policies and default tabs for all 6 required roles', () => {
    expect(ROLE_OPTIONS.map((r) => r.value)).toEqual([
      'accountant',
      'team_lead',
      'line_manager',
      'executive',
      'client',
      'admin_it',
    ]);

    expect(getRolePolicy('accountant').defaultTab).toBe('timeline');
    expect(getRolePolicy('accountant').showTimerBar).toBe(true);

    expect(getRolePolicy('team_lead').defaultTab).toBe('overview');
    expect(getRolePolicy('team_lead').canDrilldownTimeline).toBe(true);

    expect(getRolePolicy('line_manager').defaultTab).toBe('overview');
    expect(getRolePolicy('line_manager').showTimerBar).toBe(false);

    expect(getRolePolicy('executive').defaultTab).toBe('overview');
    expect(getRolePolicy('executive').canQuickLog).toBe(false);

    expect(getRolePolicy('client').allowedTabs.map((t) => t.id)).toEqual(['portal']);
    expect(getRolePolicy('client').showTimerBar).toBe(false);

    expect(getRolePolicy('admin_it').defaultTab).toBe('admin');
    expect(getRolePolicy('admin_it').allowedTabs.map((t) => t.id)).toEqual([
      'admin',
      'autotrack',
    ]);
  });

  it('enforces server-side RBAC on /api/engine/role-overview across all roles', async () => {
    // 1. Accountant sees own capacity only
    const accRes = await request(ctx.app).get(
      '/api/engine/role-overview?tenantId=firm_demo&viewerRole=accountant'
    );
    expect(accRes.status).toBe(200);
    expect(accRes.body.staffCapacity).toHaveLength(1);
    expect(accRes.body.staffCapacity[0].userId).toBe('demo_u_acc_01');
    expect(accRes.body.adminAlerts).toBeNull();

    // 2. Executive sees firm-wide utilization, profitability, and forecast
    const execRes = await request(ctx.app).get(
      '/api/engine/role-overview?tenantId=firm_demo&viewerRole=executive'
    );
    expect(execRes.status).toBe(200);
    expect(execRes.body.staffCapacity.length).toBeGreaterThan(1);
    expect(execRes.body.clientProfitability.length).toBeGreaterThan(0);
    expect(execRes.body.recurringForecast).toHaveLength(4);
    expect(execRes.body.adminAlerts).toBeNull();

    // 3. Admin / IT sees device freshness alerts & audit logs with ZERO client work content
    const adminRes = await request(ctx.app).get(
      '/api/engine/role-overview?tenantId=firm_demo&viewerRole=admin_it'
    );
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.adminAlerts).toBeTruthy();
    expect(adminRes.body.clientProfitability).toEqual([]);
    expect(adminRes.body.deadlineRisks).toEqual([]);
    expect(adminRes.body.recurringForecast).toEqual([]);
    expect(adminRes.body.devices.length).toBeGreaterThan(0);

    // 4. Client is strictly forbidden from internal role-overview
    const clientRes = await request(ctx.app).get(
      '/api/engine/role-overview?tenantId=firm_demo&viewerRole=client'
    );
    expect(clientRes.status).toBe(403);
  });

  it('hides raw individual timelines from executive & admin_it while logging team_lead drill-down', async () => {
    const execSnap = await request(ctx.app).get(
      '/api/engine/snapshot?tenantId=firm_demo&viewerUserId=demo_u_exec_01&viewerRole=executive&targetUserId=demo_u_acc_01'
    );
    expect(execSnap.status).toBe(200);
    expect(execSnap.body.visibility.timelinePermitted).toBe(false);
    expect(execSnap.body.sessions).toEqual([]);

    const execDrill = await request(ctx.app).get(
      '/api/engine/snapshot?tenantId=firm_demo&viewerUserId=demo_u_exec_01&viewerRole=executive&targetUserId=demo_u_acc_01&drilldown=true'
    );
    expect(execDrill.status).toBe(403);

    const adminSnap = await request(ctx.app).get(
      '/api/engine/snapshot?tenantId=firm_demo&viewerUserId=demo_u_admin_01&viewerRole=admin_it&targetUserId=demo_u_acc_01'
    );
    expect(adminSnap.status).toBe(200);
    expect(adminSnap.body.visibility.timelinePermitted).toBe(false);
    expect(adminSnap.body.clients).toEqual([]);
    expect(adminSnap.body.tasks).toEqual([]);

    const leadDrill = await request(ctx.app).get(
      '/api/engine/snapshot?tenantId=firm_demo&viewerUserId=demo_u_lead_01&viewerRole=team_lead&targetUserId=demo_u_acc_01&drilldown=true'
    );
    expect(leadDrill.status).toBe(200);
    expect(leadDrill.body.visibility.timelinePermitted).toBe(true);

    const adminAuditCheck = await request(ctx.app).get(
      '/api/engine/role-overview?tenantId=firm_demo&viewerRole=admin_it'
    );
    expect(adminAuditCheck.status).toBe(200);
    expect(
      adminAuditCheck.body.auditLogs.some((l: any) => l.action === 'timeline.drilldown')
    ).toBe(true);
  });

  it('enforces PORT-1 Client Portal isolation and confirmed-milestones-only boundary', async () => {
    const portalRes = await request(ctx.app).get(
      '/api/portal/overview?tenantId=firm_demo&viewerRole=client'
    );
    expect(portalRes.status).toBe(200);
    expect(portalRes.body.clientId).toBe('demo_cli-acme');
    expect(portalRes.body.milestones.length).toBeGreaterThanOrEqual(2);
    for (const m of portalRes.body.milestones) {
      expect(['confirmed', 'withdrawn']).toContain(m.status);
    }

    // Admin / IT cannot access Client Portal work content
    const adminPortal = await request(ctx.app).get(
      '/api/portal/overview?tenantId=firm_demo&viewerRole=admin_it'
    );
    expect(adminPortal.status).toBe(403);

    // Client cannot query internal tracking snapshot
    const clientEngine = await request(ctx.app).get(
      '/api/engine/snapshot?tenantId=firm_demo&viewerUserId=demo_u_client_01&viewerRole=client'
    );
    expect(clientEngine.status).toBe(403);
  });

  it('blocks raw activity:updated WebSocket broadcasts for executive, line_manager, client, and admin_it', () => {
    const activityMsg = {
      tenantId: 'firm_demo',
      affectedUserId: 'demo_u_acc_01',
      affectedTeamId: 'team_audit',
      eventType: 'activity:updated' as const,
    };

    expect(
      isSubscriberPermittedForEvent(
        { tenantId: 'firm_demo', userId: 'demo_u_acc_01', role: 'accountant', teamId: 'team_audit' },
        activityMsg
      )
    ).toBe(true);

    for (const blockedRole of ['executive', 'line_manager', 'client', 'admin_it'] as const) {
      expect(
        isSubscriberPermittedForEvent(
          { tenantId: 'firm_demo', userId: `u_${blockedRole}`, role: blockedRole, teamId: 'team_audit' },
          activityMsg
        )
      ).toBe(false);
    }

    expect(
      isSubscriberPermittedForEvent(
        { tenantId: 'firm_demo', userId: 'demo_u_admin_01', role: 'admin_it', teamId: 'team_ops' },
        {
          tenantId: 'firm_demo',
          affectedUserId: 'demo_u_acc_01',
          eventType: 'freshness:updated',
        }
      )
    ).toBe(true);
  });

  it('supports weekend shift (16h) and demo account sign-in across all roles', async () => {
    const listRes = await request(ctx.app).get('/api/auth/demo-accounts');
    expect(listRes.status).toBe(200);
    expect(listRes.body.demoModeEnabled).toBe(true);
    const rolesFound = new Set(listRes.body.accounts.map((a: any) => a.role));
    expect(rolesFound).toEqual(
      new Set(['accountant', 'team_lead', 'line_manager', 'executive', 'client', 'admin_it'])
    );
    expect(
      listRes.body.accounts.some(
        (a: any) => a.userId === 'demo_u_acc_04' && a.shiftPattern === 'weekend'
      )
    ).toBe(true);

    const mgrRes = await request(ctx.app).get(
      '/api/engine/role-overview?tenantId=firm_demo&viewerRole=line_manager'
    );
    expect(mgrRes.status).toBe(200);
    const weekendRow = mgrRes.body.staffCapacity.find(
      (s: any) => s.userId === 'demo_u_acc_04'
    );
    expect(weekendRow).toBeTruthy();
    expect(weekendRow.shiftPattern).toBe('weekend');
    expect(weekendRow.availableHoursWeek).toBe(13.6);

    // Demo login establishes an authenticated cookie session for multi-client portal isolation
    const loginRes = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_client_02' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.role).toBe('client');
    expect(loginRes.body.user.clientId).toBe('demo_cli-northstar');
    const cookieHeader = loginRes.headers['set-cookie'];
    expect(cookieHeader).toBeTruthy();

    const portalRes = await request(ctx.app)
      .get('/api/portal/overview')
      .set('Cookie', cookieHeader);
    expect(portalRes.status).toBe(200);
    expect(portalRes.body.clientId).toBe('demo_cli-northstar');
    expect(portalRes.body.clientName).toBe('Northstar Logistics');
  });
});
