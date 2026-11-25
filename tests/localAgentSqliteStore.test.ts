import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalAgentSqliteStore } from '../packages/desktop-agent/src/localStore.ts';

describe('LocalAgentSqliteStore (device SQLite + periodic cleanup)', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontrack-local-sqlite-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists seq, controls, and ordered events in embedded SQLite', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, '.ontrack-agent.db');
    const store = new LocalAgentSqliteStore({ dbPath });

    expect(store.nextSeq()).toBe(1);
    expect(store.nextSeq()).toBe(2);

    store.saveControls({ offTheRecord: true, schedule: [] });
    expect(store.loadControls()).toEqual({ offTheRecord: true, schedule: [] });

    store.enqueue({
      event_id: 'ev-act-1',
      seq: 1,
      priority: 'activity',
      event_time_utc: '2026-11-24T10:00:00.000Z',
      payload: { app: 'Excel' },
    });
    store.enqueue({
      event_id: 'ev-state-1',
      seq: 2,
      priority: 'state',
      event_time_utc: '2026-11-24T10:00:05.000Z',
      payload: { app: 'System', idle: true },
    });

    const pending = store.peekPending(10);
    expect(pending.map((e) => e.event_id)).toEqual(['ev-state-1', 'ev-act-1']);
    store.close();

    // Re-open from disk to confirm durability
    const reopened = new LocalAgentSqliteStore({ dbPath });
    expect(reopened.getSeq()).toBe(2);
    expect(reopened.loadControls()).toEqual({ offTheRecord: true, schedule: [] });
    expect(reopened.peekPending(10)).toHaveLength(2);
    reopened.close();
  });

  it('clears synced rows and compacts SQLite periodically so local disk stays lean', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, '.ontrack-agent.db');
    let nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    const store = new LocalAgentSqliteStore({
      dbPath,
      maxPendingRows: 5,
      maxPendingAgeHours: 24,
      vacuumRowThreshold: 3,
      now: () => nowMs,
    });

    for (let i = 1; i <= 4; i++) {
      store.enqueue(
        {
          event_id: `ev-${i}`,
          seq: i,
          priority: 'activity',
          event_time_utc: new Date(nowMs).toISOString(),
          payload: { app: 'Word', n: i },
        },
        nowMs
      );
    }

    expect(store.acknowledgeSynced(['ev-1', 'ev-2', 'ev-3'])).toBe(3);
    expect(store.peekPending(10).map((e) => e.event_id)).toEqual(['ev-4']);

    const cleanup1 = store.runPeriodicCleanup();
    expect(cleanup1.purgedSynced).toBe(3);
    expect(cleanup1.vacuumed).toBe(true);
    expect(cleanup1.pendingRemaining).toBe(1);

    // Simulate long offline window (>24h) + overflow queue (>5)
    const oldMs = nowMs - 48 * 60 * 60 * 1000;
    store.enqueue(
      {
        event_id: 'ev-stale',
        seq: 5,
        priority: 'activity',
        event_time_utc: new Date(oldMs).toISOString(),
        payload: { app: 'Chrome' },
      },
      oldMs
    );

    // Backdate ev-stale's created_at_ms by re-creating via fresh time jump:
    // Move clock forward 30h so ev-4 also expires, then add 7 fresh events (maxPendingRows=5)
    nowMs += 30 * 60 * 60 * 1000;
    for (let i = 6; i <= 12; i++) {
      store.enqueue(
        {
          event_id: `ev-${i}`,
          seq: i,
          priority: i === 6 ? 'state' : 'activity',
          event_time_utc: new Date(nowMs).toISOString(),
          payload: { app: 'Excel', n: i },
        },
        nowMs
      );
    }

    const cleanup2 = store.runPeriodicCleanup();
    expect(cleanup2.prunedExpiredPending).toBe(2); // ev-4 & ev-stale expired
    expect(cleanup2.prunedOverflowPending).toBe(2); // 7 -> capped at 5
    expect(cleanup2.pendingRemaining).toBe(5);
    // State event ev-6 should be preserved over older activity rows when capping overflow
    expect(store.peekPending(10).some((e) => e.event_id === 'ev-6')).toBe(true);
    store.close();
  });

  it('migrates legacy jsonl/json files into embedded SQLite and removes them', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '.ontrack-seq.json'), JSON.stringify({ seq: 42 }), 'utf8');
    fs.writeFileSync(
      path.join(dir, '.ontrack-controls.json'),
      JSON.stringify({ offTheRecord: false, pausedUntilMs: 999999 }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, '.ontrack-offline-queue.jsonl'),
      JSON.stringify({
        event_id: 'legacy-1',
        seq: 42,
        priority: 'activity',
        event_time_utc: '2026-11-24T09:00:00.000Z',
        payload: { app: 'QuickBooks' },
      }) + '\n',
      'utf8'
    );

    const store = new LocalAgentSqliteStore({
      dbPath: path.join(dir, '.ontrack-agent.db'),
      legacyDir: dir,
    });

    expect(store.getSeq()).toBe(42);
    expect(store.loadControls()).toEqual({ offTheRecord: false, pausedUntilMs: 999999 });
    expect(store.peekPending(10).map((e) => e.event_id)).toEqual(['legacy-1']);
    expect(fs.existsSync(path.join(dir, '.ontrack-seq.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.ontrack-controls.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.ontrack-offline-queue.jsonl'))).toBe(false);
    store.close();
  });
});
