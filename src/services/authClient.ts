import { ShiftPattern, UserRole } from '../engine/types';

export interface AuthUser {
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
  mustSetPassword?: boolean;
  principalType: 'staff' | 'client' | 'demo';
  isDemoSandbox: boolean;
  aiReportsEnabled: boolean;
}

export interface StaffProvisionBundle {
  user: {
    userId: string;
    tenantId: string;
    tenantName: string;
    name: string;
    email: string;
    role: UserRole;
    teamId?: string;
    shiftPattern?: ShiftPattern;
  };
  accountAccessKey: string;
  installationKey: string;
  appUrl: string;
  expiresAtUtc: string;
  credentialsText: string;
  credentialsFilename: string;
  deviceTokenRecord: {
    tokenId: string;
    deviceId: string;
    label: string;
    prefix: string;
  };
}

export interface BootstrapStatus {
  needsInitialSetup: boolean;
  demoModeEnabled: boolean;
  hasOidcTenants: boolean;
}

export interface DemoAccountSummary {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  teamId: string;
  shiftPattern: ShiftPattern;
  clientId: string | null;
  canDrilldownTimeline: boolean;
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

async function parseJsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export async function fetchBootstrapStatus(): Promise<BootstrapStatus> {
  const res = await fetch('/api/auth/bootstrap-status', {
    credentials: 'include',
  });
  return parseJsonOrThrow(res);
}

export async function fetchAuthSession(): Promise<{
  authenticated: boolean;
  user: AuthUser | null;
}> {
  const res = await fetch('/api/auth/me', {
    credentials: 'include',
  });
  return parseJsonOrThrow(res);
}

export async function bootstrapFirmAdmin(payload: {
  firmName: string;
  name: string;
  email: string;
  password: string;
}): Promise<{ user: AuthUser }> {
  const res = await fetch('/api/auth/bootstrap', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow(res);
}

export async function loginWithPassword(payload: {
  email: string;
  password: string;
  totpCode?: string;
  backupCode?: string;
  isClientPortal?: boolean;
}): Promise<{ user: AuthUser }> {
  const endpoint = payload.isClientPortal
    ? '/api/auth/client-login'
    : '/api/auth/login';
  const res = await fetch(endpoint, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: payload.email,
      password: payload.password,
      totpCode: payload.totpCode,
      backupCode: payload.backupCode,
    }),
  });
  return parseJsonOrThrow(res);
}

export async function loginWithAccessKeyApi(payload: {
  email: string;
  accessKey: string;
  tenantSlugOrId?: string;
}): Promise<{ user: AuthUser }> {
  const res = await fetch('/api/auth/key-login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow(res);
}

export async function completeOnboardingPasswordApi(
  newPassword: string
): Promise<{ ok: boolean; user: AuthUser | null }> {
  const res = await fetch('/api/auth/onboarding/set-password', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  });
  return parseJsonOrThrow(res);
}

export async function provisionStaffUserWithKeysApi(payload: {
  email: string;
  name: string;
  role: UserRole;
  teamId?: string;
  shiftPattern?: ShiftPattern;
  clientId?: string | null;
  canDrilldownTimeline?: boolean;
  workstationLabel?: string;
  appUrl?: string;
}): Promise<StaffProvisionBundle> {
  const res = await fetch('/api/auth/provision-user', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow(res);
}

export async function rotateStaffUserKeysApi(
  userId: string,
  payload?: { workstationLabel?: string; appUrl?: string }
): Promise<StaffProvisionBundle> {
  const res = await fetch(
    `/api/auth/provision-user/${encodeURIComponent(userId)}/rotate-key`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }
  );
  return parseJsonOrThrow(res);
}

export async function fetchDemoAccounts(): Promise<{
  demoModeEnabled: boolean;
  accounts: DemoAccountSummary[];
}> {
  const res = await fetch('/api/auth/demo-accounts', {
    credentials: 'include',
  });
  return parseJsonOrThrow(res);
}

export async function loginWithDemoAccount(
  userId: string
): Promise<{ user: AuthUser }> {
  const res = await fetch('/api/auth/demo-login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  return parseJsonOrThrow(res);
}

export async function logoutSession(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });
}

export async function beginMfaEnrollment(): Promise<{
  qrDataUrl: string;
  secretBase32: string;
  backupCodes: string[];
}> {
  const res = await fetch('/api/auth/mfa/enroll', {
    method: 'POST',
    credentials: 'include',
  });
  return parseJsonOrThrow(res);
}

export async function confirmMfaEnrollment(code: string): Promise<{
  ok: boolean;
  user: AuthUser | null;
}> {
  const res = await fetch('/api/auth/mfa/confirm', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return parseJsonOrThrow(res);
}

export async function verifyMfaSessionCode(payload: {
  totpCode?: string;
  backupCode?: string;
}): Promise<{ ok: boolean; user: AuthUser | null }> {
  const res = await fetch('/api/auth/mfa/verify', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow(res);
}

export async function listActiveSessions(): Promise<{ sessions: SessionInfo[] }> {
  const res = await fetch('/api/auth/sessions', {
    credentials: 'include',
  });
  return parseJsonOrThrow(res);
}

export async function revokeActiveSession(sessionId: string): Promise<{
  ok: boolean;
  revokedCurrent: boolean;
}> {
  const res = await fetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  return parseJsonOrThrow(res);
}
