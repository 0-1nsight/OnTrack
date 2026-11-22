import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UserRole } from '../src/engine/types.ts';

export interface VerifiedFirebaseClaims {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

export interface RequestAuthContext {
  mode: 'firebase' | 'device' | 'demo';
  tenantId: string;
  userId: string;
  userEmail: string;
  role: UserRole;
  deviceId?: string;
  isDemoSandbox: boolean;
}

const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let cachedJwks: { keys: Record<string, any>[]; expiresAtMs: number } = {
  keys: [],
  expiresAtMs: 0,
};

function readFirebaseProjectId(): string {
  if (process.env.FIREBASE_PROJECT_ID) {
    return process.env.FIREBASE_PROJECT_ID;
  }
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (parsed.projectId) return String(parsed.projectId);
    }
  } catch {
    // ignore
  }
  return 'dark-trees-jbcxw';
}

function base64UrlToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    '='
  );
  return Buffer.from(padded, 'base64');
}

async function getFirebaseJwks(): Promise<Record<string, any>[]> {
  if (Date.now() < cachedJwks.expiresAtMs && cachedJwks.keys.length > 0) {
    return cachedJwks.keys;
  }
  const res = await fetch(FIREBASE_JWKS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Firebase JWKS (${res.status})`);
  }
  const data = (await res.json()) as { keys?: Record<string, any>[] };
  const cc = res.headers.get('cache-control') || '';
  const maxAgeMatch = cc.match(/max-age=(\d+)/i);
  const ttlSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  cachedJwks = {
    keys: data.keys || [],
    expiresAtMs: Date.now() + ttlSec * 1000,
  };
  return cachedJwks.keys;
}

/**
 * Cryptographically verifies a Firebase Auth JWT ID token using Google's public JWKS,
 * requiring zero GCP service-account IAM keys and working in both cloud and on-prem builds.
 */
export async function verifyFirebaseIdToken(
  token: string
): Promise<VerifiedFirebaseClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase JWT');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(base64UrlToBuffer(headerB64).toString('utf8'));
  const payload = JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8'));

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Invalid Firebase JWT algorithm or key ID');
  }

  const projectId = readFirebaseProjectId();
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Firebase ID token expired');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Firebase ID token issued in the future');
  }
  if (payload.aud !== projectId) {
    throw new Error('Firebase ID token audience mismatch');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Firebase ID token issuer mismatch');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Firebase ID token subject missing');
  }

  const keys = await getFirebaseJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    cachedJwks.expiresAtMs = 0;
    const freshKeys = await getFirebaseJwks();
    jwk = freshKeys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    throw new Error('Firebase signing key not found');
  }

  const publicKey = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = base64UrlToBuffer(sigB64);

  const valid = crypto.verify('RSA-SHA256', signingInput, publicKey, signature);
  if (!valid) {
    throw new Error('Invalid Firebase JWT signature');
  }

  return {
    uid: payload.sub,
    email: String(payload.email || ''),
    emailVerified: Boolean(payload.email_verified),
    name: String(payload.name || payload.email || payload.sub),
    picture: payload.picture ? String(payload.picture) : undefined,
  };
}

export function hashDeviceToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateDeviceToken(): {
  rawToken: string;
  prefix: string;
  tokenHash: string;
} {
  const randomPart = crypto.randomBytes(24).toString('hex');
  const rawToken = `cf_dev_${randomPart}`;
  return {
    rawToken,
    prefix: rawToken.slice(0, 14),
    tokenHash: hashDeviceToken(rawToken),
  };
}

export function extractBearerToken(
  authHeader?: string | string[],
  queryToken?: string | string[]
): string | null {
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const val = authHeader.slice(7).trim();
    if (val) return val;
  }
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }
  return null;
}
