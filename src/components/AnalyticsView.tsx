import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Target, Layers, AppWindow, FileText, Search, X } from 'lucide-react';
import { ClientDictionaryEntry, UserRole } from '../engine/types';
import { AuthUser } from '../services/authClient';
import { fetchRoleOverviewApi, RoleOverviewData } from '../services/portalClient';
import {
  ActivitySegment,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  Task,
  TimeBlock,
} from '../types';
import {
  buildDailyFocusSeries,
  buildPresenceStats,
  buildProjectComparison,
  buildWeeklyAppSummary,
  buildWeeklyDocSummary,
  deriveDynamicWorkstreams,
} from '../utils/analyticsMetrics';
import {
  formatDuration,
  getAppColorTokens,
} from '../utils/workspaceConstants';

interface AnalyticsViewProps {
  weekDates: string[];
  tasks: Task[];
  timeBlocks: TimeBlock[];
  activitySegments: ActivitySegment[];
  appSegments: ApplicationUsageSegment[];
  documentSegments: DocumentUsageSegment[];
  clients?: ClientDictionaryEntry[];
  appColors?: Record<string, string>;
  activeRole?: UserRole;
  currentUser?: AuthUser | null;
  onSelectDateAndGoToTimeline: (date: string) => void;
}

export const AnalyticsView: React.FC<AnalyticsViewProps> = ({
  weekDates,
  tasks,
  timeBlocks,
  activitySegments,
  appSegments,
  documentSegments,
  clients = [],
  appColors = {},
  activeRole = 'accountant',
  currentUser = null,
  onSelectDateAndGoToTimeline,
}) => {
  const isExecutiveScope = activeRole === 'executive';
  const isOverviewRole =
    activeRole === 'executive' ||
    activeRole === 'line_manager' ||
    activeRole === 'team_lead';
  const tenantId = currentUser?.tenantId || 'firm_demo';
  const [execOverview, setExecOverview] = useState<RoleOverviewData | null>(null);
  const [selectedWorkstream, setSelectedWorkstream] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [matrixScope, setMatrixScope] = useState<'week' | 'all'>('week');

  useEffect(() => {
    if (!isOverviewRole) return;
    let active = true;
    const run = async () => {
      try {
        const overview = await fetchRoleOverviewApi({
          tenantId,
          viewerRole: activeRole,
        });
        if (active) setExecOverview(overview);
      } catch {
        if (active) setExecOverview(null);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [isOverviewRole, activeRole, tenantId]);

  const workstreamOptions = useMemo(
    () =>
      deriveDynamicWorkstreams({
        clients,
        tasks,
        timeBlocks,
      }),
    [clients, tasks, timeBlocks]
  );

  const effectiveSelectedWorkstream = useMemo(() => {
    if (selectedWorkstream === 'all') return 'all';
    const match = workstreamOptions.find(
      (w) => w.toLowerCase() === selectedWorkstream.toLowerCase()
    );
    return match || 'all';
  }, [selectedWorkstream, workstreamOptions]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (
        effectiveSelectedWorkstream !== 'all' &&
        t.project.trim().toLowerCase() !== effectiveSelectedWorkstream.toLowerCase()
      ) {
        return false;
      }
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.project.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [tasks, effectiveSelectedWorkstream, searchQuery]);

  const filteredTimeBlocks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return timeBlocks.filter((b) => {
      if (
        effectiveSelectedWorkstream !== 'all' &&
        b.project.trim().toLowerCase() !== effectiveSelectedWorkstream.toLowerCase()
      ) {
        return false;
      }
      if (!q) return true;
      return (
        b.title.toLowerCase().includes(q) ||
        b.project.toLowerCase().includes(q) ||
        (b.appName || '').toLowerCase().includes(q) ||
        (b.documentTitle || '').toLowerCase().includes(q)
      );
    });
  }, [timeBlocks, effectiveSelectedWorkstream, searchQuery]);

  const dailySeries = useMemo(
    () =>
      buildDailyFocusSeries({
        weekDates,
        timeBlocks: filteredTimeBlocks,
      }),
    [weekDates, filteredTimeBlocks]
  );

  const maxDayMins = useMemo(
    () => Math.max(240, ...dailySeries.map((d) => d.totalMins)),
    [dailySeries]
  );

  const projectComparison = useMemo(() => {
    const rows = buildProjectComparison({
      clients,
      tasks,
      timeBlocks,
      weekDates: matrixScope === 'week' ? weekDates : undefined,
      searchQuery,
    });
    if (effectiveSelectedWorkstream === 'all') return rows;
    return rows.filter(
      (r) => r.project.toLowerCase() === effectiveSelectedWorkstream.toLowerCase()
    );
  }, [
    clients,
    tasks,
    timeBlocks,
    matrixScope,
    weekDates,
    searchQuery,
    effectiveSelectedWorkstream,
  ]);

  const presenceStats = useMemo(
    () => buildPresenceStats(activitySegments, weekDates),
    [activitySegments, weekDates]
  );

  const weeklyAppSummary = useMemo(
    () =>
      buildWeeklyAppSummary({
        appSegments,
        weekDates,
        searchQuery,
      }),
    [appSegments, weekDates, searchQuery]
  );

  const weeklyDocSummary = useMemo(
    () =>
      buildWeeklyDocSummary({
        documentSegments,
        weekDates,
        searchQuery,
      }),
    [documentSegments, weekDates, searchQuery]
  );

  if (isExecutiveScope && execOverview) {
    const fs = execOverview.freshnessSummary;
    const q = searchQuery.trim().toLowerCase();
    const visibleClients = execOverview.clientProfitability.filter(
      (c) => !q || c.clientName.toLowerCase().includes(q)
    );
    const totalEstimatedHrs = visibleClients.reduce(
      (s, c) => s + c.estimatedHours,
      0
    );
    const totalTrackedHrs = visibleClients.reduce(
      (s, c) => s + c.trackedHours,
      0
    );
    const totalFeeUsd = visibleClients.reduce(
      (s, c) => s + c.estimatedFeeUsd,
      0
    );
    const avgUtil =
      execOverview.staffCapacity.length > 0
        ? Math.round(
            execOverview.staffCapacity.reduce((s, r) => s + r.utilizationPercent, 0) /
              execOverview.staffCapacity.length
          )
        : 0;

    return (
      <div className="space-y-6">
        <div className="pb-2 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
              Firm Analytics &amp; Realization Matrix
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
              Aggregated client realization, shift capacity balance, and portfolio throughput ({execOverview.tenantName})
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {fs.reportingLiveCount}/{fs.totalActiveShiftStaff} live · As of{' '}
            {new Date(fs.dataAsOfUtc).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}{' '}
            UTC{fs.provisional ? ' · Provisional' : ''}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter client engagements..."
              aria-label="Filter client engagements"
              className="w-full pl-8 pr-8 py-2 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="text-xs text-slate-500 font-mono tabular-nums">
            Showing {visibleClients.length} of {execOverview.clientProfitability.length} engagements
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            <div className="text-xs font-medium text-slate-500">Firm Utilization</div>
            <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
              {avgUtil}%
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Across {execOverview.staffCapacity.length} scheduled staff members
            </div>
          </div>

          <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            <div className="text-xs font-medium text-slate-500">Portfolio Tracked vs Estimated</div>
            <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
              {totalTrackedHrs.toFixed(1)}h / {totalEstimatedHrs.toFixed(1)}h
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Firm engagement totals (raw individual timelines hidden)
            </div>
          </div>

          <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
            <div className="text-xs font-medium text-slate-500">Estimated Fee Portfolio</div>
            <div className="mt-2 font-mono text-2xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
              ${totalFeeUsd.toLocaleString()}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              Across {visibleClients.length} visible client engagements
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Client Engagement Realization &amp; Profitability
            </h2>
          </div>
          {visibleClients.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500 space-y-2">
              <p>No client engagements match the current filter.</p>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="px-3 py-1.5 font-semibold text-indigo-600 dark:text-indigo-400 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Clear Filter
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 bg-slate-50/70 dark:bg-slate-800/40">
                    <th className="py-2.5 px-5">Client Engagement</th>
                    <th className="py-2.5 px-5 text-right">Completed / Total</th>
                    <th className="py-2.5 px-5 text-right">Estimated Hours</th>
                    <th className="py-2.5 px-5 text-right">Tracked Hours</th>
                    <th className="py-2.5 px-5 text-right">Est. Fee</th>
                    <th className="py-2.5 px-5 text-right">Realization</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {visibleClients.map((row) => (
                    <tr key={row.clientId}>
                      <td className="py-3.5 px-5 font-semibold text-slate-900 dark:text-white">
                        {row.clientName}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {row.completedCount} / {row.taskCount}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {row.estimatedHours}h
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                        {row.trackedHours}h
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                        ${row.estimatedFeeUsd.toLocaleString()}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
                        {row.realizationPercent}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  }

  const isEmptyWorkspace =
    tasks.length === 0 &&
    timeBlocks.length === 0 &&
    appSegments.length === 0 &&
    activitySegments.length === 0 &&
    clients.length === 0;

  const weekDateSet = new Set(weekDates);
  const weekFilteredBlocks = filteredTimeBlocks.filter((b) => weekDateSet.has(b.date));
  const activeLoggedDays = dailySeries.filter((d) => d.totalMins > 0).length;
  const avgDailyMins = Math.round(
    weekFilteredBlocks.reduce((s, b) => s + b.durationMinutes, 0) /
      Math.max(1, activeLoggedDays)
  );
  const hasActiveFilter =
    effectiveSelectedWorkstream !== 'all' || searchQuery.trim().length > 0;

  return (
    <div className="space-y-6">
      <div className="pb-2 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            Productivity &amp; Estimation Analytics
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            7-day focus rhythm, tenant client estimation accuracy, and workstation presence telemetry
          </p>
        </div>
        {execOverview && (
          <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {execOverview.freshnessSummary.reportingLiveCount}/
            {execOverview.freshnessSummary.totalActiveShiftStaff} live · As of{' '}
            {new Date(execOverview.freshnessSummary.dataAsOfUtc).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}{' '}
            UTC{execOverview.freshnessSummary.provisional ? ' · Provisional' : ''}
          </div>
        )}
      </div>

      {/* Interactive Filter & Scope Toolbar */}
      <div
        data-testid="analytics-filter-bar"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-0">
          <div className="relative min-w-[220px] flex-1 max-w-xs">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search client, task, app, or file..."
              aria-label="Search analytics data"
              className="w-full pl-8 pr-8 py-2 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search query"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <select
            aria-label="Filter by client or workstream"
            value={effectiveSelectedWorkstream}
            onChange={(e) => setSelectedWorkstream(e.target.value)}
            className="px-3 py-2 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-slate-200 max-w-[240px]"
          >
            <option value="all">
              All Clients &amp; Workstreams ({workstreamOptions.length})
            </option>
            {workstreamOptions.map((ws) => (
              <option key={ws} value={ws}>
                {ws}
              </option>
            ))}
          </select>

          {hasActiveFilter && (
            <button
              type="button"
              onClick={() => {
                setSelectedWorkstream('all');
                setSearchQuery('');
              }}
              className="px-3 py-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              Clear Filter
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shrink-0">
          <button
            type="button"
            onClick={() => setMatrixScope('week')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              matrixScope === 'week'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            7-Day Window
          </button>
          <button
            type="button"
            onClick={() => setMatrixScope('all')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              matrixScope === 'all'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            All Recorded
          </button>
        </div>
      </div>

      {isEmptyWorkspace && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              No tracked productivity data yet
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Start an active stopwatch, log a block on the Day Timeline, or connect your Desktop Agent to populate live analytics.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onSelectDateAndGoToTimeline(weekDates[weekDates.length - 1])}
            className="px-3.5 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg shrink-0 cursor-pointer whitespace-nowrap"
          >
            Go to Today&apos;s Timeline
          </button>
        </div>
      )}

      {/* Top 3 Summary KPI Panels */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Clock className="w-4 h-4 text-indigo-600" />
            <span>Workstation Focus Efficiency</span>
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {presenceStats.focusEfficiency}% Active
          </div>
          <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Active: {formatDuration(presenceStats.activeMins)} · Idle:{' '}
            {formatDuration(presenceStats.idleMins)} · Away:{' '}
            {formatDuration(presenceStats.awayMins)}
          </div>
        </div>

        <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Target className="w-4 h-4 text-emerald-600" />
            <span>
              {effectiveSelectedWorkstream === 'all'
                ? 'Scoped Deliverables'
                : `${effectiveSelectedWorkstream} Deliverables`}
            </span>
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {filteredTasks.filter((t) => t.status === 'completed').length} /{' '}
            {filteredTasks.length} Shipped
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {filteredTasks.filter((t) => t.status === 'blocked').length} blocked task
            {filteredTasks.filter((t) => t.status === 'blocked').length === 1 ? '' : 's'} currently awaiting external action
          </div>
        </div>

        <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Layers className="w-4 h-4 text-amber-600" />
            <span>Average Daily Tracked Output</span>
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {formatDuration(avgDailyMins)} / active day
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Across {activeLoggedDays} active logged day{activeLoggedDays === 1 ? '' : 's'} this week
          </div>
        </div>
      </div>

      {/* 7-Day Daily Stacked Distribution */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Daily Focus Distribution (Click Any Day to Inspect Timeline)
            </h2>
            <p className="text-xs text-slate-500">
              Proportional breakdown of Deep Work, Billable Delivery, Collaborative, and Admin hours
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>Indigo: Deep Work</span>
            <span>·</span>
            <span>Emerald: Billable</span>
            <span>·</span>
            <span>Amber: Collaborative</span>
          </div>
        </div>

        <div className="space-y-3 pt-2">
          {dailySeries.map((day) => {
            const widthPct = Math.round((day.totalMins / maxDayMins) * 100);
            const deepShare =
              day.totalMins > 0 ? (day.deepMins / day.totalMins) * 100 : 0;
            const billableShare =
              day.totalMins > 0 ? (day.billableMins / day.totalMins) * 100 : 0;
            const collabShare =
              day.totalMins > 0 ? (day.collabMins / day.totalMins) * 100 : 0;
            const adminShare =
              day.totalMins > 0 ? (day.adminMins / day.totalMins) * 100 : 0;

            return (
              <div
                key={day.date}
                onClick={() => onSelectDateAndGoToTimeline(day.date)}
                className="grid grid-cols-[110px_1fr_90px] items-center gap-4 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
              >
                <div className="font-mono text-xs font-medium text-slate-700 dark:text-slate-300 tabular-nums">
                  {day.date}
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 h-5 rounded-md overflow-hidden">
                  {day.totalMins > 0 && (
                    <div
                      style={{ width: `${Math.max(4, widthPct)}%` }}
                      className="h-full flex"
                    >
                      <div
                        style={{ width: `${deepShare}%` }}
                        className="bg-indigo-600 h-full"
                        title={`Deep Work: ${formatDuration(day.deepMins)}`}
                      />
                      <div
                        style={{ width: `${billableShare}%` }}
                        className="bg-emerald-600 h-full"
                        title={`Billable: ${formatDuration(day.billableMins)}`}
                      />
                      <div
                        style={{ width: `${collabShare}%` }}
                        className="bg-amber-500 h-full"
                        title={`Collaborative: ${formatDuration(day.collabMins)}`}
                      />
                      <div
                        style={{ width: `${adminShare}%` }}
                        className="bg-slate-400 h-full"
                        title={`Admin: ${formatDuration(day.adminMins)}`}
                      />
                    </div>
                  )}
                </div>
                <div className="text-right font-mono text-xs font-semibold tabular-nums text-slate-900 dark:text-white">
                  {formatDuration(day.totalMins)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Dynamic Client & Workstream Planned vs Actual Matrix */}
      <div
        data-testid="analytics-project-matrix"
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Client &amp; Workstream Estimation Accuracy Matrix
            </h2>
            <p className="text-xs text-slate-500">
              Live comparison of tenant client task estimates against OnTrack-logged blocks ({matrixScope === 'week' ? '7-day window' : 'all recorded time'}) · Click any row to filter
            </p>
          </div>
          <div className="font-mono text-xs tabular-nums text-slate-500">
            {projectComparison.length} workstream{projectComparison.length === 1 ? '' : 's'}
          </div>
        </div>

        {projectComparison.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500 space-y-2">
            <p>
              {hasActiveFilter
                ? 'No tenant clients or workstreams match the active filter.'
                : 'No client engagements or task workstreams recorded yet.'}
            </p>
            {hasActiveFilter && (
              <button
                type="button"
                onClick={() => {
                  setSelectedWorkstream('all');
                  setSearchQuery('');
                }}
                className="px-3 py-1.5 font-semibold text-indigo-600 dark:text-indigo-400 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                Reset Filter
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 bg-slate-50/70 dark:bg-slate-800/40">
                  <th className="py-2.5 px-5">Client / Workstream</th>
                  <th className="py-2.5 px-5 text-right">Scoped Tasks</th>
                  <th className="py-2.5 px-5 text-right">Completed</th>
                  <th className="py-2.5 px-5 text-right">Planned Estimate</th>
                  <th className="py-2.5 px-5 text-right">Actual Logged</th>
                  <th className="py-2.5 px-5 text-right">Billable</th>
                  <th className="py-2.5 px-5 text-right">Utilization Ratio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {projectComparison.map((row) => {
                  const isRowSelected =
                    effectiveSelectedWorkstream !== 'all' &&
                    effectiveSelectedWorkstream.toLowerCase() === row.project.toLowerCase();
                  return (
                    <tr
                      key={row.project}
                      onClick={() =>
                        setSelectedWorkstream(isRowSelected ? 'all' : row.project)
                      }
                      className={`transition-colors cursor-pointer ${
                        isRowSelected
                          ? 'bg-indigo-50/70 dark:bg-indigo-950/30'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-3.5 px-5">
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {row.project}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {row.isConfiguredClient ? 'Tenant Client Engagement' : 'Firm Workstream'}
                          {row.blockedTasks > 0 ? ` · ${row.blockedTasks} blocked` : ''}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {row.taskCount}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums text-emerald-600 font-semibold">
                        {row.completedTasks}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {formatDuration(row.plannedMins)}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                        {formatDuration(row.actualMins)}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatDuration(row.billableMins)}
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums">
                        {row.utilizationPercent === null ? (
                          <span className="text-slate-400">
                            {row.actualMins > 0 ? 'Unestimated' : '—'}
                          </span>
                        ) : (
                          <span
                            className={
                              row.utilizationPercent > 110
                                ? 'text-amber-600 font-semibold'
                                : 'text-slate-700 dark:text-slate-300'
                            }
                          >
                            {row.utilizationPercent}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 7-Day Applications Used & Most Referenced Documents */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <AppWindow className="w-4 h-4 text-sky-600" />
                <span>7-Day Applications Used</span>
              </h2>
              <p className="text-xs text-slate-500">
                Cumulative foreground application distribution across the selected week
              </p>
            </div>
          </div>

          {weeklyAppSummary.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">
              {searchQuery
                ? 'No applications match the active search query.'
                : 'No application telemetry recorded in this 7-day window.'}
            </p>
          ) : (
            <div className="space-y-3 pt-1">
              {weeklyAppSummary.map((item) => {
                const tokens = getAppColorTokens(item.appName, appColors);
                return (
                  <div key={item.appName} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-2 font-medium text-slate-800 dark:text-slate-200 min-w-0 truncate">
                        <span
                          aria-hidden="true"
                          style={tokens.customHex ? { backgroundColor: tokens.customHex } : undefined}
                          className={`w-2.5 h-2.5 rounded-xs shrink-0 ${tokens.customHex ? '' : tokens.bar}`}
                        />
                        <span className="truncate">{item.appName}</span>
                      </span>
                      <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400 shrink-0">
                        {formatDuration(item.mins)} ({item.sharePct}%)
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        style={{
                          width: `${Math.max(4, item.sharePct)}%`,
                          ...(tokens.customHex ? { backgroundColor: tokens.customHex } : {}),
                        }}
                        className={`h-full rounded-full ${tokens.customHex ? '' : tokens.bar}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-indigo-600" />
              <span>Most Referenced Documents &amp; Files</span>
            </h2>
            <p className="text-xs text-slate-500">
              Top active files, browser tabs, and workpapers tracked this week
            </p>
          </div>

          {weeklyDocSummary.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">
              {searchQuery
                ? 'No recorded documents match the active search query.'
                : 'No document or window focus sessions recorded yet.'}
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {weeklyDocSummary.map((doc, idx) => (
                <div
                  key={`${doc.appName}-${doc.documentTitle}-${idx}`}
                  className="py-2.5 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-white truncate">
                      {doc.documentTitle}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {doc.appName} · {doc.domainOrPath}
                    </div>
                  </div>
                  <div className="font-mono font-semibold tabular-nums text-slate-800 dark:text-slate-200 shrink-0">
                    {formatDuration(doc.mins)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
