import fs from 'node:fs';
import * as OTPAuth from 'otpauth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-task-collab-test-${Date.now()}`;
  process.env.DEMO_MODE = 'false';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';
import { isSubscriberPermittedForEvent } from '../server/wsGateway.ts';

function generateTotpToken(secretBase32: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

async function enrollAndConfirmMfa(
  app: Parameters<typeof request>[0],
  cookies: string[]
): Promise<string[]> {
  const enroll = await request(app).post('/api/auth/mfa/enroll').set('Cookie', cookies);
  expect(enroll.status).toBe(200);
  const code = generateTotpToken(enroll.body.secretBase32);
  const confirm = await request(app)
    .post('/api/auth/mfa/confirm')
    .set('Cookie', cookies)
    .send({ code });
  expect(confirm.status).toBe(200);
  const refreshed = confirm.headers['set-cookie'];
  return Array.isArray(refreshed) ? refreshed : refreshed ? [refreshed] : cookies;
}

describe('Multi-Level Staff Task Assignment & Internal Collaboration Workflow', () => {
  let ctx: Awaited<ReturnType<typeof createOnTrackServer>>;
  let tenantId: string;

  let adminCookie: string[];

  let leadUserId: string;
  let leadCookie: string[];

  let managerCookie: string[];

  let execUserId: string;
  let execCookie: string[];

  let accAUserId: string;
  let accACookie: string[];

  let accBUserId: string;
  let accBCookie: string[];

  let accCUserId: string;
  let accCCookie: string[];

  let clientUserId: string;
  let clientCookie: string[];

  beforeAll(async () => {
    ctx = await createOnTrackServer({
      dbPath: ':memory:',
      seedDemo: false,
      disableVite: true,
    });

    // Bootstrap firm Admin/IT user
    const bootRes = await request(ctx.app).post('/api/auth/bootstrap').send({
      firmName: 'CollabWorks CPA LLP',
      slug: 'collabworks',
      name: 'Morgan Admin',
      email: 'admin@collabworks.example',
      password: 'StrongPassword!2026',
    });
    expect(bootRes.status).toBe(201);
    const bootCookies = Array.isArray(bootRes.headers['set-cookie'])
      ? bootRes.headers['set-cookie']
      : [bootRes.headers['set-cookie']];
    tenantId = bootRes.body.user.tenantId;
    adminCookie = await enrollAndConfirmMfa(ctx.app, bootCookies);

    // Helper to invite + accept staff/client members inside the same firm
    const provisionMember = async (params: {
      name: string;
      email: string;
      role: 'accountant' | 'team_lead' | 'line_manager' | 'executive' | 'client';
      needsMfa?: boolean;
    }) => {
      const invRes = await request(ctx.app)
        .post('/api/auth/invites')
        .set('Cookie', adminCookie)
        .send({
          email: params.email,
          name: params.name,
          role: params.role,
          teamId: 'team_audit',
          shiftPattern: '8-5',
        });
      expect(invRes.status).toBe(201);
      const accRes = await request(ctx.app).post('/api/auth/invites/accept').send({
        token: invRes.body.inviteToken,
        password: 'MemberPassword!2026',
      });
      expect(accRes.status).toBe(201);
      const raw = accRes.headers['set-cookie'];
      let cookies = Array.isArray(raw) ? raw : [raw];
      if (params.needsMfa) {
        cookies = await enrollAndConfirmMfa(ctx.app, cookies);
      }
      return { userId: accRes.body.user.userId as string, cookies };
    };

    const lead = await provisionMember({
      name: 'Taylor Lead',
      email: 'lead@collabworks.example',
      role: 'team_lead',
      needsMfa: true,
    });
    leadUserId = lead.userId;
    leadCookie = lead.cookies;

    const mgr = await provisionMember({
      name: 'Jordan Manager',
      email: 'manager@collabworks.example',
      role: 'line_manager',
      needsMfa: true,
    });
    managerCookie = mgr.cookies;

    const exec = await provisionMember({
      name: 'Avery Partner',
      email: 'exec@collabworks.example',
      role: 'executive',
      needsMfa: true,
    });
    execUserId = exec.userId;
    execCookie = exec.cookies;

    const accA = await provisionMember({
      name: 'Maya Accountant',
      email: 'maya@collabworks.example',
      role: 'accountant',
    });
    accAUserId = accA.userId;
    accACookie = accA.cookies;

    const accB = await provisionMember({
      name: 'Liam Accountant',
      email: 'liam@collabworks.example',
      role: 'accountant',
    });
    accBUserId = accB.userId;
    accBCookie = accB.cookies;

    const accC = await provisionMember({
      name: 'Noah Accountant',
      email: 'noah@collabworks.example',
      role: 'accountant',
    });
    accCUserId = accC.userId;
    accCCookie = accC.cookies;

    const cli = await provisionMember({
      name: 'External Client',
      email: 'client@acme-external.example',
      role: 'client',
    });
    clientUserId = cli.userId;
    clientCookie = cli.cookies;
  });

  afterAll(async () => {
    await ctx?.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('enforces role-tiered task assignment across Admin, Executive, Line Manager, Team Lead, Accountant, and Client roles', async () => {
    // Admin creates a task assigned directly to Team Lead
    const adminCreate = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', adminCookie)
      .send({
        title: 'SOX Controls Walkthrough',
        assignedUserId: leadUserId,
        estimatedMinutes: 180,
      });
    expect(adminCreate.status).toBe(200);
    expect(adminCreate.body.task.assignedUserId).toBe(leadUserId);
    expect(adminCreate.body.task.assignedUserName).toBe('Taylor Lead');
    expect(adminCreate.body.task.assignedUserRole).toBe('team_lead');
    const leadTaskId = adminCreate.body.task.id as string;

    // Line Manager reassigns to Executive, then Executive reassigns to Accountant A
    const mgrReassign = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(leadTaskId)}`)
      .set('Cookie', managerCookie)
      .send({ assignedUserId: execUserId });
    expect(mgrReassign.status).toBe(200);
    expect(mgrReassign.body.task.assignedUserId).toBe(execUserId);

    const execReassign = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(leadTaskId)}`)
      .set('Cookie', execCookie)
      .send({ assignedUserId: accAUserId });
    expect(execReassign.status).toBe(200);
    expect(execReassign.body.task.assignedUserId).toBe(accAUserId);

    // Lead creates a task for Accountant A
    const leadCreate = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', leadCookie)
      .send({
        title: 'Q4 Lease Schedule Audit',
        assignedUserId: accAUserId,
        estimatedMinutes: 120,
      });
    expect(leadCreate.status).toBe(200);

    // Accountant A cannot assign a task to a Team Lead, Manager, or Client
    const accEscalateAttempt = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', accACookie)
      .send({
        title: 'Unauthorized Escalation',
        assignedUserId: leadUserId,
        estimatedMinutes: 60,
      });
    expect(accEscalateAttempt.status).toBe(403);

    const assignToClient = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', leadCookie)
      .send({
        title: 'Invalid Client Assignment',
        assignedUserId: clientUserId,
        estimatedMinutes: 60,
      });
    expect(assignToClient.status).toBe(403);

    // Accountant A self-assigns, then delegates to peer Accountant B
    const accSelfCreate = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', accACookie)
      .send({
        title: 'AP Aging Reconciliation',
        assignedUserId: accAUserId,
        estimatedMinutes: 90,
      });
    expect(accSelfCreate.status).toBe(200);
    const peerTaskId = accSelfCreate.body.task.id as string;

    // Accountant B cannot reassign Accountant A's task
    const accBUnauthorized = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(peerTaskId)}`)
      .set('Cookie', accBCookie)
      .send({ assignedUserId: accBUserId });
    expect(accBUnauthorized.status).toBe(403);

    // Accountant A delegates owned task to peer Accountant B
    const accDelegate = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(peerTaskId)}`)
      .set('Cookie', accACookie)
      .send({ assignedUserId: accBUserId });
    expect(accDelegate.status).toBe(200);
    expect(accDelegate.body.task.assignedUserId).toBe(accBUserId);

    // Client role cannot read or mutate internal tasks
    const clientTasks = await request(ctx.app)
      .get('/api/engine/tasks')
      .set('Cookie', clientCookie);
    expect(clientTasks.status).toBe(403);

    // Restricted client rule blocks assigning to an uncleared staff member
    const restrictedClient = await request(ctx.app)
      .post('/api/engine/clients')
      .set('Cookie', leadCookie)
      .send({
        legalName: 'Confidential Biotech Corp',
        aliases: ['Biotech'],
        codes: ['BIO-01'],
        folderPatterns: [],
        knownDomains: [],
        restrictedUserIds: [accAUserId],
      });
    expect(restrictedClient.status).toBe(200);
    const restrictedClientId = restrictedClient.body.client.id as string;

    const unclearedAssign = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', leadCookie)
      .send({
        clientId: restrictedClientId,
        clientName: 'Confidential Biotech Corp',
        title: 'Biotech Board Valuation',
        assignedUserId: accBUserId,
        estimatedMinutes: 120,
      });
    expect(unclearedAssign.status).toBe(403);
  });

  it('supports internal-only collaboration invites, collaborator editing, and auto-tracking attribution to shared tasks', async () => {
    // 1. Lead creates a client + engagement task assigned to Accountant A
    const cliRes = await request(ctx.app)
      .post('/api/engine/clients')
      .set('Cookie', leadCookie)
      .send({
        legalName: 'Meridian Manufacturing',
        aliases: ['Meridian'],
        codes: ['MERIDIAN'],
        folderPatterns: ['/Clients/Meridian'],
        knownDomains: ['meridian.example'],
        restrictedUserIds: [],
      });
    expect(cliRes.status).toBe(200);
    const cliId = cliRes.body.client.id as string;

    const tskRes = await request(ctx.app)
      .post('/api/engine/tasks')
      .set('Cookie', leadCookie)
      .send({
        clientId: cliId,
        clientName: 'Meridian Manufacturing',
        title: 'Inventory Valuation Close',
        assignedUserId: accAUserId,
        estimatedMinutes: 240,
      });
    expect(tskRes.status).toBe(200);
    const sharedTaskId = tskRes.body.task.id as string;

    // 2. Reject inviting external client accounts or non-existent external emails/IDs
    const inviteClientRes = await request(ctx.app)
      .post(`/api/engine/tasks/${encodeURIComponent(sharedTaskId)}/invites`)
      .set('Cookie', accACookie)
      .send({ inviteeUserId: clientUserId });
    expect(inviteClientRes.status).toBe(400);
    expect(inviteClientRes.body.code).toBe('EXTERNAL_CLIENT_FORBIDDEN');

    const inviteUnknownRes = await request(ctx.app)
      .post(`/api/engine/tasks/${encodeURIComponent(sharedTaskId)}/invites`)
      .set('Cookie', accACookie)
      .send({ inviteeUserId: 'external_stranger_id' });
    expect(inviteUnknownRes.status).toBe(404);

    // 3. Accountant A invites internal colleague Accountant B
    const inviteBRes = await request(ctx.app)
      .post(`/api/engine/tasks/${encodeURIComponent(sharedTaskId)}/invites`)
      .set('Cookie', accACookie)
      .send({
        inviteeUserId: accBUserId,
        note: 'Please co-own Inventory Valuation workbook.',
      });
    expect(inviteBRes.status).toBe(201);
    expect(inviteBRes.body.invite.status).toBe('pending');
    expect(inviteBRes.body.task.pendingInviteUserIds).toContain(accBUserId);
    const inviteId = inviteBRes.body.invite.id as string;

    // 4. Unrelated Accountant C cannot accept Accountant B's invitation
    const accCAcceptAttempt = await request(ctx.app)
      .post(`/api/engine/task-invites/${encodeURIComponent(inviteId)}/respond`)
      .set('Cookie', accCCookie)
      .send({ action: 'accept' });
    expect(accCAcceptAttempt.status).toBe(403);

    // 5. Accountant B sees the pending invite and accepts it
    const bInvitesList = await request(ctx.app)
      .get('/api/engine/task-invites')
      .set('Cookie', accBCookie);
    expect(bInvitesList.status).toBe(200);
    expect(
      bInvitesList.body.invites.some(
        (i: any) => i.id === inviteId && i.status === 'pending'
      )
    ).toBe(true);

    const accBAccept = await request(ctx.app)
      .post(`/api/engine/task-invites/${encodeURIComponent(inviteId)}/respond`)
      .set('Cookie', accBCookie)
      .send({ action: 'accept' });
    expect(accBAccept.status).toBe(200);
    expect(accBAccept.body.invite.status).toBe('accepted');
    expect(accBAccept.body.task.collaboratorUserIds).toContain(accBUserId);

    // 6. Collaborator Accountant B can edit the shared task, while uninvited Accountant C cannot
    const accBEdit = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(sharedTaskId)}`)
      .set('Cookie', accBCookie)
      .send({ status: 'in_progress', estimatedMinutes: 270 });
    expect(accBEdit.status).toBe(200);
    expect(accBEdit.body.task.status).toBe('in_progress');
    expect(accBEdit.body.task.estimatedMinutes).toBe(270);

    const accCEdit = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(sharedTaskId)}`)
      .set('Cookie', accCCookie)
      .send({ status: 'completed' });
    expect(accCEdit.status).toBe(403);

    // 7. Auto-Tracking Attribution attributes Accountant B's workstation session to the shared task
    const pairRes = await request(ctx.app)
      .post('/api/engine/devices/pair')
      .set('Cookie', adminCookie)
      .send({
        tenantId,
        userId: accBUserId,
        deviceId: 'dev_liam_laptop',
        label: 'Liam MacBook',
      });
    expect(pairRes.status).toBe(200);
    const deviceToken = pairRes.body.rawToken as string;

    const nowMs = Date.now();
    const evStart = new Date(nowMs - 20 * 60 * 1000).toISOString();
    const evEnd = new Date(nowMs - 1 * 60 * 1000).toISOString();
    const syncRes = await request(ctx.app)
      .post('/api/engine/sync')
      .set('Authorization', `Bearer ${deviceToken}`)
      .send({
        tenantId,
        userId: accBUserId,
        deviceId: 'dev_liam_laptop',
        events: [
          {
            event_id: `ev-collab-1-${Date.now()}`,
            schema_version: 1,
            tenant_id: tenantId,
            user_id: accBUserId,
            device_id: 'dev_liam_laptop',
            seq: 1,
            type: 'activity.window',
            priority: 'activity',
            event_time_utc: evStart,
            received_at: null,
            payload: {
              app: 'Microsoft Excel',
              window_title: 'Meridian Manufacturing - Inventory Valuation Close.xlsx',
              file_path: '/Clients/Meridian/Inventory Valuation Close.xlsx',
              duration_ms: 19 * 60 * 1000,
              os_platform: 'macos',
            },
          },
          {
            event_id: `ev-collab-2-${Date.now()}`,
            schema_version: 1,
            tenant_id: tenantId,
            user_id: accBUserId,
            device_id: 'dev_liam_laptop',
            seq: 2,
            type: 'activity.window',
            priority: 'activity',
            event_time_utc: evEnd,
            received_at: null,
            payload: {
              app: 'Microsoft Excel',
              window_title: 'Meridian Manufacturing - Inventory Valuation Close.xlsx',
              file_path: '/Clients/Meridian/Inventory Valuation Close.xlsx',
              duration_ms: 60 * 1000,
              os_platform: 'macos',
            },
          },
        ],
      });
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.acceptedCount).toBe(2);

    const bSnapshot = await request(ctx.app)
      .get('/api/engine/snapshot')
      .set('Cookie', accBCookie);
    expect(bSnapshot.status).toBe(200);
    const matchingAttr = bSnapshot.body.attributions.find(
      (a: any) => a.taskId === sharedTaskId
    );
    expect(matchingAttr).toBeTruthy();
    expect(matchingAttr.confidence).toBeGreaterThanOrEqual(0.5);
    expect(matchingAttr.reason).toContain('collaborating on shared in-progress task');

    const bChecklist = bSnapshot.body.checklistItems.find(
      (c: any) => c.taskId === sharedTaskId
    );
    expect(bChecklist).toBeTruthy();

    // 8. Owner or Manager removes collaborator; collaborator immediately loses edit access
    const removeRes = await request(ctx.app)
      .delete(
        `/api/engine/tasks/${encodeURIComponent(sharedTaskId)}/collaborators/${encodeURIComponent(accBUserId)}`
      )
      .set('Cookie', accACookie);
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.task.collaboratorUserIds).not.toContain(accBUserId);

    const bEditAfterRemove = await request(ctx.app)
      .patch(`/api/engine/tasks/${encodeURIComponent(sharedTaskId)}`)
      .set('Cookie', accBCookie)
      .send({ estimatedMinutes: 300 });
    expect(bEditAfterRemove.status).toBe(403);
  });

  it('delivers multi-recipient state:updated broadcasts to task owner and collaborators while isolating non-members and clients', () => {
    const stateMsg = {
      tenantId,
      affectedUserId: accAUserId,
      affectedUserIds: [accAUserId, accBUserId],
      eventType: 'state:updated' as const,
    };

    expect(
      isSubscriberPermittedForEvent(
        { tenantId, userId: accAUserId, role: 'accountant', teamId: 'team_audit' },
        stateMsg
      )
    ).toBe(true);
    expect(
      isSubscriberPermittedForEvent(
        { tenantId, userId: accBUserId, role: 'accountant', teamId: 'team_audit' },
        stateMsg
      )
    ).toBe(true);
    expect(
      isSubscriberPermittedForEvent(
        { tenantId, userId: accCUserId, role: 'accountant', teamId: 'team_audit' },
        stateMsg
      )
    ).toBe(false);
    expect(
      isSubscriberPermittedForEvent(
        { tenantId, userId: clientUserId, role: 'client', teamId: 'team_client' },
        stateMsg
      )
    ).toBe(false);
    expect(
      isSubscriberPermittedForEvent(
        { tenantId, userId: leadUserId, role: 'team_lead', teamId: 'team_audit' },
        stateMsg
      )
    ).toBe(true);
  });
});
