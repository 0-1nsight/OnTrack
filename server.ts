import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { validateCsrfOrigin } from './server/auth.ts';
import { AuthStore } from './server/authStore.ts';
import { appConfig } from './server/config.ts';
import { EngineSQLStore } from './server/engineStore.ts';
import { centralErrorHandler, HttpError } from './server/errors.ts';
import { logger } from './server/logger.ts';
import { PortalSQLStore } from './server/portalStore.ts';
import { createAuthRouter } from './server/routes/authRoutes.ts';
import { createEngineRouter } from './server/routes/engineRoutes.ts';
import { createPortalRouter } from './server/routes/portalRoutes.ts';
import { createReportsRouter } from './server/routes/reportsRoutes.ts';
import { EngineWsGateway } from './server/wsGateway.ts';

export interface CreateServerOptions {
  dbPath?: string;
  databaseUrl?: string;
  seedDemo?: boolean;
  disableVite?: boolean;
}

export async function createOnTrackServer(options?: CreateServerOptions) {
  const startedAtMs = Date.now();
  const app = express();
  app.set('trust proxy', 1);

  const server = http.createServer(app);

  const engineStore = new EngineSQLStore({
    dbPath: options?.dbPath,
    databaseUrl: options?.databaseUrl,
    seedDemo: options?.seedDemo ?? appConfig.demoModeEnabled,
  });
  await engineStore.ready();

  const authStore = new AuthStore(engineStore.db);
  await authStore.ensureEnvBootstrapAdmin();
  const portalStore = new PortalSQLStore(engineStore);

  const wsGateway = new EngineWsGateway(server, engineStore, authStore);

  // Security headers (allow inline scripts/styles only when Vite dev HMR is active)
  app.use(
    helmet({
      contentSecurityPolicy: appConfig.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
              fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
              imgSrc: ["'self'", 'data:', 'blob:'],
              connectSrc: ["'self'", 'ws:', 'wss:'],
              frameAncestors: ["'self'"],
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    })
  );

  // Strict CORS policy when CORS_ORIGINS is configured; same-origin works without CORS headers
  if (appConfig.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin || appConfig.corsOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(new HttpError(403, 'CORS_FORBIDDEN', 'Origin not permitted by CORS policy'));
          }
        },
        credentials: true,
      })
    );
  }

  app.use(cookieParser());
  app.use(express.json({ limit: '8mb' }));

  // CSRF Origin validation for cookie-authenticated API mutations
  app.use('/api', (req, _res, next) => {
    if (!validateCsrfOrigin(req)) {
      return next(
        new HttpError(403, 'CSRF_ORIGIN_REJECTED', 'Cross-origin state-changing request rejected.')
      );
    }
    return next();
  });

  // Auth rate limiter (disabled in Vitest automated suite)
  const authLimiter = appConfig.isTest
    ? undefined
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 40,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: {
          error: 'Too many authentication attempts. Please wait a few minutes and try again.',
          code: 'RATE_LIMITED',
        },
      });

  // Operational health & metrics endpoints
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'ontrack',
      env: appConfig.nodeEnv,
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
      timeUtc: new Date().toISOString(),
    });
  });

  app.get('/readyz', async (_req, res) => {
    const dbOk = await engineStore.db.ping();
    let migrationCount = 0;
    let currentVersion: string | null = null;
    try {
      const rows = await engineStore.db.all<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC'
      );
      migrationCount = rows.length;
      currentVersion = rows[0]?.version || null;
    } catch {
      // schema_migrations unavailable
    }

    if (!dbOk || migrationCount === 0) {
      return res.status(503).json({
        status: 'not_ready',
        dialect: engineStore.db.dialect,
        dbOk,
        migrationCount,
      });
    }

    return res.json({
      status: 'ready',
      dialect: engineStore.db.dialect,
      migrationCount,
      currentVersion,
      demoModeEnabled: appConfig.demoModeEnabled,
    });
  });

  app.get('/metrics', (_req, res) => {
    const latency = engineStore.getLatencyStats();
    res.json({
      uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
      wsConnections: wsGateway.getActiveConnectionCount(),
      broadcastLatency: latency,
      dialect: engineStore.db.dialect,
      timeUtc: new Date().toISOString(),
    });
  });

  // Modular API Routers
  app.use(
    '/api/auth',
    createAuthRouter({
      authStore,
      engineStore,
      wsGateway,
      authLimiter,
    })
  );

  app.use(
    '/api/reports',
    createReportsRouter({
      authStore,
      engineStore,
    })
  );

  app.use(
    '/api/engine',
    createEngineRouter({
      authStore,
      engineStore,
      wsGateway,
    })
  );

  app.use(
    '/api/portal',
    createPortalRouter({
      authStore,
      engineStore,
      portalStore,
      wsGateway,
    })
  );

  // Centralized Error Handler before Vite/SPA fallback
  app.use('/api', centralErrorHandler);

  // Hourly background raw event retention sweep across all tenants
  const retentionTimer = setInterval(async () => {
    try {
      const tenants = await engineStore.listTenants();
      for (const t of tenants) {
        await engineStore.purgeExpiredRawEvents(t.id);
      }
    } catch (err: any) {
      logger.warn('retention.sweep_failed', { message: err?.message });
    }
  }, 60 * 60 * 1000);
  retentionTimer.unref();

  if (!appConfig.isProduction && !appConfig.isTest && !options?.disableVite) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!appConfig.isTest && !options?.disableVite) {
    const distPath = path.resolve(appConfig.projectRoot, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        const indexPath = path.join(distPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          res.status(404).send('Client build missing. Run npm run build.');
        }
      });
    }
  }

  app.use(centralErrorHandler);

  const close = async () => {
    clearInterval(retentionTimer);
    await wsGateway.close();
    await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });
    await engineStore.db.close();
  };

  return {
    app,
    server,
    engineStore,
    authStore,
    wsGateway,
    close,
  };
}

async function startCliServer() {
  const instance = await createOnTrackServer();
  const port = appConfig.port;

  instance.server.listen(port, '0.0.0.0', () => {
    logger.info('server.listening', {
      port,
      dialect: instance.engineStore.db.dialect,
      env: appConfig.nodeEnv,
      demoModeEnabled: appConfig.demoModeEnabled,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutting_down', { signal });
    await instance.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const isEntrypoint = Boolean(
  process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
);

if (isEntrypoint) {
  startCliServer().catch((err) => {
    logger.error('server.fatal_startup_error', {
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
