import { Request } from 'express';
import {
  extractBearerToken,
  parseCookieHeader,
  RequestAuthContext,
  SESSION_COOKIE_NAME,
} from '../auth.ts';
import { AuthStore } from '../authStore.ts';
import { appConfig } from '../config.ts';
import { EngineSQLStore } from '../engineStore.ts';
import { HttpError } from '../errors.ts';
import { UserRole } from '../../src/engine/types.ts';

const VALID_ROLES = new Set<UserRole>([
  'accountant',
  'team_lead',
  'line_manager',
  'executive',
  'client',
  'admin_it',
]);

export function normalizeRole(raw: unknown, fallback: UserRole = 'accountant'): UserRole {
  return typeof raw === 'string' && VALID_ROLES.has(raw as UserRole)
    ? (raw as UserRole)
    : fallback;
}

export function extractSessionCookie(req: Request): string | null {
  if (req.cookies && typeof req.cookies[SESSION_COOKIE_NAME] === 'string') {
    return req.cookies[SESSION_COOKIE_NAME];
  }
  const parsed = parseCookieHeader(req.headers.cookie);
  return parsed[SESSION_COOKIE_NAME] || null;
}

export interface AuthResolverDeps {
  authStore: AuthStore;
  engineStore: EngineSQLStore;
}

export async function resolveHttpAuthContext(
  req: Request,
  deps: AuthResolverDeps,
  options?: { allowUnverifiedMfa?: boolean }
): Promise<RequestAuthContext> {
  // 1. Enrolled Device Pairing Token (`Authorization: Bearer ontrack_dev_...`)
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer && bearer.startsWith('ontrack_dev_')) {
    const verified = await deps.engineStore.verifyDeviceToken(bearer);
    if (!verified) {
      throw new HttpError(401, 'INVALID_DEVICE_TOKEN', 'Invalid or revoked device pairing token.');
    }
    return {
      mode: 'device',
      principalType: 'device',
      tenantId: verified.tenantId,
      userId: verified.userId,
      userEmail: verified.email,
      userName: verified.userName,
      role: verified.role,
      teamId: verified.teamId,
      canDrilldownTimeline: false,
      mfaVerified: true,
      mustEnrollMfa: false,
      deviceId: verified.deviceId,
      isDemoSandbox: verified.tenantId === 'firm_demo',
    };
  }

  // 2. Self-hosted httpOnly Session Cookie (`ontrack_sid`)
  const rawSid = extractSessionCookie(req);
  if (rawSid) {
    const verifiedSession = await deps.authStore.verifySessionToken(rawSid);
    if (!verifiedSession) {
      throw new HttpError(401, 'SESSION_INVALID', 'Your session has expired or was revoked.');
    }
    if (!options?.allowUnverifiedMfa && !verifiedSession.mfaVerified) {
      throw new HttpError(
        403,
        verifiedSession.mustEnrollMfa ? 'MFA_ENROLLMENT_REQUIRED' : 'MFA_VERIFICATION_REQUIRED',
        verifiedSession.mustEnrollMfa
          ? 'Your role requires two-factor authenticator setup before accessing workspace data.'
          : 'Complete two-factor verification to continue.'
      );
    }
    if (
      appConfig.demoModeEnabled &&
      verifiedSession.isDemoSandbox &&
      verifiedSession.role === 'admin_it'
    ) {
      const requestedPreview = req.query.previewRole || req.query.viewerRole || req.body?.previewRole;
      if (typeof requestedPreview === 'string') {
        const previewRole = normalizeRole(requestedPreview, 'admin_it');
        if (previewRole !== 'admin_it' && previewRole !== 'client') {
          const demoUser =
            previewRole === 'team_lead'
              ? 'demo_u_lead_01'
              : previewRole === 'line_manager'
              ? 'demo_u_mgr_01'
              : previewRole === 'executive'
              ? 'demo_u_exec_01'
              : 'demo_u_acc_01';
          return {
            ...verifiedSession,
            userId: demoUser,
            role: previewRole,
            teamId: 'team_audit',
            canDrilldownTimeline:
              previewRole === 'team_lead' || previewRole === 'line_manager',
          };
        }
      }
    }
    return verifiedSession;
  }

  // 3. Explicit Demo Sandbox (strictly disabled in NODE_ENV=production and requires DEMO_MODE=true)
  const requestedTenant =
    (typeof req.query.tenantId === 'string' && req.query.tenantId) ||
    (typeof req.body?.tenantId === 'string' && req.body.tenantId) ||
    undefined;

  if (appConfig.demoModeEnabled && requestedTenant === 'firm_demo') {
    const previewRole = normalizeRole(
      req.query.previewRole || req.query.viewerRole || req.body?.previewRole,
      'accountant'
    );
    const rawPreviewUser =
      req.query.previewUserId || req.query.viewerUserId || req.body?.previewUserId;
    const demoUser =
      typeof rawPreviewUser === 'string' && rawPreviewUser.startsWith('demo_')
        ? rawPreviewUser
        : previewRole === 'team_lead'
        ? 'demo_u_lead_01'
        : previewRole === 'line_manager'
        ? 'demo_u_mgr_01'
        : previewRole === 'executive'
        ? 'demo_u_exec_01'
        : previewRole === 'admin_it'
        ? 'demo_u_admin_01'
        : previewRole === 'client'
        ? 'demo_u_client_01'
        : 'demo_u_acc_01';

    const demoClientId =
      previewRole !== 'client'
        ? null
        : demoUser === 'demo_u_client_02'
        ? 'demo_cli-northstar'
        : demoUser === 'demo_u_client_03'
        ? 'demo_cli-harbor'
        : 'demo_cli-acme';

    return {
      mode: 'demo',
      principalType: 'demo',
      tenantId: 'firm_demo',
      userId: demoUser,
      userEmail: 'demo@apex-cpa.example',
      userName: 'Demo Sandbox User',
      role: previewRole,
      teamId: previewRole === 'admin_it' ? 'team_ops' : 'team_audit',
      clientId: demoClientId,
      canDrilldownTimeline: previewRole === 'team_lead' || previewRole === 'line_manager',
      mfaVerified: true,
      mustEnrollMfa: false,
      isDemoSandbox: true,
    };
  }

  throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required. Please sign in to OnTrack.');
}

export function getClientIp(req: Request): string | null {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}
