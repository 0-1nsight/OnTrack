import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface LocalStoreOptions {
  dbPath?: string;
  legacyDir?: string;
  /** Maximum number of unsynced rows retained locally if offline for extended periods. */
  maxPendingRows?: number;
  /** Maximum age in hours for unsynced rows before emergency pruning prevents disk bloat. */
  maxPendingAgeHours?: number;
  /** Run VACUUM when at least this many rows were deleted since the last vacuum. */
  vacuumRowThreshold?: number;
  now?: () => number;
}

export interface LocalStoreCleanupResult {
  purgedSynced: number;
  prunedExpiredPending: number;
  prunedOverflowPending: number;
  checkpointedWal: boolean;
  vacuumed: boolean;
  pendingRemaining: number;
  dbBytes: number;
}

export interface LocalStoreStats {
  dbPath: string;
  pendingCount: number;
  syncedPendingPurgeCount: number;
  dbBytes: number;
  lastCleanupAtMs: number | null;
}

const DEFAULT_MAX_PENDING_ROWS = 10_000;
const DEFAULT_MAX_PENDING_AGE_HOURS = 72;
const DEFAULT_VACUUM_ROW_THRESHOLD = 250;

export class LocalAgentSqliteStore {
  public readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly maxPendingRows: number;
  private readonly maxPendingAgeHours: number;
  private readonly vacuumRowThreshold: number;
  private readonly now: () => number;
  private deletedSinceVacuum = 0;
  private lastCleanupAtMs: number | null = null;
  private closed = false;

  constructor(options?: LocalStoreOptions) {
    this.now = options?.now ?? Date.now;
    this.maxPendingRows = options?.maxPendingRows ?? DEFAULT_MAX_PENDING_ROWS;
    this.maxPendingAgeHours = options?.maxPendingAgeHours ?? DEFAULT_MAX_PENDING_AGE_HOURS;
    this.vacuumRowThreshold = options?.vacuumRowThreshold ?? DEFAULT_VACUUM_ROW_THRESHOLD;

    const resolved =
      options?.dbPath ?? path.resolve(process.cwd(), '.ontrack-agent.db');
    this.dbPath = resolved;

    if (resolved !== ':memory:') {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
    }

    this.db = new DatabaseSync(resolved);
    if (resolved !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL;');

    this.initSchema();

    if (options?.legacyDir) {
      this.migrateLegacyFiles(options.legacyDir);
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_queue (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        priority TEXT NOT NULL,
        event_time_ms INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        synced_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_queue_pending
        ON event_queue(synced_at_ms, priority, seq);

      CREATE INDEX IF NOT EXISTS idx_event_queue_created
        ON event_queue(created_at_ms);
    `);
  }

  private getKv(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM agent_kv WHERE key = ?')
      .get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : null;
  }

  private setKv(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO agent_kv (key, value, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`
      )
      .run(key, value, this.now());
  }

  private migrateLegacyFiles(dir: string): void {
    const seqFile = path.join(dir, '.ontrack-seq.json');
    const controlsFile = path.join(dir, '.ontrack-controls.json');
    const queueFile = path.join(dir, '.ontrack-offline-queue.jsonl');

    if (fs.existsSync(seqFile) && this.getKv('seq') === null) {
      try {
        const parsed = JSON.parse(fs.readFileSync(seqFile, 'utf8')) as { seq?: number };
        const n = Number(parsed.seq || 0);
        if (Number.isFinite(n) && n > 0) {
          this.setKv('seq', String(Math.floor(n)));
        }
        fs.unlinkSync(seqFile);
      } catch {
        // leave file untouched on parse failure
      }
    }

    if (fs.existsSync(controlsFile) && this.getKv('controls') === null) {
      try {
        const raw = fs.readFileSync(controlsFile, 'utf8');
        JSON.parse(raw);
        this.setKv('controls', raw);
        fs.unlinkSync(controlsFile);
      } catch {
        // leave file untouched on parse failure
      }
    }

    if (fs.existsSync(queueFile)) {
      try {
        const lines = fs.readFileSync(queueFile, 'utf8').split('\n').filter(Boolean);
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const line of lines) {
            try {
              const ev = JSON.parse(line) as Record<string, any>;
              if (ev && ev.event_id) {
                const eventTimeMs = ev.event_time_utc ? Date.parse(String(ev.event_time_utc)) : this.now();
                this.insertEventRow(ev, Number.isFinite(eventTimeMs) ? eventTimeMs : this.now());
              }
            } catch {
              // skip malformed legacy line
            }
          }
          this.db.exec('COMMIT');
          fs.unlinkSync(queueFile);
        } catch (err) {
          this.db.exec('ROLLBACK');
          throw err;
        }
      } catch {
        // best-effort legacy migration
      }
    }
  }

  public getSeq(): number {
    const raw = this.getKv('seq');
    const n = Number(raw || 0);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  public nextSeq(): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next = this.getSeq() + 1;
      this.setKv('seq', String(next));
      this.db.exec('COMMIT');
      return next;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }

  public loadControls(): unknown {
    const raw = this.getKv('controls');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  public saveControls(state: unknown): void {
    this.setKv('controls', JSON.stringify(state));
  }

  private insertEventRow(event: Record<string, any>, eventTimeMs: number): void {
    const eventId = String(event.event_id);
    const seq = Number(event.seq || 0);
    const priority = event.priority === 'state' ? 'state' : 'activity';
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO event_queue
         (event_id, seq, priority, event_time_ms, event_json, synced_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(eventId, seq, priority, eventTimeMs, JSON.stringify(event), createdAt);
  }

  public enqueue(event: Record<string, any>, eventTimeMs?: number): void {
    const ts = eventTimeMs ?? this.now();
    this.insertEventRow(event, ts);
  }

  /**
   * Returns pending (unsynced) events ordered with priority='state' first, then monotonic seq.
   */
  public peekPending(limit = 250): Record<string, any>[] {
    const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT event_json
         FROM event_queue
         WHERE synced_at_ms IS NULL
         ORDER BY CASE WHEN priority = 'state' THEN 0 ELSE 1 END ASC, seq ASC
         LIMIT ?`
      )
      .all(safeLimit) as { event_json: string }[];

    const out: Record<string, any>[] = [];
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.event_json) as Record<string, any>);
      } catch {
        // skip corrupted row
      }
    }
    return out;
  }

  /**
   * Marks events acknowledged by the remote PostgreSQL server.
   * Rows are stamped synced_at_ms immediately and cleared/compacted on periodic cleanup
   * (or immediately once enough synced rows accumulate).
   */
  public acknowledgeSynced(eventIds: Iterable<string>): number {
    const ids = Array.from(eventIds).filter(Boolean);
    if (ids.length === 0) return 0;

    const nowMs = this.now();
    let updated = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(
        'UPDATE event_queue SET synced_at_ms = ? WHERE event_id = ? AND synced_at_ms IS NULL'
      );
      for (const id of ids) {
        const info = stmt.run(nowMs, id);
        updated += Number(info.changes || 0);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }

    // Keep disk footprint tiny between periodic sweeps if a large batch just synced.
    if (updated >= 100) {
      this.runPeriodicCleanup();
    }
    return updated;
  }

  /**
   * Clears synced events, enforces bounded retention on unsynced offline queues,
   * truncates the SQLite WAL, and compacts free space when needed so the local DB
   * never bogs down the user's workstation.
   */
  public runPeriodicCleanup(options?: { forceVacuum?: boolean }): LocalStoreCleanupResult {
    const nowMs = this.now();
    const ageCutoffMs = nowMs - this.maxPendingAgeHours * 60 * 60 * 1000;

    let purgedSynced: number;
    let prunedExpiredPending: number;
    let prunedOverflowPending = 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const syncedInfo = this.db
        .prepare('DELETE FROM event_queue WHERE synced_at_ms IS NOT NULL')
        .run();
      purgedSynced = Number(syncedInfo.changes || 0);

      const expiredInfo = this.db
        .prepare('DELETE FROM event_queue WHERE synced_at_ms IS NULL AND created_at_ms < ?')
        .run(ageCutoffMs);
      prunedExpiredPending = Number(expiredInfo.changes || 0);

      const countRow = this.db
        .prepare('SELECT COUNT(*) AS cnt FROM event_queue WHERE synced_at_ms IS NULL')
        .get() as { cnt?: number } | undefined;
      const pendingCount = Number(countRow?.cnt || 0);

      if (pendingCount > this.maxPendingRows) {
        const overflow = pendingCount - this.maxPendingRows;
        // Evict oldest low-priority activity rows first; preserve state transitions when possible.
        const overflowInfo = this.db
          .prepare(
            `DELETE FROM event_queue
             WHERE event_id IN (
               SELECT event_id
               FROM event_queue
               WHERE synced_at_ms IS NULL
               ORDER BY CASE WHEN priority = 'state' THEN 1 ELSE 0 END ASC, seq ASC
               LIMIT ?
             )`
          )
          .run(overflow);
        prunedOverflowPending = Number(overflowInfo.changes || 0);
      }

      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }

    const totalDeleted = purgedSynced + prunedExpiredPending + prunedOverflowPending;
    this.deletedSinceVacuum += totalDeleted;

    let checkpointedWal = false;
    if (this.dbPath !== ':memory:') {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        checkpointedWal = true;
      } catch {
        // best effort
      }
    }

    let vacuumed = false;
    if (options?.forceVacuum || this.deletedSinceVacuum >= this.vacuumRowThreshold) {
      try {
        this.db.exec('PRAGMA incremental_vacuum;');
        if (options?.forceVacuum || this.deletedSinceVacuum >= this.vacuumRowThreshold * 2) {
          this.db.exec('VACUUM;');
        }
        this.deletedSinceVacuum = 0;
        vacuumed = true;
      } catch {
        // best effort
      }
    }

    this.lastCleanupAtMs = nowMs;
    const stats = this.getStats();
    return {
      purgedSynced,
      prunedExpiredPending,
      prunedOverflowPending,
      checkpointedWal,
      vacuumed,
      pendingRemaining: stats.pendingCount,
      dbBytes: stats.dbBytes,
    };
  }

  public getStats(): LocalStoreStats {
    const pendingRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM event_queue WHERE synced_at_ms IS NULL')
      .get() as { cnt?: number } | undefined;
    const syncedRow = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM event_queue WHERE synced_at_ms IS NOT NULL')
      .get() as { cnt?: number } | undefined;

    let dbBytes = 0;
    if (this.dbPath !== ':memory:') {
      for (const candidate of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
        try {
          if (fs.existsSync(candidate)) {
            dbBytes += fs.statSync(candidate).size;
          }
        } catch {
          // ignore
        }
      }
    }

    return {
      dbPath: this.dbPath,
      pendingCount: Number(pendingRow?.cnt || 0),
      syncedPendingPurgeCount: Number(syncedRow?.cnt || 0),
      dbBytes,
      lastCleanupAtMs: this.lastCleanupAtMs,
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.runPeriodicCleanup();
    } catch {
      // ignore cleanup error on close
    }
    this.db.close();
  }
}
