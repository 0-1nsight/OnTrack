import { SqlExecutor } from '../sqlAdapter.ts';

export interface Migration {
  version: string;
  name: string;
  up(db: SqlExecutor): Promise<void>;
  down(db: SqlExecutor): Promise<void>;
}

export const migration001InitialSchema: Migration = {
  version: '001',
  name: 'initial_ontrack_schema',
  async up(db: SqlExecutor): Promise<void> {
    if (db.dialect === 'sqlite') {
      await db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    }

    await db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE,
        config_json TEXT NOT NULL,
        ai_reports_enabled INTEGER NOT NULL DEFAULT 0,
        oidc_config_json TEXT,
        branding_json TEXT,
        created_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        parent_team_id TEXT,
        lead_user_id TEXT,
        created_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id);

      CREATE TABLE IF NOT EXISTS shift_users (
        user_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        team_id TEXT NOT NULL,
        shift_pattern TEXT NOT NULL,
        shift_start_hour_utc INTEGER NOT NULL,
        shift_end_hour_utc INTEGER NOT NULL,
        on_leave INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT,
        totp_secret_enc TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        must_enroll_mfa INTEGER NOT NULL DEFAULT 0,
        backup_codes_json TEXT,
        can_drilldown_timeline INTEGER NOT NULL DEFAULT 0,
        client_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        mfa_grace_deadline_utc TEXT,
        last_login_utc TEXT,
        created_at_utc TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_users_tenant_email
        ON shift_users(tenant_id, email);

      CREATE TABLE IF NOT EXISTS user_invites (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        team_id TEXT NOT NULL,
        shift_pattern TEXT NOT NULL,
        client_id TEXT,
        can_drilldown_timeline INTEGER NOT NULL DEFAULT 0,
        token_hash TEXT NOT NULL,
        invited_by_user_id TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL,
        accepted_at_utc TEXT,
        created_at_utc TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_invites_token_hash
        ON user_invites(token_hash);

      CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL,
        used_at_utc TEXT,
        created_at_utc TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_password_resets_token_hash
        ON password_resets(token_hash);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        principal_type TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        mfa_verified INTEGER NOT NULL DEFAULT 0,
        user_agent TEXT,
        ip_address TEXT,
        created_at_utc TEXT NOT NULL,
        last_seen_utc TEXT NOT NULL,
        expires_at_utc TEXT NOT NULL,
        revoked_at_utc TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash
        ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(tenant_id, user_id);

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

      CREATE INDEX IF NOT EXISTS idx_device_tokens_tenant
        ON device_tokens(tenant_id, user_id);

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

      CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients(tenant_id);

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

      CREATE INDEX IF NOT EXISTS idx_engine_tasks_tenant
        ON engine_tasks(tenant_id, assigned_user_id);

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

      CREATE INDEX IF NOT EXISTS idx_device_freshness_tenant
        ON device_freshness(tenant_id, user_id);

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

      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant
        ON audit_logs(tenant_id, created_at_utc DESC);

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

      CREATE TABLE IF NOT EXISTS late_updates (
        tenant_id TEXT PRIMARY KEY,
        notice TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
    `);
  },
  async down(db: SqlExecutor): Promise<void> {
    await db.exec(`
      DROP TABLE IF EXISTS late_updates;
      DROP TABLE IF EXISTS stored_files;
      DROP TABLE IF EXISTS audit_logs;
      DROP TABLE IF EXISTS sync_conflicts;
      DROP TABLE IF EXISTS checklist_overrides;
      DROP TABLE IF EXISTS attribution_overrides;
      DROP TABLE IF EXISTS device_freshness;
      DROP TABLE IF EXISTS tracking_events;
      DROP TABLE IF EXISTS learned_rules;
      DROP TABLE IF EXISTS engine_tasks;
      DROP TABLE IF EXISTS task_templates;
      DROP TABLE IF EXISTS privacy_rules;
      DROP TABLE IF EXISTS activity_rules;
      DROP TABLE IF EXISTS clients;
      DROP TABLE IF EXISTS device_tokens;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS password_resets;
      DROP TABLE IF EXISTS user_invites;
      DROP TABLE IF EXISTS shift_users;
      DROP TABLE IF EXISTS teams;
      DROP TABLE IF EXISTS tenants;
    `);
  },
};
