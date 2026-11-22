import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Database,
  LogIn,
  MonitorSmartphone,
  Moon,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import heroWorkspaceImg from '../assets/images/hero_ontrack_workspace_1795323315338.jpg';
import { DemoAccountSummary } from '../services/authClient';
import { getRolePolicy } from '../utils/roleConfig';

interface LandingPageProps {
  authReady: boolean;
  authError: string | null;
  needsInitialSetup: boolean;
  demoModeEnabled?: boolean;
  demoAccounts?: DemoAccountSummary[];
  darkMode: boolean;
  onToggleTheme: () => void;
  onLogin: (payload: {
    email: string;
    password: string;
    totpCode?: string;
    isClientPortal?: boolean;
  }) => Promise<void>;
  onDemoLogin?: (userId: string) => Promise<void>;
  onBootstrapFirm: (payload: {
    firmName: string;
    name: string;
    email: string;
    password: string;
  }) => Promise<void>;
  onContinueLocal: () => void;
}

export const LandingPage: React.FC<LandingPageProps> = ({
  authReady,
  authError,
  needsInitialSetup,
  demoModeEnabled = false,
  demoAccounts = [],
  darkMode,
  onToggleTheme,
  onLogin,
  onDemoLogin,
  onBootstrapFirm,
  onContinueLocal,
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (mode === 'setup') {
        await onBootstrapFirm({
          firmName: firmName.trim(),
          name: fullName.trim(),
          email: email.trim(),
          password,
        });
      } else {
        await onLogin({
          email: email.trim(),
          password,
          totpCode: totpCode.trim() || undefined,
          isClientPortal,
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const capabilities = [
    {
      index: '01.',
      title: 'Multi-Track Activity & Presence Capture',
      span: 'lg:col-span-2',
      summary:
        'Cross-platform desktop capture for Windows, macOS, Linux, and Citrix/RDP paired with an MV3 browser collector. Records active windows, document titles, and unattended idle intervals without manual timers.',
      detail: 'Idle gaps prompt one-click reconciliation to trim, keep, or reassign time.',
    },
    {
      index: '02.',
      title: 'Deterministic Client Attribution',
      span: 'lg:col-span-1',
      summary:
        'Matches accounting tools, cloud portals, and repository paths against your client dictionary with explainable confidence scores.',
      detail: 'Confidence rules and review queues keep daily verification predictable.',
    },
    {
      index: '03.',
      title: 'Tasks, Gantt & Calendar Views',
      span: 'lg:col-span-1',
      summary:
        'Organize deliverables on status boards, inspect timelines on an interactive Gantt chart, or plan deadlines across a calendar.',
      detail: 'All four views share one synchronized task and time-block model.',
    },
    {
      index: '04.',
      title: 'Weekly Stakeholder Reports',
      span: 'lg:col-span-2',
      summary:
        'Compiles logged hours, deep-work ratio, billable allocation, and application usage into formatted weekly progress reviews tailored for executives, accounting leads, or client billing.',
      detail: 'Export to clean Markdown or print-ready PDF in one click.',
    },
  ];

  const workflowSteps = [
    {
      step: '01.',
      title: 'Sign in or initialize your firm workspace',
      body: 'Sign in with your self-hosted account (with optional TOTP MFA) or launch directly in Local Browser Mode with zero setup.',
    },
    {
      step: '02.',
      title: 'Capture workstation metadata automatically',
      body: 'Pair the optional desktop agent and browser extension to stream active application and document transitions while keeping exclusions private on-device.',
    },
    {
      step: '03.',
      title: 'Reconcile idle gaps & publish weekly dossiers',
      body: 'Review flagged away intervals on Track 1, confirm attributed client blocks, and export verified time totals and velocity summaries.',
    },
  ];

  const privacyRows = [
    {
      label: 'Private & Incognito Windows',
      value: 'Dropped on-device prior to queue buffering',
    },
    {
      label: 'Application & Domain Exclusions',
      value: 'Evaluated locally via synced firm privacy policy',
    },
    {
      label: 'Telemetry Scope',
      value: 'Metadata only — no screenshots, keystrokes, or DOM text',
    },
    {
      label: 'Storage & Portability',
      value: 'Self-hosted SQLite/PostgreSQL RLS isolation & JSON export',
    },
  ];

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
        {/* Strict 3-Zone Top Bar */}
        <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="max-w-[1440px] mx-auto px-6 py-4 flex items-center justify-between gap-8">
            <a
              href="#top"
              className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0"
            >
              OnTrack
            </a>

            <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600 dark:text-slate-400">
              <a
                href="#capabilities"
                className="whitespace-nowrap shrink-0 hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4 transition-colors"
              >
                Capabilities
              </a>
              <a
                href="#workflow"
                className="whitespace-nowrap shrink-0 hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4 transition-colors"
              >
                How It Works
              </a>
              <a
                href="#privacy"
                className="whitespace-nowrap shrink-0 hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4 transition-colors"
              >
                Privacy
              </a>
              <button
                type="button"
                onClick={onContinueLocal}
                className="whitespace-nowrap shrink-0 hover:text-slate-900 dark:hover:text-white hover:underline underline-offset-4 transition-colors cursor-pointer"
              >
                Workspace Demo
              </button>
            </nav>

            <div className="flex items-center gap-3 shrink-0">
              <a
                href="#signin"
                className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Sign In
              </a>
            </div>
          </div>
        </header>

        <main id="top" className="flex-1 w-full max-w-[1440px] mx-auto px-6">
          {/* Hero Section + Sign-In Access Panel */}
          <section className="pt-10 pb-12 lg:pt-14 lg:pb-16">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10 items-stretch">
              {/* Left 7 Columns: Proposition + 16:9 Architectural Visual */}
              <div className="lg:col-span-7 flex flex-col justify-between gap-7">
                <div className="space-y-4">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-2">
                    <span>Workstation Capture</span>
                    <span aria-hidden="true">·</span>
                    <span>Task &amp; Gantt Planning</span>
                    <span aria-hidden="true">·</span>
                    <span>Client Attribution</span>
                  </div>

                  <h1
                    className="font-display font-bold tracking-tight text-slate-900 dark:text-white leading-[1.08]"
                    style={{
                      fontSize: 'clamp(2.25rem, 4vw, 3.5rem)',
                      textWrap: 'balance',
                    }}
                  >
                    Every billable minute accounted for, without manual timers.
                  </h1>

                  <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-[62ch]">
                    OnTrack combines structured task boards, Gantt charts, and scheduling calendars with automatic desktop and browser activity timelines—matching active windows and documents to client engagements and exporting executive weekly reports.
                  </p>
                </div>

                {/* 16:9 Editorial Workspace Showcase */}
                <div className="aspect-video w-full rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900">
                  {!imageFailed ? (
                    <img
                      src={heroWorkspaceImg}
                      alt="OnTrack workstation desk displaying multi-track project timelines and usage analytics"
                      referrerPolicy="no-referrer"
                      onError={() => setImageFailed(true)}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-900 dark:to-slate-800">
                      <MonitorSmartphone className="w-10 h-10 text-indigo-600 dark:text-indigo-400 mb-3" />
                      <div className="font-display text-sm font-semibold text-slate-900 dark:text-white">
                        OnTrack Multi-Track Timeline &amp; Task Workspace
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md">
                        Synchronized presence segments, application traces, document titles, and billable time blocks.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Right 5 Columns: Sign-In & Workspace Entry Card */}
              <div id="signin" className="lg:col-span-5 flex">
                <div className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-7 flex flex-col justify-between gap-6">
                  <div className="space-y-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white tracking-tight">
                          {mode === 'setup' ? 'Initialize Your Firm' : 'Sign in to OnTrack'}
                        </h2>
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {mode === 'setup'
                            ? 'Create the initial Admin/IT account for your firm workspace.'
                            : 'Sign in with your self-hosted firm credentials to sync tracking and tasks.'}
                        </p>
                      </div>
                      {needsInitialSetup && (
                        <button
                          type="button"
                          onClick={() => setMode(mode === 'setup' ? 'login' : 'setup')}
                          className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0 cursor-pointer"
                        >
                          {mode === 'setup' ? 'Sign In' : 'First-Run Setup'}
                        </button>
                      )}
                    </div>

                    {authError && (
                      <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{authError}</span>
                      </div>
                    )}

                    <form onSubmit={handleSubmit} className="space-y-3 text-xs">
                      {mode === 'setup' && (
                        <>
                          <div>
                            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                              Accounting Firm / Organization
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
                            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                              Administrator Name
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
                        <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Work Email
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
                        <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
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
                            placeholder="MFA code (if enabled)"
                            className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white font-mono"
                          />
                          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isClientPortal}
                              onChange={(e) => setIsClientPortal(e.target.checked)}
                            />
                            <span>Client Portal</span>
                          </label>
                        </div>
                      )}

                      <button
                        type="submit"
                        disabled={isSubmitting || !authReady}
                        className="w-full min-h-[42px] flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
                      >
                        {mode === 'setup' ? (
                          <Building2 className="w-4 h-4 shrink-0" />
                        ) : (
                          <LogIn className="w-4 h-4 shrink-0" />
                        )}
                        <span className="whitespace-nowrap">
                          {isSubmitting
                            ? 'Authenticating...'
                            : !authReady
                              ? 'Checking Session...'
                              : mode === 'setup'
                                ? 'Create Firm & Sign In'
                                : 'Sign In'}
                        </span>
                      </button>
                    </form>

                    <div className="flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
                      <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                      <span>or</span>
                      <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
                    </div>

                    <button
                      type="button"
                      onClick={onContinueLocal}
                      className="w-full min-h-[42px] flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700/80 rounded-lg transition-colors cursor-pointer"
                    >
                      <span className="whitespace-nowrap">Continue in Local Workspace</span>
                      <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                    </button>

                    {demoModeEnabled && demoAccounts.length > 0 && onDemoLogin && mode === 'login' && (
                      <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                        <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                          <span>Demo Accounts by Role &amp; Shift</span>
                          <span className="font-mono text-indigo-600 dark:text-indigo-400">
                            {demoAccounts.length} ready
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-48 overflow-y-auto pr-0.5">
                          {demoAccounts.map((acc) => {
                            const roleLabel = getRolePolicy(acc.role).shortLabel;
                            return (
                              <button
                                key={acc.userId}
                                type="button"
                                disabled={isSubmitting}
                                onClick={async () => {
                                  setIsSubmitting(true);
                                  try {
                                    await onDemoLogin(acc.userId);
                                  } finally {
                                    setIsSubmitting(false);
                                  }
                                }}
                                className="text-left px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 hover:border-indigo-400 hover:bg-indigo-50/60 dark:hover:bg-indigo-950/30 transition-colors cursor-pointer disabled:opacity-50"
                              >
                                <div className="flex items-center justify-between gap-1">
                                  <span className="text-[11px] font-semibold text-slate-900 dark:text-white truncate">
                                    {acc.name.split(' (')[0]}
                                  </span>
                                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 shrink-0">
                                    {roleLabel}
                                  </span>
                                </div>
                                <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5">
                                  {acc.email} · {acc.shiftPattern}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Architectural Assurances */}
                  <div className="border-t border-slate-200 dark:border-slate-800 pt-4 space-y-3 text-xs text-slate-600 dark:text-slate-400">
                    <div className="flex items-start gap-2.5">
                      <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      <span>
                        Self-hosted argon2id authentication, httpOnly session cookies, and optional TOTP MFA.
                      </span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <MonitorSmartphone className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
                      <span>
                        Downloadable Windows, macOS, Linux, and VDI Desktop Agent plus Chrome/Edge MV3 browser extension.
                      </span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <Database className="w-4 h-4 text-slate-500 dark:text-slate-300 shrink-0 mt-0.5" />
                      <span>
                        Portable JSON workspace backups paired with an embedded SQLite / PostgreSQL RLS tracking store.
                      </span>
                    </div>
                  </div>

                  {/* Card Footer: Theme Preference */}
                  <div className="border-t border-slate-200 dark:border-slate-800 pt-4 flex items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
                    <span>Local Browser Mode saves on this device</span>
                    <button
                      type="button"
                      onClick={onToggleTheme}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {darkMode ? (
                        <>
                          <Sun className="w-3.5 h-3.5 text-amber-500" />
                          <span>Light</span>
                        </>
                      ) : (
                        <>
                          <Moon className="w-3.5 h-3.5 text-indigo-600" />
                          <span>Dark</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Full-Width Quantitative Proof Strip */}
            <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 divide-y sm:divide-y-0 sm:divide-x divide-slate-200 dark:divide-slate-800">
              <div className="p-5">
                <div className="font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                  3 Tracks
                </div>
                <div className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Presence, application, and document timelines aligned to the minute
                </div>
              </div>
              <div className="p-5">
                <div className="font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                  &lt; 5 min
                </div>
                <div className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Daily review target using deterministic client attribution rules
                </div>
              </div>
              <div className="p-5">
                <div className="font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                  0 Captures
                </div>
                <div className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Zero screenshots, keystrokes, or browser DOM contents recorded
                </div>
              </div>
              <div className="p-5">
                <div className="font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                  4 Views
                </div>
                <div className="mt-1 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Board, Timeline, Gantt, and Calendar powered by one task model
                </div>
              </div>
            </div>
          </section>

          {/* Section 2: Asymmetric Capabilities Bento */}
          <section
            id="capabilities"
            className="py-14 border-t border-slate-200 dark:border-slate-800 space-y-8"
          >
            <div className="max-w-2xl space-y-2">
              <h2
                className="font-display text-2xl lg:text-3xl font-bold tracking-tight text-slate-900 dark:text-white"
                style={{ textWrap: 'balance' }}
              >
                Built for teams that bill by precision, not guesswork
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                Every logged interval links directly back to real tasks, client engagements, and verified workstation context.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {capabilities.map((cap) => (
                <article
                  key={cap.index}
                  className={`${cap.span} bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between gap-5`}
                >
                  <div className="space-y-2.5">
                    <div className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400 tabular-nums">
                      {cap.index}
                    </div>
                    <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                      {cap.title}
                    </h3>
                    <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                      {cap.summary}
                    </p>
                  </div>
                  <div className="pt-4 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                    {cap.detail}
                  </div>
                </article>
              ))}
            </div>
          </section>

          {/* Section 3: How It Works & Privacy Guarantees */}
          <section className="py-14 border-t border-slate-200 dark:border-slate-800">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
              {/* Workflow */}
              <div id="workflow" className="lg:col-span-6 space-y-6">
                <div className="space-y-1.5">
                  <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    How OnTrack fits your workday
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Start immediately in your browser or connect workstation collectors when ready.
                  </p>
                </div>

                <div className="divide-y divide-slate-200 dark:divide-slate-800 border-t border-b border-slate-200 dark:border-slate-800">
                  {workflowSteps.map((item) => (
                    <div key={item.step} className="py-5 flex gap-4">
                      <span className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400 tabular-nums pt-0.5 shrink-0">
                        {item.step}
                      </span>
                      <div className="space-y-1">
                        <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                          {item.title}
                        </h3>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {item.body}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Privacy & Persistence Architecture */}
              <div id="privacy" className="lg:col-span-6 space-y-6">
                <div className="space-y-1.5">
                  <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                    On-device privacy before sync
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Sensitive tabs, password managers, and personal folders never leave the workstation.
                  </p>
                </div>

                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-200 dark:divide-slate-800">
                  {privacyRows.map((row) => (
                    <div
                      key={row.label}
                      className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {row.label}
                      </span>
                      <span className="text-slate-600 dark:text-slate-400 sm:text-right">
                        {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* Bottom Conversion Band */}
          <section className="pb-16">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 lg:p-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-1.5 max-w-xl">
                <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Ready to get every project OnTrack?
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Sign in to your self-hosted workspace or open locally to inspect timelines and reports.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 shrink-0">
                <a
                  href="#signin"
                  className="inline-flex items-center gap-2 px-5 py-3 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogIn className="w-4 h-4" />
                  <span>Sign In</span>
                </a>
                <button
                  type="button"
                  onClick={onContinueLocal}
                  className="px-4 py-3 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white underline underline-offset-4 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Open Local Workspace
                </button>
              </div>
            </div>
          </section>
        </main>

        {/* Quiet Footer */}
        <footer className="border-t border-slate-200 dark:border-slate-800 px-6 py-5 text-xs text-slate-500 dark:text-slate-400">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-4">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              OnTrack · Task Workspace &amp; Timeline Tracker
            </span>
            <div className="flex flex-wrap items-center gap-4">
              <a href="#capabilities" className="hover:text-slate-900 dark:hover:text-white">
                Capabilities
              </a>
              <span aria-hidden="true">·</span>
              <a href="#workflow" className="hover:text-slate-900 dark:hover:text-white">
                How It Works
              </a>
              <span aria-hidden="true">·</span>
              <a href="#privacy" className="hover:text-slate-900 dark:hover:text-white">
                Privacy
              </a>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onToggleTheme}
                className="hover:text-slate-900 dark:hover:text-white underline cursor-pointer"
              >
                {darkMode ? 'Light Canvas' : 'Dark Slate'}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
};
