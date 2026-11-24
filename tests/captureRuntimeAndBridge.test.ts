import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeRequestHandler } from '../packages/desktop-agent/src/bridge.ts';
import { CaptureRuntime } from '../packages/desktop-agent/src/captureRuntime.ts';
import type { CapturedEvent, CaptureSample } from '../packages/desktop-agent/src/capture/captureSampler.ts';

const T0 = Date.parse('2026-11-23T09:00:00Z');

function sample(atMs: number, over: Partial<CaptureSample> = {}): CaptureSample {
  return {
    atMs,
    app: 'Microsoft Excel',
    windowTitle: 'Acme TB.xlsx - Excel',
    filePath: null,
    idleSeconds: 0,
    sessionLocked: false,
    systemSleeping: false,
    meetingActive: false,
    osPlatform: 'windows',
    source: 'native_events',
    ...over,
  };
}

function makeRuntime(initial: unknown = null) {
  let nowMs = T0;
  let saved: unknown = initial;
  const emitted: CapturedEvent[] = [];
  const runtime = new CaptureRuntime({
    platform: 'windows',
    store: { load: () => saved, save: (s) => (saved = s) },
    onEvents: (e) => emitted.push(...e),
    now: () => nowMs,
  });
  return {
    runtime,
    emitted,
    advance: (ms: number) => (nowMs += ms),
    saved: () => saved,
  };
}

describe('capture runtime', () => {
  it('closes the open segment the moment the user goes off the record', () => {
    const h = makeRuntime();
    h.runtime.setCollectorMode('native_events');
    h.runtime.handleSample(sample(T0), true);
    h.advance(8000);
    const res = h.runtime.applyControl({ action: 'offTheRecord', enabled: true });
    expect(res.ok).toBe(true);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].payload.duration_ms).toBe(8000);
    // Later samples record nothing.
    expect(h.runtime.handleSample(sample(T0 + 20_000), true)).toEqual([]);
    expect(h.runtime.getHealth(true).level).toBe('stopped');
  });

  it('persists controls and restores them after a restart', () => {
    const h = makeRuntime();
    h.runtime.applyControl({ action: 'offTheRecord', enabled: true });
    const restarted = makeRuntime(h.saved());
    expect(restarted.runtime.getControls().offTheRecord).toBe(true);
    expect(restarted.runtime.getControls().allowedNow).toBe(false);
  });

  it('validates control input', () => {
    const h = makeRuntime();
    expect(h.runtime.applyControl({ action: 'pause', minutes: -5 }).ok).toBe(false);
    expect(h.runtime.applyControl({ action: 'pause' }).ok).toBe(false);
    expect(h.runtime.applyControl({ action: 'explode' }).ok).toBe(false);
    expect(
      h.runtime.applyControl({ action: 'setSchedule', schedule: [{ days: [1], start: '9am', end: '5pm' }] }).ok
    ).toBe(false);
    expect(
      h.runtime.applyControl({ action: 'setSchedule', schedule: [{ days: [1], start: '08:00', end: '17:00' }] }).ok
    ).toBe(true);
  });

  it('reports collector failure and recovers', () => {
    const h = makeRuntime();
    h.runtime.setCollectorMode('polling');
    for (let i = 0; i < 5; i++) h.runtime.recordCollectorError();
    expect(h.runtime.getHealth(true).level).toBe('poor');
    h.runtime.handleSample(sample(T0), true);
    expect(h.runtime.getHealth(true).issues.map((i) => i.code)).not.toContain('collector_failing');
  });

  it('keeps a bounded, newest-first log of what was recorded', () => {
    const h = makeRuntime();
    for (let i = 0; i < 250; i++) h.runtime.recordQueued('activity.window', T0 + i * 1000, { n: i });
    const recent = h.runtime.getRecentEvents(500);
    expect(recent).toHaveLength(200);
    expect(recent[0].payload.n).toBe(249);
  });
});

describe('loopback bridge controls', () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function start() {
    const h = makeRuntime();
    const server = http.createServer(
      createBridgeRequestHandler({
        getSecret: () => 'secret',
        getConfigInfo: () => ({ excludedDomains: [], idleThresholdSeconds: 180, deviceId: 'd' }),
        getHealthInfo: () => ({}),
        onBrowserEvent: () => true,
        getControls: () => h.runtime.getControls(),
        applyControl: (m) => h.runtime.applyControl(m),
        getCaptureHealth: () => ({ ...h.runtime.getHealth(true) }),
        getRecentEvents: (n) => h.runtime.getRecentEvents(n) as unknown as Record<string, unknown>[],
      })
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, h };
  }

  it('rejects control requests without the bridge secret', async () => {
    const { base, h } = await start();
    const res = await fetch(`${base}/controls`, { method: 'POST', body: JSON.stringify({ action: 'offTheRecord' }) });
    expect(res.status).toBe(401);
    expect(h.runtime.getControls().offTheRecord).toBe(false);
  });

  it('applies controls and serves health and the recorded-events log with the secret', async () => {
    const { base, h } = await start();
    const headers = { 'X-OnTrack-Bridge-Secret': 'secret' };

    h.runtime.recordQueued('activity.window', T0, { app: 'Excel' });
    const recent = await (await fetch(`${base}/recent-events?limit=5`, { headers })).json();
    expect(recent.events).toHaveLength(1);

    const paused = await fetch(`${base}/controls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'pause', minutes: 10 }),
    });
    expect(paused.status).toBe(200);
    expect((await paused.json()).controls.blockedReason).toBe('paused');

    const bad = await fetch(`${base}/controls`, { method: 'POST', headers, body: JSON.stringify({ action: 'nope' }) });
    expect(bad.status).toBe(400);

    const health = await (await fetch(`${base}/capture-health`, { headers })).json();
    expect(health.level).toBe('stopped');
  });
});
