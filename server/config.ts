import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  VITEST: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: z.string().trim().default('http://localhost:3000'),
  SESSION_SECRET: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  DEMO_MODE: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  SQL_HOST: z.string().optional(),
  SQL_USER: z.string().optional(),
  SQL_PASSWORD: z.string().optional(),
  SQL_DB_NAME: z.string().optional(),
  SQL_ADMIN_USER: z.string().optional(),
  SQL_ADMIN_PASSWORD: z.string().optional(),
  DATA_DIR: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('OnTrack <noreply@ontrack.local>'),
  CORS_ORIGINS: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  AI_REPORTS_GLOBAL_ALLOW: z.string().optional(),
  BOOTSTRAP_ADMIN_EMAIL: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  BOOTSTRAP_TENANT_NAME: z.string().default('Apex Chartered Accountants'),
});

export interface SqlConnectionConfig {
  host: string;
  user: string;
  password: string;
  database: string;
  adminUser: string | null;
  adminPassword: string | null;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  isTest: boolean;
  port: number;
  appUrl: string;
  projectRoot: string;
  dataDir: string;
  databaseUrl: string;
  sqlConnection: SqlConnectionConfig | null;
  sessionSecret: string;
  encryptionKeyBytes: Buffer;
  cookieSecure: 'auto' | 'true' | 'false';
  demoModeEnabled: boolean;
  corsOrigins: string[];
  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };
  aiReportsGlobalAllow: boolean;
  geminiApiKey: string | null;
  bootstrapAdminEmail: string | null;
  bootstrapAdminPassword: string | null;
  bootstrapTenantName: string;
}

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    return cwd;
  }
  const parent = path.resolve(import.meta.dirname, '..');
  if (fs.existsSync(path.join(parent, 'package.json'))) {
    return parent;
  }
  return path.resolve(import.meta.dirname, '..', '..');
}

function loadOrCreateLocalSecret(dataDir: string, fileName: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, fileName);
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

export function loadAppConfig(overrides?: Partial<Record<string, string>>): AppConfig {
  const merged = { ...process.env, ...(overrides || {}) };
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const env = parsed.data;
  const projectRoot = resolveProjectRoot();
  const isProduction = env.NODE_ENV === 'production';
  const isTest = env.NODE_ENV === 'test' || (env.VITEST ?? process.env.VITEST) === 'true';

  const dataDir = env.DATA_DIR
    ? path.resolve(projectRoot, env.DATA_DIR)
    : path.resolve(projectRoot, 'data');

  let sessionSecret = (env.SESSION_SECRET || '').trim();
  if (isProduction && sessionSecret.length < 32) {
    throw new Error(
      'SESSION_SECRET must be at least 32 characters when NODE_ENV=production.'
    );
  }
  if (!sessionSecret) {
    sessionSecret = isTest
      ? crypto.randomBytes(32).toString('hex')
      : loadOrCreateLocalSecret(dataDir, '.ontrack-session-secret');
  }

  const rawEncKey = (env.ENCRYPTION_KEY || '').trim() || sessionSecret;
  const encryptionKeyBytes = crypto
    .createHash('sha256')
    .update(rawEncKey, 'utf8')
    .digest();

  // Never allow unauthenticated demo sandbox in production; in local/preview dev enable demo accounts unless explicitly set to 'false'
  const demoModeEnabled =
    !isProduction &&
    (env.DEMO_MODE === 'true' || (!isTest && (env.DEMO_MODE === undefined || env.DEMO_MODE.trim() === '')));

  const corsOrigins = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const geminiApiKey =
    env.GEMINI_API_KEY && env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ? env.GEMINI_API_KEY.trim()
      : null;

  const aiReportsGlobalAllow =
    env.AI_REPORTS_GLOBAL_ALLOW === 'false'
      ? false
      : env.AI_REPORTS_GLOBAL_ALLOW === 'true' || Boolean(geminiApiKey);

  const sqlHost = (env.SQL_HOST || '').trim();
  const sqlUser = (env.SQL_USER || '').trim();
  const sqlDbName = (env.SQL_DB_NAME || '').trim();
  const sqlConnection: SqlConnectionConfig | null =
    sqlHost && sqlUser && sqlDbName
      ? {
          host: sqlHost,
          user: sqlUser,
          password: env.SQL_PASSWORD || '',
          database: sqlDbName,
          adminUser: (env.SQL_ADMIN_USER || '').trim() || null,
          adminPassword: env.SQL_ADMIN_PASSWORD || null,
        }
      : null;

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    isTest,
    port: env.PORT,
    appUrl: env.APP_URL,
    projectRoot,
    dataDir,
    databaseUrl: (env.DATABASE_URL || '').trim(),
    sqlConnection,
    sessionSecret,
    encryptionKeyBytes,
    cookieSecure: env.COOKIE_SECURE,
    demoModeEnabled,
    corsOrigins,
    smtp: {
      enabled: Boolean(env.SMTP_HOST && env.SMTP_HOST.trim()),
      host: (env.SMTP_HOST || '').trim(),
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE === 'true',
      user: (env.SMTP_USER || '').trim(),
      pass: (env.SMTP_PASS || '').trim(),
      from: env.SMTP_FROM,
    },
    aiReportsGlobalAllow,
    geminiApiKey,
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL?.trim() || null,
    bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD || null,
    bootstrapTenantName: env.BOOTSTRAP_TENANT_NAME,
  };
}

export const appConfig = loadAppConfig();
