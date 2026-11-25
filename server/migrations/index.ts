import { PortableSqlAdapter } from '../sqlAdapter.ts';
import { Migration, migration001InitialSchema } from './001_initial_schema.ts';
import { migration002PostgresRls } from './002_postgres_rls.ts';
import { migration003ClientPortal } from './003_client_portal.ts';
import { migration004PortalEnhancements } from './004_portal_enhancements.ts';
import { migration005TaskCollaboration } from './005_task_collaboration.ts';
import { migration006OnboardingAccessKeys } from './006_onboarding_access_keys.ts';

export const MIGRATIONS: Migration[] = [
  migration001InitialSchema,
  migration002PostgresRls,
  migration003ClientPortal,
  migration004PortalEnhancements,
  migration005TaskCollaboration,
  migration006OnboardingAccessKeys,
];

async function ensureMigrationsTable(db: PortableSqlAdapter) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_utc TEXT NOT NULL
    );
  `);
}

async function withMigrationAdapter<T>(
  db: PortableSqlAdapter,
  fn: (migDb: PortableSqlAdapter) => Promise<T>
): Promise<T> {
  const hasAdminCreds =
    db.dialect === 'postgres' &&
    Boolean(process.env.SQL_HOST && process.env.SQL_DB_NAME && process.env.SQL_ADMIN_USER && process.env.SQL_ADMIN_PASSWORD);

  if (!hasAdminCreds) {
    return fn(db);
  }

  const adminDb = new PortableSqlAdapter({ useAdminUser: true });
  try {
    return await fn(adminDb);
  } finally {
    await adminDb.close();
  }
}

async function ensureAppUserDmlGrants(migDb: PortableSqlAdapter) {
  if (migDb.dialect !== 'postgres') return;
  const appUser = (process.env.SQL_USER || '').trim();
  const adminUser = (process.env.SQL_ADMIN_USER || '').trim();
  if (!appUser || !adminUser || appUser === adminUser) return;
  const safeUser = `"${appUser.replace(/"/g, '""')}"`;
  await migDb.exec(`
    GRANT USAGE ON SCHEMA public TO ${safeUser};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${safeUser};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${safeUser};
  `);
}

export async function runMigrationsUp(
  db: PortableSqlAdapter
): Promise<{ applied: string[]; currentVersion: string | null }> {
  return withMigrationAdapter(db, async (migDb) => {
    await ensureMigrationsTable(migDb);
    const rows = await migDb.all<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version ASC'
    );
    const existing = new Set(rows.map((r) => r.version));
    const applied: string[] = [];

    for (const mig of MIGRATIONS) {
      if (existing.has(mig.version)) continue;
      await migDb.withTenantTransaction({ tenantId: '__system__', bypassRls: true }, async (tx) => {
        await mig.up(tx);
        await tx.run(
          'INSERT INTO schema_migrations (version, name, applied_at_utc) VALUES (?, ?, ?)',
          mig.version,
          mig.name,
          new Date().toISOString()
        );
      });
      applied.push(`${mig.version}_${mig.name}`);
    }

    await ensureAppUserDmlGrants(migDb);

    const latest = await migDb.get<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
    return { applied, currentVersion: latest?.version || null };
  });
}

export async function rollbackLastMigration(
  db: PortableSqlAdapter
): Promise<{ rolledBack: string | null; currentVersion: string | null }> {
  return withMigrationAdapter(db, async (migDb) => {
    await ensureMigrationsTable(migDb);
    const latest = await migDb.get<{ version: string; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
    if (!latest) {
      return { rolledBack: null, currentVersion: null };
    }

    const mig = MIGRATIONS.find((m) => m.version === latest.version);
    if (!mig) {
      throw new Error(`Migration ${latest.version} (${latest.name}) definition not found`);
    }

    await migDb.withTenantTransaction({ tenantId: '__system__', bypassRls: true }, async (tx) => {
      await mig.down(tx);
      await tx.run('DELETE FROM schema_migrations WHERE version = ?', mig.version);
    });

    const nextLatest = await migDb.get<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
    return {
      rolledBack: `${mig.version}_${mig.name}`,
      currentVersion: nextLatest?.version || null,
    };
  });
}
