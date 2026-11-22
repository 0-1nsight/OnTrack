import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Target, Layers, AppWindow, FileText } from 'lucide-react';
import { UserRole } from '../engine/types';
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
  APP_COLORS,
  PROJECTS,
  formatDuration,
} from '../utils/workspaceConstants';

interface AnalyticsViewProps {
  weekDates: string[];
  tasks: Task[];
  timeBlocks: TimeBlock[];
  activitySegments: ActivitySegment[];
  appSegments: ApplicationUsageSegment[];
  documentSegments: DocumentUsageSegment[];
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
  // Daily breakdown across the 7-day window
  const dailySeries = useMemo(() => {
    return weekDates.map((date) => {
      const blocks = timeBlocks.filter((b) => b.date === date);
      const totalMins = blocks.reduce((s, b) => s + b.durationMinutes, 0);
      const deepMins = blocks
        .filter((b) => b.category === 'deep_work')
        .reduce((s, b) => s + b.durationMinutes, 0);
      const billableMins = blocks
        .filter((b) => b.isBillable || b.category === 'billable')
        .reduce((s, b) => s + b.durationMinutes, 0);
      const collabMins = blocks
        .filter((b) => b.category === 'collaborative')
        .reduce((s, b) => s + b.durationMinutes, 0);
      const adminMins = blocks
        .filter((b) => b.category === 'admin')
        .reduce((s, b) => s + b.durationMinutes, 0);

      return {
        date,
        shortDay: date.slice(5), // MM-DD
        totalMins,
        deepMins,
        billableMins,
        collabMins,
        adminMins,
      };
    });
  }, [weekDates, timeBlocks]);

  const maxDayMins = useMemo(
    () => Math.max(240, ...dailySeries.map((d) => d.totalMins)),
    [dailySeries]
  );

  // Planned vs Actual by Project
  const projectComparison = useMemo(() => {
    return PROJECTS.map((proj) => {
      const projTasks = tasks.filter((t) => t.project === proj);
      const plannedMins = projTasks.reduce(
        (s, t) => s + t.estimatedMinutes,
        0
      );
      const actualMins = timeBlocks
        .filter((b) => b.project === proj)
        .reduce((s, b) => s + b.durationMinutes, 0);
      const completedTasks = projTasks.filter(
        (t) => t.status === 'completed'
      ).length;

      return {
        project: proj,
        plannedMins,
        actualMins,
        taskCount: projTasks.length,
        completedTasks,
      };
    });
  }, [tasks, timeBlocks]);

  // Presence & Idle telemetry summary
  const presenceStats = useMemo(() => {
    const activeMins = activitySegments
      .filter((s) => s.state === 'active')
      .reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    const idleMins = activitySegments
      .filter((s) => s.state === 'idle')
      .reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    const awayMins = activitySegments
      .filter((s) => s.state === 'away')
      .reduce((s, seg) => s + (seg.endTime - seg.startTime), 0);
    const totalObserved = activeMins + idleMins + awayMins;
    const focusEfficiency =
      totalObserved > 0 ? Math.round((activeMins / totalObserved) * 100) : 0;

    return {
      activeMins,
      idleMins,
      awayMins,
      focusEfficiency,
    };
  }, [activitySegments]);

  const weeklyAppSummary = useMemo(() => {
    const dateSet = new Set(weekDates);
    const map = new Map<string, number>();
    let total = 0;
    appSegments
      .filter((seg) => dateSet.has(seg.date))
      .forEach((seg) => {
        const mins = Math.max(0, seg.endTime - seg.startTime);
        total += mins;
        map.set(seg.appName, (map.get(seg.appName) || 0) + mins);
      });
    return Array.from(map.entries())
      .map(([appName, mins]) => ({
        appName,
        mins,
        sharePct: total > 0 ? Math.round((mins / total) * 100) : 0,
      }))
      .sort((a, b) => b.mins - a.mins);
  }, [appSegments, weekDates]);

  const weeklyDocSummary = useMemo(() => {
    const dateSet = new Set(weekDates);
    const map = new Map<
      string,
      {
        documentTitle: string;
        appName: string;
        domainOrPath: string;
        mins: number;
      }
    >();
    documentSegments
      .filter((seg) => dateSet.has(seg.date))
      .forEach((seg) => {
        const mins = Math.max(0, seg.endTime - seg.startTime);
        const key = `${seg.appName}::${seg.documentTitle}`;
        const existing = map.get(key);
        if (existing) {
          existing.mins += mins;
        } else {
          map.set(key, {
            documentTitle: seg.documentTitle,
            appName: seg.appName,
            domainOrPath: seg.domainOrPath,
            mins,
          });
        }
      });
    return Array.from(map.values())
      .sort((a, b) => b.mins - a.mins)
      .slice(0, 8);
  }, [documentSegments, weekDates]);

  if (isExecutiveScope && execOverview) {
    const fs = execOverview.freshnessSummary;
    const totalEstimatedHrs = execOverview.clientProfitability.reduce(
      (s, c) => s + c.estimatedHours,
      0
    );
    const totalTrackedHrs = execOverview.clientProfitability.reduce(
      (s, c) => s + c.trackedHours,
      0
    );
    const totalFeeUsd = execOverview.clientProfitability.reduce(
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
              Across {execOverview.clientProfitability.length} visible client engagements
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Client Engagement Realization &amp; Profitability
            </h2>
          </div>
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
                {execOverview.clientProfitability.map((row) => (
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
        </div>
      </div>
    );
  }

  const isEmptyWorkspace =
    tasks.length === 0 &&
    timeBlocks.length === 0 &&
    appSegments.length === 0 &&
    activitySegments.length === 0;

  return (
    <div className="space-y-6">
      <div className="pb-2 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            Productivity & Estimation Analytics
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            7-day focus rhythm, project estimation accuracy, and workstation presence telemetry
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
            className="px-3.5 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg shrink-0 cursor-pointer"
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
            <span>Weekly Scoped Deliverables</span>
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {tasks.filter((t) => t.status === 'completed').length} /{' '}
            {tasks.length} Shipped
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {tasks.filter((t) => t.status === 'blocked').length} blocked task
            currently awaiting external action
          </div>
        </div>

        <div className="p-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Layers className="w-4 h-4 text-amber-600" />
            <span>Average Daily Tracked Output</span>
          </div>
          <div className="mt-2 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {formatDuration(
              Math.round(
                timeBlocks.reduce((s, b) => s + b.durationMinutes, 0) /
                  Math.max(
                    1,
                    dailySeries.filter((d) => d.totalMins > 0).length
                  )
              )
            )}{' '}
            / active day
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Across {dailySeries.filter((d) => d.totalMins > 0).length} active
            logged days this week
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

      {/* Project Planned vs Actual Matrix */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            Project Estimation Accuracy & Delivery Matrix
          </h2>
          <p className="text-xs text-slate-500">
            Compares practice task estimates against OnTrack-logged blocks per project
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 bg-slate-50/70 dark:bg-slate-800/40">
                <th className="py-2.5 px-5">Project Workstream</th>
                <th className="py-2.5 px-5 text-right">Scoped Tasks</th>
                <th className="py-2.5 px-5 text-right">Completed</th>
                <th className="py-2.5 px-5 text-right">Planned Estimate</th>
                <th className="py-2.5 px-5 text-right">Actual Logged</th>
                <th className="py-2.5 px-5 text-right">Utilization Ratio</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {projectComparison.map((row) => {
                const ratio =
                  row.plannedMins > 0
                    ? Math.round((row.actualMins / row.plannedMins) * 100)
                    : 0;
                return (
                  <tr key={row.project}>
                    <td className="py-3.5 px-5 font-semibold text-slate-900 dark:text-white">
                      {row.project}
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
                    <td className="py-3.5 px-5 text-right font-mono tabular-nums">
                      <span
                        className={
                          ratio > 110
                            ? 'text-amber-600 font-semibold'
                            : 'text-slate-700 dark:text-slate-300'
                        }
                      >
                        {ratio}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
              No application telemetry recorded in this 7-day window.
            </p>
          ) : (
            <div className="space-y-3 pt-1">
              {weeklyAppSummary.map((item) => {
                const style =
                  APP_COLORS[item.appName] || APP_COLORS['Google Chrome'];
                return (
                  <div key={item.appName} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-800 dark:text-slate-200">
                        {item.appName}
                      </span>
                      <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {formatDuration(item.mins)} ({item.sharePct}%)
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div
                        style={{ width: `${Math.max(4, item.sharePct)}%` }}
                        className={`h-full rounded-full ${style.bar}`}
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
              <span>Most Referenced Documents & Files</span>
            </h2>
            <p className="text-xs text-slate-500">
              Top active files, browser tabs, and design specs tracked this week
            </p>
          </div>

          {weeklyDocSummary.length === 0 ? (
            <p className="text-xs text-slate-400 py-4">
              No document or window focus sessions recorded yet.
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
