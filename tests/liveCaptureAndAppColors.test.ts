import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DEMO_MODE = 'true';
});

import { CapturePipeline } from '../packages/desktop-agent/src/capture/captureSampler.ts';
import { CaptureRuntime } from '../packages/desktop-agent/src/captureRuntime.ts';
import { createOnTrackServer } from '../server.ts';
import { isSubscriberPermittedForEvent } from '../server/wsGateway.ts';
import {
  APP_PALETTE_PRESETS,
  canonicalizeAppName,
  getAppColorTokens,
  isValidAppColorValue,
} from '../src/utils/workspaceConstants.ts';

describe('Application Color Coding & Normalization', () => {
  it('canonicalizes executable aliases and auto-assigns distinct colors for arbitrary apps', () => {
    expect(canonicalizeAppName('excel.exe')).toBe('Microsoft Excel');
    expect(canonicalizeAppName('chrome.exe')).toBe('Google Chrome');
    expect(canonicalizeAppName('cwin64.exe')).toBe('CaseWare');
    expect(canonicalizeAppName('TaxPrepPro.exe')).toBe('TaxPrepPro');

    const excel = getAppColorTokens('EXCEL.EXE');
    const qb = getAppColorTokens('QuickBooks Online');
    const slack = getAppColorTokens('slack');
    const chrome = getAppColorTokens('Google Chrome');

    expect(excel.presetId).toBe('emerald');
    expect(qb.presetId).toBe('teal');
    expect(slack.presetId).toBe('fuchsia');
    expect(chrome.presetId).toBe('sky');
    expect(new Set([excel.hex, qb.hex, slack.hex, chrome.hex]).size).toBe(4);

    // Arbitrary unseen apps get deterministic FNV-1a palette assignments rather than Chrome blue fallback
    const customAppA = getAppColorTokens('Sage 50cloud Accounting');
    const customAppB = getAppColorTokens('Sage 50cloud Accounting');
    const customAppC = getAppColorTokens('Thomson Reuters UltraTax CS');
    expect(customAppA.hex).toBe(customAppB.hex);
    expect(APP_PALETTE_PRESETS.some((p) => p.id === customAppA.presetId)).toBe(true);
    expect(APP_PALETTE_PRESETS.some((p) => p.id === customAppC.presetId)).toBe(true);
  });

  it('applies firm custom preset and hex overrides and validates color strings', () => {
    expect(isValidAppColorValue('emerald')).toBe(true);
    expect(isValidAppColorValue('#0f766e')).toBe(true);
    expect(isValidAppColorValue('red')).toBe(false);
    expect(isValidAppColorValue('url(https://evil.example)')).toBe(false);
    expect(isValidAppColorValue('#12345')).toBe(false);

    const presetOverride = getAppColorTokens('Microsoft Excel', {
      'Microsoft Excel': 'rose',
    });
    expect(presetOverride.isCustom).toBe(true);
    expect(presetOverride.presetId).toBe('rose');
    expect(presetOverride.bar).toContain('rose');

    const hexOverride = getAppColorTokens('winword.exe', {
      'Microsoft Word': '#0F766E',
    });
    expect(hexOverride.canonicalName).toBe('Microsoft Word');
    expect(hexOverride.isCustom).toBe(true);
    expect(hexOverride.customHex).toBe('#0f766e');
    expect(hexOverride.barTextColor).toBe('#ffffff');

    const lightHex = getAppColorTokens('Notion', { Notion: '#fef08a' });
    expect(lightHex.barTextColor).toBe('#0f172a');
  });
});

describe('Agent Live Open Segment Tracking', () => {
  const T0 = Date.parse('2026-11-25T10:00:00Z');

  it('exposes the open segment immediately on sample 1 before segment closes and clears when paused', () => {
    const pipeline = new CapturePipeline({ segmentMaxMs: 5_000, minSegmentMs: 1_500 });
    expect(pipeline.getOpenSegment()).toBeNull();

    const emitted = pipeline.ingest(
      {
        atMs: T0,
        app: 'Microsoft Excel',
        windowTitle: 'Acme_FY26_TB.xlsx - Excel',
        filePath: 'C:\\Clients\\Acme\\Acme_FY26_TB.xlsx',
        idleSeconds: 0,
        sessionLocked: false,
        systemSleeping: false,
        meetingActive: false,
        osPlatform: 'windows',
        source: 'native_events',
      },
      { extensionConnected: true }
    );
    expect(emitted).toHaveLength(0);

    const open = pipeline.getOpenSegment();
    expect(open).not.toBeNull();
    expect(open?.startMs).toBe(T0);
    expect(open?.state).toBe('active');
    expect(open?.payload.app).toBe('Microsoft Excel');
    expect(open?.payload.document_name).toBe('Acme_FY26_TB.xlsx');

    const closed = pipeline.close(T0 + 3_000);
    expect(closed).toHaveLength(1);
    expect(pipeline.getOpenSegment()).toBeNull();
  });

  it('exposes open state via CaptureRuntime and clears immediately when going off-the-record', () => {
    let nowMs = T0;
    const runtime = new CaptureRuntime({
      platform: 'windows',
      store: { load: () => null, save: () => undefined },
      onEvents: () => undefined,
      now: () => nowMs,
      pipeline: { segmentMaxMs: 5_000 },
    });

    runtime.handleSample(
      {
        atMs: nowMs,
        app: 'QuickBooks Online',
        windowTitle: 'Acme Ltd - Reconcile - QuickBooks',
        filePath: null,
        idleSeconds: 0,
        sessionLocked: false,
        systemSleeping: false,
        meetingActive: false,
        osPlatform: 'windows',
        source: 'native_events',
      },
      true
    );

    const liveState = runtime.getOpenState();
    expect(liveState).not.toBeNull();
    expect(liveState?.payload.app).toBe('QuickBooks Online');
    expect(liveState?.state).toBe('active');

    nowMs += 4_000;
    runtime.applyControl({ action: 'offTheRecord', enabled: true });
    expect(runtime.getOpenState()).toBeNull();
  });
});

describe('Server Live Activity Validation, VIS-1 Privacy & Firm App Colors API', () => {
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

  it('validates live pulses against forbidden fields & privacy rules and extracts liveActivity from sync batches', async () => {
    const forbiddenRes = await ctx.engineStore.validateLivePulse({
      tenantId: 'firm_demo',
      userId: 'demo_u_acc_01',
      deviceId: 'dev_test',
      rawPulse: {
        appName: 'Microsoft Excel',
        documentTitle: 'Secret.xlsx',
        keystrokes: 'abc',
      },
    });
    expect(forbiddenRes.allowed).toBe(false);
    expect(forbiddenRes.liveActivity).toBeNull();

    const incognitoRes = await ctx.engineStore.validateLivePulse({
      tenantId: 'firm_demo',
      userId: 'demo_u_acc_01',
      deviceId: 'dev_test',
      rawPulse: {
        appName: 'Google Chrome',
        documentTitle: 'Private Tab',
        incognito: true,
      },
    });
    expect(incognitoRes.allowed).toBe(false);

    const allowedPulse = await ctx.engineStore.validateLivePulse({
      tenantId: 'firm_demo',
      userId: 'demo_u_acc_01',
      deviceId: 'dev_test',
      rawPulse: {
        appName: 'Microsoft Excel',
        documentTitle: 'Acme_Q4_Recon.xlsx',
        state: 'active',
        source: 'agent',
      },
    });
    expect(allowedPulse.allowed).toBe(true);
    expect(allowedPulse.liveActivity?.appName).toBe('Microsoft Excel');
    expect(allowedPulse.liveActivity?.documentTitle).toBe('Acme_Q4_Recon.xlsx');

    const hbOnly = await ctx.engineStore.ingestEventBatch({
      tenantId: 'firm_demo',
      userId: 'demo_u_acc_01',
      deviceId: 'dev_test_live',
      events: [
        {
          event_id: 'hb-only-1',
          schema_version: 1,
          tenant_id: 'firm_demo',
          user_id: 'demo_u_acc_01',
          device_id: 'dev_test_live',
          seq: 1,
          type: 'activity.heartbeat',
          priority: 'activity',
          event_time_utc: new Date().toISOString(),
          received_at: null,
          payload: { app: 'ontrack-agent', window_title: 'Daemon' },
        },
      ],
    });
    expect(hbOnly.liveActivity).toBeNull();

    const winBatch = await ctx.engineStore.ingestEventBatch({
      tenantId: 'firm_demo',
      userId: 'demo_u_acc_01',
      deviceId: 'dev_test_live',
      events: [
        {
          event_id: 'win-live-1',
          schema_version: 1,
          tenant_id: 'firm_demo',
          user_id: 'demo_u_acc_01',
          device_id: 'dev_test_live',
          seq: 2,
          type: 'activity.window',
          priority: 'activity',
          event_time_utc: new Date().toISOString(),
          received_at: null,
          payload: {
            app: 'CaseWare',
            window_title: 'Acme Audit File.ac',
            document_name: 'Acme Audit File.ac',
            duration_ms: 5000,
          },
        },
      ],
    });
    expect(winBatch.liveActivity?.appName).toBe('CaseWare');
    expect(winBatch.liveActivity?.documentTitle).toBe('Acme Audit File.ac');
  });

  it('preserves VIS-1 isolation on live activity pulses while broadcasting tenant app color updates to staff', () => {
    const liveActivityMsg = {
      tenantId: 'firm_demo',
      affectedUserId: 'demo_u_acc_01',
      affectedTeamId: 'team_audit',
      eventType: 'activity:updated' as const,
      meta: { livePulseOnly: true },
    };

    expect(
      isSubscriberPermittedForEvent(
        { tenantId: 'firm_demo', userId: 'demo_u_acc_01', role: 'accountant', teamId: 'team_audit' },
        liveActivityMsg
      )
    ).toBe(true);
    expect(
      isSubscriberPermittedForEvent(
        { tenantId: 'firm_demo', userId: 'demo_u_acc_02', role: 'accountant', teamId: 'team_audit' },
        liveActivityMsg
      )
    ).toBe(false);
    for (const blockedRole of ['executive', 'line_manager', 'client', 'admin_it'] as const) {
      expect(
        isSubscriberPermittedForEvent(
          { tenantId: 'firm_demo', userId: `u_${blockedRole}`, role: blockedRole, teamId: 'team_audit' },
          liveActivityMsg
        )
      ).toBe(false);
    }

    const paletteBroadcastMsg = {
      tenantId: 'firm_demo',
      affectedUserId: 'demo_u_admin_01',
      eventType: 'state:updated' as const,
      meta: { broadcastTenantConfig: true, kind: 'app_colors_updated' },
    };
    expect(
      isSubscriberPermittedForEvent(
        { tenantId: 'firm_demo', userId: 'demo_u_acc_01', role: 'accountant', teamId: 'team_audit' },
        paletteBroadcastMsg
      )
    ).toBe(true);
    expect(
      isSubscriberPermittedForEvent(
        { tenantId: 'firm_demo', userId: 'demo_u_exec_01', role: 'executive', teamId: 'team_exec' },
        paletteBroadcastMsg
      )
    ).toBe(true);
    expect(
      isSubscriberPermittedForEvent(
        { tenantId: 'firm_demo', userId: 'demo_u_client_01', role: 'client', teamId: 'team_ext', clientId: 'demo_cli-acme' },
        paletteBroadcastMsg
      )
    ).toBe(false);
  });

  it('enforces RBAC and validation on PATCH /api/engine/app-colors and reflects overrides in snapshot', async () => {
    const accDenied = await request(ctx.app)
      .patch('/api/engine/app-colors?tenantId=firm_demo&viewerRole=accountant&viewerUserId=demo_u_acc_01')
      .send({ appName: 'Microsoft Excel', color: 'rose' });
    expect(accDenied.status).toBe(403);

    const invalidColor = await request(ctx.app)
      .patch('/api/engine/app-colors?tenantId=firm_demo&viewerRole=admin_it&viewerUserId=demo_u_admin_01')
      .send({ appName: 'Microsoft Excel', color: 'not-a-color' });
    expect(invalidColor.status).toBe(400);

    const leadUpdate = await request(ctx.app)
      .patch('/api/engine/app-colors?tenantId=firm_demo&viewerRole=team_lead&viewerUserId=demo_u_lead_01')
      .send({ appName: 'Microsoft Excel', color: '#0f766e' });
    expect(leadUpdate.status).toBe(200);
    expect(leadUpdate.body.config.appColors['Microsoft Excel']).toBe('#0f766e');

    const adminUpdate = await request(ctx.app)
      .patch('/api/engine/app-colors?tenantId=firm_demo&viewerRole=admin_it&viewerUserId=demo_u_admin_01')
      .send({ appName: 'Slack', color: 'cobalt' });
    expect(adminUpdate.status).toBe(200);
    expect(adminUpdate.body.config.appColors['Slack']).toBe('cobalt');
    expect(adminUpdate.body.config.appColors['Microsoft Excel']).toBe('#0f766e');

    const snap = await request(ctx.app).get(
      '/api/engine/snapshot?tenantId=firm_demo&viewerRole=accountant&viewerUserId=demo_u_acc_01'
    );
    expect(snap.status).toBe(200);
    expect(snap.body.config.appColors).toMatchObject({
      'Microsoft Excel': '#0f766e',
      Slack: 'cobalt',
    });

    // Reset Excel back to auto (null)
    const resetRes = await request(ctx.app)
      .patch('/api/engine/app-colors?tenantId=firm_demo&viewerRole=team_lead&viewerUserId=demo_u_lead_01')
      .send({ appName: 'Microsoft Excel', color: null });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.config.appColors['Microsoft Excel']).toBeUndefined();
    expect(resetRes.body.config.appColors['Slack']).toBe('cobalt');
  });
});
