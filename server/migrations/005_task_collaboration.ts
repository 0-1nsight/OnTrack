import { SqlExecutor } from '../sqlAdapter.ts';
import { Migration } from './001_initial_schema.ts';

export const migration005TaskCollaboration: Migration = {
  version: '005',
  name: 'task_collaboration_and_invites',
  async up(db: SqlExecutor): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS task_collaborators (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        added_by_user_id TEXT NOT NULL,
        can_edit INTEGER NOT NULL DEFAULT 1,
        can_auto_track INTEGER NOT NULL DEFAULT 1,
        created_at_utc TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_collaborators_unique
        ON task_collaborators(tenant_id, task_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_task_collaborators_user
        ON task_collaborators(tenant_id, user_id);

      CREATE TABLE IF NOT EXISTS task_collaboration_invites (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        inviter_user_id TEXT NOT NULL,
        invitee_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT NOT NULL DEFAULT '',
        responded_at_utc TEXT,
        created_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_collab_invites_invitee
        ON task_collaboration_invites(tenant_id, invitee_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_collab_invites_task
        ON task_collaboration_invites(tenant_id, task_id, status);
    `);

    if (db.dialect === 'postgres') {
      for (const table of ['task_collaborators', 'task_collaboration_invites']) {
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
      for (const table of ['task_collaboration_invites', 'task_collaborators']) {
        await db.exec(`
          DROP POLICY IF EXISTS ${table}_tenant_isolation ON ${table};
          ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
          ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
        `);
      }
    }
    await db.exec(`
      DROP TABLE IF EXISTS task_collaboration_invites;
      DROP TABLE IF EXISTS task_collaborators;
    `);
  },
};
