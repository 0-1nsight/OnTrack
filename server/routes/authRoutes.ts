import { Router } from 'express';
import { z } from 'zod';
import {
  clearSessionCookie,
  roleRequiresMfa,
  setSessionCookie,
} from '../auth.ts';
import { AuthStore, buildOnboardingCredentialsText } from '../authStore.ts';
import { appConfig } from '../config.ts';
import { EngineSQLStore } from '../engineStore.ts';
import { asyncHandler, HttpError } from '../errors.ts';
import { beginOidcLogin, completeOidcCallback } from '../oidc.ts';
import { EngineWsGateway } from '../wsGateway.ts';
import {
  extractSessionCookie,
  getClientIp,
  resolveHttpAuthContext,
} from './authMiddleware.ts';

const BootstrapSchema = z.object({
  firmName: z.string().trim().min(2).max(120),
  slug: z.string().trim().min(2).max(48).optional(),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email(),
  password: z.string().min(10).max(200),
});

const LoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
  tenantSlugOrId: z.string().trim().optional(),
  totpCode: z.string().trim().optional(),
  backupCode: z.string().trim().optional(),
});

const InviteCreateSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(2).max(120),
  role: z.enum([
    'accountant',
    'team_lead',
    'line_manager',
    'executive',
    'client',
    'admin_it',
  ]),
  teamId: z.string().trim().min(1).default('team_audit'),
  shiftPattern: z.enum(['8-5', '5-9', 'remote', 'weekend']).default('8-5'),
  clientId: z.string().trim().nullable().optional(),
  canDrilldownTimeline: z.boolean().optional(),
});

const DemoLoginSchema = z.object({
  userId: z.string().trim().min(1),
});

const AcceptInviteSchema = z.object({
  token: z.string().trim().min(10),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(2).max(120).optional(),
});

const PasswordResetRequestSchema = z.object({
  email: z.string().trim().email(),
  tenantId: z.string().trim().optional(),
});

const PasswordResetConfirmSchema = z.object({
  token: z.string().trim().min(10),
  newPassword: z.string().min(10).max(200),
});

const MfaCodeSchema = z.object({
  code: z.string().trim().min(6).max(16),
});

const MfaVerifySchema = z.object({
  totpCode: z.string().trim().optional(),
  backupCode: z.string().trim().optional(),
});

const OidcConfigSchema = z.object({
  enabled: z.boolean(),
  issuerUrl: z.string().trim().url(),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().optional(),
  allowedDomains: z.array(z.string().trim().min(1)).optional(),
});

const ProvisionUserSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(2).max(120),
  role: z
    .enum([
      'accountant',
      'team_lead',
      'line_manager',
      'executive',
      'client',
      'admin_it',
    ])
    .default('accountant'),
  teamId: z.string().trim().min(1).default('team_audit'),
  shiftPattern: z.enum(['8-5', '5-9', 'remote', 'weekend']).default('8-5'),
  clientId: z.string().trim().nullable().optional(),
  canDrilldownTimeline: z.boolean().optional(),
  workstationLabel: z.string().trim().max(120).optional(),
  appUrl: z.string().trim().url().optional(),
});

const RotateKeyBodySchema = z.object({
  workstationLabel: z.string().trim().max(120).optional(),
  appUrl: z.string().trim().url().optional(),
});

const KeyLoginSchema = z.object({
  email: z.string().trim().email(),
  accessKey: z.string().trim().min(12).max(200),
  tenantSlugOrId: z.string().trim().optional(),
});

const OnboardingPasswordSchema = z.object({
  newPassword: z.string().min(10).max(200),
});

function resolveRequestAppUrl(req: any, explicitUrl?: string): string {
  if (explicitUrl && explicitUrl.trim()) {
    return explicitUrl.trim().replace(/\/+$/, '');
  }
  const xfProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : req.protocol || 'http';
  const xfHost = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0].trim()
    : typeof req.headers.host === 'string'
    ? req.headers.host.trim()
    : '';
  if (xfHost) {
    return `${xfProto}://${xfHost}`.replace(/\/+$/, '');
  }
  return (appConfig.appUrl || `http://localhost:${appConfig.port}`).replace(/\/+$/, '');
}

function makeCredentialsFilename(email: string): string {
  const safeHandle = email
    .trim()
    .toLowerCase()
    .replace(/@.*/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '') || 'staff';
  return `OnTrack-Credentials-${safeHandle}.txt`;
}

export function createAuthRouter(deps: {
  authStore: AuthStore;
  engineStore: EngineSQLStore;
  wsGateway: EngineWsGateway;
  authLimiter?: any;
}) {
  const router = Router();
  const limitMiddleware = deps.authLimiter
    ? [deps.authLimiter]
    : [];

  router.get(
    '/bootstrap-status',
    asyncHandler(async (_req, res) => {
      const status = await deps.authStore.getBootstrapStatus();
      res.json(status);
    })
  );

  router.post(
    '/bootstrap',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const input = BootstrapSchema.parse(req.body);
      const { tenantId, userId } = await deps.authStore.bootstrapInitialTenantAdmin(input);
      const session = await deps.authStore.createSessionForUser({
        tenantId,
        userId,
        principalType: 'staff',
        mfaVerified: false, // Admin must enroll TOTP MFA
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      setSessionCookie(req, res, session.rawToken);
      const verified = await deps.authStore.verifySessionToken(session.rawToken);
      res.status(201).json({
        user: verified?.summary,
      });
    })
  );

  router.post(
    '/login',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const input = LoginSchema.parse(req.body);
      const out = await deps.authStore.authenticateWithPassword({
        ...input,
        principalType: 'staff',
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      setSessionCookie(req, res, out.rawToken);
      res.json({ user: out.user });
    })
  );

  router.post(
    '/client-login',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const input = LoginSchema.parse(req.body);
      const out = await deps.authStore.authenticateWithPassword({
        ...input,
        principalType: 'client',
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      setSessionCookie(req, res, out.rawToken);
      res.json({ user: out.user });
    })
  );

  router.post(
    '/key-login',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const input = KeyLoginSchema.parse(req.body);
      const out = await deps.authStore.authenticateWithAccessKey({
        ...input,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      setSessionCookie(req, res, out.rawToken);
      res.json({ user: out.user });
    })
  );

  router.post(
    '/onboarding/set-password',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps, {
        allowUnverifiedMfa: true,
      });
      if (authCtx.mode !== 'session') {
        throw new HttpError(
          401,
          'SESSION_REQUIRED',
          'Password setup requires an authenticated onboarding session.'
        );
      }
      const { newPassword } = OnboardingPasswordSchema.parse(req.body);
      await deps.authStore.completeOnboardingPasswordSetup({
        tenantId: authCtx.tenantId,
        userId: authCtx.userId,
        newPassword,
      });
      const rawSid = extractSessionCookie(req);
      const verified = rawSid ? await deps.authStore.verifySessionToken(rawSid) : null;
      res.json({
        ok: true,
        user: verified?.summary || null,
      });
    })
  );

  router.get(
    '/demo-accounts',
    asyncHandler(async (_req, res) => {
      if (!appConfig.demoModeEnabled) {
        return res.json({ demoModeEnabled: false, accounts: [] });
      }
      await deps.engineStore.seedDemoTenantIfMissing('firm_demo');
      const accounts = await deps.authStore.listDemoAccounts();
      return res.json({ demoModeEnabled: true, accounts });
    })
  );

  router.post(
    '/demo-login',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      if (!appConfig.demoModeEnabled) {
        throw new HttpError(
          403,
          'DEMO_DISABLED',
          'Demo account sign-in is disabled outside demo mode.'
        );
      }
      const { userId } = DemoLoginSchema.parse(req.body);
      await deps.engineStore.seedDemoTenantIfMissing('firm_demo');
      const out = await deps.authStore.authenticateDemoAccount({
        userId,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      setSessionCookie(req, res, out.rawToken);
      res.json({ user: out.user });
    })
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const rawSid = extractSessionCookie(req);
      if (rawSid) {
        const verified = await deps.authStore.verifySessionToken(rawSid);
        if (verified?.sessionId) {
          deps.wsGateway.disconnectSession(verified.sessionId);
        }
        await deps.authStore.revokeSessionByRawToken(rawSid);
      }
      clearSessionCookie(req, res);
      res.json({ ok: true });
    })
  );

  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      const rawSid = extractSessionCookie(req);
      if (!rawSid) {
        return res.json({ authenticated: false, user: null });
      }
      const verified = await deps.authStore.verifySessionToken(rawSid);
      if (!verified) {
        clearSessionCookie(req, res);
        return res.json({ authenticated: false, user: null });
      }
      return res.json({
        authenticated: true,
        user: verified.summary,
      });
    })
  );

  router.post(
    '/mfa/enroll',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps, {
        allowUnverifiedMfa: true,
      });
      if (authCtx.mode !== 'session') {
        throw new HttpError(400, 'SESSION_REQUIRED', 'TOTP enrollment requires a signed-in user session.');
      }
      if (authCtx.mustSetPassword) {
        throw new HttpError(
          403,
          'PASSWORD_SETUP_REQUIRED',
          'Create your account password first before setting up Two-Factor Authentication.'
        );
      }
      const enrollment = await deps.authStore.beginMfaEnrollment(
        authCtx.tenantId,
        authCtx.userId
      );
      res.json(enrollment);
    })
  );

  router.post(
    '/mfa/confirm',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps, {
        allowUnverifiedMfa: true,
      });
      if (authCtx.mode !== 'session') {
        throw new HttpError(400, 'SESSION_REQUIRED', 'TOTP confirmation requires a signed-in user session.');
      }
      if (authCtx.mustSetPassword) {
        throw new HttpError(
          403,
          'PASSWORD_SETUP_REQUIRED',
          'Create your account password first before confirming Two-Factor Authentication.'
        );
      }
      const { code } = MfaCodeSchema.parse(req.body);
      await deps.authStore.confirmMfaEnrollment(
        authCtx.tenantId,
        authCtx.userId,
        code,
        authCtx.sessionId
      );
      const rawSid = extractSessionCookie(req);
      const verified = rawSid ? await deps.authStore.verifySessionToken(rawSid) : null;
      res.json({
        ok: true,
        user: verified?.summary || null,
      });
    })
  );

  router.post(
    '/mfa/verify',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps, {
        allowUnverifiedMfa: true,
      });
      if (authCtx.mode !== 'session' || !authCtx.sessionId) {
        throw new HttpError(400, 'SESSION_REQUIRED', 'Session required.');
      }
      const input = MfaVerifySchema.parse(req.body);
      await deps.authStore.verifyCurrentSessionMfa(
        authCtx.tenantId,
        authCtx.userId,
        authCtx.sessionId,
        input
      );
      const rawSid = extractSessionCookie(req);
      const verified = rawSid ? await deps.authStore.verifySessionToken(rawSid) : null;
      res.json({ ok: true, user: verified?.summary || null });
    })
  );

  router.get(
    '/sessions',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps, {
        allowUnverifiedMfa: true,
      });
      if (authCtx.mode !== 'session') {
        return res.json({ sessions: [] });
      }
      const sessions = await deps.authStore.listSessionsForUser(
        authCtx.tenantId,
        authCtx.userId,
        authCtx.sessionId
      );
      return res.json({ sessions });
    })
  );

  router.delete(
    '/sessions/:sessionId',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps, {
        allowUnverifiedMfa: true,
      });
      if (authCtx.mode !== 'session') {
        throw new HttpError(401, 'SESSION_REQUIRED', 'Active user session required.');
      }
      const revoked = await deps.authStore.revokeSessionById(
        authCtx.tenantId,
        authCtx.userId,
        req.params.sessionId
      );
      if (!revoked) {
        throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found or already revoked.');
      }
      deps.wsGateway.disconnectSession(req.params.sessionId);
      const revokedCurrent = req.params.sessionId === authCtx.sessionId;
      if (revokedCurrent) {
        clearSessionCookie(req, res);
      }
      res.json({ ok: true, revokedCurrent });
    })
  );

  router.get(
    '/invites',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can view user invitations.');
      }
      const invites = await deps.authStore.listInvites(authCtx.tenantId);
      res.json({ invites });
    })
  );

  router.post(
    '/invites',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can invite firm users or clients.');
      }
      const input = InviteCreateSchema.parse(req.body);
      const invite = await deps.authStore.createUserInvite({
        tenantId: authCtx.tenantId,
        invitedByUserId: authCtx.userId,
        ...input,
      });
      res.status(201).json(invite);
    })
  );

  router.post(
    '/provision-user',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Only Firm Admin/IT can register staff accounts and issue onboarding keys.'
        );
      }
      const input = ProvisionUserSchema.parse(req.body);
      const provisioned = await deps.authStore.provisionUserWithKey({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        email: input.email,
        name: input.name,
        role: input.role,
        teamId: input.teamId,
        shiftPattern: input.shiftPattern,
        clientId: input.clientId,
        canDrilldownTimeline: input.canDrilldownTimeline,
      });

      const deviceId = `dev-${provisioned.userId}-ws`;
      const paired = await deps.engineStore.createDeviceToken({
        tenantId: authCtx.tenantId,
        userId: provisioned.userId,
        deviceId,
        label: input.workstationLabel?.trim() || `${provisioned.name} Workstation`,
      });

      await deps.engineStore.recordAuditLog({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        actorRole: authCtx.role,
        targetUserId: provisioned.userId,
        action: 'device.token_created',
        details: `Issued installation key ${paired.record.prefix}... for ${provisioned.email} (${deviceId})`,
      });

      const appUrl = resolveRequestAppUrl(req, input.appUrl);
      const credentialsText = buildOnboardingCredentialsText({
        firmName: provisioned.tenantName,
        tenantId: provisioned.tenantId,
        appUrl,
        userId: provisioned.userId,
        name: provisioned.name,
        email: provisioned.email,
        role: provisioned.role,
        accountAccessKey: provisioned.accountAccessKey,
        installationKey: paired.rawToken,
        deviceId,
        expiresAtUtc: provisioned.expiresAtUtc,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: provisioned.userId,
        eventType: 'state:updated',
      });

      res.status(201).json({
        user: {
          userId: provisioned.userId,
          tenantId: provisioned.tenantId,
          tenantName: provisioned.tenantName,
          name: provisioned.name,
          email: provisioned.email,
          role: provisioned.role,
          teamId: provisioned.teamId,
          shiftPattern: provisioned.shiftPattern,
        },
        accountAccessKey: provisioned.accountAccessKey,
        installationKey: paired.rawToken,
        deviceTokenRecord: paired.record,
        appUrl,
        expiresAtUtc: provisioned.expiresAtUtc,
        credentialsText,
        credentialsFilename: makeCredentialsFilename(provisioned.email),
      });
    })
  );

  router.post(
    '/provision-user/:userId/rotate-key',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(
          403,
          'FORBIDDEN',
          'Only Firm Admin/IT can re-generate staff onboarding keys.'
        );
      }
      const input = RotateKeyBodySchema.parse(req.body || {});
      const rotated = await deps.authStore.rotateUserOnboardingKey({
        tenantId: authCtx.tenantId,
        actorUserId: authCtx.userId,
        targetUserId: req.params.userId,
      });

      const deviceId = `dev-${rotated.userId}-ws`;
      const paired = await deps.engineStore.createDeviceToken({
        tenantId: authCtx.tenantId,
        userId: rotated.userId,
        deviceId,
        label: input.workstationLabel?.trim() || `${rotated.name} Workstation`,
      });

      const appUrl = resolveRequestAppUrl(req, input.appUrl);
      const credentialsText = buildOnboardingCredentialsText({
        firmName: rotated.tenantName,
        tenantId: rotated.tenantId,
        appUrl,
        userId: rotated.userId,
        name: rotated.name,
        email: rotated.email,
        role: rotated.role,
        accountAccessKey: rotated.accountAccessKey,
        installationKey: paired.rawToken,
        deviceId,
        expiresAtUtc: rotated.expiresAtUtc,
      });

      await deps.wsGateway.publish({
        tenantId: authCtx.tenantId,
        affectedUserId: rotated.userId,
        eventType: 'state:updated',
      });

      res.json({
        user: {
          userId: rotated.userId,
          tenantId: rotated.tenantId,
          tenantName: rotated.tenantName,
          name: rotated.name,
          email: rotated.email,
          role: rotated.role,
        },
        accountAccessKey: rotated.accountAccessKey,
        installationKey: paired.rawToken,
        deviceTokenRecord: paired.record,
        appUrl,
        expiresAtUtc: rotated.expiresAtUtc,
        credentialsText,
        credentialsFilename: makeCredentialsFilename(rotated.email),
      });
    })
  );

  router.post(
    '/invites/accept',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const input = AcceptInviteSchema.parse(req.body);
      const out = await deps.authStore.acceptUserInvite({
        ...input,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      setSessionCookie(req, res, out.rawToken);
      res.status(201).json({
        user: out.user,
        mustEnrollMfa: roleRequiresMfa(out.user.role),
      });
    })
  );

  router.post(
    '/password-reset/request',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const input = PasswordResetRequestSchema.parse(req.body);
      const out = await deps.authStore.requestPasswordReset(input);
      res.json(out);
    })
  );

  router.post(
    '/password-reset/confirm',
    ...limitMiddleware,
    asyncHandler(async (req, res) => {
      const input = PasswordResetConfirmSchema.parse(req.body);
      await deps.authStore.completePasswordReset(input);
      res.json({ ok: true });
    })
  );

  router.get(
    '/oidc/config',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can read tenant OIDC settings.');
      }
      const cfg = await deps.authStore.getTenantOidcConfig(authCtx.tenantId);
      res.json({
        config: cfg
          ? {
              enabled: cfg.enabled,
              issuerUrl: cfg.issuerUrl,
              clientId: cfg.clientId,
              hasClientSecret: Boolean(cfg.clientSecretEnc),
              allowedDomains: cfg.allowedDomains || [],
            }
          : {
              enabled: false,
              issuerUrl: '',
              clientId: '',
              hasClientSecret: false,
              allowedDomains: [],
            },
      });
    })
  );

  router.put(
    '/oidc/config',
    asyncHandler(async (req, res) => {
      const authCtx = await resolveHttpAuthContext(req, deps);
      if (authCtx.role !== 'admin_it') {
        throw new HttpError(403, 'FORBIDDEN', 'Only Admin/IT can configure tenant OIDC SSO.');
      }
      const input = OidcConfigSchema.parse(req.body);
      const saved = await deps.authStore.updateTenantOidcConfig(
        authCtx.tenantId,
        authCtx.userId,
        input
      );
      res.json({ config: saved });
    })
  );

  router.get(
    '/oidc/start',
    asyncHandler(async (req, res) => {
      const tenantRef = String(req.query.tenantId || '').trim();
      if (!tenantRef) {
        throw new HttpError(400, 'TENANT_REQUIRED', 'tenantId query parameter is required for OIDC SSO.');
      }
      const cfg = await deps.authStore.getTenantOidcConfig(tenantRef);
      if (!cfg?.enabled) {
        throw new HttpError(400, 'OIDC_DISABLED', 'OIDC SSO is not enabled for this workspace.');
      }
      const redirectUri = `${appConfig.appUrl.replace(/\/$/, '')}/api/auth/oidc/callback`;
      const authUrl = await beginOidcLogin({
        tenantId: tenantRef,
        cfg,
        redirectUri,
      });
      res.redirect(authUrl);
    })
  );

  router.get(
    '/oidc/callback',
    asyncHandler(async (req, res) => {
      const state = String(req.query.state || '');
      const tenantId = String(req.query.tenantId || '');
      if (!state) {
        throw new HttpError(400, 'OIDC_STATE_MISSING', 'Missing OIDC state.');
      }
      const tenants = await deps.engineStore.listTenants();
      const targetTenant = tenantId || tenants[0]?.id || '';
      const cfg = await deps.authStore.getTenantOidcConfig(targetTenant);
      if (!cfg?.enabled) {
        throw new HttpError(400, 'OIDC_DISABLED', 'OIDC SSO is not configured.');
      }
      const callbackUrl = new URL(
        req.originalUrl,
        appConfig.appUrl || `http://localhost:${appConfig.port}`
      );
      const identity = await completeOidcCallback({
        cfg,
        callbackUrl,
        state,
      });
      const out = await deps.authStore.authenticateOidcUser({
        tenantId: identity.tenantId,
        email: identity.email,
        name: identity.name,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
      });
      setSessionCookie(req, res, out.rawToken);
      res.redirect('/');
    })
  );

  return router;
}
