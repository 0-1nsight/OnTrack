import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type SqlDialect = 'sqlite' | 'postgres';

export interface RunResult {
  changes: number;
}

/**
 * Dual SQLite (`node:sqlite`) and PostgreSQL (`pg`) parameterized adapter.
 * Converts `?` placeholders cleanly to `$1, $2, ...` when running against PostgreSQL.
 */
export class PortableSqlAdapter {
  public readonly dialect: SqlDialect;
  private sqliteDb: DatabaseSync | null = null;
  private pgPool: Pool | null = null;

  constructor(options?: { dbPath?: string; databaseUrl?: string }) {
    const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_URL ?? '';
    const usePg =
      /^postgres(ql)?:\/\//i.test(databaseUrl.trim()) &&
      options?.dbPath !== ':memory:';

    if (usePg) {
      this.dialect = 'postgres';
      this.pgPool = new Pool({
        connectionString: databaseUrl.trim(),
        max: 15,
      });
    } else {
      this.dialect = 'sqlite';
      const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
      const resolved = options?.dbPath || path.resolve(dataDir, 'chronoflow-engine.db');
      if (resolved !== ':memory:') {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
      }
      this.sqliteDb = new DatabaseSync(resolved);
    }
  }

  private translateSql(sql: string): string {
    if (this.dialect === 'sqlite') return sql;
    let idx = 0;
    let inSingleQuote = false;
    let out = '';
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "'") {
        inSingleQuote = !inSingleQuote;
        out += ch;
      } else if (ch === '?' && !inSingleQuote) {
        idx += 1;
        out += `$${idx}`;
      } else {
        out += ch;
      }
    }
    return out;
  }

  public async exec(ddl: string): Promise<void> {
    if (this.sqliteDb) {
      this.sqliteDb.exec(ddl);
      return;
    }
    if (this.pgPool) {
      await this.pgPool.query(ddl);
    }
  }

  public async get<T = Record<string, any>>(
    sql: string,
    ...params: any[]
  ): Promise<T | undefined> {
    if (this.sqliteDb) {
      return this.sqliteDb.prepare(sql).get(...params) as T | undefined;
    }
    if (this.pgPool) {
      const res = await this.pgPool.query(this.translateSql(sql), params);
      return res.rows[0] as T | undefined;
    }
    return undefined;
  }

  public async all<T = Record<string, any>>(
    sql: string,
    ...params: any[]
  ): Promise<T[]> {
    if (this.sqliteDb) {
      return this.sqliteDb.prepare(sql).all(...params) as T[];
    }
    if (this.pgPool) {
      const res = await this.pgPool.query(this.translateSql(sql), params);
      return res.rows as T[];
    }
    return [];
  }

  public async run(sql: string, ...params: any[]): Promise<RunResult> {
    if (this.sqliteDb) {
      const info = this.sqliteDb.prepare(sql).run(...params);
      return { changes: Number(info.changes) };
    }
    if (this.pgPool) {
      const res = await this.pgPool.query(this.translateSql(sql), params);
      return { changes: Number(res.rowCount || 0) };
    }
    return { changes: 0 };
  }

  public async close(): Promise<void> {
    if (this.sqliteDb) {
      this.sqliteDb.close();
    }
    if (this.pgPool) {
      await this.pgPool.end();
    }
  }
}

export async function initPortableSchema(db: PortableSqlAdapter): Promise<void> {
  if (db.dialect === 'sqlite') {
    await db.exec('PRAGMA journal_mode = WAL;');
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shift_users (
      user_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      firebase_uid TEXT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      team_id TEXT NOT NULL,
      shift_pattern TEXT NOT NULL,
      shift_start_hour_utc INTEGER NOT NULL,
      shift_end_hour_utc INTEGER NOT NULL,
      on_leave INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      token_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      label TEXT NOT NULL,
      prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      last_used_utc TEXT,
      revoked_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      legal_name TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      codes_json TEXT NOT NULL,
      folder_patterns_json TEXT NOT NULL,
      known_domains_json TEXT NOT NULL,
      restricted_user_ids_json TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      work_category TEXT NOT NULL,
      weight DOUBLE PRECISION NOT NULL
    );

    CREATE TABLE IF NOT EXISTS privacy_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      pattern TEXT NOT NULL,
      reason TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS task_templates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      default_category TEXT NOT NULL,
      steps_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS engine_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      template_id TEXT,
      title TEXT NOT NULL,
      period TEXT NOT NULL,
      status TEXT NOT NULL,
      due_date_utc TEXT NOT NULL,
      assigned_user_id TEXT NOT NULL,
      estimated_minutes INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learned_rules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      pattern_type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      target_client_id TEXT NOT NULL,
      target_task_id TEXT,
      accepted INTEGER NOT NULL DEFAULT 1,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracking_events (
      event_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      event_time_utc TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tracking_events_tenant_user
      ON tracking_events(tenant_id, user_id, event_time_utc);

    CREATE TABLE IF NOT EXISTS device_freshness (
      device_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      shift_pattern TEXT NOT NULL,
      os_platform TEXT NOT NULL,
      extension_connected INTEGER NOT NULL DEFAULT 1,
      last_heartbeat_utc TEXT NOT NULL,
      last_ack_seq INTEGER NOT NULL DEFAULT 0,
      clock_offset_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attribution_overrides (
      session_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      task_id TEXT,
      task_title TEXT,
      client_id TEXT,
      client_name TEXT,
      step_id TEXT,
      step_title TEXT,
      period TEXT,
      confidence DOUBLE PRECISION NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checklist_overrides (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      step_id TEXT,
      order_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      minutes_accumulated INTEGER NOT NULL,
      source_session_ids_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      is_free_form INTEGER NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_title TEXT NOT NULL,
      local_status TEXT NOT NULL,
      server_status TEXT NOT NULL,
      local_version INTEGER NOT NULL,
      server_version INTEGER NOT NULL,
      created_at_utc TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolution TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      target_user_id TEXT,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stored_files (
      file_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      uploader_user_id TEXT NOT NULL,
      uploader_email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_rel_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );
  `);

  if (db.dialect === 'sqlite') {
    const cols = await db.all<{ name: string }>('PRAGMA table_info(shift_users)');
    if (!cols.some((c) => c.name === 'firebase_uid')) {
      await db.exec('ALTER TABLE shift_users ADD COLUMN firebase_uid TEXT;');
    }
  } else {
    await db.exec('ALTER TABLE shift_users ADD COLUMN IF NOT EXISTS firebase_uid TEXT;');
  }
}
