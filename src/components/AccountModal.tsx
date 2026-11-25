import React, { useState, useEffect } from 'react';
import {
  X,
  LogIn,
  LogOut,
  ShieldCheck,
  Building2,
  Check,
  AlertTriangle,
  Download,
  SlidersHorizontal,
  UserCircle2,
  KeyRound,
  Trash2,
} from 'lucide-react';
import {
  AuthUser,
  DemoAccountSummary,
  SessionInfo,
  beginMfaEnrollment,
  completeOnboardingPasswordApi,
  confirmMfaEnrollment,
  listActiveSessions,
  revokeActiveSession,
  verifyMfaSessionCode,
} from '../services/authClient';
import { UserProfile } from '../types';
import { getRolePolicy } from '../utils/roleConfig';

interface AccountModalProps {
  isOpen: boolean;
  user: AuthUser | null;
  userProfile: UserProfile | null;
  authReady: boolean;
  needsInitialSetup: boolean;
  demoModeEnabled?: boolean;
  demoAccounts?: DemoAccountSummary[];
  authError: string | null;
  onLogin: (payload: {
    email: string;
    password: string;
    totpCode?: string;
    isClientPortal?: boolean;
  }) => Promise<void>;
  onKeyLogin?: (payload: {
    email: string;
    accessKey: string;
  }) => Promise<void>;
  onDemoLogin?: (userId: string) => Promise<void>;
  onBootstrapFirm: (payload: {
    firmName: string;
    name: string;
    email: string;
    password: string;
  }) => Promise<void>;
  onSignOut: () => Promise<void>;
  onSaveProfile: (updates: {
    displayName: string;
    jobTitle: string;
    hourlyRate: number;
    currency: string;
  }) => Promise<void>;
  onRefreshSession: () => Promise<AuthUser | null>;
  onOnboardingComplete?: (freshUser?: AuthUser | null) => void;
  onExportJson: () => void;
  onOpenPreferences: () => void;
  onClose: () => void;
}

export const AccountModal: React.FC<AccountModalProps> = ({
  isOpen,
  user,
  userProfile,
  authReady,
  needsInitialSetup,
  demoModeEnabled = false,
  demoAccounts = [],
  authError,
  onLogin,
  onKeyLogin,
  onDemoLogin,
  onBootstrapFirm,
  onSignOut,
  onSaveProfile,
  onRefreshSession,
  onOnboardingComplete,
  onExportJson,
  onOpenPreferences,
  onClose,
}) => {
  const initialQuery =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const wantsKeyLogin = initialQuery.get('signin') === 'key';
  const prefillEmail = initialQuery.get('email') || '';

  const [modeOverride, setModeOverride] = useState<'login' | 'setup' | null>(
    wantsKeyLogin ? 'login' : null
  );
  const mode: 'login' | 'setup' =
    modeOverride ?? (needsInitialSetup ? 'setup' : 'login');
  const setMode = (next: 'login' | 'setup') => setModeOverride(next);
  const [loginMethod, setLoginMethod] = useState<'password' | 'key'>(
    wantsKeyLogin ? 'key' : 'password'
  );
  const [firmName, setFirmName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState(prefillEmail);
  const [password, setPassword] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [isClientPortal, setIsClientPortal] = useState(false);

  // Onboarding Step 1 (Create Password)
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSettingPassword, setIsSettingPassword] = useState(false);

  const [displayName, setDisplayName] = useState(
    () => userProfile?.displayName || user?.name || user?.email?.split('@')[0] || ''
  );
  const [jobTitle, setJobTitle] = useState(
    () => userProfile?.jobTitle || user?.role || ''
  );
  const [hourlyRate, setHourlyRate] = useState(
    () => String(userProfile?.hourlyRate ?? 150)
  );
  const [currency, setCurrency] = useState(
    () => userProfile?.currency || 'USD'
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // MFA enrollment & active sessions state
  const [mfaEnrollment, setMfaEnrollment] = useState<{
    qrDataUrl: string;
    secretBase32: string;
    backupCodes: string[];
  } | null>(null);
  const [mfaConfirmCode, setMfaConfirmCode] = useState('');
  const [mfaVerifyCode, setMfaVerifyCode] = useState('');
  const [isVerifyingMfa, setIsVerifyingMfa] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    if (!isOpen || !user) return;
    let active = true;
    listActiveSessions()
      .then((res) => {
        if (active) setSessions(res.sessions || []);
      })
      .catch(() => {
        if (active) setSessions([]);
      });
    return () => {
      active = false;
    };
  }, [isOpen, user]);

  // Auto-begin TOTP enrollment when user reaches onboarding Step 2 (password set, MFA pending)
  useEffect(() => {
    if (
      !isOpen ||
      !user ||
      user.mustSetPassword ||
      user.mfaVerified ||
      user.totpEnabled ||
      mfaEnrollment
    ) {
      return;
    }
    let active = true;
    beginMfaEnrollment()
      .then((data) => {
        if (active) setMfaEnrollment(data);
      })
      .catch((err: any) => {
        if (active) setLocalError(err?.message || 'Unable to start MFA enrollment.');
      });
    return () => {
      active = false;
    };
  }, [isOpen, user, mfaEnrollment]);

  if (!isOpen) return null;

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSigningIn(true);
    setFeedback(null);
    setLocalError(null);
    try {
      if (mode === 'setup') {
        await onBootstrapFirm({
          firmName: firmName.trim(),
          name: fullName.trim(),
          email: email.trim(),
          password,
        });
        setFeedback('Firm created and signed in.');
      } else if (loginMethod === 'key' && onKeyLogin) {
        await onKeyLogin({
          email: email.trim(),
          accessKey: accessKey.trim(),
        });
        setFeedback('Access key verified.');
      } else {
        await onLogin({
          email: email.trim(),
          password,
          totpCode: totpCode.trim() || undefined,
          isClientPortal,
        });
        setFeedback('Signed in to OnTrack.');
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Authentication failed.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleOnboardingPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setFeedback(null);
    if (newPassword.length < 10) {
      setLocalError('Password must be at least 10 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError('Passwords do not match.');
      return;
    }
    setIsSettingPassword(true);
    try {
      await completeOnboardingPasswordApi(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      await onRefreshSession();
      setFeedback('Password created. Now scan the authenticator QR code to complete MFA setup.');
    } catch (err: any) {
      setLocalError(err?.message || 'Unable to set password.');
    } finally {
      setIsSettingPassword(false);
    }
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setFeedback(null);
    try {
      await onSaveProfile({
        displayName: displayName.trim() || 'OnTrack User',
        jobTitle: jobTitle.trim(),
        hourlyRate: Math.max(0, Number(hourlyRate) || 0),
        currency,
      });
      setFeedback('Local profile & billing preferences saved.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleStartMfa = async () => {
    setLocalError(null);
    try {
      const data = await beginMfaEnrollment();
      setMfaEnrollment(data);
    } catch (err: any) {
      setLocalError(err?.message || 'Failed to begin TOTP setup.');
    }
  };

  const handleConfirmMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const wasOnboarding = Boolean(user && !user.mfaVerified);
    try {
      const res = await confirmMfaEnrollment(mfaConfirmCode.trim());
      setMfaEnrollment(null);
      setMfaConfirmCode('');
      const freshUser = (await onRefreshSession()) ?? res.user ?? null;
      setFeedback('Two-factor authentication verified and enabled.');
      if (wasOnboarding && onOnboardingComplete) {
        onOnboardingComplete(freshUser);
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Invalid TOTP verification code.');
    }
  };

  const handleVerifyExistingMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    const raw = mfaVerifyCode.trim();
    if (!raw) {
      setLocalError('Enter your 6-digit authenticator code or backup code.');
      return;
    }
    setIsVerifyingMfa(true);
    try {
      const isTotpDigits = /^\d{6}$/.test(raw);
      const res = await verifyMfaSessionCode(
        isTotpDigits ? { totpCode: raw } : { backupCode: raw }
      );
      setMfaVerifyCode('');
      const freshUser = (await onRefreshSession()) ?? res.user ?? null;
      setFeedback('Two-factor authentication verified.');
      if (onOnboardingComplete) {
        onOnboardingComplete(freshUser);
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Invalid MFA verification code.');
    } finally {
      setIsVerifyingMfa(false);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    try {
      const res = await revokeActiveSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      if (res.revokedCurrent) {
        await onSignOut();
      }
    } catch (err: any) {
      setLocalError(err?.message || 'Unable to revoke session.');
    }
  };

  const initials = (
    userProfile?.displayName ||
    user?.name ||
    user?.email ||
    'OT'
  )
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');

  const displayError = localError || authError;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <UserCircle2 className="w-5 h-5 text-indigo-600" />
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {!user
                ? 'Sign In to OnTrack'
                : user.mustSetPassword || !user.mfaVerified
                  ? 'Complete Account Onboarding'
                  : 'Account & Security Settings'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {displayError && (
          <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{displayError}</span>
          </div>
        )}

        {!authReady ? (
          <div className="py-8 text-center text-xs text-slate-500">
            Checking authentication session...
          </div>
        ) : !user ? (
          <div className="space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm text-slate-900 dark:text-white">
                {mode === 'setup' ? 'First-Run Firm Setup' : 'Firm & Staff Sign In'}
              </span>
              {needsInitialSetup && (
                <button
                  type="button"
                  onClick={() => {
                    setLocalError(null);
                    setFeedback(null);
                    setMode(mode === 'setup' ? 'login' : 'setup');
                  }}
                  className="text-indigo-600 dark:text-indigo-400 font-semibold hover:underline cursor-pointer"
                >
                  {mode === 'setup' ? 'Switch to Sign In' : 'Create Initial Firm'}
                </button>
              )}
            </div>

            {mode === 'login' && onKeyLogin && (
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                <button
                  type="button"
                  onClick={() => {
                    setLocalError(null);
                    setFeedback(null);
                    setLoginMethod('password');
                  }}
                  className={`py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
                    loginMethod === 'password'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  Password
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLocalError(null);
                    setFeedback(null);
                    setLoginMethod('key');
                  }}
                  className={`py-1.5 rounded-md font-semibold transition-colors cursor-pointer ${
                    loginMethod === 'key'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  Access Key
                </button>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-3">
              {mode === 'setup' && (
                <>
                  <div>
                    <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                      Firm / Organization Name
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      value={firmName}
                      onChange={(e) => setFirmName(e.target.value)}
                      placeholder="Apex Chartered Accountants"
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                      Admin Full Name
                    </label>
                    <input
                      type="text"
                      required
                      minLength={2}
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Alex Morgan"
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@firm.example"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                />
              </div>

              {mode === 'login' && loginMethod === 'key' ? (
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Account Access Key
                  </label>
                  <input
                    type="text"
                    required
                    minLength={12}
                    value={accessKey}
                    onChange={(e) => setAccessKey(e.target.value)}
                    placeholder="ontrack_key_..."
                    className="w-full px-3 py-2 font-mono bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
              ) : (
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    minLength={mode === 'setup' ? 10 : 1}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'setup' ? 'Minimum 10 characters' : '••••••••••••'}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
              )}

              {mode === 'login' && loginMethod === 'password' && (
                <div className="grid grid-cols-2 gap-2 items-center">
                  <input
                    type="text"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    placeholder="MFA code (optional)"
                    className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white font-mono"
                  />
                  <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isClientPortal}
                      onChange={(e) => setIsClientPortal(e.target.checked)}
                    />
                    <span>Client Portal login</span>
                  </label>
                </div>
              )}

              <button
                type="submit"
                disabled={isSigningIn}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg cursor-pointer transition-colors"
              >
                {mode === 'setup' ? <Building2 className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
                <span>
                  {isSigningIn
                    ? 'Authenticating...'
                    : mode === 'setup'
                      ? 'Create Firm & Sign In'
                      : loginMethod === 'key'
                        ? 'Verify Key & Continue Setup'
                        : 'Sign In'}
                </span>
              </button>
            </form>

            {demoModeEnabled && demoAccounts.length > 0 && onDemoLogin && mode === 'login' && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between font-semibold text-slate-700 dark:text-slate-300">
                  <span>Quick Demo Accounts by Role &amp; Shift</span>
                  <span className="font-mono text-[11px] text-indigo-600 dark:text-indigo-400">
                    {demoAccounts.length} available
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-44 overflow-y-auto">
                  {demoAccounts.map((acc) => (
                    <button
                      key={acc.userId}
                      type="button"
                      disabled={isSigningIn}
                      onClick={async () => {
                        setIsSigningIn(true);
                        setLocalError(null);
                        try {
                          await onDemoLogin(acc.userId);
                          onClose();
                        } catch (err: any) {
                          setLocalError(err?.message || 'Demo sign-in failed.');
                        } finally {
                          setIsSigningIn(false);
                        }
                      }}
                      className="text-left px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/30 cursor-pointer disabled:opacity-50"
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-slate-900 dark:text-white truncate">
                          {acc.name.split(' (')[0]}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 shrink-0">
                          {getRolePolicy(acc.role).shortLabel}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                        {acc.email} · {acc.shiftPattern}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-slate-500">
              <span>Currently in Local Browser Mode</span>
              <button
                type="button"
                onClick={onClose}
                className="font-semibold text-slate-700 dark:text-slate-300 hover:underline cursor-pointer"
              >
                Continue Locally
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-5 text-xs">
            {/* Identity Summary */}
            <div className="flex items-center justify-between gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-11 h-11 rounded-full bg-indigo-600 text-white font-display font-bold text-sm flex items-center justify-center shrink-0">
                  {initials}
                </div>
                <div className="min-w-0">
                  <div className="font-display text-sm font-bold text-slate-900 dark:text-white truncate">
                    {userProfile?.displayName || user.name}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400 truncate">
                    {user.email} · {user.role}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-0.5 truncate">
                    Firm: {user.tenantName} ({user.tenantId})
                  </div>
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>{user.mfaVerified ? 'MFA Verified' : 'Session Active'}</span>
                </div>
              </div>
            </div>

            {demoModeEnabled && user.isDemoSandbox && demoAccounts.length > 0 && onDemoLogin && (
              <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    Switch Demo Role Account
                  </span>
                  <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                    Shift: {user.shiftPattern}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-36 overflow-y-auto">
                  {demoAccounts.map((acc) => {
                    const isCurrent = acc.userId === user.userId;
                    return (
                      <button
                        key={acc.userId}
                        type="button"
                        disabled={isSigningIn || isCurrent}
                        onClick={async () => {
                          setIsSigningIn(true);
                          setLocalError(null);
                          try {
                            await onDemoLogin(acc.userId);
                            onClose();
                          } catch (err: any) {
                            setLocalError(err?.message || 'Unable to switch demo account.');
                          } finally {
                            setIsSigningIn(false);
                          }
                        }}
                        className={`text-left px-2.5 py-1.5 rounded border text-[11px] transition-colors cursor-pointer disabled:cursor-default ${
                          isCurrent
                            ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-800 dark:text-indigo-200'
                            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-indigo-400'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-semibold truncate">{acc.name.split(' (')[0]}</span>
                          <span className="font-mono text-[10px] text-indigo-600 dark:text-indigo-400 shrink-0">
                            {getRolePolicy(acc.role).shortLabel}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400 truncate">
                          {acc.email} · {acc.shiftPattern}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Guided Step 1: Create Personal Password (when user logged in via Access Key) */}
            {user.mustSetPassword ? (
              <div className="p-4 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-display text-sm font-bold text-indigo-950 dark:text-indigo-100">
                    Step 1 of 2 · Create Your Password
                  </div>
                  <span className="font-mono text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 tabular-nums">
                    1 / 2
                  </span>
                </div>
                <p className="text-[11px] text-indigo-900/80 dark:text-indigo-200/80">
                  Your email and access key were verified. Choose a personal password (at least 10 characters), then you will set up your 2FA Authenticator.
                </p>
                <form onSubmit={handleOnboardingPasswordSubmit} className="space-y-2.5">
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      New Password (min 10 characters)
                    </label>
                    <input
                      type="password"
                      required
                      minLength={10}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Enter a strong personal password"
                      className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Confirm Password
                    </label>
                    <input
                      type="password"
                      required
                      minLength={10}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter your password"
                      className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isSettingPassword}
                    className="w-full px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg cursor-pointer"
                  >
                    {isSettingPassword ? 'Saving Password...' : 'Save Password & Continue to 2FA Setup'}
                  </button>
                </form>
              </div>
            ) : !user.mfaVerified && user.totpEnabled ? (
              <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 space-y-3">
                <div className="font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Step 2 · Verify Authenticator MFA</span>
                </div>
                <p className="text-[11px] text-amber-900/80 dark:text-amber-200/80">
                  Enter the 6-digit code from your authenticator app (or a recovery backup code) to unlock your live workspace timeline.
                </p>
                <form onSubmit={handleVerifyExistingMfa} className="flex items-center gap-2">
                  <input
                    type="text"
                    required
                    value={mfaVerifyCode}
                    onChange={(e) => setMfaVerifyCode(e.target.value)}
                    placeholder="6-digit TOTP or backup code"
                    className="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded font-mono"
                  />
                  <button
                    type="submit"
                    disabled={isVerifyingMfa}
                    className="px-3 py-1.5 font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 rounded cursor-pointer"
                  >
                    {isVerifyingMfa ? 'Verifying...' : 'Verify & Open Workspace'}
                  </button>
                </form>
              </div>
            ) : (!user.totpEnabled || user.mustEnrollMfa) ? (
              <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>
                      {!user.mfaVerified
                        ? 'Step 2 of 2 · Set Up Authenticator MFA'
                        : 'Enable Two-Factor Authentication (TOTP)'}
                    </span>
                  </div>
                  {!mfaEnrollment && (
                    <button
                      type="button"
                      onClick={handleStartMfa}
                      className="px-2.5 py-1 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer"
                    >
                      Setup TOTP
                    </button>
                  )}
                </div>

                {mfaEnrollment && (
                  <form onSubmit={handleConfirmMfa} className="space-y-3 pt-1">
                    <div className="flex flex-col sm:flex-row gap-3 items-center">
                      <img
                        src={mfaEnrollment.qrDataUrl}
                        alt="TOTP QR Code"
                        className="w-28 h-28 rounded border border-slate-200 bg-white p-1"
                      />
                      <div className="space-y-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                        <div>Scan with your authenticator app or enter secret:</div>
                        <div className="font-mono bg-white dark:bg-slate-900 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 break-all">
                          {mfaEnrollment.secretBase32}
                        </div>
                        <div className="text-slate-500">
                          Backup codes: {mfaEnrollment.backupCodes.slice(0, 4).join(', ')}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        required
                        value={mfaConfirmCode}
                        onChange={(e) => setMfaConfirmCode(e.target.value)}
                        placeholder="Enter 6-digit code"
                        className="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded font-mono"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded cursor-pointer"
                      >
                        Verify &amp; Activate Account
                      </button>
                    </div>
                  </form>
                )}
              </div>
            ) : null}

            {/* Editable Account Profile & Billing Settings */}
            <form onSubmit={handleProfileSubmit} className="space-y-3">
              <div className="font-semibold text-slate-900 dark:text-white">
                Workspace Profile &amp; Billable Defaults
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Role / Title
                  </label>
                  <input
                    type="text"
                    maxLength={100}
                    value={jobTitle}
                    onChange={(e) => setJobTitle(e.target.value)}
                    placeholder="e.g., Senior Accountant"
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Default Hourly Rate
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100000}
                    value={hourlyRate}
                    onChange={(e) => setHourlyRate(e.target.value)}
                    className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Billing Currency
                  </label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="CAD">CAD ($)</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg cursor-pointer"
                >
                  {isSaving ? 'Saving...' : 'Save Preferences'}
                </button>

                {feedback && (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                    <Check className="w-3.5 h-3.5" />
                    <span>{feedback}</span>
                  </span>
                )}
              </div>
            </form>

            {/* Active Sessions */}
            {sessions.length > 0 && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="font-semibold text-slate-900 dark:text-white">
                  Active Sessions ({sessions.length})
                </div>
                <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-28 overflow-y-auto">
                  {sessions.map((s) => (
                    <div key={s.id} className="py-1.5 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] text-slate-700 dark:text-slate-300 truncate">
                          {s.isCurrent ? 'Current session' : 'Session'} · {s.ipAddress || 'local'}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate">
                          Last seen {new Date(s.lastSeenUtc).toLocaleString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRevokeSession(s.id)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Revoke</span>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Workspace Actions */}
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onExportJson}
                  className="flex items-center gap-1.5 px-3 py-2 font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Export JSON</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenPreferences();
                  }}
                  className="flex items-center gap-1.5 px-3 py-2 font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  <span>Idle &amp; Theme</span>
                </button>
              </div>

              <button
                type="button"
                onClick={onSignOut}
                className="flex items-center gap-1.5 px-3.5 py-2 font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
