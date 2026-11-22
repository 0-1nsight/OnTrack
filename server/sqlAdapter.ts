import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool, PoolClient } from 'pg';

export type SqlDialect = 'sqlite' | 'postgres';

export interface RunResult {
  changes: number;
}

export interface SqlExecutor {
  readonly dialect: SqlDialect;
  exec(ddl: string): Promise<void>;
  get<T = Record<string, any>>(sql: string, ...params: any[]): Promise<T | undefined>;
  all<T = Record<string, any>>(sql: string, ...params: any[]): Promise<T[]>;
  run(sql: string, ...params: any[]): Promise<RunResult>;
}

export function translateSqlPlaceholders(sql: string, dialect: SqlDialect): string {
  if (dialect === 'sqlite') return sql;
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

/**
 * Dual SQLite (`node:sqlite`, dev/tests) and PostgreSQL (`pg`, production with RLS) adapter.
 * Converts `?` placeholders cleanly to `$1, $2, ...` when running against PostgreSQL.
 */
export class PortableSqlAdapter implements SqlExecutor {
  public readonly dialect: SqlDialect;
  private sqliteDb: DatabaseSync | null = null;
  private pgPool: Pool | null = null;
  private sqliteTxDepth = 0;

  constructor(options?: { dbPath?: string; databaseUrl?: string }) {
    const databaseUrl = options?.databaseUrl ?? process.env.DATABASE_URL ?? '';
    const usePg =
      /^postgres(ql)?:\/\//i.test(databaseUrl.trim()) &&
      options?.dbPath !== ':memory:';

    if (usePg) {
      this.dialect = 'postgres';
      this.pgPool = new Pool({
        connectionString: databaseUrl.trim(),
        max: 20,
      });
    } else {
      this.dialect = 'sqlite';
      const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
      const resolved = options?.dbPath || path.resolve(dataDir, 'ontrack-engine.db');
      if (resolved !== ':memory:') {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
      }
      this.sqliteDb = new DatabaseSync(resolved);
      if (resolved !== ':memory:') {
        this.sqliteDb.exec('PRAGMA journal_mode = WAL;');
      }
      this.sqliteDb.exec('PRAGMA foreign_keys = ON;');
    }
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
      const res = await this.pgPool.query(translateSqlPlaceholders(sql, 'postgres'), params);
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
      const res = await this.pgPool.query(translateSqlPlaceholders(sql, 'postgres'), params);
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
      const res = await this.pgPool.query(translateSqlPlaceholders(sql, 'postgres'), params);
      return { changes: Number(res.rowCount || 0) };
    }
    return { changes: 0 };
  }

  /**
   * Executes a callback inside an explicit DB transaction.
   * On PostgreSQL, sets transaction-local RLS context variables:
   * `SET LOCAL app.tenant_id`, `app.user_id`, `app.role`, `app.bypass_rls`.
   */
  public async withTenantTransaction<T>(
    ctx: { tenantId: string; userId?: string; role?: string; bypassRls?: boolean },
    fn: (tx: SqlExecutor) => Promise<T>
  ): Promise<T> {
    if (this.sqliteDb) {
      const nested = this.sqliteTxDepth > 0;
      this.sqliteTxDepth += 1;
      if (!nested) {
        this.sqliteDb.exec('BEGIN IMMEDIATE');
      }
      try {
        const result = await fn(this);
        if (!nested) {
          this.sqliteDb.exec('COMMIT');
        }
        return result;
      } catch (err) {
        if (!nested) {
          try {
            this.sqliteDb.exec('ROLLBACK');
          } catch {
            // ignore rollback errors
          }
        }
        throw err;
      } finally {
        this.sqliteTxDepth = Math.max(0, this.sqliteTxDepth - 1);
      }
    }

    if (this.pgPool) {
      const client: PoolClient = await this.pgPool.connect();
      const txExec: SqlExecutor = {
        dialect: 'postgres',
        exec: async (ddl: string) => {
          await client.query(ddl);
        },
        get: async <R = Record<string, any>>(sql: string, ...params: any[]) => {
          const res = await client.query(translateSqlPlaceholders(sql, 'postgres'), params);
          return res.rows[0] as R | undefined;
        },
        all: async <R = Record<string, any>>(sql: string, ...params: any[]) => {
          const res = await client.query(translateSqlPlaceholders(sql, 'postgres'), params);
          return res.rows as R[];
        },
        run: async (sql: string, ...params: any[]) => {
          const res = await client.query(translateSqlPlaceholders(sql, 'postgres'), params);
          return { changes: Number(res.rowCount || 0) };
        },
      };

      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT
             set_config('app.tenant_id', $1, true),
             set_config('app.user_id', $2, true),
             set_config('app.role', $3, true),
             set_config('app.bypass_rls', $4, true)`,
          [
            ctx.tenantId || '',
            ctx.userId || '',
            ctx.role || '',
            ctx.bypassRls ? 'true' : 'false',
          ]
        );
        const result = await fn(txExec);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    return fn(this);
  }

  public async getPgPool(): Promise<Pool | null> {
    return this.pgPool;
  }

  public async ping(): Promise<boolean> {
    try {
      const row = await this.get<{ ok: number }>('SELECT 1 as ok');
      return Number(row?.ok) === 1;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    if (this.sqliteDb) {
      this.sqliteDb.close();
      this.sqliteDb = null;
    }
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = null;
    }
  }
}
