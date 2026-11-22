import React, { useState, useMemo } from 'react';
import {
  FileText,
  Copy,
  Check,
  Printer,
  RefreshCw,
  Download,
  AlertTriangle,
  CheckCircle2,
  ArrowUpRight,
  Clock,
} from 'lucide-react';
import {
  ApplicationUsageSegment,
  DocumentUsageSegment,
  ReportTone,
  Task,
  TimeBlock,
  WeeklyMetricsSnapshot,
  WeeklyReport,
  WorkCategory,
} from '../types';
import {
  APP_COLORS,
  CATEGORY_LABELS,
  PROJECT_COLORS,
  formatDuration,
} from '../data/seedData';

interface WeeklyReportViewProps {
  weekDates: string[];
  tasks: Task[];
  timeBlocks: TimeBlock[];
  appSegments: ApplicationUsageSegment[];
  documentSegments: DocumentUsageSegment[];
  reports: WeeklyReport[];
  onSaveReport: (report: WeeklyReport) => void;
}

export const WeeklyReportView: React.FC<WeeklyReportViewProps> = ({
  weekDates,
  tasks,
  timeBlocks,
  appSegments,
  documentSegments,
  reports,
  onSaveReport,
}) => {
  const [selectedTone, setSelectedTone] = useState<ReportTone>('executive');
  const [isGenerating, setIsGenerating] = useState(false);
  const [copiedMarkdown, setCopiedMarkdown] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const weekStartDate = weekDates[0];
  const weekEndDate = weekDates[weekDates.length - 1];

  // Filter blocks in the 7-day window
  const weekBlocks = useMemo(() => {
    const dateSet = new Set(weekDates);
    return timeBlocks.filter((b) => dateSet.has(b.date));
  }, [timeBlocks, weekDates]);

  // Map taskId -> logged minutes this week
  const loggedByTask = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of weekBlocks) {
      if (b.taskId) {
        map.set(b.taskId, (map.get(b.taskId) || 0) + b.durationMinutes);
      }
    }
    return map;
  }, [weekBlocks]);

  // Live Weekly Metrics Snapshot
  const liveMetrics: WeeklyMetricsSnapshot = useMemo(() => {
    const totalMinutes = weekBlocks.reduce((s, b) => s + b.durationMinutes, 0);
    const totalHours = Number((totalMinutes / 60).toFixed(1));
    const plannedMinutes = tasks.reduce((s, t) => s + t.estimatedMinutes, 0);
    const plannedHours = Number((plannedMinutes / 60).toFixed(1));
    const deepWorkMinutes = weekBlocks
      .filter((b) => b.category === 'deep_work')
      .reduce((s, b) => s + b.durationMinutes, 0);
    const deepWorkPercent =
      totalMinutes > 0 ? Math.round((deepWorkMinutes / totalMinutes) * 100) : 0;
    const billableMinutes = weekBlocks
      .filter((b) => b.isBillable || b.category === 'billable')
      .reduce((s, b) => s + b.durationMinutes, 0);
    const billablePercent =
      totalMinutes > 0 ? Math.round((billableMinutes / totalMinutes) * 100) : 0;

    const completedCount = tasks.filter((t) => t.status === 'completed').length;
    const totalTasksCount = tasks.length;
    const completionRate =
      totalTasksCount > 0
        ? Math.round((completedCount / totalTasksCount) * 100)
        : 0;

    // Estimation accuracy across tasks that have logged time
    const trackedTasks = tasks.filter((t) => (loggedByTask.get(t.id) || 0) > 0);
    const trackedEst = trackedTasks.reduce((s, t) => s + t.estimatedMinutes, 0);
    const trackedAct = trackedTasks.reduce(
      (s, t) => s + (loggedByTask.get(t.id) || 0),
      0
    );
    const drift =
      trackedEst > 0 ? Math.abs(trackedAct - trackedEst) / trackedEst : 0;
    const estimationAccuracyPercent = Math.max(
      0,
      Math.round((1 - Math.min(1, drift)) * 100)
    );

    return {
      totalMinutes,
      totalHours,
      plannedMinutes,
      plannedHours,
      deepWorkMinutes,
      deepWorkPercent,
      billableMinutes,
      billablePercent,
      completedCount,
      totalTasksCount,
      completionRate,
      estimationAccuracyPercent,
    };
  }, [weekBlocks, tasks, loggedByTask]);

  // Breakdowns by Project, Work Category, and Tag
  const projectBreakdown = useMemo(() => {
    const map = new Map<
      string,
      { logged: number; billable: number; blocksCount: number }
    >();
    for (const b of weekBlocks) {
      const prev = map.get(b.project) || {
        logged: 0,
        billable: 0,
        blocksCount: 0,
      };
      map.set(b.project, {
        logged: prev.logged + b.durationMinutes,
        billable:
          prev.billable +
          (b.isBillable || b.category === 'billable' ? b.durationMinutes : 0),
        blocksCount: prev.blocksCount + 1,
      });
    }
    return Array.from(map.entries())
      .map(([project, stats]) => ({
        project,
        ...stats,
        share:
          liveMetrics.totalMinutes > 0
            ? Math.round((stats.logged / liveMetrics.totalMinutes) * 100)
            : 0,
      }))
      .sort((a, b) => b.logged - a.logged);
  }, [weekBlocks, liveMetrics.totalMinutes]);

  const categoryBreakdown = useMemo(() => {
    const map = new Map<WorkCategory, number>();
    for (const b of weekBlocks) {
      map.set(b.category, (map.get(b.category) || 0) + b.durationMinutes);
    }
    return (Object.keys(CATEGORY_LABELS) as WorkCategory[]).map((cat) => {
      const minutes = map.get(cat) || 0;
      return {
        category: cat,
        label: CATEGORY_LABELS[cat],
        minutes,
        share:
          liveMetrics.totalMinutes > 0
            ? Math.round((minutes / liveMetrics.totalMinutes) * 100)
            : 0,
      };
    });
  }, [weekBlocks, liveMetrics.totalMinutes]);

  const tagBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of weekBlocks) {
      for (const tag of b.tags) {
        map.set(tag, (map.get(tag) || 0) + b.durationMinutes);
      }
    }
    return Array.from(map.entries())
      .map(([tag, minutes]) => ({ tag, minutes }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [weekBlocks]);

  const appBreakdown = useMemo(() => {
    const dateSet = new Set(weekDates);
    const map = new Map<string, number>();
    let totalMins = 0;
    for (const seg of appSegments) {
      if (!dateSet.has(seg.date)) continue;
      const dur = Math.max(1, seg.endTime - seg.startTime);
      map.set(seg.appName, (map.get(seg.appName) || 0) + dur);
      totalMins += dur;
    }
    return Array.from(map.entries())
      .map(([appName, minutes]) => ({
        appName,
        minutes,
        share: totalMins > 0 ? Math.round((minutes / totalMins) * 100) : 0,
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [appSegments, weekDates]);

  const docBreakdown = useMemo(() => {
    const dateSet = new Set(weekDates);
    const map = new Map<
      string,
      { documentTitle: string; appName: string; minutes: number }
    >();
    for (const seg of documentSegments) {
      if (!dateSet.has(seg.date)) continue;
      const dur = Math.max(1, seg.endTime - seg.startTime);
      const prev = map.get(seg.documentTitle);
      if (prev) {
        prev.minutes += dur;
      } else {
        map.set(seg.documentTitle, {
          documentTitle: seg.documentTitle,
          appName: seg.appName,
          minutes: dur,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.minutes - a.minutes);
  }, [documentSegments, weekDates]);

  const currentReport: WeeklyReport = reports[0];

  // Local deterministic fallback generator if Gemini API key is unconfigured or unreachable
  const buildLocalSynthesizedReport = (tone: ReportTone): WeeklyReport => {
    const completedTasks = tasks.filter((t) => t.status === 'completed');
    const inProgressTasks = tasks.filter((t) => t.status === 'in_progress');
    const blockedTasks = tasks.filter(
      (t) => t.status === 'blocked' || Boolean(t.blockerNote)
    );

    const toneIntro =
      tone === 'client'
        ? `Client Delivery Summary (${weekStartDate} to ${weekEndDate}): Invested ${liveMetrics.totalHours}h total across active workstreams, including ${formatDuration(liveMetrics.billableMinutes)} (${liveMetrics.billablePercent}%) in direct billable deliverables.`
        : tone === 'standup'
        ? `Engineering Sprint Review (${weekStartDate} to ${weekEndDate}): Shipped ${completedTasks.length} tasks and logged ${liveMetrics.totalHours}h on the timeline with ${liveMetrics.deepWorkPercent}% deep technical focus.`
        : `Executive Progress Review (${weekStartDate} to ${weekEndDate}): Logged ${liveMetrics.totalHours}h across ${weekBlocks.length} tracked timeline sessions (${liveMetrics.deepWorkPercent}% deep work ratio), completing ${completedTasks.length} of ${tasks.length} scoped deliverables at ${liveMetrics.estimationAccuracyPercent}% estimation accuracy.`;

    const accomplishments = [
      ...completedTasks.map(
        (t) =>
          `Completed "${t.title}" [${t.project}] — Logged ${formatDuration(
            loggedByTask.get(t.id) || t.estimatedMinutes
          )} vs. ${formatDuration(t.estimatedMinutes)} planned estimate.`
      ),
      ...inProgressTasks.map(
        (t) =>
          `Advanced "${t.title}" [${t.project}] — ${formatDuration(
            loggedByTask.get(t.id) || 0
          )} invested across active deep-work blocks.`
      ),
    ].slice(0, 5);

    const blockersAndRisks =
      blockedTasks.length > 0
        ? blockedTasks.map(
            (t) =>
              `${t.title} [${t.project}]: ${
                t.blockerNote || 'Flagged as blocked in task board.'
              } (${formatDuration(loggedByTask.get(t.id) || 0)} logged so far).`
          )
        : [
            'No critical blockers flagged on active tasks this week.',
            'Monitor context switching during afternoon collaborative intervals.',
          ];

    const velocityInsights = `Tracked ${formatDuration(
      liveMetrics.totalMinutes
    )} against ${formatDuration(
      liveMetrics.plannedMinutes
    )} total scoped estimates (${liveMetrics.estimationAccuracyPercent}% estimation alignment). Deep Work accounted for ${formatDuration(
      liveMetrics.deepWorkMinutes
    )} (${liveMetrics.deepWorkPercent}%), while Billable Client work accounted for ${formatDuration(
      liveMetrics.billableMinutes
    )} (${liveMetrics.billablePercent}%).`;

    const nextWeekFocus = tasks
      .filter((t) => t.status !== 'completed')
      .slice(0, 4)
      .map(
        (t) =>
          `[${t.project}] ${t.title} (${
            t.status === 'blocked' ? 'Unblock & verify' : 'Complete remaining scope'
          })`
      );

    return {
      id: `rep-${Date.now()}`,
      weekStartDate,
      weekEndDate,
      generatedAt: new Date().toISOString(),
      tone,
      executiveSummary: toneIntro,
      accomplishments:
        accomplishments.length > 0
          ? accomplishments
          : ['Logged foundational timeline sessions across projects.'],
      blockersAndRisks,
      velocityInsights,
      nextWeekFocus:
        nextWeekFocus.length > 0
          ? nextWeekFocus
          : ['Scope new sprint backlog deliverables.'],
      metricsSnapshot: liveMetrics,
      isAiGenerated: true,
    };
  };

  const handleGenerateReport = async () => {
    setIsGenerating(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/reports/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weekStartDate,
          weekEndDate,
          tone: selectedTone,
          metrics: {
            totalHours: liveMetrics.totalHours,
            totalMinutes: liveMetrics.totalMinutes,
            plannedHours: liveMetrics.plannedHours,
            deepWorkPercent: liveMetrics.deepWorkPercent,
            billablePercent: liveMetrics.billablePercent,
            completedCount: liveMetrics.completedCount,
            totalTasksCount: liveMetrics.totalTasksCount,
          },
        }),
      });

      if (!res.ok) {
        const synthesized = buildLocalSynthesizedReport(selectedTone);
        onSaveReport(synthesized);
        setStatusMessage(
          'Generated fresh weekly report from live timeline & task telemetry.'
        );
        return;
      }

      const data = await res.json();
      if (data?.report) {
        const newReport: WeeklyReport = {
          id: `rep-${Date.now()}`,
          weekStartDate,
          weekEndDate,
          generatedAt: new Date().toISOString(),
          tone: selectedTone,
          executiveSummary: data.report.executiveSummary,
          accomplishments: data.report.accomplishments || [],
          blockersAndRisks: data.report.blockersAndRisks || [],
          velocityInsights: data.report.velocityInsights || '',
          nextWeekFocus: data.report.nextWeekFocus || [],
          metricsSnapshot: liveMetrics,
          isAiGenerated: true,
        };
        onSaveReport(newReport);
        setStatusMessage('AI Weekly Progress Report synthesized via Gemini.');
      }
    } catch {
      const synthesized = buildLocalSynthesizedReport(selectedTone);
      onSaveReport(synthesized);
      setStatusMessage(
        'Generated weekly report from your live task and timeline data.'
      );
    } finally {
      setIsGenerating(false);
    }
  };

  // Build Markdown representation for one-click copy & download
  const buildMarkdownString = (): string => {
    const projectLines = projectBreakdown
      .map(
        (p) =>
          `| ${p.project} | ${formatDuration(p.logged)} | ${formatDuration(
            p.billable
          )} | ${p.share}% |`
      )
      .join('\n');

    const taskVelocityLines = tasks
      .map((t) => {
        const actual = loggedByTask.get(t.id) || 0;
        const delta = actual - t.estimatedMinutes;
        const deltaStr =
          delta === 0
            ? 'On target'
            : delta > 0
            ? `+${formatDuration(delta)} over`
            : `${formatDuration(Math.abs(delta))} under`;
        return `| ${t.title} | ${t.project} | ${t.status.toUpperCase()} | ${formatDuration(
          t.estimatedMinutes
        )} | ${formatDuration(actual)} | ${deltaStr} |`;
      })
      .join('\n');

    const appLines = appBreakdown
      .map((a) => `| ${a.appName} | ${formatDuration(a.minutes)} | ${a.share}% |`)
      .join('\n');

    const docLines = docBreakdown
      .slice(0, 10)
      .map(
        (d) =>
          `| ${d.documentTitle} | ${d.appName} | ${formatDuration(d.minutes)} |`
      )
      .join('\n');

    return `# Weekly Progress Report (${weekStartDate} – ${weekEndDate})

**Generated**: ${new Date(currentReport.generatedAt).toLocaleString()} · **Report Mode**: ${currentReport.tone.toUpperCase()}

## 1. Executive Summary
${currentReport.executiveSummary}

### Key Weekly Metrics
- **Total Logged Time**: ${formatDuration(liveMetrics.totalMinutes)} (${liveMetrics.totalHours}h)
- **Planned Scope**: ${formatDuration(liveMetrics.plannedMinutes)} (${liveMetrics.plannedHours}h)
- **Deep Work Focus**: ${formatDuration(liveMetrics.deepWorkMinutes)} (${liveMetrics.deepWorkPercent}%)
- **Billable Delivery**: ${formatDuration(liveMetrics.billableMinutes)} (${liveMetrics.billablePercent}%)
- **Task Completion Velocity**: ${liveMetrics.completedCount} / ${liveMetrics.totalTasksCount} tasks (${liveMetrics.completionRate}%)
- **Estimation Accuracy**: ${liveMetrics.estimationAccuracyPercent}%

## 2. Key Accomplishments & Milestones
${currentReport.accomplishments.map((a) => `- ${a}`).join('\n')}

## 3. Blockers & Escalation Risks
${currentReport.blockersAndRisks.map((b) => `- ${b}`).join('\n')}

## 4. Velocity & Time Allocation Insights
${currentReport.velocityInsights}

### Time Breakdown by Project
| Project | Logged Time | Billable Time | Share |
| :--- | :---: | :---: | :---: |
${projectLines}

### Applications Used & Documents Worked On
| Application | Focus Time | Share |
| :--- | :---: | :---: |
${appLines}

| Document / Window | Application | Time Spent |
| :--- | :--- | :---: |
${docLines}

### Planned vs. Actual Task Velocity
| Task Deliverable | Project | Status | Planned Est | Actual Logged | Variance |
| :--- | :--- | :--- | :---: | :---: | :---: |
${taskVelocityLines}

## 5. Next Week Priorities
${currentReport.nextWeekFocus.map((n) => `- ${n}`).join('\n')}
`;
  };

  const handleCopyMarkdown = async () => {
    const md = buildMarkdownString();
    try {
      await navigator.clipboard.writeText(md);
      setCopiedMarkdown(true);
      setTimeout(() => setCopiedMarkdown(false), 2500);
    } catch {
      setStatusMessage('Clipboard access unavailable; use Download .MD button.');
    }
  };

  const handleDownloadMarkdown = () => {
    const md = buildMarkdownString();
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ontrack-weekly-report-${weekEndDate}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 print-only-full">
      {/* Top Action Bar */}
      <div className="no-print flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-3 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            Automated Weekly Progress Report
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Review period:{' '}
            <span className="font-mono font-semibold text-slate-900 dark:text-slate-200 tabular-nums">
              {weekStartDate} to {weekEndDate}
            </span>
          </p>
        </div>

        {/* Tone Selector + Generate + Export Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
            {(
              [
                { id: 'executive', label: 'Executive Brief' },
                { id: 'standup', label: 'Engineering Standup' },
                { id: 'client', label: 'Client Billable' },
              ] as { id: ReportTone; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedTone(t.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedTone === t.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            disabled={isGenerating}
            onClick={handleGenerateReport}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isGenerating ? 'animate-spin' : ''}`}
            />
            <span>
              {isGenerating
                ? 'Synthesizing Report...'
                : 'Regenerate AI Weekly Report'}
            </span>
          </button>

          <button
            type="button"
            onClick={handleCopyMarkdown}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedMarkdown ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600" />
                <span className="text-emerald-700 dark:text-emerald-400">
                  Copied Markdown
                </span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Markdown</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadMarkdown}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>.MD</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print / PDF</span>
          </button>
        </div>
      </div>

      {statusMessage && (
        <div className="no-print px-4 py-2.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 text-xs text-indigo-800 dark:text-indigo-200 flex items-center justify-between">
          <span>{statusMessage}</span>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="text-indigo-600 font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Printable Report Document Container */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 lg:p-8 space-y-8">
        {/* Document Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-6">
          <div>
            <div className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
              onTrack Automated Stakeholder Dossier · Mode:{' '}
              <span className="capitalize">{currentReport.tone}</span>
            </div>
            <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white mt-1">
              Weekly Progress & Velocity Review
            </h2>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono tabular-nums">
              Period: {weekStartDate} — {weekEndDate} · Last Updated:{' '}
              {new Date(currentReport.generatedAt).toLocaleString()}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 sm:pt-0">
            <div className="text-right">
              <div className="text-[11px] text-slate-500">Logged Time</div>
              <div className="font-mono text-lg font-bold text-slate-900 dark:text-white tabular-nums">
                {formatDuration(liveMetrics.totalMinutes)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500">Deep Work</div>
              <div className="font-mono text-lg font-bold text-indigo-600 dark:text-indigo-400 tabular-nums">
                {liveMetrics.deepWorkPercent}%
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500">Billable</div>
              <div className="font-mono text-lg font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                {formatDuration(liveMetrics.billableMinutes)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500">Est. Accuracy</div>
              <div className="font-mono text-lg font-bold text-slate-900 dark:text-white tabular-nums">
                {liveMetrics.estimationAccuracyPercent}%
              </div>
            </div>
          </div>
        </div>

        {/* Section 1: AI-Generated Executive Summary, Accomplishments & Blockers */}
        <div className="space-y-6">
          <div>
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white mb-2">
              01. Executive Summary
            </h3>
            <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-300 max-w-4xl">
              {currentReport.executiveSummary}
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Accomplishments */}
            <div className="p-5 rounded-xl bg-slate-50/70 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <h4 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Key Accomplishments & Completed Deliverables
                </h4>
              </div>
              <ul className="space-y-2.5 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                {currentReport.accomplishments.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="font-mono text-emerald-600 font-bold">
                      •
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Blockers & Escalation Risks */}
            <div className="p-5 rounded-xl bg-slate-50/70 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <h4 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Blockers, Escalations & Estimation Risks
                </h4>
              </div>
              <ul className="space-y-2.5 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                {currentReport.blockersAndRisks.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="font-mono text-amber-600 font-bold">
                      !
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Section 2: Time Breakdown by Project, Tag, and Deep-Work/Billable Category */}
        <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
            02. Time Breakdown by Project, Work Category & Tag
          </h3>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* By Project */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">
                By Project Workstream
              </div>
              <div className="space-y-3">
                {projectBreakdown.map((p) => {
                  const color =
                    PROJECT_COLORS[p.project] || PROJECT_COLORS['Core Platform'];
                  return (
                    <div key={p.project} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {p.project}
                        </span>
                        <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {formatDuration(p.logged)} ({p.share}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${p.share}%` }}
                          className={`h-full rounded-full ${color.bar}`}
                        />
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                        {p.blocksCount} sessions · Billable:{' '}
                        {formatDuration(p.billable)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* By Work Mode / Category */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">
                By Work Mode & Billable Category
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {categoryBreakdown.map((c) => (
                  <div
                    key={c.category}
                    className="py-2.5 flex items-center justify-between"
                  >
                    <span className="text-slate-700 dark:text-slate-300 font-medium">
                      {c.label}
                    </span>
                    <span className="font-mono tabular-nums text-slate-900 dark:text-white font-semibold">
                      {formatDuration(c.minutes)} ({c.share}%)
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 pt-1">
                {currentReport.velocityInsights}
              </p>
            </div>

            {/* By ManicTime Tag */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">
                Top Activity Tags
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {tagBreakdown.slice(0, 7).map((item) => (
                  <div
                    key={item.tag}
                    className="py-2 flex items-center justify-between"
                  >
                    <span className="text-slate-700 dark:text-slate-300">
                      #{item.tag}
                    </span>
                    <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                      {formatDuration(item.minutes)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {/* Applications Used & Documents Opened Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-2">
            {/* Applications Breakdown */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">
                Applications Used This Week
              </div>
              {appBreakdown.length === 0 ? (
                <p className="text-xs text-slate-500">No applications captured.</p>
              ) : (
                <div className="space-y-2.5">
                  {appBreakdown.map((app) => {
                    const style =
                      APP_COLORS[app.appName] || APP_COLORS['Google Chrome'];
                    return (
                      <div key={app.appName} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-slate-800 dark:text-slate-200">
                            {app.appName}
                          </span>
                          <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                            {formatDuration(app.minutes)} ({app.share}%)
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div
                            style={{ width: `${app.share}%` }}
                            className={`h-full rounded-full ${style.bar}`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Documents Worked On */}
            <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="text-xs font-semibold text-slate-900 dark:text-white">
                Top Documents & Files Worked On
              </div>
              {docBreakdown.length === 0 ? (
                <p className="text-xs text-slate-500">No documents captured.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                  {docBreakdown.slice(0, 7).map((doc) => (
                    <div
                      key={doc.documentTitle}
                      className="py-2 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                          {doc.documentTitle}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {doc.appName}
                        </div>
                      </div>
                      <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                        {formatDuration(doc.minutes)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Section 3: Planned vs. Actual Time Comparison & Task Completion Velocity */}
        <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
              03. Planned vs. Actual Time Comparison & Task Velocity
            </h3>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {liveMetrics.completedCount} of {liveMetrics.totalTasksCount} tasks completed ({liveMetrics.completionRate}%)
            </span>
          </div>

          <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-xl">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-800/40">
                  <th className="py-2.5 px-4">Task Deliverable</th>
                  <th className="py-2.5 px-4">Project & Category</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4 text-right">Planned Est</th>
                  <th className="py-2.5 px-4 text-right">Actual Logged</th>
                  <th className="py-2.5 px-4 text-right">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {tasks.map((t) => {
                  const actual = loggedByTask.get(t.id) || 0;
                  const delta = actual - t.estimatedMinutes;
                  return (
                    <tr key={t.id}>
                      <td className="py-3 px-4 font-medium text-slate-900 dark:text-white">
                        {t.title}
                      </td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-400">
                        {t.project} · {CATEGORY_LABELS[t.category]}
                      </td>
                      <td className="py-3 px-4 capitalize text-slate-700 dark:text-slate-300">
                        {t.status.replace('_', ' ')}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {formatDuration(t.estimatedMinutes)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                        {formatDuration(actual)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        {actual === 0 ? (
                          <span className="text-slate-400">Not started</span>
                        ) : delta === 0 ? (
                          <span className="text-emerald-600">Exact match</span>
                        ) : delta > 0 ? (
                          <span className="text-amber-600">
                            +{formatDuration(delta)} over
                          </span>
                        ) : (
                          <span className="text-emerald-600">
                            -{formatDuration(Math.abs(delta))} under
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Section 4: Next Week Focus & Carry-Over Priorities */}
        <div className="space-y-3 pt-4 border-t border-slate-200 dark:border-slate-800">
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
            04. Recommended Priorities for Next Week
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {currentReport.nextWeekFocus.map((focusItem, idx) => (
              <div
                key={idx}
                className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 flex items-start gap-2.5 text-xs text-slate-800 dark:text-slate-200"
              >
                <ArrowUpRight className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                <span>{focusItem}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
