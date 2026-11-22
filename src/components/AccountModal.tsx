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
  SessionInfo,
  beginMfaEnrollment,
  confirmMfaEnrollment,
  listActiveSessions,
  revokeActiveSession,
} from '../services/authClient';
import { UserProfile } from '../types';

interface AccountModalProps {
  isOpen: boolean;
  user: AuthUser | null;
  userProfile: UserProfile | null;
  authReady: boolean;
  needsInitialSetup: boolean;
  authError: string | null;
  onLogin: (payload: {
    email: string;
    password: string;
    totpCode?: string;
    isClientPortal?: boolean;
  }) => Promise<void>;
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
  onRefreshSession: () => Promise<void>;
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
  authError,
  onLogin,
  onBootstrapFirm,
  onSignOut,
  onSaveProfile,
  onRefreshSession,
  onExportJson,
  onOpenPreferences,
  onClose,
}) => {
  const [modeOverride, setModeOverride] = useState<'login' | 'setup' | null>(
    null
  );
  const mode: 'login' | 'setup' =
    modeOverride ?? (needsInitialSetup ? 'setup' : 'login');
  const setMode = (next: 'login' | 'setup') => setModeOverride(next);
  const [firmName, setFirmName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [isClientPortal, setIsClientPortal] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [hourlyRate, setHourlyRate] = useState('150');
  const [currency, setCurrency] = useState('USD');
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
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    if (!isOpen) {
      setFeedback(null);
      setLocalError(null);
      setMfaEnrollment(null);
      return;
    }
    if (userProfile) {
      setDisplayName(userProfile.displayName || '');
      setJobTitle(userProfile.jobTitle || '');
      setHourlyRate(String(userProfile.hourlyRate ?? 150));
      setCurrency(userProfile.currency || 'USD');
    } else if (user) {
      setDisplayName(user.name || user.email?.split('@')[0] || '');
      setJobTitle(user.role);
      setHourlyRate('150');
      setCurrency('USD');
    }
    if (user) {
      listActiveSessions()
        .then((res) => setSessions(res.sessions || []))
        .catch(() => setSessions([]));
    }
  }, [isOpen, userProfile, user]);

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
    try {
      await confirmMfaEnrollment(mfaConfirmCode.trim());
      setMfaEnrollment(null);
      setMfaConfirmCode('');
      await onRefreshSession();
      setFeedback('Two-factor authentication verified and enabled.');
    } catch (err: any) {
      setLocalError(err?.message || 'Invalid TOTP verification code.');
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
              {user ? 'Account & Security Settings' : 'Sign In to OnTrack'}
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
                  onClick={() => setMode(mode === 'setup' ? 'login' : 'setup')}
                  className="text-indigo-600 dark:text-indigo-400 font-semibold hover:underline cursor-pointer"
                >
                  {mode === 'setup' ? 'Switch to Sign In' : 'Create Initial Firm'}
                </button>
              )}
            </div>

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

              {mode === 'login' && (
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
                      : 'Sign In'}
                </span>
              </button>
            </form>

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

            {/* TOTP MFA Setup Prompt / Status */}
            {(!user.totpEnabled || user.mustEnrollMfa) && (
              <div className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>
                      {user.mustEnrollMfa
                        ? 'Two-Factor Authenticator Required for Your Role'
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
                        Verify &amp; Enable
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

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
