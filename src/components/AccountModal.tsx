import React, { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import {
  X,
  LogIn,
  LogOut,
  ShieldCheck,
  Cloud,
  UploadCloud,
  Trash2,
  Check,
  AlertTriangle,
  Download,
  SlidersHorizontal,
  UserCircle2,
} from 'lucide-react';
import { UserProfile } from '../types';

interface AccountModalProps {
  isOpen: boolean;
  user: User | null;
  userProfile: UserProfile | null;
  authReady: boolean;
  cloudSyncStatus: 'local' | 'syncing' | 'synced' | 'error';
  authError: string | null;
  onSignInWithGoogle: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onSaveProfile: (updates: {
    displayName: string;
    jobTitle: string;
    hourlyRate: number;
    currency: string;
  }) => Promise<void>;
  onSyncLocalToCloud: () => Promise<void>;
  onDeleteCloudWorkspace: () => Promise<void>;
  onExportJson: () => void;
  onOpenPreferences: () => void;
  onClose: () => void;
}

export const AccountModal: React.FC<AccountModalProps> = ({
  isOpen,
  user,
  userProfile,
  authReady,
  cloudSyncStatus,
  authError,
  onSignInWithGoogle,
  onSignOut,
  onSaveProfile,
  onSyncLocalToCloud,
  onDeleteCloudWorkspace,
  onExportJson,
  onOpenPreferences,
  onClose,
}) => {
  const [displayName, setDisplayName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [hourlyRate, setHourlyRate] = useState('150');
  const [currency, setCurrency] = useState('USD');
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setConfirmDeleteOpen(false);
      setFeedback(null);
      return;
    }
    if (userProfile) {
      setDisplayName(userProfile.displayName || '');
      setJobTitle(userProfile.jobTitle || '');
      setHourlyRate(String(userProfile.hourlyRate ?? 150));
      setCurrency(userProfile.currency || 'USD');
    } else if (user) {
      setDisplayName(user.displayName || user.email?.split('@')[0] || '');
      setJobTitle('');
      setHourlyRate('150');
      setCurrency('USD');
    }
  }, [isOpen, userProfile, user]);

  if (!isOpen) return null;

  const handleGoogleLogin = async () => {
    setIsSigningIn(true);
    setFeedback(null);
    try {
      await onSignInWithGoogle();
      setFeedback('Signed in and connected to cloud workspace.');
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
        displayName: displayName.trim() || 'onTrack User',
        jobTitle: jobTitle.trim(),
        hourlyRate: Math.max(0, Number(hourlyRate) || 0),
        currency,
      });
      setFeedback('Account profile & billing preferences saved.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleManualSync = async () => {
    setIsSyncing(true);
    setFeedback(null);
    try {
      await onSyncLocalToCloud();
      setFeedback('Current workspace pushed to Firestore.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleConfirmDelete = async () => {
    setIsDeleting(true);
    try {
      await onDeleteCloudWorkspace();
      setConfirmDeleteOpen(false);
      onClose();
    } finally {
      setIsDeleting(false);
    }
  };

  const initials = (
    userProfile?.displayName ||
    user?.displayName ||
    user?.email ||
    'OT'
  )
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <UserCircle2 className="w-5 h-5 text-indigo-600" />
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {user ? 'User Account & Cloud Workspace' : 'Sign In to onTrack'}
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

        {authError && (
          <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{authError}</span>
          </div>
        )}

        {!authReady ? (
          <div className="py-8 text-center text-xs text-slate-500">
            Checking authentication session...
          </div>
        ) : !user ? (
          /* Signed Out Experience */
          <div className="space-y-5 text-xs">
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="font-semibold text-sm text-slate-900 dark:text-white">
                Personal Cloud Sync & Account Profile
              </div>
              <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                Sign in to onTrack with your Google account to back up your task boards, automatic activity &amp; application timelines, and generated weekly progress reports in real time across devices.
              </p>
              <div className="pt-1 space-y-1.5 text-slate-600 dark:text-slate-400">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  <span>Private per-user Firestore isolation & verified identity</span>
                </div>
                <div className="flex items-center gap-2">
                  <Cloud className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                  <span>Seamless migration of any existing local browser data</span>
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled={isSigningIn}
              onClick={handleGoogleLogin}
              className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg cursor-pointer transition-colors"
            >
              <LogIn className="w-4 h-4" />
              <span>
                {isSigningIn ? 'Signing in with Google...' : 'Continue with Google'}
              </span>
            </button>

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
          /* Signed In User Account Management */
          <div className="space-y-5 text-xs">
            {/* Identity Summary */}
            <div className="flex items-center justify-between gap-3 p-4 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-3 min-w-0">
                {user.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt={displayName || 'User avatar'}
                    referrerPolicy="no-referrer"
                    className="w-11 h-11 rounded-full object-cover border border-slate-200 dark:border-slate-700 shrink-0"
                  />
                ) : (
                  <div className="w-11 h-11 rounded-full bg-indigo-600 text-white font-display font-bold text-sm flex items-center justify-center shrink-0">
                    {initials}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="font-display text-sm font-bold text-slate-900 dark:text-white truncate">
                    {userProfile?.displayName || user.displayName || 'onTrack User'}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400 truncate">
                    {user.email} · {user.emailVerified ? 'Verified' : 'Unverified'}
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-0.5 truncate">
                    UID: {user.uid}
                  </div>
                </div>
              </div>

              <div className="text-right shrink-0">
                <div className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                  <Cloud className="w-3.5 h-3.5" />
                  <span>
                    {cloudSyncStatus === 'syncing'
                      ? 'Syncing...'
                      : cloudSyncStatus === 'error'
                        ? 'Sync Error'
                        : 'Cloud Synced'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  Google Auth
                </div>
              </div>
            </div>

            {/* Editable Account Profile & Billing Settings */}
            <form onSubmit={handleProfileSubmit} className="space-y-3">
              <div className="font-semibold text-slate-900 dark:text-white">
                Account Profile & Billable Defaults
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
                    placeholder="e.g., Principal Engineer"
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
                  {isSaving ? 'Saving...' : 'Save Account Profile'}
                </button>

                {feedback && (
                  <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                    <Check className="w-3.5 h-3.5" />
                    <span>{feedback}</span>
                  </span>
                )}
              </div>
            </form>

            {/* Cloud Workspace Actions */}
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="font-semibold text-slate-900 dark:text-white">
                Workspace Data & Controls
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isSyncing}
                  onClick={handleManualSync}
                  className="flex items-center gap-1.5 px-3 py-2 font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>{isSyncing ? 'Syncing...' : 'Force Cloud Sync'}</span>
                </button>

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
                  <span>Idle & Theme Settings</span>
                </button>
              </div>
            </div>

            {/* Session & Account Removal */}
            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={onSignOut}
                  className="flex items-center gap-1.5 px-3.5 py-2 font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>

                {!confirmDeleteOpen && (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteOpen(true)}
                    className="flex items-center gap-1.5 px-3 py-2 font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Cloud Account Data</span>
                  </button>
                )}
              </div>

              {confirmDeleteOpen && (
                <div className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 space-y-2.5">
                  <div className="font-semibold text-rose-800 dark:text-rose-200">
                    Permanently delete your cloud profile, tasks, timeline logs, and reports?
                  </div>
                  <p className="text-[11px] text-rose-700 dark:text-rose-300">
                    This action removes all cloud-stored records for {user.email} and signs you out. Local browser storage remains untouched unless cleared separately.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={handleConfirmDelete}
                      className="px-3 py-1.5 font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-md cursor-pointer"
                    >
                      {isDeleting ? 'Deleting...' : 'Confirm Delete Account Data'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteOpen(false)}
                      className="px-3 py-1.5 font-medium text-slate-600 dark:text-slate-300 hover:underline cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
