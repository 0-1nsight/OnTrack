import { SqlExecutor } from '../sqlAdapter.ts';
import { Migration } from './001_initial_schema.ts';

async function ensureColumnSqlite(
  db: SqlExecutor,
  table: string,
  column: string,
  definition: string
) {
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const migration004PortalEnhancements: Migration = {
  version: '004',
  name: 'portal_signatures_and_task_link',
  async up(db: SqlExecutor): Promise<void> {
    if (db.dialect === 'postgres') {
      await db.exec(`
        ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS signature_name TEXT;
        ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS approval_notes TEXT;
        ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS engine_task_id TEXT;
        ALTER TABLE client_requests ADD COLUMN IF NOT EXISTS notes TEXT;
      `);
    } else {
      await ensureColumnSqlite(db, 'client_requests', 'signature_name', 'TEXT');
      await ensureColumnSqlite(db, 'client_requests', 'approval_notes', 'TEXT');
      await ensureColumnSqlite(db, 'client_requests', 'engine_task_id', 'TEXT');
      await ensureColumnSqlite(db, 'client_requests', 'notes', 'TEXT');
    }
  },
  async down(db: SqlExecutor): Promise<void> {
    if (db.dialect === 'postgres') {
      await db.exec(`
        ALTER TABLE client_requests DROP COLUMN IF EXISTS notes;
        ALTER TABLE client_requests DROP COLUMN IF EXISTS engine_task_id;
        ALTER TABLE client_requests DROP COLUMN IF EXISTS approval_notes;
        ALTER TABLE client_requests DROP COLUMN IF EXISTS signature_name;
      `);
    }
  },
};
