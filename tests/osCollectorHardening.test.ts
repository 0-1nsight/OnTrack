import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  captureForegroundMetadata,
  normalizeDocumentPath,
  type ExecRunner,
} from '../packages/desktop-agent/src/adapters/osCollector.ts';
import { loadAppConfig } from '../server/config.ts';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-hardening-test-${Date.now()}`;
  process.env.DEMO_MODE = 'true';
  process.env.DATA_DIR = dir;
  return dir;
});

import fs from 'node:fs';
import { createOnTrackServer } from '../server.ts';

describe('OS collector hardening (macOS & Linux)', () => {
  it('normalizes file:// URLs and strips personal user home prefixes without stripping client folders', () => {
    expect(
      normalizeDocumentPath('file:///Users/maya/Clients/Acme_Ltd/FY25/Tax%20Return.xlsx')
    ).toBe('Clients/Acme_Ltd/FY25/Tax Return.xlsx');
    expect(
      normalizeDocumentPath('file://localhost/home/alex/Workpapers/Harbor_Health_TB.pdf')
    ).toBe('Workpapers/Harbor_Health_TB.pdf');
    expect(normalizeDocumentPath('/Users/maya/Desktop/Untitled.xlsx')).toBe('Desktop/Untitled.xlsx');
    expect(normalizeDocumentPath('Untitled')).toBeNull();
    expect(normalizeDocumentPath('missing value')).toBeNull();
  });

  it('extracts macOS AXDocument, Accessibility state, lock, sleep, and CoreAudio mediaInUse', async () => {
    const exec: ExecRunner = async (file, args) => {
      if (file === 'osascript') {
        return {
          stdout:
            'Microsoft Excel||Acme TB Q4.xlsx||file:///Users/maya/Clients/Acme_Ltd/Acme%20TB%20Q4.xlsx||ok',
        };
      }
      if (file === 'sh' && args[1]?.includes('HIDIdleTime')) {
        return { stdout: '12\n' };
      }
      if (file === 'sh' && args[1]?.includes('CGSSessionScreenIsLocked')) {
        return { stdout: '1\n' };
      }
      if (file === 'pmset') {
        return {
          stdout:
            'pid 412(coreaudiod): [0x001] PreventUserIdleSystemSleep named: "com.apple.audio.AppleHDAEngineInput"\nDisplay is asleep',
        };
      }
      return { stdout: '' };
    };

    const sample = await captureForegroundMetadata({
      platform: 'darwin',
      env: {},
      exec,
    });

    expect(sample.osPlatform).toBe('macos');
    expect(sample.collectorFailed).toBe(false);
    expect(sample.app).toBe('Microsoft Excel');
    expect(sample.windowTitle).toBe('Acme TB Q4.xlsx');
    expect(sample.filePath).toBe('Clients/Acme_Ltd/Acme TB Q4.xlsx');
    expect(sample.idleSeconds).toBe(12);
    expect(sample.sessionLocked).toBe(true);
    expect(sample.systemSleeping).toBe(true);
    expect(sample.mediaInUse).toBe(true);
    expect(sample.meetingActive).toBe(true);
    expect(sample.accessibilityGranted).toBe(true);
  });

  it('marks macOS accessibilityGranted=false when TCC blocks front window inspection', async () => {
    const exec: ExecRunner = async (file) => {
      if (file === 'osascript') {
        return { stdout: 'Google Chrome||||||denied'.replace('||||||', '||||') };
      }
      return { stdout: '0' };
    };

    const sample = await captureForegroundMetadata({
      platform: 'darwin',
      env: {},
      exec,
    });

    expect(sample.collectorFailed).toBe(false);
    expect(sample.app).toBe('Google Chrome');
    expect(sample.accessibilityGranted).toBe(false);
  });

  it('captures Linux X11 active window via xprop WM_CLASS + _NET_WM_PID + /proc/<pid>/comm and PipeWire mediaInUse', async () => {
    const exec: ExecRunner = async (file, args) => {
      if (file === 'xprop' && args[0] === '-root') {
        return { stdout: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007\n' };
      }
      if (file === 'xprop' && args[0] === '-id') {
        return {
          stdout: [
            '_NET_WM_NAME(UTF8_STRING) = "Harbor_Payroll_FY26.xlsx - LibreOffice Calc"',
            'WM_CLASS(STRING) = "soffice.bin", "libreoffice-calc"',
            '_NET_WM_PID(CARDINAL) = 4242',
          ].join('\n'),
        };
      }
      if (file === 'sh' && args[1]?.includes('xprintidle')) {
        return { stdout: '4500\n' };
      }
      if (file === 'sh' && args[1]?.includes('LockedHint')) {
        return { stdout: 'no\n' };
      }
      if (file === 'sh' && args[1]?.includes('pactl')) {
        return { stdout: '55\t42\t4242\tpipewire\tfloat32le\n' };
      }
      return { stdout: '' };
    };

    const sample = await captureForegroundMetadata({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' },
      exec,
      readFileSync: (p) => (p === '/proc/4242/comm' ? 'libreoffice-calc\n' : ''),
    });

    expect(sample.osPlatform).toBe('linux');
    expect(sample.linuxSession).toBe('x11');
    expect(sample.collectorFailed).toBe(false);
    expect(sample.app).toBe('LibreOffice Calc');
    expect(sample.windowTitle).toBe('Harbor_Payroll_FY26.xlsx - LibreOffice Calc');
    expect(sample.filePath).toBe('Harbor_Payroll_FY26.xlsx');
    expect(sample.idleSeconds).toBe(4);
    expect(sample.sessionLocked).toBe(false);
    expect(sample.mediaInUse).toBe(true);
    expect(sample.meetingActive).toBe(true);
  });

  it('captures Linux Wayland active window on Sway and Hyprland', async () => {
    const swayExec: ExecRunner = async (file) => {
      if (file === 'swaymsg') {
        return {
          stdout: JSON.stringify({
            focused: false,
            nodes: [
              {
                focused: true,
                name: 'Client Portal Audit - Chromium',
                app_id: 'chromium',
                pid: 901,
              },
            ],
          }),
        };
      }
      return { stdout: '0\n' };
    };

    const swaySample = await captureForegroundMetadata({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', SWAYSOCK: '/tmp/sway.sock' },
      exec: swayExec,
      readFileSync: () => 'chromium\n',
    });
    expect(swaySample.collectorFailed).toBe(false);
    expect(swaySample.linuxSession).toBe('wayland');
    expect(swaySample.app).toBe('Chromium');
    expect(swaySample.windowTitle).toBe('Client Portal Audit - Chromium');

    const hyprExec: ExecRunner = async (file) => {
      if (file === 'hyprctl') {
        return {
          stdout: JSON.stringify({
            class: 'google-chrome',
            title: 'Acme Tax Return Q4.pdf - Google Chrome',
            pid: 902,
          }),
        };
      }
      return { stdout: '0\n' };
    };

    const hyprSample = await captureForegroundMetadata({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland', HYPRLAND_INSTANCE_SIGNATURE: 'sig-1' },
      exec: hyprExec,
      readFileSync: () => 'google-chrome\n',
    });
    expect(hyprSample.collectorFailed).toBe(false);
    expect(hyprSample.app).toBe('Google Chrome');
    expect(hyprSample.filePath).toBe('Acme Tax Return Q4.pdf');
  });

  it('reports collectorFailed=true when Wayland has no supported compositor IPC or DISPLAY', async () => {
    const exec: ExecRunner = async () => {
      throw new Error('command not found');
    };
    const sample = await captureForegroundMetadata({
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' },
      exec,
      hostname: 'linux-laptop',
    });

    expect(sample.collectorFailed).toBe(true);
    expect(sample.linuxSession).toBe('wayland');
  });
});

describe('Config & Free-Tier Gemini AI Report Status', () => {
  let ctx: Awaited<ReturnType<typeof createOnTrackServer>>;

  beforeAll(async () => {
    ctx = await createOnTrackServer({ dbPath: ':memory:', seedDemo: true, disableVite: true });
  });

  afterAll(async () => {
    await ctx?.close();
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('computes demoModeEnabled and free-tier Gemini readiness accurately across environments', () => {
    const devCfg = loadAppConfig({ NODE_ENV: 'development', VITEST: 'false', DEMO_MODE: '' });
    expect(devCfg.demoModeEnabled).toBe(true);

    const prodCfg = loadAppConfig({
      NODE_ENV: 'production',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'a-very-long-production-secret-at-least-32-chars',
    });
    expect(prodCfg.demoModeEnabled).toBe(false);

    const keyReadyCfg = loadAppConfig({
      NODE_ENV: 'development',
      GEMINI_API_KEY: 'test-key-value',
      AI_REPORTS_GLOBAL_ALLOW: '',
    });
    expect(keyReadyCfg.aiReportsGlobalAllow).toBe(true);

    const keyBlockedCfg = loadAppConfig({
      NODE_ENV: 'development',
      GEMINI_API_KEY: 'test-key-value',
      AI_REPORTS_GLOBAL_ALLOW: 'false',
    });
    expect(keyBlockedCfg.aiReportsGlobalAllow).toBe(false);
  });

  it('serves /api/reports/status with gemini-4-hydrogen and role toggle permission', async () => {
    const loginRes = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_admin_01' });
    expect(loginRes.status).toBe(200);
    const adminCookie = loginRes.headers['set-cookie'];

    const statusRes = await request(ctx.app)
      .get('/api/reports/status')
      .set('Cookie', adminCookie);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.model).toBe('gemini-4-hydrogen');
    expect(statusRes.body.aiReportsEnabled).toBe(false);
    expect(statusRes.body.canToggle).toBe(true);
    expect(statusRes.body.aggregateOnly).toBe(true);

    const staffLogin = await request(ctx.app)
      .post('/api/auth/demo-login')
      .send({ userId: 'demo_u_acc_01' });
    expect(staffLogin.status).toBe(200);
    const staffStatus = await request(ctx.app)
      .get('/api/reports/status')
      .set('Cookie', staffLogin.headers['set-cookie']);
    expect(staffStatus.status).toBe(200);
    expect(staffStatus.body.canToggle).toBe(false);
  });
});
