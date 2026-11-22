import { EngineSQLStore } from '../engineStore.ts';
import { logger } from '../logger.ts';

async function main() {
  const store = new EngineSQLStore({ seedDemo: false });
  try {
    await store.ready();
    await store.seedDemoTenantIfMissing('firm_demo');
    logger.info('seed.demo_tenant_ready', { tenantId: 'firm_demo' });
    console.log('Seeded demo tenant (firm_demo) successfully.');
  } finally {
    await store.db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
