import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tempDataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/ontrack-bundle-test-${Date.now()}`;
  process.env.DEMO_MODE = 'true';
  process.env.DATA_DIR = dir;
  return dir;
});

import { createOnTrackServer } from '../server.ts';

describe('downloadable desktop agent bundle', () => {
  let ctx: Awaited<ReturnType<typeof createOnTrackServer>>;
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontrack-agent-bundle-'));

  beforeAll(async () => {
    ctx = await createOnTrackServer({ dbPath: ':memory:', seedDemo: true, disableVite: true });
  });

  afterAll(async () => {
    await ctx?.close();
    // Windows refuses to delete a folder that a process still uses, so retry, and treat a
    // leftover temp folder as harmless rather than failing the suite.
    for (const dir of [tempDataDir, extractDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // best effort: the OS clears the temp directory
      }
    }
  });

  it('boots from the extracted zip with no files from the rest of the repo', async () => {
    const res = await request(ctx.app)
      .get('/api/engine/package/desktop-agent?tenantId=firm_demo&viewerRole=admin_it')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);

    const zip = await JSZip.loadAsync(res.body as Buffer);
    const names = Object.keys(zip.files);
    expect(names).toContain('src/capture/captureSampler.ts');
    expect(names).toContain('native/windows/FocusWatcher.cs');
    for (const name of names) {
      const entry = zip.files[name];
      const target = path.join(extractDir, name);
      if (entry.dir) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await entry.async('nodebuffer'));
      }
    }

    // The bundle ships its own agent.config.json (port and bridge secret), which overrides env vars.
    const cfgPath = path.join(extractDir, 'agent.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const port = 47700 + Math.floor(Math.random() * 200);
    cfg.bridgePort = port;
    cfg.serverUrl = 'http://127.0.0.1:1';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const secret = String(cfg.bridgeSecret);
    expect(cfg.pollSampleMs).toBe(2000);

    const child = spawn(process.execPath, ['--experimental-strip-types', 'src/agent.ts'], {
      cwd: extractDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    try {
      let health: Response | null = null;
      for (let i = 0; i < 40 && !health; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const r = await fetch(`http://127.0.0.1:${port}/capture-health`, {
            headers: { 'X-OnTrack-Bridge-Secret': secret },
          });
          if (r.ok) health = r;
        } catch {
          // not listening yet
        }
      }
      expect(health, `agent did not start. Output:\n${output}`).not.toBeNull();
      const body = await health!.json();
      expect(['native_events', 'polling', 'fallback', 'none']).toContain(body.collectorMode);
    } finally {
      child.kill();
      // Wait for the agent to exit; on Windows its working directory stays locked until it does.
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }, 30_000);
});
