import crypto from 'node:crypto';
import argon2 from 'argon2';
import { Request, Response } from 'express';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { UserRole } from '../src/engine/types.ts';
import { appConfig } from './config.ts';

export type PrincipalType = 'staff' | 'client' | 'device' | 'demo';

export interface RequestAuthContext {
  mode: 'session' | 'device' | 'demo';
  principalType: PrincipalType;
  sessionId?: string;
  tenantId: string;
  userId: string;
  userEmail: string;
  userName: string;
  role: UserRole;
  teamId: string;
  clientId?: string | null;
  canDrilldownTimeline: boolean;
  mfaVerified: boolean;
  mustEnrollMfa: boolean;
  mustSetPassword: boolean;
  deviceId?: string;
  isDemoSandbox: boolean;
}

export const SESSION_COOKIE_NAME = 'ontrack_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ROLES_REQUIRING_MFA = new Set<UserRole>(['admin_it', 'executive']);

export function roleRequiresMfa(role: UserRole): boolean {
  return ROLES_REQUIRING_MFA.has(role);
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function hashOpaqueToken(rawToken: string): string {
  return crypto
    .createHmac('sha256', appConfig.sessionSecret)
    .update(rawToken, 'utf8')
    .digest('hex');
}

export function hashDeviceToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateOpaqueToken(prefix = 'ots'): {
  rawToken: string;
  tokenHash: string;
} {
  const rawToken = `${prefix}_${crypto.randomBytes(32).toString('hex')}`;
  return {
    rawToken,
    tokenHash: hashOpaqueToken(rawToken),
  };
}

export function generateDeviceToken(): {
  rawToken: string;
  prefix: string;
  tokenHash: string;
} {
  const randomPart = crypto.randomBytes(24).toString('hex');
  const rawToken = `ontrack_dev_${randomPart}`;
  return {
    rawToken,
    prefix: rawToken.slice(0, 18),
    tokenHash: hashDeviceToken(rawToken),
  };
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', appConfig.encryptionKeyBytes, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${enc.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret');
  }
  const [ivHex, tagHex, encHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    appConfig.encryptionKeyBytes,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

export async function generateTotpEnrollment(email: string, firmName = 'OnTrack') {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: firmName || 'OnTrack',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  const otpauthUri = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(otpauthUri);
  const backupCodes = Array.from({ length: 8 }, () =>
    `${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()}`
  );
  return {
    secretBase32: secret.base32,
    otpauthUri,
    qrDataUrl,
    backupCodes,
    backupCodeHashes: backupCodes.map((c) => hashOpaqueToken(c)),
  };
}

export function verifyTotpCode(secretBase32: string, code: string): boolean {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: clean, window: 2 });
  return delta !== null;
}

export function isHttpsRequest(req: Request): boolean {
  if (appConfig.cookieSecure === 'true') return true;
  if (appConfig.cookieSecure === 'false') return false;
  if (req.secure) return true;
  const xfProto = req.headers['x-forwarded-proto'];
  if (typeof xfProto === 'string' && xfProto.toLowerCase().includes('https')) {
    return true;
  }
  return appConfig.appUrl.startsWith('https://');
}

export function setSessionCookie(req: Request, res: Response, rawToken: string) {
  const secure = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response) {
  const secure = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
  ];
  if (secure) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', parts.join('; '));
}

export function getSessionExpiryIso(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

export function extractBearerToken(authHeader?: string | string[]): string | null {
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const val = authHeader.slice(7).trim();
    if (val) return val;
  }
  return null;
}

export function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export function validateCsrfOrigin(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }
  // Device Bearer tokens don't use ambient browser cookies
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer && bearer.startsWith('ontrack_dev_')) {
    return true;
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const checkHeader = typeof origin === 'string' ? origin : typeof referer === 'string' ? referer : '';

  if (!checkHeader) {
    // Allow non-browser test clients in test environment or when no cookie is present
    if (!req.cookies?.[SESSION_COOKIE_NAME] && !parseCookieHeader(req.headers.cookie)[SESSION_COOKIE_NAME]) {
      return true;
    }
    return appConfig.isTest;
  }

  let sourceOrigin: string;
  try {
    sourceOrigin = new URL(checkHeader).origin;
  } catch {
    return false;
  }

  const allowedOrigins = new Set<string>(appConfig.corsOrigins);
  if (appConfig.appUrl) {
    try {
      allowedOrigins.add(new URL(appConfig.appUrl).origin);
    } catch {
      // ignore invalid APP_URL
    }
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (typeof host === 'string' && host.trim()) {
    const cleanHost = host.split(',')[0].trim();
    allowedOrigins.add(`http://${cleanHost}`);
    allowedOrigins.add(`https://${cleanHost}`);
  }

  return allowedOrigins.has(sourceOrigin);
}
