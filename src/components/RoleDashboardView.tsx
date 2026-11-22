import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  BarChart3,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Lock,
  MailPlus,
  Palette,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TrendingUp,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  PortalAccentTheme,
  ShiftPattern,
  TaskTemplate,
  UserRole,
} from '../engine/types';
import { AuthUser } from '../services/authClient';
import {
  purgeRetentionApi,
  updateEngineConfigApi,
  updateStaffRoleApi,
} from '../services/engineClient';
import {
  createInviteApi,
  fetchBrandingAndTemplatesApi,
  fetchRoleOverviewApi,
  InviteRecord,
  listInvitesApi,
  PortalApiError,
  RoleOverviewData,
  updatePortalBrandingApi,
  updateTemplateMilestonesApi,
} from '../services/portalClient';
import { ROLE_OPTIONS, getRolePolicy } from '../utils/roleConfig';

interface RoleDashboardViewProps {
  activeRole: UserRole;
  currentUser: AuthUser | null;
  onInspectStaffTimeline?: (targetUserId: string) => void;
  onOpenAutoTrackConfig?: () => void;
  onOpenAccount?: () => void;
  onNotify: (msg: string) => void;
}

export const RoleDashboardView: React.FC<RoleDashboardViewProps> = ({
  activeRole,
  currentUser,
  onInspectStaffTimeline,
  onOpenAutoTrackConfig,
  onOpenAccount,
  onNotify,
}) => {
  const tenantId = currentUser ? currentUser.tenantId : 'firm_demo';
  const policy = getRolePolicy(activeRole);

  const [data, setData] = useState<RoleOverviewData | null>(null);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Admin invite form state
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('accountant');
  const [inviteShift, setInviteShift] = useState<ShiftPattern>('8-5');
  const [inviteDrilldown, setInviteDrilldown] = useState(false);
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [focusFactorDraft, setFocusFactorDraft] = useState<number>(85);
  const [delayedThresholdDraft, setDelayedThresholdDraft] = useState<number>(120);

  // Admin portal branding & template milestone configuration (PORT-2)
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [brandTitle, setBrandTitle] = useState('Client Portal');
  const [brandDomain, setBrandDomain] = useState('');
  const [brandLogoText, setBrandLogoText] = useState('OT');
  const [brandTheme, setBrandTheme] = useState<PortalAccentTheme>('indigo');
  const [brandWelcome, setBrandWelcome] = useState('');
  const [brandNotice, setBrandNotice] = useState('');
  const [templateDrafts, setTemplateDrafts] = useState<
    Record<string, { name: string; milestonesText: string }>
  >({});

  const percentToWidthClass = (pct: number): string => {
    const p = Math.max(0, Math.min(100, pct));
    if (p >= 95) return 'w-full';
    if (p >= 85) return 'w-5/6';
    if (p >= 75) return 'w-3/4';
    if (p >= 66) return 'w-2/3';
    if (p >= 60) return 'w-3/5';
    if (p >= 50) return 'w-1/2';
    if (p >= 40) return 'w-2/5';
    if (p >= 33) return 'w-1/3';
    if (p >= 25) return 'w-1/4';
    if (p >= 16) return 'w-1/6';
    if (p > 0) return 'w-1/12';
    return 'w-0';
  };

  const syncPortalConfigState = useCallback(
    (cfg: Awaited<ReturnType<typeof fetchBrandingAndTemplatesApi>>) => {
      setBrandTitle(cfg.branding.portalTitle || 'Client Portal');
      setBrandDomain(cfg.branding.customDomain || '');
      setBrandLogoText(cfg.branding.logoText || 'OT');
      setBrandTheme(cfg.branding.accentTheme || 'indigo');
      setBrandWelcome(cfg.branding.welcomeMessage || '');
      setBrandNotice(cfg.branding.supportNotice || '');
      setTemplates(cfg.templates || []);
      const drafts: Record<string, { name: string; milestonesText: string }> = {};
      for (const tpl of cfg.templates || []) {
        drafts[tpl.id] = {
          name: tpl.name,
          milestonesText: (tpl.steps || []).map((s) => s.title).join('\n'),
        };
      }
      setTemplateDrafts(drafts);
    },
    []
  );

  const loadData = useCallback(async () => {
    if (currentUser && !currentUser.mfaVerified) {
      return;
    }

    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const overview = await fetchRoleOverviewApi({
        tenantId,
        viewerRole: activeRole,
      });
      setData(overview);
      if (overview.adminAlerts) {
        setFocusFactorDraft(Math.round((overview.adminAlerts.focusFactor ?? 0.85) * 100));
        setDelayedThresholdDraft(overview.adminAlerts.delayedThresholdSeconds ?? 120);
      }

      if (activeRole === 'admin_it') {
        if (currentUser) {
          try {
            const inv = await listInvitesApi();
            setInvites(inv.invites || []);
          } catch {
            setInvites([]);
          }
        } else {
          setInvites([]);
        }
        try {
          const cfg = await fetchBrandingAndTemplatesApi({
            tenantId,
            viewerRole: activeRole,
          });
          syncPortalConfigState(cfg);
        } catch {
          // ignore if unavailable
        }
      } else {
        setInvites([]);
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to load role operational overview.');
      setErrorCode(err instanceof PortalApiError ? err.code : null);
    } finally {
      setLoading(false);
    }
  }, [tenantId, activeRole, currentUser, syncPortalConfigState]);

  useEffect(() => {
    if (currentUser && !currentUser.mfaVerified) {
      return;
    }

    let active = true;
    const run = async () => {
      try {
        const overview = await fetchRoleOverviewApi({
          tenantId,
          viewerRole: activeRole,
        });
        if (!active) return;
        setData(overview);
        if (overview.adminAlerts) {
          setFocusFactorDraft(Math.round((overview.adminAlerts.focusFactor ?? 0.85) * 100));
          setDelayedThresholdDraft(overview.adminAlerts.delayedThresholdSeconds ?? 120);
        }
        setError(null);
        setErrorCode(null);
        if (activeRole === 'admin_it') {
          if (currentUser) {
            const inv = await listInvitesApi().catch(() => ({ invites: [] }));
            if (active) setInvites(inv.invites || []);
          } else {
            setInvites([]);
          }
          const cfg = await fetchBrandingAndTemplatesApi({
            tenantId,
            viewerRole: activeRole,
          }).catch(() => null);
          if (active && cfg) {
            syncPortalConfigState(cfg);
          }
        } else {
          setInvites([]);
        }
      } catch (err: any) {
        if (active) {
          setError(err?.message || 'Unable to load role operational overview.');
          setErrorCode(err instanceof PortalApiError ? err.code : null);
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [tenantId, activeRole, currentUser, syncPortalConfigState]);

  const handleRoleUpdate = async (
    userId: string,
    role: UserRole,
    shiftPattern: ShiftPattern,
    onLeave: boolean,
    canDrilldownTimeline: boolean
  ) => {
    setBusyAction(true);
    try {
      await updateStaffRoleApi(
        tenantId,
        userId,
        role,
        shiftPattern,
        onLeave,
        canDrilldownTimeline
      );
      onNotify(`Updated permissions for ${userId} (${role}).`);
      await loadData();
    } catch (err: any) {
      onNotify(err?.message || 'Permission update failed.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleToggleAiReports = async () => {
    if (!data?.adminAlerts) return;
    setBusyAction(true);
    try {
      await updateEngineConfigApi(tenantId, {
        aiReportsEnabled: !data.adminAlerts.aiReportsEnabled,
      });
      onNotify(
        `Tenant aggregate AI reports ${
          !data.adminAlerts.aiReportsEnabled ? 'enabled' : 'disabled'
        }.`
      );
      await loadData();
    } catch (err: any) {
      onNotify(err?.message || 'Unable to update AI policy.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleSaveCapacityThresholds = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction(true);
    try {
      const clampedFocus = Math.min(1, Math.max(0.5, focusFactorDraft / 100));
      const clampedDelay = Math.min(600, Math.max(30, delayedThresholdDraft));
      await updateEngineConfigApi(tenantId, {
        focusFactor: clampedFocus,
        delayedThresholdSeconds: clampedDelay,
      });
      onNotify(
        `Updated firm focus factor (${Math.round(clampedFocus * 100)}%) and IT delay threshold (${clampedDelay}s).`
      );
      await loadData();
    } catch (err: any) {
      onNotify(err?.message || 'Unable to update capacity/freshness thresholds.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleRetentionPurge = async () => {
    setBusyAction(true);
    try {
      const res = await purgeRetentionApi(tenantId);
      onNotify(`Retention sweep complete: purged ${res.purgedCount} expired raw event(s).`);
      await loadData();
    } catch (err: any) {
      onNotify(err?.message || 'Retention purge failed.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteName.trim() || !inviteEmail.trim()) return;
    setBusyAction(true);
    try {
      const res = await createInviteApi({
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        role: inviteRole,
        shiftPattern: inviteShift,
        canDrilldownTimeline: inviteDrilldown,
      });
      setCreatedInviteUrl(res.inviteUrl || res.token || 'Invitation created');
      setInviteName('');
      setInviteEmail('');
      onNotify(`Invitation created for ${inviteEmail.trim()}.`);
      await loadData();
    } catch (err: any) {
      onNotify(err?.message || 'Invitation failed (sign in as live Admin/IT required).');
    } finally {
      setBusyAction(false);
    }
  };

  const handleSavePortalBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction(true);
    try {
      await updatePortalBrandingApi({
        tenantId,
        viewerRole: activeRole,
        updates: {
          portalTitle: brandTitle.trim(),
          customDomain: brandDomain.trim(),
          logoText: brandLogoText.trim().slice(0, 4).toUpperCase() || 'OT',
          accentTheme: brandTheme,
          welcomeMessage: brandWelcome.trim(),
          supportNotice: brandNotice.trim(),
        },
      });
      onNotify('Client Portal branding saved and pushed to live client sessions.');
      await loadData();
    } catch (err: any) {
      onNotify(err?.message || 'Failed to update portal branding.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleSaveTemplateMilestones = async (templateId: string) => {
    const draft = templateDrafts[templateId];
    if (!draft) return;
    const milestoneNames = draft.milestonesText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (milestoneNames.length === 0) {
      onNotify('Provide at least one milestone name.');
      return;
    }
    setBusyAction(true);
    try {
      await updateTemplateMilestonesApi({
        tenantId,
        viewerRole: activeRole,
        templateId,
        name: draft.name.trim(),
        milestoneNames,
      });
      onNotify(`Updated milestone roadmap for template "${draft.name}".`);
      await loadData();
    } catch (err: any) {
      onNotify(err?.message || 'Failed to update template milestones.');
    } finally {
      setBusyAction(false);
    }
  };

  const mfaBlocked = Boolean(currentUser && !currentUser.mfaVerified);
  const effectiveError = mfaBlocked
    ? currentUser?.mustEnrollMfa
      ? 'Two-factor authenticator setup is required for your role before accessing workspace data.'
      : 'Complete two-factor verification to continue.'
    : error;

  if (!mfaBlocked && loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-8 text-sm text-slate-500 dark:text-slate-400">
        Loading {policy.label} workspace...
      </div>
    );
  }

  if (mfaBlocked || (effectiveError && !data)) {
    const isMfaError =
      mfaBlocked ||
      errorCode === 'MFA_ENROLLMENT_REQUIRED' ||
      errorCode === 'MFA_VERIFICATION_REQUIRED';
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-8 space-y-4">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {isMfaError
                ? 'Two-Factor Authenticator Setup Required'
                : `Authentication Required for ${policy.label}`}
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-1">{effectiveError}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {onOpenAccount && (
            <button
              type="button"
              onClick={onOpenAccount}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              {isMfaError ? 'Set Up 2FA Authenticator' : 'Sign In'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadData()}
            className="px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const fs = data.freshnessSummary;
  const highRiskCount = data.deadlineRisks.filter((r) => r.riskLevel === 'high').length;
  const avgUtilization =
    data.staffCapacity.length > 0
      ? Math.round(
          data.staffCapacity.reduce((s, r) => s + r.utilizationPercent, 0) /
            data.staffCapacity.length
        )
      : 0;
  const totalFeePortfolio = data.clientProfitability.reduce(
    (s, c) => s + c.estimatedFeeUsd,
    0
  );

  return (
    <div className="space-y-6">
      {/* Freshness & Role Scope Header (FRESH-2) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                {policy.label} Dashboard
              </h1>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300">
                {data.tenantName}
              </span>
              {fs.provisional ? (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] px-2 py-0.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="w-3 h-3" />
                  <span>Provisional ({fs.delayedCount + fs.offlineCount} missing)</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-mono text-[11px] px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="w-3 h-3" />
                  <span>Current</span>
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {policy.description}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 font-mono tabular-nums text-slate-700 dark:text-slate-300">
              {fs.reportingLiveCount} of {fs.totalActiveShiftStaff} active-shift staff reporting live
            </div>
            <div className="px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 font-mono tabular-nums text-slate-500 dark:text-slate-400">
              Data as of {new Date(fs.dataAsOfUtc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} UTC
            </div>
            <button
              type="button"
              onClick={() => void loadData()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {fs.recentlyUpdatedNotice && (
          <div className="mt-3 px-3 py-2 rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 text-xs font-mono text-indigo-700 dark:text-indigo-300">
            Updated · {fs.recentlyUpdatedNotice}
          </div>
        )}
      </section>

      {/* ADMIN / IT CONSOLE (No client work content visible) */}
      {activeRole === 'admin_it' && data.adminAlerts && (
        <>
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Delayed Shift Devices (&gt;2m)
              </div>
              <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">
                {data.adminAlerts.delayedDevicesCount}
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Routed to IT/Admin only (never managers)
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Offline Shift Devices
              </div>
              <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
                {data.adminAlerts.offlineDevicesCount}
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Off-shift &amp; leave excluded automatically
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Retention &amp; Privacy Scope
              </div>
              <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                {data.adminAlerts.retentionDays}d
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Policy: {data.adminAlerts.monitoringPolicy} · Zero client content
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-col justify-between">
              <div>
                <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Admin Controls
                </div>
                <div className="mt-1 text-xs text-slate-700 dark:text-slate-300">
                  AI Aggregate Reports:{' '}
                  <span className="font-mono font-semibold">
                    {data.adminAlerts.aiReportsEnabled ? 'ON' : 'OFF'}
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => void handleToggleAiReports()}
                  className="px-2.5 py-1 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Toggle AI Opt-In
                </button>
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => void handleRetentionPurge()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Purge Expired</span>
                </button>
                {onOpenAutoTrackConfig && (
                  <button
                    type="button"
                    onClick={onOpenAutoTrackConfig}
                    className="px-2.5 py-1 text-[11px] font-medium rounded bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer"
                  >
                    Agent Packages &amp; Tokens
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* IT-Only Delayed Shift Device Alert Feed (FRESH-1) */}
          {data.adminAlerts.itDelayedDevices.length > 0 && (
            <section className="bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                  <span>
                    Active IT Freshness Alerts ({data.adminAlerts.itDelayedDevices.length} active-shift device
                    {data.adminAlerts.itDelayedDevices.length === 1 ? '' : 's'})
                  </span>
                </div>
                <span className="font-mono text-[11px] text-amber-800 dark:text-amber-300">
                  Routed exclusively to Admin / IT · Never exposed to line managers
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs">
                {data.adminAlerts.itDelayedDevices.map((d) => (
                  <div
                    key={d.deviceId}
                    className="px-3 py-2 rounded border border-amber-200 dark:border-amber-800/80 bg-white dark:bg-slate-900 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 dark:text-white truncate">
                        {d.userName}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {d.deviceId} · {d.shiftPattern} shift
                      </div>
                    </div>
                    <span
                      className={`font-mono text-[11px] font-semibold whitespace-nowrap ${
                        d.status === 'offline'
                          ? 'text-rose-700 dark:text-rose-400'
                          : 'text-amber-700 dark:text-amber-400'
                      }`}
                    >
                      {d.status === 'offline' ? 'OFFLINE' : 'DELAYED'} · {d.delayedSeconds}s
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Tenant Focus Factor & Freshness Threshold Configuration */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
            <form
              onSubmit={handleSaveCapacityThresholds}
              className="flex flex-wrap items-end justify-between gap-4 text-xs"
            >
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Capacity Focus Factor &amp; Freshness Thresholds
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Focus factor adjusts weekly shift hours for deadline risk; delay threshold triggers IT-only device alerts.
                </p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Focus Factor (%)
                  </label>
                  <input
                    type="number"
                    min={50}
                    max={100}
                    value={focusFactorDraft}
                    onChange={(e) => setFocusFactorDraft(Number(e.target.value))}
                    className="w-24 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white font-mono tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                    IT Delay Alert (sec)
                  </label>
                  <input
                    type="number"
                    min={30}
                    max={600}
                    value={delayedThresholdDraft}
                    onChange={(e) => setDelayedThresholdDraft(Number(e.target.value))}
                    className="w-24 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white font-mono tabular-nums"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busyAction || !currentUser}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{currentUser ? 'Save Settings' : 'Sign In as Admin'}</span>
                </button>
              </div>
            </form>
          </section>

          {/* Device Sync Health Table */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-4">
              <Wifi className="w-4 h-4 text-indigo-600" />
              <span>Device Fleet Sync Health &amp; Delayed Alerts</span>
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                    <th className="py-2 pr-3 font-medium">Staff Member</th>
                    <th className="py-2 pr-3 font-medium">Device ID</th>
                    <th className="py-2 pr-3 font-medium">OS / Ext</th>
                    <th className="py-2 pr-3 font-medium">Shift</th>
                    <th className="py-2 pr-3 font-medium">Last Heartbeat</th>
                    <th className="py-2 pr-3 font-medium">Freshness Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.devices.map((d) => (
                    <tr key={d.deviceId}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900 dark:text-white">
                        {d.userName}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-slate-600 dark:text-slate-300">
                        {d.deviceId}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600 dark:text-slate-300">
                        {d.osPlatform} · {d.extensionConnected ? 'Ext ON' : 'No Ext'}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-slate-600 dark:text-slate-300">
                        {d.shiftPattern}
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {d.delayedSeconds}s ago (seq #{d.lastAckSeq})
                      </td>
                      <td className="py-2.5 pr-3">
                        {d.status === 'live' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
                            <Wifi className="w-3.5 h-3.5" /> Live
                          </span>
                        ) : d.status === 'delayed' ? (
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-semibold">
                            <AlertTriangle className="w-3.5 h-3.5" /> Delayed (IT Notified)
                          </span>
                        ) : d.status === 'offline' ? (
                          <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400 font-semibold">
                            <WifiOff className="w-3.5 h-3.5" /> Offline
                          </span>
                        ) : (
                          <span className="text-slate-500 dark:text-slate-400">Off Shift / Leave</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Staff Roster & Role-Based Permissions */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-4">
              <Users className="w-4 h-4 text-indigo-600" />
              <span>Role Assignments, Shift Calendars &amp; Drill-Down Permissions</span>
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                    <th className="py-2 pr-3 font-medium">User</th>
                    <th className="py-2 pr-3 font-medium">Role</th>
                    <th className="py-2 pr-3 font-medium">Shift</th>
                    <th className="py-2 pr-3 font-medium">On Leave</th>
                    <th className="py-2 pr-3 font-medium">Timeline Drill-Down</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.staffCapacity.map((u) => (
                    <tr key={u.userId}>
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-slate-900 dark:text-white">{u.name}</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">{u.email}</div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <select
                          value={u.role}
                          disabled={busyAction}
                          onChange={(e) =>
                            void handleRoleUpdate(
                              u.userId,
                              e.target.value as UserRole,
                              u.shiftPattern,
                              u.onLeave,
                              u.canDrilldownTimeline
                            )
                          }
                          className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 pr-3">
                        <select
                          value={u.shiftPattern}
                          disabled={busyAction}
                          onChange={(e) =>
                            void handleRoleUpdate(
                              u.userId,
                              u.role,
                              e.target.value as ShiftPattern,
                              u.onLeave,
                              u.canDrilldownTimeline
                            )
                          }
                          className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200"
                        >
                          <option value="8-5">8-5 Shift</option>
                          <option value="5-9">5-9 Shift</option>
                          <option value="remote">Remote</option>
                          <option value="weekend">Weekend</option>
                        </select>
                      </td>
                      <td className="py-2.5 pr-3">
                        <button
                          type="button"
                          disabled={busyAction}
                          onClick={() =>
                            void handleRoleUpdate(
                              u.userId,
                              u.role,
                              u.shiftPattern,
                              !u.onLeave,
                              u.canDrilldownTimeline
                            )
                          }
                          className={`px-2 py-1 rounded border text-[11px] font-medium cursor-pointer ${
                            u.onLeave
                              ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                              : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {u.onLeave ? 'On Leave' : 'Active'}
                        </button>
                      </td>
                      <td className="py-2.5 pr-3">
                        <button
                          type="button"
                          disabled={busyAction}
                          onClick={() =>
                            void handleRoleUpdate(
                              u.userId,
                              u.role,
                              u.shiftPattern,
                              u.onLeave,
                              !u.canDrilldownTimeline
                            )
                          }
                          className={`px-2 py-1 rounded border text-[11px] font-medium cursor-pointer ${
                            u.canDrilldownTimeline
                              ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300'
                              : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {u.canDrilldownTimeline ? 'Permitted (Audit Logged)' : 'Blocked'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* User Invitation & Audit Trail */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <MailPlus className="w-4 h-4 text-indigo-600" />
                <span>Invite Staff or Client Portal User</span>
              </h2>
              <form onSubmit={handleCreateInvite} className="space-y-2.5 text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    required
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Full Name"
                    className="px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                  />
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="Email address"
                    className="px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as UserRole)}
                    className="px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={inviteShift}
                    onChange={(e) => setInviteShift(e.target.value as ShiftPattern)}
                    className="px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                  >
                    <option value="8-5">8-5 Shift</option>
                    <option value="5-9">5-9 Shift</option>
                    <option value="remote">Remote</option>
                    <option value="weekend">Weekend</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={inviteDrilldown}
                    onChange={(e) => setInviteDrilldown(e.target.checked)}
                  />
                  <span>Grant audit-logged timeline drill-down permission</span>
                </label>
                <button
                  type="submit"
                  disabled={busyAction || !currentUser}
                  className="px-3 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  {currentUser ? 'Generate Invitation Token' : 'Sign In as Live Admin to Invite'}
                </button>
              </form>
              {createdInviteUrl && (
                <div className="p-2.5 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-[11px] font-mono break-all text-emerald-800 dark:text-emerald-200">
                  {createdInviteUrl}
                </div>
              )}
              {invites.length > 0 && (
                <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-1 pt-2 border-t border-slate-100 dark:border-slate-800">
                  {invites.slice(0, 4).map((inv) => (
                    <div key={inv.id} className="flex justify-between">
                      <span>{inv.email} ({inv.role})</span>
                      <span>{inv.acceptedAtUtc ? 'Accepted' : 'Pending'}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-3">
                <ShieldCheck className="w-4 h-4 text-indigo-600" />
                <span>Immutable Governance &amp; Drill-Down Audit Log</span>
              </h2>
              <div className="space-y-2 max-h-64 overflow-y-auto text-xs">
                {data.auditLogs.length === 0 ? (
                  <p className="text-slate-500 dark:text-slate-400">No audit entries yet.</p>
                ) : (
                  data.auditLogs.slice(0, 15).map((log) => (
                    <div
                      key={log.id}
                      className="p-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40"
                    >
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className="font-semibold text-indigo-700 dark:text-indigo-300">
                          {log.action}
                        </span>
                        <span className="text-slate-500 dark:text-slate-400">
                          {new Date(log.createdAtUtc).toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-1 text-slate-700 dark:text-slate-300">{log.details}</div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          {/* PORT-2: Firm Portal Branding & Template Milestone Names (Configuration Only, Zero Client Work Content) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <section className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Palette className="w-4 h-4 text-indigo-600" />
                  <span>Client Portal Branding (PORT-2)</span>
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Configure firm logo badge, theme palette, custom domain, and client-facing wording without accessing client deliverables.
                </p>
              </div>
              <form onSubmit={handleSavePortalBranding} className="space-y-2.5 text-xs">
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Portal Title
                    </label>
                    <input
                      type="text"
                      value={brandTitle}
                      onChange={(e) => setBrandTitle(e.target.value)}
                      className="w-full px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Logo Badge
                    </label>
                    <input
                      type="text"
                      maxLength={4}
                      value={brandLogoText}
                      onChange={(e) => setBrandLogoText(e.target.value)}
                      className="w-full px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white font-mono uppercase"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Custom Domain
                    </label>
                    <input
                      type="text"
                      value={brandDomain}
                      onChange={(e) => setBrandDomain(e.target.value)}
                      placeholder="portal.firm-cpa.com"
                      className="w-full px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Accent Palette
                    </label>
                    <select
                      value={brandTheme}
                      onChange={(e) => setBrandTheme(e.target.value as PortalAccentTheme)}
                      className="w-full px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                    >
                      <option value="indigo">Indigo (Firm Default)</option>
                      <option value="emerald">Emerald (Audit &amp; Tax)</option>
                      <option value="blue">Classic Navy Blue</option>
                      <option value="slate">Executive Slate</option>
                      <option value="amber">Warm Advisory Amber</option>
                      <option value="rose">Crimson Partner Accent</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Welcome Message
                  </label>
                  <input
                    type="text"
                    value={brandWelcome}
                    onChange={(e) => setBrandWelcome(e.target.value)}
                    className="w-full px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Confirmed-Milestones Confidentiality Notice
                  </label>
                  <input
                    type="text"
                    value={brandNotice}
                    onChange={(e) => setBrandNotice(e.target.value)}
                    className="w-full px-2.5 py-2 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busyAction}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-50 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Portal Branding</span>
                </button>
              </form>
            </section>

            <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <FileText className="w-4 h-4 text-indigo-600" />
                  <span>Engagement Template Milestone Names (PORT-2)</span>
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Customize the client-facing milestone steps associated with each recurring engagement template (one milestone per line).
                </p>
              </div>
              {templates.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  No task templates configured yet.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {templates.map((tpl) => {
                    const draft = templateDrafts[tpl.id] || {
                      name: tpl.name,
                      milestonesText: (tpl.steps || []).map((s) => s.title).join('\n'),
                    };
                    return (
                      <div
                        key={tpl.id}
                        className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30 space-y-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="text"
                            value={draft.name}
                            onChange={(e) =>
                              setTemplateDrafts((prev) => ({
                                ...prev,
                                [tpl.id]: { ...draft, name: e.target.value },
                              }))
                            }
                            className="flex-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-semibold"
                          />
                          <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                            {tpl.defaultCategory}
                          </span>
                        </div>
                        <textarea
                          rows={4}
                          value={draft.milestonesText}
                          onChange={(e) =>
                            setTemplateDrafts((prev) => ({
                              ...prev,
                              [tpl.id]: { ...draft, milestonesText: e.target.value },
                            }))
                          }
                          className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 font-mono text-[11px]"
                        />
                        <button
                          type="button"
                          disabled={busyAction}
                          onClick={() => void handleSaveTemplateMilestones(tpl.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 cursor-pointer disabled:opacity-50"
                        >
                          <Save className="w-3 h-3" />
                          <span>Save Template Milestones</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {/* MANAGEMENT & EXECUTIVE VIEWS (team_lead, line_manager, executive) */}
      {activeRole !== 'admin_it' && (
        <>
          {/* KPI Strip */}
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
                <span>Average Shift Utilization</span>
                <Users className="w-4 h-4 text-indigo-600" />
              </div>
              <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                {avgUtilization}%
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Calculated from 8-5 / 5-9 / remote / weekend shift calendars
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
                <span>Deadlines At Risk</span>
                <ShieldAlert className="w-4 h-4 text-rose-600" />
              </div>
              <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
                {highRiskCount}
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Remaining estimated work exceeds remaining time
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
                <span>
                  {activeRole === 'executive' ? 'Billable Fee Portfolio' : 'Active Client Engagements'}
                </span>
                <Building2 className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
                {activeRole === 'executive'
                  ? `$${totalFeePortfolio.toLocaleString()}`
                  : data.clientProfitability.length}
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                {activeRole === 'executive'
                  ? 'Estimated realization across visible clients'
                  : 'Scoped to role & restricted client rules'}
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center justify-between">
                <span>Timeline Privacy Boundary</span>
                <Lock className="w-4 h-4 text-slate-500" />
              </div>
              <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-white">
                {activeRole === 'executive'
                  ? 'Aggregates Only (No Raw Timelines)'
                  : 'Aggregated by Default'}
              </div>
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                {activeRole === 'executive'
                  ? 'Individual timelines strictly hidden at server'
                  : 'Individual drill-down requires permission & audit log'}
              </div>
            </div>
          </section>

          {/* Workload Heatmap & Shift Capacity */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-indigo-600" />
                <span>
                  {activeRole === 'executive'
                    ? 'Firm-Wide Capacity & Utilization Overview'
                    : 'Team Workload Heatmap (Shift-Adjusted Capacity)'}
                </span>
              </h2>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                8-5 (40h) · 5-9 (20h) · Remote (40h) · Weekend (16h) · Leave (0h)
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                    <th className="py-2 pr-3 font-medium">Staff Member</th>
                    <th className="py-2 pr-3 font-medium">Shift</th>
                    <th className="py-2 pr-3 font-medium">Available</th>
                    <th className="py-2 pr-3 font-medium">Assigned</th>
                    <th className="py-2 pr-3 font-medium">Tracked (Agg.)</th>
                    <th className="py-2 pr-3 font-medium w-48">Utilization Heatmap</th>
                    {(activeRole === 'team_lead' || activeRole === 'line_manager') && (
                      <th className="py-2 pr-3 font-medium text-right">Audit-Logged Drill-Down</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.staffCapacity.map((row) => {
                    const barColor =
                      row.utilizationPercent >= 95
                        ? 'bg-rose-600'
                        : row.utilizationPercent >= 75
                        ? 'bg-amber-500'
                        : 'bg-emerald-600';
                    const pct = Math.max(0, Math.min(100, row.utilizationPercent));
                    const barWidthClass =
                      pct >= 95
                        ? 'w-full'
                        : pct >= 85
                        ? 'w-5/6'
                        : pct >= 70
                        ? 'w-3/4'
                        : pct >= 55
                        ? 'w-3/5'
                        : pct >= 45
                        ? 'w-1/2'
                        : pct >= 30
                        ? 'w-1/3'
                        : pct >= 15
                        ? 'w-1/6'
                        : pct > 0
                        ? 'w-1/12'
                        : 'w-0';
                    return (
                      <tr key={row.userId}>
                        <td className="py-2.5 pr-3">
                          <div className="font-medium text-slate-900 dark:text-white">
                            {row.name}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {row.teamId} · {row.role}
                          </div>
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-slate-700 dark:text-slate-300">
                          {row.onLeave ? 'On Leave' : row.shiftPattern}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {row.availableHoursWeek}h
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {row.assignedHoursWeek}h
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {row.trackedHoursWeek}h
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-slate-100 dark:bg-slate-800 rounded overflow-hidden">
                              <div className={`h-full ${barColor} ${barWidthClass}`} />
                            </div>
                            <span className="font-mono tabular-nums text-[11px] w-10 text-right text-slate-700 dark:text-slate-300">
                              {row.utilizationPercent}%
                            </span>
                          </div>
                        </td>
                        {(activeRole === 'team_lead' || activeRole === 'line_manager') && (
                          <td className="py-2.5 pr-3 text-right">
                            {onInspectStaffTimeline && (
                              <button
                                type="button"
                                onClick={() => onInspectStaffTimeline(row.userId)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer"
                              >
                                <Eye className="w-3 h-3" />
                                <span>Inspect Timeline</span>
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <span>
                Effective weekly availability applies the configured{' '}
                <strong className="font-mono text-slate-700 dark:text-slate-200">
                  {Math.round((data.focusFactor ?? 0.85) * 100)}%
                </strong>{' '}
                focus factor and deducts active leave.
              </span>
              <span className="font-mono">
                {data.staffCapacity.filter((s) => s.onLeave).length} staff currently on leave
              </span>
            </div>
          </section>

          {/* Day-by-Day Shift Workload Heatmap (Mon–Sat net of leave) */}
          {data.shiftHeatmap.length > 0 && (
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <CalendarClock className="w-4 h-4 text-indigo-600" />
                  <span>This Week Shift Workload Heatmap (Net of Leave)</span>
                </h2>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  Assigned vs available focus hours per day ({Math.round((data.focusFactor ?? 0.85) * 100)}% focus factor)
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                      <th className="py-2 pr-3 font-medium">Shift Schedule</th>
                      <th className="py-2 px-2 font-medium text-right">Staff / Leave</th>
                      {data.shiftHeatmap[0]?.days.map((d) => (
                        <th key={d.dayLabel} className="py-2 px-2 font-medium text-center">
                          {d.dayLabel}
                        </th>
                      ))}
                      <th className="py-2 pl-3 font-medium text-right">Weekly Net Cap.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {data.shiftHeatmap.map((row) => (
                      <tr key={row.shiftPattern}>
                        <td className="py-2.5 pr-3 font-medium text-slate-900 dark:text-white whitespace-nowrap">
                          {row.shiftLabel}
                        </td>
                        <td className="py-2.5 px-2 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {row.staffCount} · {row.onLeaveCount} leave
                        </td>
                        {row.days.map((cell) => {
                          const cellStyle =
                            cell.availableHoursNetLeave === 0
                              ? 'bg-slate-50 dark:bg-slate-800/40 text-slate-400 dark:text-slate-500 border-slate-200 dark:border-slate-800'
                              : cell.utilizationPercent >= 95
                              ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 border-rose-200 dark:border-rose-800'
                              : cell.utilizationPercent >= 75
                              ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-800'
                              : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-800';
                          return (
                            <td key={cell.dayLabel} className="py-1.5 px-1.5 text-center">
                              <div
                                className={`px-2 py-1.5 rounded border font-mono tabular-nums text-[11px] ${cellStyle}`}
                              >
                                <div className="font-semibold">
                                  {cell.availableHoursNetLeave > 0
                                    ? `${cell.utilizationPercent}%`
                                    : 'Off'}
                                </div>
                                <div className="text-[10px] opacity-80">
                                  {cell.assignedHours}h / {cell.availableHoursNetLeave}h
                                </div>
                              </div>
                            </td>
                          );
                        })}
                        <td className="py-2.5 pl-3 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200 whitespace-nowrap">
                          {row.weeklyAssignedHours}h / {row.weeklyAvailableHoursNetLeave}h
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Deadline Risk & Recurring Capacity Forecast */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Clock className="w-4 h-4 text-rose-600" />
                  <span>Tasks Progress &amp; Deadline Risk Watchlist</span>
                </h2>
                <div className="flex items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-2 rounded-xs bg-indigo-600 inline-block" />
                    <span>Confirmed</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-2 rounded-xs bg-hatched-detected border border-indigo-400/50 inline-block" />
                    <span>Detected</span>
                  </span>
                </div>
              </div>
              <div className="space-y-3">
                {data.deadlineRisks.map((item) => {
                  const confirmedPct =
                    item.estimatedHours > 0
                      ? Math.round((item.confirmedHours / item.estimatedHours) * 100)
                      : 0;
                  const detectedPct =
                    item.estimatedHours > 0
                      ? Math.round((item.detectedHours / item.estimatedHours) * 100)
                      : 0;
                  const confirmedCls = percentToWidthClass(confirmedPct);
                  const detectedCls = percentToWidthClass(
                    Math.min(100 - confirmedPct, detectedPct)
                  );

                  return (
                    <div
                      key={item.taskId}
                      className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-900 dark:text-white">
                            {item.title}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {item.clientName} · {item.period} · {item.assignedUserName}
                          </div>
                        </div>
                        <span
                          className={`px-2 py-0.5 rounded border text-[11px] font-mono font-semibold whitespace-nowrap ${
                            item.riskLevel === 'high'
                              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                              : item.riskLevel === 'medium'
                              ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                          }`}
                        >
                          {item.riskLevel.toUpperCase()} RISK
                        </span>
                      </div>

                      {/* Solid (confirmed) + Hatched (detected) progress bar */}
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2.5 bg-slate-200/80 dark:bg-slate-800 rounded overflow-hidden flex">
                          {confirmedPct > 0 && (
                            <div
                              title={`Confirmed: ${item.confirmedHours}h`}
                              className={`h-full bg-indigo-600 ${confirmedCls}`}
                            />
                          )}
                          {detectedPct > 0 && (
                            <div
                              title={`Detected / Suggested: ${item.detectedHours}h`}
                              className={`h-full bg-hatched-detected ${detectedCls}`}
                            />
                          )}
                        </div>
                        <span className="font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          {item.confirmedHours}h conf. + {item.detectedHours}h det. / {item.estimatedHours}h est.
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        <span>
                          Remaining effort: <strong className="text-slate-700 dark:text-slate-200">{item.remainingHours}h</strong>
                        </span>
                        <span>
                          Shift avail. before due (@{Math.round(item.focusFactor * 100)}% focus):{' '}
                          <strong className="text-slate-700 dark:text-slate-200">
                            {item.availableHoursBeforeDue}h
                          </strong>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-5">
              <div>
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-3">
                  <CalendarClock className="w-4 h-4 text-indigo-600" />
                  <span>4-Week Recurring Close &amp; Filing Forecast</span>
                </h2>
                <div className="space-y-2.5">
                  {data.recurringForecast.map((wk) => (
                    <div
                      key={wk.weekLabel}
                      className="p-2.5 rounded border border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-white">
                          {wk.weekLabel}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {wk.projectedRecurringHours}h projected vs {wk.teamAvailableHours}h net cap.
                          {wk.leaveDeductedHours > 0
                            ? ` (-${wk.leaveDeductedHours}h leave)`
                            : ''}
                        </div>
                      </div>
                      <span
                        className={`font-mono text-[11px] font-semibold whitespace-nowrap ${
                          wk.status === 'overallocated'
                            ? 'text-rose-600 dark:text-rose-400'
                            : wk.status === 'tight'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {wk.capacityDeltaHours >= 0
                          ? `+${wk.capacityDeltaHours}h free`
                          : `${wk.capacityDeltaHours}h deficit`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
                <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-3">
                  <TrendingUp className="w-4 h-4 text-emerald-600" />
                  <span>Client Effort &amp; Profitability</span>
                </h3>
                <div className="space-y-2 text-xs">
                  {data.clientProfitability.map((c) => (
                    <div
                      key={c.clientId}
                      className="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-slate-800/70 last:border-b-0"
                    >
                      <div>
                        <div className="font-medium text-slate-900 dark:text-white">
                          {c.clientName}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {c.completedCount}/{c.taskCount} tasks · {c.trackedHours}h tracked / {c.estimatedHours}h est.
                        </div>
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          ${c.estimatedFeeUsd.toLocaleString()}
                        </div>
                        <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                          {c.realizationPercent}% realiz.
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* Shift Handoffs Across 8-5 & 5-9 (Team Leads & Line Managers only, never Executive or Admin/IT) */}
          {(activeRole === 'team_lead' || activeRole === 'line_manager') && (
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <ArrowRightLeft className="w-4 h-4 text-indigo-600" />
                  <span>Cross-Shift Handoffs (8-5 &amp; 5-9 Continuity)</span>
                </h2>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  {data.handoffs.length} active handoff thread{data.handoffs.length === 1 ? '' : 's'}
                </span>
              </div>
              {data.handoffs.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  No open cross-shift handoffs are currently queued for this team.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  {data.handoffs.map((h) => (
                    <div
                      key={`${h.taskId}-${h.assignedUserId}`}
                      className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {h.taskTitle}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {h.clientName} · {h.period} · {h.assignedUserName} ({h.shiftPattern} shift)
                          </div>
                        </div>
                        <span className="font-mono tabular-nums text-[11px] text-indigo-700 dark:text-indigo-300 whitespace-nowrap">
                          {h.totalMinutes}m logged
                        </span>
                      </div>
                      <p className="text-slate-700 dark:text-slate-300 leading-relaxed">
                        {h.handoffNote}
                      </p>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
                        <div>
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            Confirmed steps ({h.confirmedSteps.length}):
                          </span>{' '}
                          {h.confirmedSteps.length > 0 ? h.confirmedSteps.join(', ') : 'None yet'}
                        </div>
                        <div>
                          <span className="font-medium text-slate-700 dark:text-slate-200">
                            Pending pickup ({h.pendingSteps.length}):
                          </span>{' '}
                          {h.pendingSteps.length > 0 ? h.pendingSteps.join(', ') : 'All confirmed'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {activeRole === 'executive' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <section className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Users className="w-4 h-4 text-indigo-600" />
                  <span>Practice Team Capacity Rollup</span>
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Aggregated department capacity across shifts without exposing raw individual workstation timelines.
                </p>
                <div className="space-y-2.5">
                  {Array.from(
                    data.staffCapacity.reduce((map, row) => {
                      const prev = map.get(row.teamId) || {
                        teamId: row.teamId,
                        members: 0,
                        available: 0,
                        assigned: 0,
                        tracked: 0,
                      };
                      prev.members += 1;
                      prev.available += row.availableHoursWeek;
                      prev.assigned += row.assignedHoursWeek;
                      prev.tracked += row.trackedHoursWeek;
                      map.set(row.teamId, prev);
                      return map;
                    }, new Map<string, { teamId: string; members: number; available: number; assigned: number; tracked: number }>())
                      .values()
                  ).map((team) => {
                    const loadPct =
                      team.available > 0
                        ? Math.round((Math.max(team.assigned, team.tracked) / team.available) * 100)
                        : 0;
                    return (
                      <div
                        key={team.teamId}
                        className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-mono font-semibold text-slate-900 dark:text-white">
                            {team.teamId}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">
                            {team.members} staff · {team.assigned.toFixed(1)}h assigned / {team.available}h shift cap.
                          </div>
                        </div>
                        <span className="font-mono tabular-nums font-bold text-indigo-700 dark:text-indigo-300">
                          {loadPct}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
                <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-3">
                  <ShieldCheck className="w-4 h-4 text-indigo-600" />
                  <span>Executive Governance &amp; Drill-Down Audit Log</span>
                </h2>
                <div className="space-y-2 max-h-64 overflow-y-auto text-xs">
                  {data.auditLogs.length === 0 ? (
                    <p className="text-slate-500 dark:text-slate-400">No governance audit events recorded yet.</p>
                  ) : (
                    data.auditLogs.slice(0, 20).map((log) => (
                      <div
                        key={log.id}
                        className="p-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40"
                      >
                        <div className="flex items-center justify-between font-mono text-[11px]">
                          <span className="font-semibold text-indigo-700 dark:text-indigo-300">
                            {log.action}
                          </span>
                          <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                            {new Date(log.createdAtUtc).toLocaleString()}
                          </span>
                        </div>
                        <div className="mt-1 text-slate-700 dark:text-slate-300">{log.details}</div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
};
