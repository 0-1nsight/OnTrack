import crypto from 'node:crypto';
import { ShiftPattern, UserRole } from '../src/engine/types.ts';
import {
  decryptSecret,
  encryptSecret,
  generateOpaqueToken,
  generateTotpEnrollment,
  getSessionExpiryIso,
  hashOpaqueToken,
  hashPassword,
  RequestAuthContext,
  roleRequiresMfa,
  verifyPassword,
  verifyTotpCode,
} from './auth.ts';
import { appConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { sendMail } from './mailer.ts';
import { serializeOidcConfig, TenantOidcConfig } from './oidc.ts';
import { PortableSqlAdapter } from './sqlAdapter.ts';

// Precomputed valid argon2id hash used solely to equalize timing when a user email doesn't exist
let dummyHashPromise: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('hex'));
  }
  return dummyHashPromise;
}

export interface SessionInfo {
  id: string;
  principalType: 'staff' | 'client';
  mfaVerified: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAtUtc: string;
  lastSeenUtc: string;
  expiresAtUtc: string;
  isCurrent: boolean;
}

export interface PublicUserSummary {
  userId: string;
  tenantId: string;
  tenantName: string;
  name: string;
  email: string;
  role: UserRole;
  teamId: string;
  clientId: string | null;
  shiftPattern: ShiftPattern;
  canDrilldownTimeline: boolean;
  totpEnabled: boolean;
  mfaVerified: boolean;
  mustEnrollMfa: boolean;
  principalType: 'staff' | 'client' | 'demo';
  isDemoSandbox: boolean;
  aiReportsEnabled: boolean;
}

export class AuthStore {
  constructor(private readonly db: PortableSqlAdapter) {}

  public async getBootstrapStatus(): Promise<{
    needsInitialSetup: boolean;
    demoModeEnabled: boolean;
    hasOidcTenants: boolean;
  }> {
    return this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        const row = await tx.get<{ cnt: number }>(
          "SELECT COUNT(*) as cnt FROM tenants WHERE id != 'firm_demo'"
        );
        const oidcRows = await tx.all<{ oidc_config_json: string | null }>(
          'SELECT oidc_config_json FROM tenants WHERE oidc_config_json IS NOT NULL'
        );
        const hasOidcTenants = oidcRows.some((r) => {
          try {
            return Boolean(r.oidc_config_json && JSON.parse(r.oidc_config_json).enabled);
          } catch {
            return false;
          }
        });
        return {
          needsInitialSetup: Number(row?.cnt || 0) === 0,
          demoModeEnabled: appConfig.demoModeEnabled,
          hasOidcTenants,
        };
      }
    );
  }

  public async ensureEnvBootstrapAdmin(): Promise<void> {
    if (!appConfig.bootstrapAdminEmail || !appConfig.bootstrapAdminPassword) {
      return;
    }
    const status = await this.getBootstrapStatus();
    if (!status.needsInitialSetup) return;

    await this.bootstrapInitialTenantAdmin({
      firmName: appConfig.bootstrapTenantName,
      slug: 'primary-firm',
      name: 'Firm Administrator',
      email: appConfig.bootstrapAdminEmail,
      password: appConfig.bootstrapAdminPassword,
    });
  }

  public async bootstrapInitialTenantAdmin(params: {
    firmName: string;
    slug?: string;
    name: string;
    email: string;
    password: string;
  }): Promise<{ tenantId: string; userId: string }> {
    const cleanEmail = params.email.trim().toLowerCase();
    const cleanFirm = params.firmName.trim();
    const slug = (
      params.slug ||
      cleanFirm
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') ||
      'firm'
    ).slice(0, 48);

    const passwordHash = await hashPassword(params.password);
    const nowIso = new Date().toISOString();
    const tenantId = `firm_${crypto.randomBytes(5).toString('hex')}`;
    const userId = `u_${crypto.randomBytes(6).toString('hex')}`;
    const teamId = `team_${crypto.randomBytes(4).toString('hex')}`;

    return this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        const existing = await tx.get<{ cnt: number }>(
          "SELECT COUNT(*) as cnt FROM tenants WHERE id != 'firm_demo'"
        );
        if (Number(existing?.cnt || 0) > 0) {
          throw new HttpError(
            409,
            'ALREADY_INITIALIZED',
            'An organization already exists. Sign in with an administrator account or accept an invite.'
          );
        }

        const config = {
          id: tenantId,
          name: cleanFirm,
          confidenceThresholds: { detected: 0.85, suggested: 0.5 },
          sessionizer: { maxInterruptionSeconds: 30, idleCloseSeconds: 180 },
          heartbeatIntervalSeconds: 12,
          delayedThresholdSeconds: 120,
          retentionDays: 60,
          monitoringPolicy: 'mandatory',
          serverUrl: appConfig.appUrl,
        };

        await tx.run(
          `INSERT INTO tenants (id, name, slug, config_json, ai_reports_enabled, created_at_utc)
           VALUES (?, ?, ?, ?, 0, ?)`,
          tenantId,
          cleanFirm,
          slug,
          JSON.stringify(config),
          nowIso
        );

        await tx.run(
          `INSERT INTO teams (id, tenant_id, name, parent_team_id, lead_user_id, created_at_utc)
           VALUES (?, ?, 'Operations & IT', NULL, ?, ?)`,
          teamId,
          tenantId,
          userId,
          nowIso
        );

        await tx.run(
          `INSERT INTO shift_users
           (user_id, tenant_id, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave, password_hash, totp_enabled, must_enroll_mfa, can_drilldown_timeline, status, created_at_utc)
           VALUES (?, ?, ?, ?, 'admin_it', ?, '8-5', 13, 22, 0, ?, 0, 1, 0, 'active', ?)`,
          userId,
          tenantId,
          params.name.trim(),
          cleanEmail,
          teamId,
          passwordHash,
          nowIso
        );

        // Seed default safe privacy rules for the new firm
        const defaultPrivacy = [
          { kind: 'domain', pattern: 'personalbank', reason: 'Personal Banking' },
          { kind: 'domain', pattern: 'mychart', reason: 'Personal Health' },
          { kind: 'app', pattern: '1Password', reason: 'Credential Manager' },
          { kind: 'path', pattern: '*\\Personal\\*', reason: 'Personal Folder' },
        ];
        for (let i = 0; i < defaultPrivacy.length; i++) {
          const p = defaultPrivacy[i];
          await tx.run(
            `INSERT INTO privacy_rules (id, tenant_id, kind, pattern, reason, enabled)
             VALUES (?, ?, ?, ?, ?, 1)`,
            `priv-${crypto.randomBytes(4).toString('hex')}-${i}`,
            tenantId,
            p.kind,
            p.pattern,
            p.reason
          );
        }

        await tx.run(
          `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, target_user_id, action, details, created_at_utc)
           VALUES (?, ?, ?, 'admin_it', ?, 'tenant.bootstrapped', ?, ?)`,
          `aud-${crypto.randomBytes(6).toString('hex')}`,
          tenantId,
          userId,
          userId,
          `Initial firm "${cleanFirm}" created and Admin/IT account provisioned`,
          nowIso
        );

        return { tenantId, userId };
      }
    );
  }

  public async createSessionForUser(params: {
    tenantId: string;
    userId: string;
    principalType: 'staff' | 'client';
    mfaVerified: boolean;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{ rawToken: string; sessionId: string }> {
    const { rawToken, tokenHash } = generateOpaqueToken('ots');
    const sessionId = `ses_${crypto.randomBytes(8).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const expiresAtUtc = getSessionExpiryIso();

    await this.db.withTenantTransaction(
      { tenantId: params.tenantId, userId: params.userId },
      async (tx) => {
        await tx.run(
          `INSERT INTO sessions
           (id, tenant_id, user_id, principal_type, token_hash, mfa_verified, user_agent, ip_address, created_at_utc, last_seen_utc, expires_at_utc, revoked_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          sessionId,
          params.tenantId,
          params.userId,
          params.principalType,
          tokenHash,
          params.mfaVerified ? 1 : 0,
          params.userAgent ? params.userAgent.slice(0, 250) : null,
          params.ipAddress ? params.ipAddress.slice(0, 80) : null,
          nowIso,
          nowIso,
          expiresAtUtc
        );
        await tx.run(
          'UPDATE shift_users SET last_login_utc = ? WHERE tenant_id = ? AND user_id = ?',
          nowIso,
          params.tenantId,
          params.userId
        );
      }
    );

    return { rawToken, sessionId };
  }

  public async authenticateWithPassword(params: {
    email: string;
    password: string;
    tenantSlugOrId?: string;
    principalType: 'staff' | 'client';
    totpCode?: string;
    backupCode?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{
    rawToken: string;
    sessionId: string;
    user: PublicUserSummary;
  }> {
    const cleanEmail = params.email.trim().toLowerCase();

    const candidates = await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        if (params.tenantSlugOrId && params.tenantSlugOrId.trim()) {
          const ref = params.tenantSlugOrId.trim();
          return tx.all<any>(
            `SELECT u.*, t.name as tenant_name, t.ai_reports_enabled
             FROM shift_users u
             JOIN tenants t ON t.id = u.tenant_id
             WHERE lower(u.email) = ? AND (t.id = ? OR lower(t.slug) = lower(?))`,
            cleanEmail,
            ref,
            ref
          );
        }
        return tx.all<any>(
          `SELECT u.*, t.name as tenant_name, t.ai_reports_enabled
           FROM shift_users u
           JOIN tenants t ON t.id = u.tenant_id
           WHERE lower(u.email) = ?`,
          cleanEmail
        );
      }
    );

    const expectedRoleFilter = (row: any) =>
      params.principalType === 'client' ? row.role === 'client' : row.role !== 'client';

    const matchedCandidates = candidates.filter(expectedRoleFilter);

    if (matchedCandidates.length > 1) {
      throw new HttpError(
        409,
        'TENANT_DISAMBIGUATION_REQUIRED',
        'Multiple firms match this email address. Please specify your Firm ID or workspace slug.'
      );
    }

    const userRow = matchedCandidates[0];
    if (!userRow || !userRow.password_hash) {
      await verifyPassword(await getDummyPasswordHash(), params.password);
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    if (userRow.status === 'disabled') {
      await verifyPassword(await getDummyPasswordHash(), params.password);
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'Account is disabled. Contact your Firm Administrator.');
    }

    const validPw = await verifyPassword(userRow.password_hash, params.password);
    if (!validPw) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const role = userRow.role as UserRole;
    const totpEnabled = Boolean(userRow.totp_enabled);
    const mustEnrollMfa = roleRequiresMfa(role) && !totpEnabled;
    let mfaVerified = !totpEnabled && !mustEnrollMfa;

    if (totpEnabled) {
      if (params.totpCode) {
        const secretBase32 = decryptSecret(userRow.totp_secret_enc);
        if (!verifyTotpCode(secretBase32, params.totpCode)) {
          throw new HttpError(401, 'INVALID_MFA_CODE', 'Invalid verification code.');
        }
        mfaVerified = true;
      } else if (params.backupCode) {
        const consumed = await this.consumeBackupCode(
          userRow.tenant_id,
          userRow.user_id,
          params.backupCode
        );
        if (!consumed) {
          throw new HttpError(401, 'INVALID_BACKUP_CODE', 'Invalid or already used backup code.');
        }
        mfaVerified = true;
      } else {
        throw new HttpError(401, 'MFA_CODE_REQUIRED', 'Enter your 6-digit authenticator code.');
      }
    }

    const session = await this.createSessionForUser({
      tenantId: userRow.tenant_id,
      userId: userRow.user_id,
      principalType: params.principalType,
      mfaVerified,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    return {
      rawToken: session.rawToken,
      sessionId: session.sessionId,
      user: {
        userId: userRow.user_id,
        tenantId: userRow.tenant_id,
        tenantName: userRow.tenant_name,
        name: userRow.name,
        email: userRow.email,
        role,
        teamId: userRow.team_id,
        clientId: userRow.client_id || null,
        shiftPattern: userRow.shift_pattern as ShiftPattern,
        canDrilldownTimeline: Boolean(userRow.can_drilldown_timeline),
        totpEnabled,
        mfaVerified,
        mustEnrollMfa,
        principalType: params.principalType,
        isDemoSandbox: userRow.tenant_id === 'firm_demo',
        aiReportsEnabled: Boolean(userRow.ai_reports_enabled),
      },
    };
  }

  private async consumeBackupCode(
    tenantId: string,
    userId: string,
    rawCode: string
  ): Promise<boolean> {
    const normalized = rawCode.trim().toUpperCase();
    const targetHash = hashOpaqueToken(normalized);
    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const row = await tx.get<{ backup_codes_json: string | null }>(
        'SELECT backup_codes_json FROM shift_users WHERE tenant_id = ? AND user_id = ?',
        tenantId,
        userId
      );
      const list: string[] = row?.backup_codes_json
        ? JSON.parse(row.backup_codes_json)
        : [];
      const idx = list.indexOf(targetHash);
      if (idx === -1) return false;
      list.splice(idx, 1);
      await tx.run(
        'UPDATE shift_users SET backup_codes_json = ? WHERE tenant_id = ? AND user_id = ?',
        JSON.stringify(list),
        tenantId,
        userId
      );
      return true;
    });
  }

  public async verifySessionToken(
    rawToken: string
  ): Promise<(RequestAuthContext & { summary: PublicUserSummary }) | null> {
    const tokenHash = hashOpaqueToken(rawToken);
    const nowIso = new Date().toISOString();

    return this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        const row = await tx.get<any>(
          `SELECT s.*, u.name as user_name, u.email as user_email, u.role as user_role,
                  u.team_id, u.client_id, u.shift_pattern, u.can_drilldown_timeline,
                  u.totp_enabled, u.must_enroll_mfa, u.status as user_status,
                  t.name as tenant_name, t.ai_reports_enabled
           FROM sessions s
           JOIN shift_users u ON u.user_id = s.user_id AND u.tenant_id = s.tenant_id
           JOIN tenants t ON t.id = s.tenant_id
           WHERE s.token_hash = ? AND s.revoked_at_utc IS NULL AND s.expires_at_utc > ?`,
          tokenHash,
          nowIso
        );
        if (!row || row.user_status === 'disabled') {
          return null;
        }

        await tx.run(
          'UPDATE sessions SET last_seen_utc = ? WHERE id = ?',
          nowIso,
          row.id
        );

        const isDemoSandbox = appConfig.demoModeEnabled && row.tenant_id === 'firm_demo';
        const role = row.user_role as UserRole;
        const totpEnabled = Boolean(row.totp_enabled);
        const mustEnrollMfa = !isDemoSandbox && roleRequiresMfa(role) && !totpEnabled;
        const mfaVerified = Boolean(row.mfa_verified) && !mustEnrollMfa;
        const principalType = row.principal_type === 'client' ? 'client' : 'staff';

        const summary: PublicUserSummary = {
          userId: row.user_id,
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          name: row.user_name,
          email: row.user_email,
          role,
          teamId: row.team_id,
          clientId: row.client_id || null,
          shiftPattern: row.shift_pattern as ShiftPattern,
          canDrilldownTimeline: Boolean(row.can_drilldown_timeline),
          totpEnabled,
          mfaVerified,
          mustEnrollMfa,
          principalType,
          isDemoSandbox,
          aiReportsEnabled: Boolean(row.ai_reports_enabled),
        };

        return {
          mode: 'session',
          principalType,
          sessionId: row.id,
          tenantId: row.tenant_id,
          userId: row.user_id,
          userEmail: row.user_email,
          userName: row.user_name,
          role,
          teamId: row.team_id,
          clientId: row.client_id || null,
          canDrilldownTimeline: Boolean(row.can_drilldown_timeline),
          mfaVerified,
          mustEnrollMfa,
          isDemoSandbox,
          summary,
        };
      }
    );
  }

  public async revokeSessionById(
    tenantId: string,
    userId: string,
    sessionId: string
  ): Promise<boolean> {
    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const res = await tx.run(
        `UPDATE sessions SET revoked_at_utc = ?
         WHERE tenant_id = ? AND user_id = ? AND id = ? AND revoked_at_utc IS NULL`,
        new Date().toISOString(),
        tenantId,
        userId,
        sessionId
      );
      return res.changes > 0;
    });
  }

  public async revokeSessionByRawToken(rawToken: string): Promise<void> {
    const tokenHash = hashOpaqueToken(rawToken);
    await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        await tx.run(
          'UPDATE sessions SET revoked_at_utc = ? WHERE token_hash = ? AND revoked_at_utc IS NULL',
          new Date().toISOString(),
          tokenHash
        );
      }
    );
  }

  public async listSessionsForUser(
    tenantId: string,
    userId: string,
    currentSessionId?: string
  ): Promise<SessionInfo[]> {
    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const nowIso = new Date().toISOString();
      const rows = await tx.all<any>(
        `SELECT id, principal_type, mfa_verified, user_agent, ip_address, created_at_utc, last_seen_utc, expires_at_utc
         FROM sessions
         WHERE tenant_id = ? AND user_id = ? AND revoked_at_utc IS NULL AND expires_at_utc > ?
         ORDER BY last_seen_utc DESC`,
        tenantId,
        userId,
        nowIso
      );
      return rows.map((r) => ({
        id: r.id,
        principalType: r.principal_type === 'client' ? 'client' : 'staff',
        mfaVerified: Boolean(r.mfa_verified),
        userAgent: r.user_agent || null,
        ipAddress: r.ip_address || null,
        createdAtUtc: r.created_at_utc,
        lastSeenUtc: r.last_seen_utc,
        expiresAtUtc: r.expires_at_utc,
        isCurrent: Boolean(currentSessionId && r.id === currentSessionId),
      }));
    });
  }

  public async beginMfaEnrollment(tenantId: string, userId: string) {
    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const u = await tx.get<any>(
        `SELECT u.email, t.name as tenant_name
         FROM shift_users u
         JOIN tenants t ON t.id = u.tenant_id
         WHERE u.tenant_id = ? AND u.user_id = ?`,
        tenantId,
        userId
      );
      if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found');

      const enrollment = await generateTotpEnrollment(u.email, u.tenant_name || 'OnTrack');
      const secretEnc = encryptSecret(enrollment.secretBase32);

      // Persist pending secret encrypted until user confirms 6-digit code
      await tx.run(
        `UPDATE shift_users SET totp_secret_enc = ?, backup_codes_json = ?
         WHERE tenant_id = ? AND user_id = ?`,
        secretEnc,
        JSON.stringify(enrollment.backupCodeHashes),
        tenantId,
        userId
      );

      return {
        otpauthUri: enrollment.otpauthUri,
        qrDataUrl: enrollment.qrDataUrl,
        secretBase32: enrollment.secretBase32,
        backupCodes: enrollment.backupCodes,
      };
    });
  }

  public async confirmMfaEnrollment(
    tenantId: string,
    userId: string,
    code: string,
    sessionId?: string
  ): Promise<boolean> {
    return this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      const u = await tx.get<{ totp_secret_enc: string | null }>(
        'SELECT totp_secret_enc FROM shift_users WHERE tenant_id = ? AND user_id = ?',
        tenantId,
        userId
      );
      if (!u?.totp_secret_enc) {
        throw new HttpError(400, 'MFA_NOT_STARTED', 'MFA enrollment has not been initiated.');
      }
      const secretBase32 = decryptSecret(u.totp_secret_enc);
      if (!verifyTotpCode(secretBase32, code)) {
        throw new HttpError(400, 'INVALID_MFA_CODE', 'Invalid 6-digit authenticator code.');
      }

      await tx.run(
        'UPDATE shift_users SET totp_enabled = 1, must_enroll_mfa = 0 WHERE tenant_id = ? AND user_id = ?',
        tenantId,
        userId
      );
      if (sessionId) {
        await tx.run(
          'UPDATE sessions SET mfa_verified = 1 WHERE tenant_id = ? AND user_id = ? AND id = ?',
          tenantId,
          userId,
          sessionId
        );
      }
      return true;
    });
  }

  public async verifyCurrentSessionMfa(
    tenantId: string,
    userId: string,
    sessionId: string,
    params: { totpCode?: string; backupCode?: string }
  ): Promise<boolean> {
    if (params.backupCode) {
      const ok = await this.consumeBackupCode(tenantId, userId, params.backupCode);
      if (!ok) {
        throw new HttpError(401, 'INVALID_BACKUP_CODE', 'Invalid backup code.');
      }
    } else if (params.totpCode) {
      const row = await this.db.withTenantTransaction({ tenantId, userId }, (tx) =>
        tx.get<{ totp_secret_enc: string | null; totp_enabled: number }>(
          'SELECT totp_secret_enc, totp_enabled FROM shift_users WHERE tenant_id = ? AND user_id = ?',
          tenantId,
          userId
        )
      );
      if (!row?.totp_enabled || !row.totp_secret_enc) {
        throw new HttpError(400, 'MFA_NOT_ENABLED', 'MFA is not enabled for this account.');
      }
      const secret = decryptSecret(row.totp_secret_enc);
      if (!verifyTotpCode(secret, params.totpCode)) {
        throw new HttpError(401, 'INVALID_MFA_CODE', 'Invalid 6-digit authenticator code.');
      }
    } else {
      throw new HttpError(400, 'MFA_CODE_REQUIRED', 'Verification code required.');
    }

    await this.db.withTenantTransaction({ tenantId, userId }, async (tx) => {
      await tx.run(
        'UPDATE sessions SET mfa_verified = 1 WHERE tenant_id = ? AND user_id = ? AND id = ?',
        tenantId,
        userId,
        sessionId
      );
    });
    return true;
  }

  public async createUserInvite(params: {
    tenantId: string;
    invitedByUserId: string;
    email: string;
    name: string;
    role: UserRole;
    teamId: string;
    shiftPattern: ShiftPattern;
    clientId?: string | null;
    canDrilldownTimeline?: boolean;
  }) {
    const cleanEmail = params.email.trim().toLowerCase();
    const { rawToken, tokenHash } = generateOpaqueToken('oti');
    const inviteId = `inv_${crypto.randomBytes(6).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const expiresAtUtc = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    await this.db.withTenantTransaction(
      { tenantId: params.tenantId, userId: params.invitedByUserId },
      async (tx) => {
        const existingUser = await tx.get<{ user_id: string }>(
          'SELECT user_id FROM shift_users WHERE tenant_id = ? AND lower(email) = ?',
          params.tenantId,
          cleanEmail
        );
        if (existingUser) {
          throw new HttpError(409, 'USER_EXISTS', 'A user with this email already exists in this tenant.');
        }

        await tx.run(
          `INSERT INTO user_invites
           (id, tenant_id, email, name, role, team_id, shift_pattern, client_id, can_drilldown_timeline, token_hash, invited_by_user_id, expires_at_utc, accepted_at_utc, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          inviteId,
          params.tenantId,
          cleanEmail,
          params.name.trim(),
          params.role,
          params.teamId,
          params.shiftPattern,
          params.clientId || null,
          params.canDrilldownTimeline ? 1 : 0,
          tokenHash,
          params.invitedByUserId,
          expiresAtUtc,
          nowIso
        );

        await tx.run(
          `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, target_user_id, action, details, created_at_utc)
           VALUES (?, ?, ?, 'admin_it', NULL, 'user.invited', ?, ?)`,
          `aud-${crypto.randomBytes(6).toString('hex')}`,
          params.tenantId,
          params.invitedByUserId,
          `Invited ${cleanEmail} (${params.role})`,
          nowIso
        );
      }
    );

    const inviteUrl = `${appConfig.appUrl.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(rawToken)}`;
    await sendMail({
      to: cleanEmail,
      subject: 'Your OnTrack Workspace Invitation',
      text: `You have been invited to OnTrack. Complete your account setup: ${inviteUrl}`,
      meta: { kind: 'invite', actionUrl: inviteUrl },
    });

    return {
      inviteId,
      email: cleanEmail,
      role: params.role,
      expiresAtUtc,
      inviteToken: rawToken,
      inviteUrl,
    };
  }

  public async listInvites(tenantId: string) {
    return this.db.withTenantTransaction({ tenantId }, async (tx) => {
      const rows = await tx.all<any>(
        `SELECT id, email, name, role, team_id, shift_pattern, client_id, can_drilldown_timeline, expires_at_utc, accepted_at_utc, created_at_utc
         FROM user_invites WHERE tenant_id = ? ORDER BY created_at_utc DESC`,
        tenantId
      );
      return rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role as UserRole,
        teamId: r.team_id,
        shiftPattern: r.shift_pattern as ShiftPattern,
        clientId: r.client_id || null,
        canDrilldownTimeline: Boolean(r.can_drilldown_timeline),
        expiresAtUtc: r.expires_at_utc,
        acceptedAtUtc: r.accepted_at_utc || null,
        createdAtUtc: r.created_at_utc,
      }));
    });
  }

  public async acceptUserInvite(params: {
    token: string;
    password: string;
    name?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    const tokenHash = hashOpaqueToken(params.token.trim());
    const nowIso = new Date().toISOString();
    const passwordHash = await hashPassword(params.password);

    const created = await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        const inv = await tx.get<any>(
          'SELECT * FROM user_invites WHERE token_hash = ?',
          tokenHash
        );
        if (!inv) {
          throw new HttpError(400, 'INVALID_INVITE', 'Invitation token is invalid.');
        }
        if (inv.accepted_at_utc) {
          throw new HttpError(400, 'INVITE_ALREADY_ACCEPTED', 'This invitation has already been accepted.');
        }
        if (inv.expires_at_utc <= nowIso) {
          throw new HttpError(400, 'INVITE_EXPIRED', 'This invitation has expired.');
        }

        const role = inv.role as UserRole;
        const shiftPattern = (inv.shift_pattern as ShiftPattern) || '8-5';
        const startHour = shiftPattern === '5-9' ? 22 : shiftPattern === 'remote' ? 14 : 13;
        const endHour = shiftPattern === '5-9' ? 2 : shiftPattern === 'remote' ? 23 : 22;
        const userId = `u_${crypto.randomBytes(6).toString('hex')}`;
        const mustEnrollMfa = roleRequiresMfa(role) ? 1 : 0;

        await tx.run(
          `INSERT INTO shift_users
           (user_id, tenant_id, name, email, role, team_id, shift_pattern, shift_start_hour_utc, shift_end_hour_utc, on_leave, password_hash, totp_enabled, must_enroll_mfa, can_drilldown_timeline, client_id, status, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, 'active', ?)`,
          userId,
          inv.tenant_id,
          params.name?.trim() || inv.name,
          inv.email,
          role,
          inv.team_id,
          shiftPattern,
          startHour,
          endHour,
          passwordHash,
          mustEnrollMfa,
          inv.can_drilldown_timeline ? 1 : 0,
          inv.client_id || null,
          nowIso
        );

        await tx.run(
          'UPDATE user_invites SET accepted_at_utc = ? WHERE id = ?',
          nowIso,
          inv.id
        );

        const tRow = await tx.get<{ name: string; ai_reports_enabled: number }>(
          'SELECT name, ai_reports_enabled FROM tenants WHERE id = ?',
          inv.tenant_id
        );

        return {
          tenantId: inv.tenant_id,
          tenantName: tRow?.name || inv.tenant_id,
          aiReportsEnabled: Boolean(tRow?.ai_reports_enabled),
          userId,
          name: params.name?.trim() || inv.name,
          email: inv.email,
          role,
          teamId: inv.team_id,
          clientId: inv.client_id || null,
          shiftPattern,
          canDrilldownTimeline: Boolean(inv.can_drilldown_timeline),
          mustEnrollMfa: Boolean(mustEnrollMfa),
        };
      }
    );

    const principalType = created.role === 'client' ? 'client' : 'staff';
    const session = await this.createSessionForUser({
      tenantId: created.tenantId,
      userId: created.userId,
      principalType,
      mfaVerified: !created.mustEnrollMfa,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    return {
      rawToken: session.rawToken,
      sessionId: session.sessionId,
      user: {
        userId: created.userId,
        tenantId: created.tenantId,
        tenantName: created.tenantName,
        name: created.name,
        email: created.email,
        role: created.role,
        teamId: created.teamId,
        clientId: created.clientId,
        shiftPattern: created.shiftPattern,
        canDrilldownTimeline: created.canDrilldownTimeline,
        totpEnabled: false,
        mfaVerified: !created.mustEnrollMfa,
        mustEnrollMfa: created.mustEnrollMfa,
        principalType,
        isDemoSandbox: created.tenantId === 'firm_demo',
        aiReportsEnabled: created.aiReportsEnabled,
      } satisfies PublicUserSummary,
    };
  }

  public async requestPasswordReset(params: { email: string; tenantId?: string }) {
    const cleanEmail = params.email.trim().toLowerCase();
    const nowIso = new Date().toISOString();
    const expiresAtUtc = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const matches = await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        if (params.tenantId) {
          return tx.all<any>(
            "SELECT user_id, tenant_id, email FROM shift_users WHERE tenant_id = ? AND lower(email) = ? AND status = 'active'",
            params.tenantId,
            cleanEmail
          );
        }
        return tx.all<any>(
          "SELECT user_id, tenant_id, email FROM shift_users WHERE lower(email) = ? AND status = 'active'",
          cleanEmail
        );
      }
    );

    let lastResetToken: string | undefined;
    for (const u of matches) {
      const { rawToken, tokenHash } = generateOpaqueToken('otp');
      const resetId = `rst_${crypto.randomBytes(6).toString('hex')}`;
      await this.db.withTenantTransaction(
        { tenantId: u.tenant_id, userId: u.user_id },
        async (tx) => {
          await tx.run(
            `INSERT INTO password_resets (id, tenant_id, user_id, token_hash, expires_at_utc, used_at_utc, created_at_utc)
             VALUES (?, ?, ?, ?, ?, NULL, ?)`,
            resetId,
            u.tenant_id,
            u.user_id,
            tokenHash,
            expiresAtUtc,
            nowIso
          );
        }
      );
      const resetUrl = `${appConfig.appUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(rawToken)}`;
      await sendMail({
        to: u.email,
        subject: 'OnTrack Password Reset',
        text: `Reset your OnTrack password using this link (valid for 1 hour): ${resetUrl}`,
        meta: { kind: 'password_reset', actionUrl: resetUrl },
      });
      lastResetToken = rawToken;
    }

    return { accepted: true, devToken: appConfig.isTest ? lastResetToken : undefined };
  }

  public async completePasswordReset(params: {
    token: string;
    newPassword: string;
  }): Promise<void> {
    const tokenHash = hashOpaqueToken(params.token.trim());
    const nowIso = new Date().toISOString();
    const newHash = await hashPassword(params.newPassword);

    await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        const rst = await tx.get<any>(
          'SELECT * FROM password_resets WHERE token_hash = ?',
          tokenHash
        );
        if (!rst || rst.used_at_utc || rst.expires_at_utc <= nowIso) {
          throw new HttpError(400, 'INVALID_RESET_TOKEN', 'Password reset token is invalid or expired.');
        }

        await tx.run(
          'UPDATE shift_users SET password_hash = ? WHERE tenant_id = ? AND user_id = ?',
          newHash,
          rst.tenant_id,
          rst.user_id
        );
        await tx.run(
          'UPDATE password_resets SET used_at_utc = ? WHERE id = ?',
          nowIso,
          rst.id
        );
        // Revoke all active sessions on password reset
        await tx.run(
          'UPDATE sessions SET revoked_at_utc = ? WHERE tenant_id = ? AND user_id = ? AND revoked_at_utc IS NULL',
          nowIso,
          rst.tenant_id,
          rst.user_id
        );
      }
    );
  }

  public async getTenantOidcConfig(tenantId: string): Promise<TenantOidcConfig | null> {
    const row = await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      (tx) =>
        tx.get<{ oidc_config_json: string | null }>(
          'SELECT oidc_config_json FROM tenants WHERE id = ?',
          tenantId
        )
    );
    if (!row?.oidc_config_json) return null;
    try {
      return JSON.parse(row.oidc_config_json) as TenantOidcConfig;
    } catch {
      return null;
    }
  }

  public async updateTenantOidcConfig(
    tenantId: string,
    actorUserId: string,
    input: {
      enabled: boolean;
      issuerUrl: string;
      clientId: string;
      clientSecret?: string;
      allowedDomains?: string[];
    }
  ) {
    const existing = await this.getTenantOidcConfig(tenantId);
    const serialized = serializeOidcConfig({
      ...input,
      existingEnc: existing?.clientSecretEnc,
    });

    await this.db.withTenantTransaction(
      { tenantId: '__system__', bypassRls: true },
      async (tx) => {
        await tx.run(
          'UPDATE tenants SET oidc_config_json = ? WHERE id = ?',
          JSON.stringify(serialized),
          tenantId
        );
      }
    );
    await this.db.withTenantTransaction({ tenantId, userId: actorUserId }, async (tx) => {
      await tx.run(
        `INSERT INTO audit_logs (id, tenant_id, actor_user_id, actor_role, target_user_id, action, details, created_at_utc)
         VALUES (?, ?, ?, 'admin_it', NULL, 'auth.oidc_updated', ?, ?)`,
        `aud-${crypto.randomBytes(6).toString('hex')}`,
        tenantId,
        actorUserId,
        `Updated OIDC SSO configuration (enabled=${serialized.enabled})`,
        new Date().toISOString()
      );
    });

    return {
      enabled: serialized.enabled,
      issuerUrl: serialized.issuerUrl,
      clientId: serialized.clientId,
      hasClientSecret: Boolean(serialized.clientSecretEnc),
      allowedDomains: serialized.allowedDomains || [],
    };
  }

  public async authenticateOidcUser(params: {
    tenantId: string;
    email: string;
    name: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    const cleanEmail = params.email.trim().toLowerCase();
    const userRow = await this.db.withTenantTransaction(
      { tenantId: params.tenantId },
      (tx) =>
        tx.get<any>(
          `SELECT u.*, t.name as tenant_name, t.ai_reports_enabled
           FROM shift_users u
           JOIN tenants t ON t.id = u.tenant_id
           WHERE u.tenant_id = ? AND lower(u.email) = ? AND u.status = 'active'`,
          params.tenantId,
          cleanEmail
        )
    );
    if (!userRow) {
      throw new HttpError(
        403,
        'INVITE_REQUIRED',
        'No active OnTrack user exists for this email. Ask your firm Admin to invite you first.'
      );
    }

    const role = userRow.role as UserRole;
    const principalType = role === 'client' ? 'client' : 'staff';
    const totpEnabled = Boolean(userRow.totp_enabled);
    const mustEnrollMfa = roleRequiresMfa(role) && !totpEnabled;

    const session = await this.createSessionForUser({
      tenantId: userRow.tenant_id,
      userId: userRow.user_id,
      principalType,
      mfaVerified: !totpEnabled && !mustEnrollMfa,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    return {
      rawToken: session.rawToken,
      sessionId: session.sessionId,
      user: {
        userId: userRow.user_id,
        tenantId: userRow.tenant_id,
        tenantName: userRow.tenant_name,
        name: userRow.name,
        email: userRow.email,
        role,
        teamId: userRow.team_id,
        clientId: userRow.client_id || null,
        shiftPattern: userRow.shift_pattern as ShiftPattern,
        canDrilldownTimeline: Boolean(userRow.can_drilldown_timeline),
        totpEnabled,
        mfaVerified: !totpEnabled && !mustEnrollMfa,
        mustEnrollMfa,
        principalType,
        isDemoSandbox: userRow.tenant_id === 'firm_demo',
        aiReportsEnabled: Boolean(userRow.ai_reports_enabled),
      } satisfies PublicUserSummary,
    };
  }

  public async listDemoAccounts() {
    return this.db.withTenantTransaction(
      { tenantId: 'firm_demo', bypassRls: true },
      async (tx) => {
        const rows = await tx.all<any>(
          `SELECT user_id, name, email, role, team_id, shift_pattern, client_id, can_drilldown_timeline
           FROM shift_users
           WHERE tenant_id = 'firm_demo' AND status = 'active'
           ORDER BY CASE role
             WHEN 'accountant' THEN 1
             WHEN 'team_lead' THEN 2
             WHEN 'line_manager' THEN 3
             WHEN 'executive' THEN 4
             WHEN 'client' THEN 5
             WHEN 'admin_it' THEN 6
             ELSE 7
           END, user_id ASC`
        );
        return rows.map((r) => ({
          userId: String(r.user_id),
          name: String(r.name),
          email: String(r.email),
          role: r.role as UserRole,
          teamId: String(r.team_id),
          shiftPattern: (r.shift_pattern as ShiftPattern) || '8-5',
          clientId: r.client_id ? String(r.client_id) : null,
          canDrilldownTimeline: Boolean(r.can_drilldown_timeline),
        }));
      }
    );
  }

  public async authenticateDemoAccount(params: {
    userId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<{
    rawToken: string;
    sessionId: string;
    user: PublicUserSummary;
  }> {
    const userRow = await this.db.withTenantTransaction(
      { tenantId: 'firm_demo', bypassRls: true },
      (tx) =>
        tx.get<any>(
          `SELECT u.*, t.name as tenant_name, t.ai_reports_enabled
           FROM shift_users u
           JOIN tenants t ON t.id = u.tenant_id
           WHERE u.tenant_id = 'firm_demo' AND u.user_id = ? AND u.status = 'active'`,
          params.userId
        )
    );

    if (!userRow) {
      throw new HttpError(404, 'DEMO_USER_NOT_FOUND', 'Demo account not found.');
    }

    const role = userRow.role as UserRole;
    const principalType: 'staff' | 'client' = role === 'client' ? 'client' : 'staff';
    const session = await this.createSessionForUser({
      tenantId: 'firm_demo',
      userId: userRow.user_id,
      principalType,
      mfaVerified: true,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });

    return {
      rawToken: session.rawToken,
      sessionId: session.sessionId,
      user: {
        userId: userRow.user_id,
        tenantId: userRow.tenant_id,
        tenantName: userRow.tenant_name,
        name: userRow.name,
        email: userRow.email,
        role,
        teamId: userRow.team_id,
        clientId: userRow.client_id || null,
        shiftPattern: userRow.shift_pattern as ShiftPattern,
        canDrilldownTimeline: Boolean(userRow.can_drilldown_timeline),
        totpEnabled: Boolean(userRow.totp_enabled),
        mfaVerified: true,
        mustEnrollMfa: false,
        principalType,
        isDemoSandbox: true,
        aiReportsEnabled: Boolean(userRow.ai_reports_enabled),
      } satisfies PublicUserSummary,
    };
  }
}
