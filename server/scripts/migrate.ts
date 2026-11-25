import { appConfig } from '../config.ts';
import { logger } from '../logger.ts';
import { rollbackLastMigration, runMigrationsUp } from '../migrations/index.ts';
import { PortableSqlAdapter } from '../sqlAdapter.ts';

async function main() {
  const direction = (process.argv[2] || 'up').toLowerCase();
  const db = new PortableSqlAdapter({
    databaseUrl: appConfig.databaseUrl || undefined,
  });
  try {
    if (direction === 'down') {
      const res = await rollbackLastMigration(db);
      logger.info('migrations.rollback_complete', res);
      console.log(JSON.stringify(res, null, 2));
    } else if (direction === 'up') {
      const res = await runMigrationsUp(db);
      logger.info('migrations.up_complete', res);
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.error('Usage: tsx server/scripts/migrate.ts [up|down]');
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
