import React from 'react';
import { UserCircle2 } from 'lucide-react';
import { AuthUser } from '../services/authClient';
import { NavigationTab, UserProfile } from '../types';

interface TopBarProps {
  activeTab: NavigationTab;
  onSelectTab: (tab: NavigationTab) => void;
  onOpenQuickLog: () => void;
  user: AuthUser | null;
  userProfile: UserProfile | null;
  onOpenAccount: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenQuickLog,
  user,
  userProfile,
  onOpenAccount,
}) => {
  const navItems: { id: NavigationTab; label: string }[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'autotrack', label: 'Auto-Track' },
    { id: 'report', label: 'Weekly Report' },
    { id: 'analytics', label: 'Analytics' },
  ];

  const shortName = (
    userProfile?.displayName ||
    user?.name ||
    user?.email?.split('@')[0] ||
    'Account'
  ).split(' ')[0];

  return (
    <header className="no-print flex items-center justify-between gap-8 px-6 py-3.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
      {/* Zone 1: Single text element wordmark */}
      <a
        href="#timeline"
        onClick={(e) => {
          e.preventDefault();
          onSelectTab('timeline');
        }}
        className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0"
      >
        onTrack
      </a>

      {/* Zone 2: 4 concise single-line text navigation links */}
      <nav className="flex items-center gap-7 text-sm font-medium">
        {navItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`whitespace-nowrap shrink-0 py-1 transition-colors border-b-2 ${
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

      {/* Zone 3: Account trigger & Primary Quick Log CTA */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onOpenAccount}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          title={user ? `Signed in as ${user.email}` : 'Sign in to OnTrack'}
        >
          <UserCircle2 className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <span>{user ? shortName : 'Sign In'}</span>
        </button>

        <button
          type="button"
          onClick={onOpenQuickLog}
          className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          + Quick Log
        </button>
      </div>
    </header>
  );
};
