import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createBridgeRequestHandler } from '../../packages/desktop-agent/src/bridge';
import { CaptureRuntime } from '../../packages/desktop-agent/src/captureRuntime';
import { LocalAgentSqliteStore } from '../../packages/desktop-agent/src/localStore';

test.describe('Component 1: Workstation Agent Controls & ManicTime Timeline Review', () => {
  let bridgeServer: http.Server;
  let bridgeBaseUrl: string;
  let bridgeSecret: string;
  let tempDir: string;
  let localStore: LocalAgentSqliteStore;
  let runtime: CaptureRuntime;

  test.beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontrack-e2e-agent-'));
    bridgeSecret = 'e2e-bridge-secret-ontrack-2026';
    localStore = new LocalAgentSqliteStore({
      dbPath: path.join(tempDir, '.ontrack-agent.db'),
      maxPendingRows: 500,
    });

    runtime = new CaptureRuntime({
      platform: 'linux',
      store: {
        load: () => localStore.loadControls(),
        save: (state) => localStore.saveControls(state),
      },
      onEvents: (events) => {
        for (const ev of events) {
          runtime.recordQueued(ev.type, Date.now(), ev.payload as Record<string, unknown>);
        }
      },
    });
    runtime.setCollectorMode('native_events');
    runtime.handleSample(
      {
        atMs: Date.now(),
        app: 'Microsoft Excel',
        windowTitle: 'Acme_Q3_Bank_Rec.xlsx - Excel',
        filePath: 'C:\\Clients\\Acme_Ltd\\Acme_Q3_Bank_Rec.xlsx',
        idleSeconds: 0,
        sessionLocked: false,
        systemSleeping: false,
        meetingActive: false,
        osPlatform: 'windows',
        source: 'native_events',
      },
      true
    );
    runtime.recordQueued('activity.window', Date.now() - 5000, {
      app: 'Microsoft Excel',
      window_title: 'Acme_Q3_Bank_Rec.xlsx - Excel',
      duration_ms: 900_000,
      os_platform: 'windows',
    });
    localStore.enqueue({
      event_id: 'e2e-local-ev-1',
      schema_version: 1,
      tenant_id: 'firm_demo',
      user_id: 'demo_u_acc_01',
      device_id: 'dev-e2e-win-01',
      seq: 1,
      type: 'activity.window',
      priority: 'activity',
      event_time_utc: new Date().toISOString(),
      received_at: null,
      payload: {
        app: 'Microsoft Excel',
        window_title: 'Acme_Q3_Bank_Rec.xlsx - Excel',
        duration_ms: 900_000,
      },
    });

    bridgeServer = http.createServer(
      createBridgeRequestHandler({
        getSecret: () => bridgeSecret,
        getAllowedOrigins: () => ['http://127.0.0.1:3000', 'http://localhost:3000'],
        getConfigInfo: () => ({
          excludedDomains: [],
          idleThresholdSeconds: 180,
          deviceId: 'dev-e2e-win-01',
        }),
        getHealthInfo: () => ({
          deviceId: 'dev-e2e-win-01',
          seq: 42,
          wsConnected: true,
          extensionConnected: true,
          clockSkewMs: 4,
          localStore: localStore.getStats(),
          latestSample: {
            app: 'Microsoft Excel',
            windowTitle: 'Acme_Q3_Bank_Rec.xlsx - Excel',
            idleSeconds: 0,
            osPlatform: 'windows',
          },
        }),
        onBrowserEvent: (payload) => {
          if (!runtime.getControls().allowedNow) return false;
          runtime.recordQueued('activity.browser', Date.now(), payload);
          return true;
        },
        getControls: () => runtime.getControls() as unknown as Record<string, unknown>,
        applyControl: (msg) =>
          runtime.applyControl(msg) as unknown as {
            ok: boolean;
            error?: string;
            controls?: Record<string, unknown>;
          },
        getCaptureHealth: () => ({
          ...runtime.getHealth(true),
          localStore: localStore.getStats(),
        }),
        getRecentEvents: (limit) =>
          runtime.getRecentEvents(limit) as unknown as Record<string, unknown>[],
      })
    );

    await new Promise<void>((resolve) => bridgeServer.listen(0, '127.0.0.1', resolve));
    const port = (bridgeServer.address() as AddressInfo).port;
    bridgeBaseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => bridgeServer.close(() => resolve()));
    localStore?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('logs in to Timeline, controls live background capture & SQLite health, and persists Timeline adjustments across reloads', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        // Ignore expected WebSocket close warnings during page reloads if any
        if (!txt.includes('WebSocket')) consoleErrors.push(txt);
      }
    });

    await page.addInitScript(
      ({ bUrl, bSecret }) => {
        window.localStorage.setItem('ontrack_bridge_url_v1', bUrl);
        window.localStorage.setItem('ontrack_bridge_secret_v1', bSecret);
      },
      { bUrl: bridgeBaseUrl, bSecret: bridgeSecret }
    );

    await page.goto('/');

    // Click Sign In / Demo Maya Patel (Accountant)
    const demoMayaBtn = page.getByRole('button', { name: /Maya Patel/i });
    if (await demoMayaBtn.isVisible().catch(() => false)) {
      await demoMayaBtn.click();
    } else {
      await page.getByRole('button', { name: /^Sign In$/i }).first().click();
      await page.getByRole('button', { name: /Maya Patel/i }).click();
    }

    // Should land directly on Timeline with Workstation Capture Strip
    await expect(page.getByText('Day View Activity Timeline')).toBeVisible({ timeout: 15_000 });
    const strip = page.getByTestId('workstation-capture-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('Background Capture Active · Recording', { timeout: 10_000 });
    await expect(strip).toContainText('Queued in SQLite');

    // Test Pause -> 15 minutes -> Resume Recording
    await strip.getByRole('button', { name: /^Pause$/i }).click();
    await strip.getByRole('button', { name: /Pause for 15 minutes/i }).click();
    await expect(strip).toContainText('Capture Paused', { timeout: 8_000 });

    await strip.getByRole('button', { name: /Resume Recording/i }).click();
    await expect(strip).toContainText('Background Capture Active · Recording', { timeout: 8_000 });

    // Test Off the Record -> Resume Recording
    await strip.getByRole('button', { name: /Off the Record/i }).click();
    await expect(strip).toContainText('Off the Record · Capture Stopped', { timeout: 8_000 });

    await strip.getByRole('button', { name: /Resume Recording/i }).click();
    await expect(strip).toContainText('Background Capture Active · Recording', { timeout: 8_000 });

    // Test Capture Health drawer (shows SQLite telemetry)
    await strip.getByRole('button', { name: /Health \d+%|Capture Health/i }).click();
    const healthDrawer = page.getByTestId('capture-drawer-health');
    await expect(healthDrawer).toBeVisible();
    await expect(healthDrawer).toContainText('SQLite');
    await healthDrawer.getByRole('button', { name: 'Close drawer' }).click();

    // Test Recorded Activity drawer
    await strip.getByRole('button', { name: /Recorded Activity/i }).click();
    const recordedDrawer = page.getByTestId('capture-drawer-recorded');
    await expect(recordedDrawer).toBeVisible();
    await expect(recordedDrawer).toContainText('Acme_Q3_Bank_Rec.xlsx', { timeout: 8_000 });
    await recordedDrawer.getByRole('button', { name: 'Close drawer' }).click();

    // Test Schedule drawer
    await strip.getByRole('button', { name: /Schedule/i }).click();
    const scheduleDrawer = page.getByTestId('capture-drawer-schedule');
    await expect(scheduleDrawer).toBeVisible();
    await scheduleDrawer.getByRole('button', { name: /Mon–Fri 08:00–18:00/i }).click();
    await scheduleDrawer.getByRole('button', { name: /Save Work Schedule/i }).click();
    await expect(strip).toContainText('Schedule · 08:00–18:00', { timeout: 5_000 });
    await scheduleDrawer.getByRole('button', { name: /Always Capture/i }).click();
    await expect(strip).toContainText('Schedule · Always', { timeout: 5_000 });
    await scheduleDrawer.getByRole('button', { name: 'Close drawer' }).click();
    await expect(scheduleDrawer).not.toBeVisible();

    // Seed an unattributed background session via authenticated API so we test the inline Timeline review tray too
    const uniqueSuffix = Date.now().toString().slice(-5);
    const createdTitle = `E2E Acme Close Block ${uniqueSuffix}`;
    const updatedTitle = `E2E Acme Close Revised ${uniqueSuffix}`;
    const suggestedDocTitle = `Unmatched Client Workpaper Portal ${uniqueSuffix}`;

    const tSuggested = new Date();
    tSuggested.setHours(9, 0, 0, 0);

    await page.evaluate(
      async ({ suggestedIso, docTitle }) => {
        await fetch('/api/engine/sync', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: 'dev-e2e-win-01',
            events: [
              {
                event_id: `e2e-sugg-${Date.now()}`,
                schema_version: 1,
                tenant_id: 'firm_demo',
                user_id: 'demo_u_acc_01',
                device_id: 'dev-e2e-win-01',
                seq: Math.floor(Date.now() / 1000),
                type: 'activity.window',
                priority: 'activity',
                event_time_utc: suggestedIso,
                received_at: null,
                payload: {
                  app: 'Google Chrome',
                  window_title: docTitle,
                  duration_ms: 30 * 60_000,
                },
              },
            ],
          }),
        });
      },
      { suggestedIso: tSuggested.toISOString(), docTitle: suggestedDocTitle }
    );

    // Reload cleanly to pick up the synced suggestion if WS was still debouncing
    await page.reload();
    await expect(page.getByText('Day View Activity Timeline')).toBeVisible({ timeout: 15_000 });

    const reviewTray = page.getByTestId('timeline-suggested-review-tray');
    await expect(reviewTray).toBeVisible({ timeout: 10_000 });
    await reviewTray.getByRole('button', { name: /Review & Confirm Now/i }).click();
    await expect(reviewTray).toContainText(suggestedDocTitle);
    const matchingRow = reviewTray
      .getByTestId('review-tray-row')
      .filter({ hasText: suggestedDocTitle })
      .first();
    await matchingRow.getByRole('button', { name: /^Dismiss$/i }).click();
    await expect(reviewTray.getByText(suggestedDocTitle)).toHaveCount(0);

    // Log a Track 4 block cleanly via Quick Log Modal
    await page.getByRole('button', { name: /Quick Log/i }).first().click();
    await page.getByPlaceholder(/Acme Corp Q3 Bank Reconciliation/i).fill(createdTitle);
    await page.locator('input[type="time"]').first().fill('10:00');
    await page.locator('input[type="time"]').nth(1).fill('10:30');
    await page.getByRole('button', { name: /Log to Timeline/i }).click();

    // Confirm block appears on Track 4 and persists across reload
    await expect(page.getByText(createdTitle).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByText('Day View Activity Timeline')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(createdTitle).first()).toBeVisible({ timeout: 10_000 });

    // Select the Track 4 block to open selected-block-inspector & nudge duration +15m
    await page.locator('button', { hasText: createdTitle }).first().click();
    const inspector = page.getByTestId('selected-block-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText('10:00 – 10:30');
    await inspector.getByRole('button', { name: '+15m' }).click();
    await expect(inspector).toContainText('10:00 – 10:45');

    // Edit title via QuickLogModal
    await inspector.getByRole('button', { name: /Edit Block/i }).click();
    await page.getByPlaceholder(/Acme Corp Q3 Bank Reconciliation/i).fill(updatedTitle);
    await page.getByRole('button', { name: /Update Block/i }).click();
    await expect(page.getByText(updatedTitle).first()).toBeVisible({ timeout: 10_000 });

    // Reload and verify edited title + duration survived in Postgres
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByText(updatedTitle).first()).toBeVisible({ timeout: 15_000 });
    await page.locator('button', { hasText: updatedTitle }).first().click();
    await expect(page.getByTestId('selected-block-inspector')).toContainText('10:00 – 10:45');

    // Delete the block and confirm deletion persists across reload
    await page.getByTestId('selected-block-inspector').getByRole('button', { name: /^Delete$/i }).click();
    await expect(page.getByText(updatedTitle)).toHaveCount(0);

    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByText('Day View Activity Timeline')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(updatedTitle)).toHaveCount(0);

    expect(pageErrors, `Uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
    expect(consoleErrors, `Console errors: ${consoleErrors.join('; ')}`).toEqual([]);
  });
});
