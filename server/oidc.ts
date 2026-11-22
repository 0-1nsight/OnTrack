import * as oidc from 'openid-client';
import { decryptSecret, encryptSecret } from './auth.ts';

export interface TenantOidcConfig {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecretEnc: string;
  autoProvisionRole?: 'accountant' | 'team_lead';
  allowedDomains?: string[];
}

export interface PendingOidcState {
  tenantId: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  createdAtMs: number;
}

const pendingOidcStates = new Map<string, PendingOidcState>();

export function serializeOidcConfig(input: {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  existingEnc?: string;
  allowedDomains?: string[];
}): TenantOidcConfig {
  const clientSecretEnc = input.clientSecret
    ? encryptSecret(input.clientSecret)
    : input.existingEnc || '';
  return {
    enabled: input.enabled,
    issuerUrl: input.issuerUrl.trim(),
    clientId: input.clientId.trim(),
    clientSecretEnc,
    allowedDomains: input.allowedDomains?.map((d) => d.trim().toLowerCase()).filter(Boolean),
  };
}

export async function beginOidcLogin(params: {
  tenantId: string;
  cfg: TenantOidcConfig;
  redirectUri: string;
}): Promise<string> {
  if (!params.cfg.enabled) {
    throw new Error('OIDC SSO is not enabled for this tenant');
  }
  const clientSecret = params.cfg.clientSecretEnc
    ? decryptSecret(params.cfg.clientSecretEnc)
    : undefined;

  const config = await oidc.discovery(
    new URL(params.cfg.issuerUrl),
    params.cfg.clientId,
    clientSecret
  );
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();

  pendingOidcStates.set(state, {
    tenantId: params.tenantId,
    codeVerifier,
    nonce,
    redirectUri: params.redirectUri,
    createdAtMs: Date.now(),
  });

  // Clean expired pending states (> 10 minutes)
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pendingOidcStates.entries()) {
    if (v.createdAtMs < cutoff) pendingOidcStates.delete(k);
  }

  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: params.redirectUri,
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return authUrl.href;
}

export async function completeOidcCallback(params: {
  cfg: TenantOidcConfig;
  callbackUrl: URL;
  state: string;
}): Promise<{ email: string; name: string; tenantId: string }> {
  const pending = pendingOidcStates.get(params.state);
  if (!pending) {
    throw new Error('Invalid or expired OIDC state parameter');
  }
  pendingOidcStates.delete(params.state);

  const clientSecret = params.cfg.clientSecretEnc
    ? decryptSecret(params.cfg.clientSecretEnc)
    : undefined;

  const config = await oidc.discovery(
    new URL(params.cfg.issuerUrl),
    params.cfg.clientId,
    clientSecret
  );

  const tokens = await oidc.authorizationCodeGrant(config, params.callbackUrl, {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: params.state,
    expectedNonce: pending.nonce,
  });

  const claims = tokens.claims();
  const email = claims?.email ? String(claims.email).toLowerCase() : '';
  const name = claims?.name ? String(claims.name) : email.split('@')[0];
  if (!email) {
    throw new Error('OIDC provider did not return an email claim');
  }

  if (
    params.cfg.allowedDomains &&
    params.cfg.allowedDomains.length > 0 &&
    !params.cfg.allowedDomains.some((dom) => email.endsWith(`@${dom}`))
  ) {
    throw new Error('Email domain is not permitted by tenant OIDC policy');
  }

  return { email, name, tenantId: pending.tenantId };
}
