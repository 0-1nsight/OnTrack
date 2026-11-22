import { SqlExecutor } from '../sqlAdapter.ts';
import { Migration } from './001_initial_schema.ts';

const TENANT_SCOPED_TABLES = [
  'teams',
  'shift_users',
  'user_invites',
  'password_resets',
  'sessions',
  'device_tokens',
  'clients',
  'activity_rules',
  'privacy_rules',
  'task_templates',
  'engine_tasks',
  'learned_rules',
  'tracking_events',
  'device_freshness',
  'attribution_overrides',
  'checklist_overrides',
  'sync_conflicts',
  'audit_logs',
  'stored_files',
  'late_updates',
];

export const migration002PostgresRls: Migration = {
  version: '002',
  name: 'postgres_row_level_security',
  async up(db: SqlExecutor): Promise<void> {
    if (db.dialect !== 'postgres') {
      // SQLite uses explicit tenant-scoped parameterized queries in dev/test.
      return;
    }

    for (const table of TENANT_SCOPED_TABLES) {
      await db.exec(`
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
        CREATE POLICY ${table}_tenant_isolation ON ${table}
          USING (
            current_setting('app.bypass_rls', true) = 'true'
            OR tenant_id = current_setting('app.tenant_id', true)
          )
          WITH CHECK (
            current_setting('app.bypass_rls', true) = 'true'
            OR tenant_id = current_setting('app.tenant_id', true)
          );
      `);
    }
  },
  async down(db: SqlExecutor): Promise<void> {
    if (db.dialect !== 'postgres') return;

    for (const table of [...TENANT_SCOPED_TABLES].reverse()) {
      await db.exec(`
        DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
        ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
        ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
      `);
    }
  },
};
