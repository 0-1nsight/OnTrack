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

export const migration006OnboardingAccessKeys: Migration = {
  version: '006',
  name: 'onboarding_access_keys_and_password_gate',
  async up(db: SqlExecutor): Promise<void> {
    if (db.dialect === 'postgres') {
      await db.exec(`
        ALTER TABLE shift_users ADD COLUMN IF NOT EXISTS onboarding_key_hash TEXT;
        ALTER TABLE shift_users ADD COLUMN IF NOT EXISTS onboarding_key_expires_utc TEXT;
        ALTER TABLE shift_users ADD COLUMN IF NOT EXISTS must_set_password INTEGER NOT NULL DEFAULT 0;
      `);
    } else {
      await ensureColumnSqlite(db, 'shift_users', 'onboarding_key_hash', 'TEXT');
      await ensureColumnSqlite(db, 'shift_users', 'onboarding_key_expires_utc', 'TEXT');
      await ensureColumnSqlite(
        db,
        'shift_users',
        'must_set_password',
        'INTEGER NOT NULL DEFAULT 0'
      );
    }

    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shift_users_onboarding_key_hash
        ON shift_users(onboarding_key_hash);
    `);
  },
  async down(db: SqlExecutor): Promise<void> {
    await db.exec(`DROP INDEX IF EXISTS idx_shift_users_onboarding_key_hash;`);
    if (db.dialect === 'postgres') {
      await db.exec(`
        ALTER TABLE shift_users DROP COLUMN IF EXISTS must_set_password;
        ALTER TABLE shift_users DROP COLUMN IF EXISTS onboarding_key_expires_utc;
        ALTER TABLE shift_users DROP COLUMN IF EXISTS onboarding_key_hash;
      `);
    }
  },
};
