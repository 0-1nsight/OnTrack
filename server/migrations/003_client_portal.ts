import { SqlExecutor } from '../sqlAdapter.ts';
import { Migration } from './001_initial_schema.ts';

const PORTAL_TABLES = [
  'client_requests',
  'client_milestones',
  'client_document_requests',
  'client_messages',
];

export const migration003ClientPortal: Migration = {
  version: '003',
  name: 'client_portal_and_milestones',
  async up(db: SqlExecutor): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS client_requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        template_id TEXT,
        title TEXT NOT NULL,
        period TEXT NOT NULL,
        stage TEXT NOT NULL,
        expected_due_utc TEXT NOT NULL,
        approval_status TEXT NOT NULL DEFAULT 'pending',
        approved_by TEXT,
        approved_at_utc TEXT,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_client_requests_tenant_client
        ON client_requests(tenant_id, client_id);

      CREATE TABLE IF NOT EXISTS client_milestones (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        confirmed_at_utc TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        withdrawn_at_utc TEXT,
        withdrawal_reason TEXT,
        updated_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_client_milestones_tenant_client
        ON client_milestones(tenant_id, client_id);

      CREATE TABLE IF NOT EXISTS client_document_requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        due_date_utc TEXT NOT NULL,
        reminder_sent_at_utc TEXT,
        uploaded_file_id TEXT,
        uploaded_file_name TEXT,
        updated_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_client_doc_reqs_tenant_client
        ON client_document_requests(tenant_id, client_id);

      CREATE TABLE IF NOT EXISTS client_messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_client_messages_request
        ON client_messages(tenant_id, request_id, created_at_utc ASC);
    `);

    if (db.dialect === 'postgres') {
      for (const table of PORTAL_TABLES) {
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
    }
  },
  async down(db: SqlExecutor): Promise<void> {
    if (db.dialect === 'postgres') {
      for (const table of [...PORTAL_TABLES].reverse()) {
        await db.exec(`
          DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
          ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
          ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
        `);
      }
    }

    await db.exec(`
      DROP TABLE IF EXISTS client_messages;
      DROP TABLE IF EXISTS client_document_requests;
      DROP TABLE IF EXISTS client_milestones;
      DROP TABLE IF EXISTS client_requests;
    `);
  },
};
