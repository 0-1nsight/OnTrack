import React from 'react';
import { UserCircle2 } from 'lucide-react';
import { UserRole } from '../engine/types';
import { AuthUser } from '../services/authClient';
import { NavigationTab, UserProfile } from '../types';
import { ROLE_OPTIONS, getRolePolicy } from '../utils/roleConfig';

interface TopBarProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  onOpenQuickLog: () => void;
  user: AuthUser | null;
  userProfile: UserProfile | null;
  activeRole: UserRole;
  canSwitchPreviewRole: boolean;
  onChangePreviewRole: (role: UserRole) => void;
  onOpenAccount: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenQuickLog,
  user,
  userProfile,
  activeRole,
  canSwitchPreviewRole,
  onChangePreviewRole,
  onOpenAccount,
}) => {
  const policy = getRolePolicy(activeRole);
  const navItems = policy.allowedTabs;

  const shortName = (
    userProfile?.displayName ||
    user?.name ||
    user?.email?.split('@')[0] ||
    'Account'
  ).split(' ')[0];

  return (
    <header className="no-print flex items-center justify-between gap-6 px-6 py-3.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
      {/* Zone 1: Single text element wordmark */}
      <a
        href={`#${policy.defaultTab}`}
        onClick={(e) => {
          e.preventDefault();
          onSelectTab(policy.defaultTab);
        }}
        className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0"
      >
        onTrack
      </a>

      {/* Zone 2: Concise single-line role-scoped navigation links */}
      <nav className="flex items-center gap-6 text-sm font-medium overflow-x-auto">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`whitespace-nowrap shrink-0 py-1 transition-colors border-b-2 cursor-pointer ${
                isActive
                  ? 'border-indigo-600 text-slate-900 dark:text-white font-semibold'
                  : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:border-slate-300'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Role Switcher / Badge, Account trigger & Role-gated Quick Log CTA */}
      <div className="flex items-center gap-2.5 shrink-0">
        {canSwitchPreviewRole ? (
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="hidden xl:inline">Role View:</span>
            <select
              aria-label="Role View"
              value={activeRole}
              onChange={(e) => onChangePreviewRole(e.target.value as UserRole)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 cursor-pointer"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="px-2.5 py-1 text-[11px] font-mono font-semibold rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 whitespace-nowrap">
            {policy.shortLabel}
          </span>
        )}

        <button
          type="button"
          onClick={onOpenAccount}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          title={user ? `Signed in as ${user.email}` : 'Sign in to OnTrack'}
        >
          <UserCircle2 className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <span>{user ? shortName : 'Sign In'}</span>
        </button>

        {policy.canQuickLog && (
          <button
            type="button"
            onClick={onOpenQuickLog}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            + Quick Log
          </button>
        )}
      </div>
    </header>
  );
};
