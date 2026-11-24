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

export async function runMigrationsUp(
  db: PortableSqlAdapter
): Promise<{ applied: string[]; currentVersion: string | null }> {
  await ensureMigrationsTable(db);
  const rows = await db.all<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC'
  );
  const existing = new Set(rows.map((r) => r.version));
  const applied: string[] = [];

  for (const mig of MIGRATIONS) {
    if (existing.has(mig.version)) continue;
    await db.withTenantTransaction({ tenantId: '__system__', bypassRls: true }, async (tx) => {
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

  const latest = await db.get<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );
  return { applied, currentVersion: latest?.version || null };
}

export async function rollbackLastMigration(
  db: PortableSqlAdapter
): Promise<{ rolledBack: string | null; currentVersion: string | null }> {
  await ensureMigrationsTable(db);
  const latest = await db.get<{ version: string; name: string }>(
    'SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );
  if (!latest) {
    return { rolledBack: null, currentVersion: null };
  }

  const mig = MIGRATIONS.find((m) => m.version === latest.version);
  if (!mig) {
    throw new Error(`Migration ${latest.version} (${latest.name}) definition not found`);
  }

  await db.withTenantTransaction({ tenantId: '__system__', bypassRls: true }, async (tx) => {
    await mig.down(tx);
    await tx.run('DELETE FROM schema_migrations WHERE version = ?', mig.version);
  });

  const nextLatest = await db.get<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );
  return {
    rolledBack: `${mig.version}_${mig.name}`,
    currentVersion: nextLatest?.version || null,
  };
}
