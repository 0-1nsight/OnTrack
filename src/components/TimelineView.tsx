import React, { useState, useMemo, useEffect } from 'react';
import {
  Play,
  Plus,
  Trash2,
  Edit3,
  Clock,
  Layers,
  Tag,
  AppWindow,
  FileText,
  Search,
  TagIcon,
  CalendarRange,
  Check,
  X,
  Sparkles,
} from 'lucide-react';
import {
  AttributionRecord,
  ClientDictionaryEntry,
  DeviceFreshnessRecord,
  WorkSession,
} from '../engine/types';
import {
  ActivitySegment,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  Task,
  TimeBlock,
} from '../types';
import {
  PROJECT_COLORS,
  APP_COLORS,
  CATEGORY_LABELS,
  CATEGORY_RIBBON_STYLES,
  formatMinutesToHHMM,
  formatDuration,
} from '../utils/workspaceConstants';
import { toLocalDateString } from '../utils/engineWorkspaceAdapter';
import { WorkstationCapturePanel } from './WorkstationCapturePanel';

interface TimelineViewProps {
  selectedDate: string;
  weekDates: string[];
  timeBlocks: TimeBlock[];
  activitySegments: ActivitySegment[];
  appSegments: ApplicationUsageSegment[];
  documentSegments: DocumentUsageSegment[];
  tasks: Task[];
  clients?: ClientDictionaryEntry[];
  engineSessions?: WorkSession[];
  engineAttributions?: AttributionRecord[];
  workstationDevices?: DeviceFreshnessRecord[];
  syncStatus?: 'idle' | 'syncing' | 'error';
  onSelectDate: (date: string) => void;
  onOpenQuickLogWithRange: (startTime: number, endTime: number) => void;
  onConvertAppDocToBlock: (doc: {
    appName: string;
    documentTitle: string;
    startTime: number;
    endTime: number;
    linkedTaskId?: string | null;
  }) => void;
  onEditTimeBlock: (block: TimeBlock) => void;
  onQuickUpdateTimeBlock?: (block: TimeBlock) => void;
  onDeleteTimeBlock: (blockId: string) => void;
  onStartTimerForTask: (taskId: string) => void;
  onReconcileSegment: (segment: ActivitySegment) => void;
  onResolveTimelineAttribution?: (params: {
    sessionId: string;
    taskId: string | null;
    status: 'confirmed' | 'dismissed';
  }) => void;
  onNotify?: (message: string) => void;
  onOpenInstallers?: () => void;
}

export const TimelineView: React.FC<TimelineViewProps> = ({
  selectedDate,
  weekDates,
  timeBlocks,
  activitySegments,
  appSegments,
  documentSegments,
  tasks,
  clients = [],
  engineSessions = [],
  engineAttributions = [],
  workstationDevices = [],
  syncStatus = 'idle',
  onSelectDate,
  onOpenQuickLogWithRange,
  onConvertAppDocToBlock,
  onEditTimeBlock,
  onQuickUpdateTimeBlock,
  onDeleteTimeBlock,
  onStartTimerForTask,
  onReconcileSegment,
  onResolveTimelineAttribution,
  onNotify,
  onOpenInstallers,
}) => {
  const [timelineMode, setTimelineMode] = useState<'day' | 'week'>('day');
  const [zoomMode, setZoomMode] = useState<'workday' | 'full24'>('workday');
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedBlockAnchor, setSelectedBlockAnchor] = useState<{
    date: string;
    startTime: number;
  } | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [docQuickTaskId, setDocQuickTaskId] = useState<string>('');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [detailsTab, setDetailsTab] = useState<'blocks' | 'apps' | 'docs'>('blocks');
  const [detailsSearch, setDetailsSearch] = useState('');
  const [nowDate, setNowDate] = useState<Date>(() => new Date());
  const [reviewTrayExpanded, setReviewTrayExpanded] = useState<boolean>(false);
  const [suggestedTaskDraft, setSuggestedTaskDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowDate(new Date());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const todayDateStr = toLocalDateString(nowDate);
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();

  const rangeStartMin = zoomMode === 'workday' ? 8 * 60 : 0; // 08:00 or 00:00
  const rangeEndMin = zoomMode === 'workday' ? 20 * 60 : 24 * 60; // 20:00 or 24:00
  const totalRangeMins = rangeEndMin - rangeStartMin;
  const isTodaySelected = selectedDate === todayDateStr;
  const showDayNowLine =
    isTodaySelected && nowMinutes >= rangeStartMin && nowMinutes <= rangeEndMin;
  const dayNowLeftPct = ((nowMinutes - rangeStartMin) / totalRangeMins) * 100;

  const dayBlocks = useMemo(() => {
    return timeBlocks
      .filter(
        (b) =>
          b.date === selectedDate &&
          (projectFilter === 'all' || b.project === projectFilter)
      )
      .sort((a, b) => a.startTime - b.startTime);
  }, [timeBlocks, selectedDate, projectFilter]);

  const daySegments = useMemo(() => {
    return activitySegments
      .filter((s) => s.date === selectedDate)
      .sort((a, b) => a.startTime - b.startTime);
  }, [activitySegments, selectedDate]);

  const dayApps = useMemo(() => {
    return appSegments
      .filter((a) => a.date === selectedDate)
      .sort((a, b) => a.startTime - b.startTime);
  }, [appSegments, selectedDate]);

  const dayDocs = useMemo(() => {
    return documentSegments
      .filter((d) => d.date === selectedDate)
      .sort((a, b) => a.startTime - b.startTime);
  }, [documentSegments, selectedDate]);

  const selectedBlock = useMemo(() => {
    const exact = dayBlocks.find((b) => b.id === selectedBlockId);
    if (exact) return exact;
    if (selectedBlockId && selectedBlockAnchor && selectedBlockAnchor.date === selectedDate) {
      return (
        dayBlocks.find(
          (b) => Math.abs(b.startTime - selectedBlockAnchor.startTime) <= 1
        ) || null
      );
    }
    return null;
  }, [dayBlocks, selectedBlockId, selectedBlockAnchor, selectedDate]);

  const selectedDoc = useMemo(
    () => dayDocs.find((d) => d.id === selectedDocId) || null,
    [dayDocs, selectedDocId]
  );

  // Day summary metrics
  const dayMetrics = useMemo(() => {
    const totalMinutes = dayBlocks.reduce((acc, b) => acc + b.durationMinutes, 0);
    const deepWorkMinutes = dayBlocks
      .filter((b) => b.category === 'deep_work')
      .reduce((acc, b) => acc + b.durationMinutes, 0);
    const billableMinutes = dayBlocks
      .filter((b) => b.isBillable || b.category === 'billable')
      .reduce((acc, b) => acc + b.durationMinutes, 0);
    const activePresenceMinutes = daySegments
      .filter((s) => s.state === 'active')
      .reduce((acc, s) => acc + (s.endTime - s.startTime), 0);
    const unreconciledCount = daySegments.filter(
      (s) => s.state === 'idle' && !s.reconciled
    ).length;

    const uniqueApps = new Set(dayApps.map((a) => a.appName)).size;
    const uniqueDocs = new Set(dayDocs.map((d) => d.documentTitle)).size;

    return {
      totalMinutes,
      deepWorkMinutes,
      deepWorkPercent:
        totalMinutes > 0 ? Math.round((deepWorkMinutes / totalMinutes) * 100) : 0,
      billableMinutes,
      activePresenceMinutes,
      unreconciledCount,
      uniqueApps,
      uniqueDocs,
    };
  }, [dayBlocks, daySegments, dayApps, dayDocs]);

  // Aggregated Application Usage Summary (Application Summary pane)
  const appSummary = useMemo(() => {
    const map = new Map<string, number>();
    let totalAppMins = 0;
    for (const seg of dayApps) {
      const dur = Math.max(1, seg.endTime - seg.startTime);
      map.set(seg.appName, (map.get(seg.appName) || 0) + dur);
      totalAppMins += dur;
    }
    return Array.from(map.entries())
      .map(([appName, minutes]) => ({
        appName,
        minutes,
        percent:
          totalAppMins > 0 ? Math.round((minutes / totalAppMins) * 100) : 0,
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [dayApps]);

  // Aggregated Document Usage Summary
  const docSummary = useMemo(() => {
    const map = new Map<
      string,
      {
        documentTitle: string;
        appName: string;
        domainOrPath: string;
        minutes: number;
        latestStart: number;
        latestEnd: number;
        linkedTaskId?: string | null;
      }
    >();
    for (const seg of dayDocs) {
      const dur = Math.max(1, seg.endTime - seg.startTime);
      const prev = map.get(seg.documentTitle);
      if (prev) {
        map.set(seg.documentTitle, {
          ...prev,
          minutes: prev.minutes + dur,
          latestStart: Math.min(prev.latestStart, seg.startTime),
          latestEnd: Math.max(prev.latestEnd, seg.endTime),
        });
      } else {
        map.set(seg.documentTitle, {
          documentTitle: seg.documentTitle,
          appName: seg.appName,
          domainOrPath: seg.domainOrPath,
          minutes: dur,
          latestStart: seg.startTime,
          latestEnd: seg.endTime,
          linkedTaskId: seg.linkedTaskId,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.minutes - a.minutes);
  }, [dayDocs]);

  // Project & Tag summary breakdown
  const projectSummary = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of dayBlocks) {
      map.set(b.project, (map.get(b.project) || 0) + b.durationMinutes);
    }
    return Array.from(map.entries())
      .map(([project, minutes]) => ({
        project,
        minutes,
        percent:
          dayMetrics.totalMinutes > 0
            ? Math.round((minutes / dayMetrics.totalMinutes) * 100)
            : 0,
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [dayBlocks, dayMetrics.totalMinutes]);

  const tagSummary = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of dayBlocks) {
      for (const t of b.tags) {
        map.set(t, (map.get(t) || 0) + b.durationMinutes);
      }
    }
    return Array.from(map.entries())
      .map(([tag, minutes]) => ({
        tag,
        minutes,
      }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [dayBlocks]);

  // Hour markers for timeline ruler
  const hourTicks = useMemo(() => {
    const startHour = rangeStartMin / 60;
    const endHour = rangeEndMin / 60;
    const ticks: number[] = [];
    for (let h = startHour; h <= endHour; h++) {
      ticks.push(h);
    }
    return ticks;
  }, [rangeStartMin, rangeEndMin]);

  const getTrackGeometry = (startMin: number, endMin: number) => {
    const clampedStart = Math.max(rangeStartMin, Math.min(rangeEndMin, startMin));
    const clampedEnd = Math.max(rangeStartMin, Math.min(rangeEndMin, endMin));
    if (clampedEnd <= clampedStart) return null;
    const leftPercent = ((clampedStart - rangeStartMin) / totalRangeMins) * 100;
    const widthPercent = ((clampedEnd - clampedStart) / totalRangeMins) * 100;
    return {
      left: `${leftPercent.toFixed(2)}%`,
      width: `${Math.max(widthPercent, 0.8).toFixed(2)}%`,
    };
  };

  const handleTimelineCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickRatio = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width)
    );
    const clickedMinute =
      Math.round((rangeStartMin + clickRatio * totalRangeMins) / 15) * 15;
    const endMinute = Math.min(1440, clickedMinute + 60);
    onOpenQuickLogWithRange(clickedMinute, endMinute);
  };

  // Filtered detail lists
  const filteredDayBlocks = useMemo(() => {
    if (!detailsSearch.trim()) return dayBlocks;
    const q = detailsSearch.toLowerCase();
    return dayBlocks.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        b.project.toLowerCase().includes(q) ||
        (b.appName || '').toLowerCase().includes(q) ||
        (b.documentTitle || '').toLowerCase().includes(q)
    );
  }, [dayBlocks, detailsSearch]);

  const filteredDayDocs = useMemo(() => {
    if (!detailsSearch.trim()) return dayDocs;
    const q = detailsSearch.toLowerCase();
    return dayDocs.filter(
      (d) =>
        d.documentTitle.toLowerCase().includes(q) ||
        d.appName.toLowerCase().includes(q) ||
        d.domainOrPath.toLowerCase().includes(q)
    );
  }, [dayDocs, detailsSearch]);

  const filteredAppSummary = useMemo(() => {
    if (!detailsSearch.trim()) return appSummary;
    const q = detailsSearch.toLowerCase();
    return appSummary.filter((a) => a.appName.toLowerCase().includes(q));
  }, [appSummary, detailsSearch]);

  const dynamicProjectTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of timeBlocks) {
      if (b.date === selectedDate && b.project) {
        counts.set(b.project, (counts.get(b.project) || 0) + b.durationMinutes);
      }
    }
    for (const t of tasks) {
      if (t.project && !counts.has(t.project)) counts.set(t.project, 0);
    }
    for (const c of clients) {
      if (c.legalName && !counts.has(c.legalName)) counts.set(c.legalName, 0);
    }
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name]) => name);
    return ['all', ...top];
  }, [timeBlocks, tasks, clients, selectedDate]);

  const pendingSuggestedForDay = useMemo(() => {
    if (engineSessions.length === 0 || engineAttributions.length === 0) return [];
    const attrBySession = new Map(engineAttributions.map((a) => [a.sessionId, a]));
    return engineSessions
      .filter((s) => {
        if (s.isIdle) return false;
        const dt = new Date(s.startTimeUtc);
        const dayStr = Number.isNaN(dt.getTime()) ? selectedDate : toLocalDateString(dt);
        if (dayStr !== selectedDate) return false;
        const attr = attrBySession.get(s.id);
        return Boolean(
          attr && (attr.status === 'suggested' || attr.status === 'review_tray')
        );
      })
      .map((s) => ({
        session: s,
        attribution: attrBySession.get(s.id)!,
      }));
  }, [engineSessions, engineAttributions, selectedDate]);

  return (
    <div className="space-y-6">
      <WorkstationCapturePanel
        workstationDevices={workstationDevices}
        syncStatus={syncStatus}
        onNotify={onNotify}
        onOpenInstallers={onOpenInstallers}
      />

      {/* Top Header & KPI Strip */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            {timelineMode === 'day'
              ? 'Day View Activity Timeline'
              : '7-Day Time-Blocking Schedule Grid'}
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            {timelineMode === 'day' ? (
              <>
                Multi-track presence, applications used, documents opened, and task blocks for{' '}
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-200 tabular-nums">
                  {selectedDate}
                </span>
              </>
            ) : (
              <>
                Weekly time-block schedule across{' '}
                <span className="font-mono font-semibold text-slate-900 dark:text-slate-200 tabular-nums">
                  {weekDates[0]} → {weekDates[weekDates.length - 1]}
                </span>
                {' · Click any block to edit or any day header to inspect workstation tracks'}
              </>
            )}
          </p>
        </div>

        {/* Controls: Day Tracks vs Week Grid + Project Filter + Zoom Range Toggle */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setTimelineMode('day')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                timelineMode === 'day'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Day Tracks</span>
            </button>
            <button
              type="button"
              onClick={() => setTimelineMode('week')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                timelineMode === 'week'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <CalendarRange className="w-3.5 h-3.5" />
              <span>Week Grid</span>
            </button>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
            {dynamicProjectTabs.map((proj) => (
              <button
                key={proj}
                type="button"
                onClick={() => setProjectFilter(proj)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer max-w-[140px] truncate ${
                  projectFilter === proj
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {proj === 'all' ? 'All Engagements' : proj}
              </button>
            ))}
          </div>

          {timelineMode === 'day' && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <button
                type="button"
                onClick={() => setZoomMode('workday')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  zoomMode === 'workday'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Workday (08:00–20:00)
              </button>
              <button
                type="button"
                onClick={() => setZoomMode('full24')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  zoomMode === 'full24'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Full 24h
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 4-Column Day Metric Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Logged Task Time
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {formatDuration(dayMetrics.totalMinutes)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {dayBlocks.length} task blocks · {dayMetrics.deepWorkPercent}% deep work
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Active Workstation Presence
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
            {formatDuration(dayMetrics.activePresenceMinutes)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {dayMetrics.unreconciledCount > 0
              ? `${dayMetrics.unreconciledCount} idle gap awaiting review`
              : 'All idle intervals reconciled'}
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Applications & Documents Tracked
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-sky-700 dark:text-sky-400 tabular-nums">
            {dayMetrics.uniqueApps} Apps · {dayMetrics.uniqueDocs} Docs
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Automatic window & document capture
          </div>
        </div>

        <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Billable Client Hours
          </div>
          <div className="mt-1 font-mono text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
            {formatDuration(dayMetrics.billableMinutes)}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Ready for weekly stakeholder export
          </div>
        </div>
      </div>

      {timelineMode === 'week' ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70 dark:bg-slate-800/40">
            <div className="text-xs text-slate-600 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-white">
                7-Day Time-Block Schedule (08:00–20:00)
              </span>{' '}
              · Click any empty hour slot to schedule a block, or click a block to edit
            </div>
            <div className="font-mono text-xs tabular-nums text-slate-600 dark:text-slate-400">
              Week Total:{' '}
              <span className="font-bold text-slate-900 dark:text-white">
                {formatDuration(
                  timeBlocks
                    .filter(
                      (b) =>
                        weekDates.includes(b.date) &&
                        (projectFilter === 'all' || b.project === projectFilter)
                    )
                    .reduce((acc, b) => acc + b.durationMinutes, 0)
                )}
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[1040px]">
              {/* Day Column Headers */}
              <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/80">
                <div className="py-2.5 px-2 text-[11px] font-mono text-slate-400 border-r border-slate-200 dark:border-slate-800 text-center">
                  Hour
                </div>
                {weekDates.map((d) => {
                  const dt = new Date(`${d}T12:00:00`);
                  const weekday = dt.toLocaleDateString('en-US', { weekday: 'short' });
                  const colBlocks = timeBlocks.filter(
                    (b) =>
                      b.date === d &&
                      (projectFilter === 'all' || b.project === projectFilter)
                  );
                  const colTotal = colBlocks.reduce(
                    (acc, b) => acc + b.durationMinutes,
                    0
                  );
                  const isSelectedDay = d === selectedDate;
                  return (
                    <div
                      key={d}
                      className={`py-2 px-2.5 border-r last:border-r-0 border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-1 ${
                        isSelectedDay
                          ? 'bg-indigo-50/80 dark:bg-indigo-950/40'
                          : ''
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelectDate(d);
                          setTimelineMode('day');
                        }}
                        title={`Open 4-track OnTrack Day View for ${d}`}
                        className="text-left cursor-pointer group"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`text-xs font-bold ${
                              isSelectedDay
                                ? 'text-indigo-700 dark:text-indigo-300'
                                : 'text-slate-900 dark:text-white group-hover:text-indigo-600'
                            }`}
                          >
                            {weekday}
                          </span>
                          <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                            {d.slice(5)}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-semibold">
                          {formatDuration(colTotal)}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectDate(d);
                          onOpenQuickLogWithRange(9 * 60, 10 * 60);
                        }}
                        title={`Log time block on ${d}`}
                        className="p-1 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-white dark:hover:bg-slate-800 rounded cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* 12-Hour Vertical Schedule Body (08:00 - 20:00) */}
              <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] relative">
                {/* Left Hour Axis */}
                <div className="border-r border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900/40">
                  {Array.from({ length: 12 }, (_, idx) => 8 + idx).map((hr) => (
                    <div
                      key={hr}
                      className="h-12 border-b last:border-b-0 border-slate-200/70 dark:border-slate-800/70 px-2 pt-1 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 text-right"
                    >
                      {String(hr).padStart(2, '0')}:00
                    </div>
                  ))}
                </div>

                {/* 7 Day Columns */}
                {weekDates.map((d) => {
                  const colBlocks = timeBlocks.filter(
                    (b) =>
                      b.date === d &&
                      (projectFilter === 'all' || b.project === projectFilter)
                  );
                  const isSelectedDay = d === selectedDate;
                  const weekRangeStart = 8 * 60;
                  const weekRangeMins = 12 * 60;

                  return (
                    <div
                      key={`col-${d}`}
                      className={`relative border-r last:border-r-0 border-slate-200/80 dark:border-slate-800 h-[576px] ${
                        isSelectedDay
                          ? 'bg-indigo-50/20 dark:bg-indigo-950/10'
                          : ''
                      }`}
                    >
                      {/* Clickable Hour Slots */}
                      {Array.from({ length: 12 }, (_, idx) => 8 + idx).map((hr) => (
                        <div
                          key={`${d}-${hr}`}
                          onClick={() => {
                            onSelectDate(d);
                            onOpenQuickLogWithRange(hr * 60, (hr + 1) * 60);
                          }}
                          title={`Click to log time on ${d} at ${String(hr).padStart(2, '0')}:00`}
                          className="h-12 border-b last:border-b-0 border-slate-100 dark:border-slate-800/70 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20 transition-colors cursor-crosshair"
                        />
                      ))}

                      {/* Positioned TimeBlocks */}
                      {colBlocks.map((block) => {
                        const clampedStart = Math.max(
                          weekRangeStart,
                          Math.min(weekRangeStart + weekRangeMins, block.startTime)
                        );
                        const clampedEnd = Math.max(
                          weekRangeStart,
                          Math.min(weekRangeStart + weekRangeMins, block.endTime)
                        );
                        if (clampedEnd <= clampedStart) return null;

                        const topPct =
                          ((clampedStart - weekRangeStart) / weekRangeMins) * 100;
                        const heightPct = Math.max(
                          ((clampedEnd - clampedStart) / weekRangeMins) * 100,
                          4.5
                        );
                        const pColor =
                          PROJECT_COLORS[block.project] ||
                          PROJECT_COLORS['Core Platform'];

                        return (
                          <button
                            key={block.id}
                            type="button"
                            style={{
                              top: `calc(${topPct.toFixed(2)}% + 2px)`,
                              height: `calc(${heightPct.toFixed(2)}% - 4px)`,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectDate(d);
                              onEditTimeBlock(block);
                            }}
                            title={`${block.title} · ${block.project}\n${formatMinutesToHHMM(
                              block.startTime
                            )}–${formatMinutesToHHMM(block.endTime)} (${formatDuration(
                              block.durationMinutes
                            )})`}
                            className={`absolute left-1 right-1 rounded-md border px-2 py-1 text-left overflow-hidden flex flex-col justify-start transition-shadow hover:shadow-md cursor-pointer ${pColor.bg} ${pColor.border} ${pColor.text}`}
                          >
                            <div className="text-[11px] font-semibold truncate leading-tight">
                              {block.title}
                            </div>
                            <div className="text-[10px] font-mono tabular-nums opacity-85 truncate">
                              {formatMinutesToHHMM(block.startTime)}–
                              {formatMinutesToHHMM(block.endTime)} ·{' '}
                              {formatDuration(block.durationMinutes)}
                            </div>
                          </button>
                        );
                      })}

                      {/* Current Time ("Now") Line across today's column in Week Grid */}
                      {d === todayDateStr &&
                        nowMinutes >= weekRangeStart &&
                        nowMinutes <= weekRangeStart + weekRangeMins && (
                          <div
                            aria-label={`Current time ${formatMinutesToHHMM(nowMinutes)}`}
                            style={{
                              top: `${(
                                ((nowMinutes - weekRangeStart) / weekRangeMins) *
                                100
                              ).toFixed(2)}%`,
                            }}
                            className="pointer-events-none absolute left-0 right-0 z-20 flex items-center"
                          >
                            <span className="-ml-1 px-1 py-px rounded bg-rose-500 text-white font-mono text-[9px] font-bold tabular-nums leading-none shadow-xs">
                              {formatMinutesToHHMM(nowMinutes)}
                            </span>
                            <div className="h-[2px] flex-1 bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.45)]" />
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
      {/* OnTrack Multi-Track Synchronized Timeline Instrument */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-400">
            <span className="font-semibold text-slate-900 dark:text-white">
              Synchronized OnTrack Activity Tracks
            </span>
            <span>
              Click any document or app segment to tag it as a task block, or click Track 4 to log time
            </span>
          </div>
          <button
            type="button"
            onClick={() => onOpenQuickLogWithRange(9 * 60, 10 * 60)}
            className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Manual Time Block</span>
          </button>
        </div>

        {/* Synchronized Time Ruler + 5 Activity Tracks Container (shared coordinates for Now Line) */}
        <div className="relative">
          {showDayNowLine && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-20 grid grid-cols-[185px_1fr] gap-4"
            >
              <div />
              <div className="relative h-full">
                <div
                  style={{ left: `${dayNowLeftPct.toFixed(2)}%` }}
                  className="absolute top-0 bottom-0 -translate-x-1/2 flex flex-col items-center"
                >
                  <span className="px-1.5 py-0.5 rounded bg-rose-500 text-white font-mono text-[10px] font-bold tabular-nums leading-none shadow-xs whitespace-nowrap">
                    {formatMinutesToHHMM(nowMinutes)}
                  </span>
                  <div className="w-[2.5px] flex-1 bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.5)]" />
                </div>
              </div>
            </div>
          )}

        {/* Time Ruler Header */}
        <div className="grid grid-cols-[185px_1fr] gap-4 items-center mb-2">
          <div className="text-[11px] font-mono text-slate-400">
            Time Scale ({zoomMode === 'workday' ? '12h' : '24h'})
          </div>
          <div className="relative h-6 border-b border-slate-200 dark:border-slate-800">
            {hourTicks.map((hour, i) => {
              const leftPct = (i / (hourTicks.length - 1)) * 100;
              return (
                <div
                  key={hour}
                  style={{ left: `${leftPct}%` }}
                  className="absolute top-0 -translate-x-1/2 flex flex-col items-center"
                >
                  <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {String(hour).padStart(2, '0')}:00
                  </span>
                  <div className="h-1.5 w-px bg-slate-300 dark:bg-slate-700 mt-0.5" />
                </div>
              );
            })}
          </div>
        </div>

        {/* Track 1: Computer Usage / Activity & Idle */}
        <div className="grid grid-cols-[185px_1fr] gap-4 items-center py-2 border-b border-slate-100 dark:border-slate-800/70">
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white">
              1. Activity & Idle
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Active vs. Away presence
            </div>
          </div>
          <div className="relative h-8 bg-slate-100/80 dark:bg-slate-800/50 rounded-lg overflow-hidden border border-slate-200/70 dark:border-slate-800">
            {daySegments.map((seg) => {
              const geom = getTrackGeometry(seg.startTime, seg.endTime);
              if (!geom) return null;
              const isIdleUnreconciled = seg.state === 'idle' && !seg.reconciled;
              const colorClass =
                seg.state === 'active'
                  ? 'bg-emerald-600/85 hover:bg-emerald-600 text-white'
                  : seg.state === 'idle'
                  ? 'bg-amber-500/90 hover:bg-amber-500 text-slate-950'
                  : 'bg-slate-300 dark:bg-slate-700 text-slate-700 dark:text-slate-300';

              return (
                <button
                  key={seg.id}
                  type="button"
                  style={geom}
                  onClick={() => {
                    if (seg.state === 'idle') {
                      onReconcileSegment(seg);
                    }
                  }}
                  title={`${seg.label} (${formatMinutesToHHMM(
                    seg.startTime
                  )}–${formatMinutesToHHMM(seg.endTime)})`}
                  className={`absolute top-1 bottom-1 rounded px-2 flex items-center text-[11px] font-medium truncate transition-opacity cursor-pointer ${colorClass} ${
                    isIdleUnreconciled ? 'ring-2 ring-amber-400' : ''
                  }`}
                >
                  <span className="truncate">
                    {seg.state === 'active'
                      ? 'Active'
                      : seg.state === 'idle'
                      ? 'Idle (Reconcile)'
                      : 'Away'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Track 2: Applications Used (Workstation Applications Track) */}
        <div className="grid grid-cols-[185px_1fr] gap-4 items-center py-2 border-b border-slate-100 dark:border-slate-800/70">
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white">
              2. Applications Used
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Foreground app focus
            </div>
          </div>
          <div className="relative h-9 bg-slate-100/80 dark:bg-slate-800/50 rounded-lg overflow-hidden border border-slate-200/70 dark:border-slate-800">
            {dayApps.map((appSeg) => {
              const geom = getTrackGeometry(appSeg.startTime, appSeg.endTime);
              if (!geom) return null;
              const style =
                APP_COLORS[appSeg.appName] || APP_COLORS['Google Chrome'];
              const dur = Math.max(1, appSeg.endTime - appSeg.startTime);

              return (
                <button
                  key={appSeg.id}
                  type="button"
                  style={geom}
                  onClick={() => {
                    setDetailsTab('apps');
                    setDetailsSearch(appSeg.appName);
                  }}
                  title={`${appSeg.appName} (${formatMinutesToHHMM(
                    appSeg.startTime
                  )}–${formatMinutesToHHMM(appSeg.endTime)} · ${formatDuration(
                    dur
                  )})`}
                  className={`absolute top-1 bottom-1 rounded px-2 flex items-center text-[11px] font-semibold text-white truncate transition-opacity hover:opacity-90 cursor-pointer ${style.bar}`}
                >
                  <span className="truncate">{appSeg.appName}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Track 3: Documents & Windows Opened (Workstation Documents Track) */}
        <div className="grid grid-cols-[185px_1fr] gap-4 items-center py-2 border-b border-slate-100 dark:border-slate-800/70">
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white">
              3. Documents Opened
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Files, tabs & active titles
            </div>
          </div>
          <div className="relative h-10 bg-slate-50 dark:bg-slate-800/40 rounded-lg overflow-hidden border border-slate-200/80 dark:border-slate-800">
            {dayDocs.map((docSeg) => {
              const geom = getTrackGeometry(docSeg.startTime, docSeg.endTime);
              if (!geom) return null;
              const style =
                APP_COLORS[docSeg.appName] || APP_COLORS['Google Chrome'];
              const isSelected = selectedDocId === docSeg.id;
              const dur = Math.max(1, docSeg.endTime - docSeg.startTime);

              return (
                <button
                  key={docSeg.id}
                  type="button"
                  style={geom}
                  onClick={() => {
                    setSelectedBlockId(null);
                    setSelectedDocId(selectedDocId === docSeg.id ? null : docSeg.id);
                  }}
                  title={`${docSeg.appName}: ${docSeg.documentTitle}\n${
                    docSeg.domainOrPath
                  }\n${formatMinutesToHHMM(docSeg.startTime)}–${formatMinutesToHHMM(
                    docSeg.endTime
                  )} (${formatDuration(dur)})`}
                  className={`absolute top-1 bottom-1 rounded px-2 flex flex-col justify-center text-left overflow-hidden border transition-all cursor-pointer ${
                    style.bg
                  } ${style.border} ${style.text} ${
                    isSelected ? 'ring-2 ring-indigo-600 z-10' : 'hover:opacity-90'
                  }`}
                >
                  <div className="text-[11px] font-semibold truncate leading-tight">
                    {docSeg.documentTitle}
                  </div>
                  <div className="text-[10px] opacity-80 truncate leading-tight">
                    {docSeg.appName}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Track 4: Task & Project Timeline Blocks */}
        <div className="grid grid-cols-[185px_1fr] gap-4 items-center py-2.5 border-b border-slate-100 dark:border-slate-800/70">
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white">
              4. Task Blocks
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Practice task allocations
            </div>
          </div>
          <div
            onClick={handleTimelineCanvasClick}
            className="relative h-12 bg-slate-50 dark:bg-slate-800/40 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 cursor-crosshair"
            title="Click any empty space to log a time block at that hour"
          >
            {dayBlocks.map((block) => {
              const geom = getTrackGeometry(block.startTime, block.endTime);
              if (!geom) return null;
              const pColor =
                PROJECT_COLORS[block.project] || PROJECT_COLORS['Core Platform'];
              const isSelected = selectedBlockId === block.id;

              return (
                <button
                  key={block.id}
                  type="button"
                  style={geom}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedDocId(null);
                    if (selectedBlockId === block.id) {
                      setSelectedBlockId(null);
                      setSelectedBlockAnchor(null);
                    } else {
                      setSelectedBlockId(block.id);
                      setSelectedBlockAnchor({
                        date: block.date,
                        startTime: block.startTime,
                      });
                    }
                  }}
                  title={`${block.title} · ${block.project} (${formatMinutesToHHMM(
                    block.startTime
                  )}–${formatMinutesToHHMM(block.endTime)}, ${formatDuration(
                    block.durationMinutes
                  )})`}
                  className={`absolute top-1 bottom-1 rounded-md px-2.5 flex flex-col justify-center text-left overflow-hidden border transition-all cursor-pointer ${
                    pColor.bg
                  } ${pColor.border} ${pColor.text} ${
                    isSelected ? 'ring-2 ring-indigo-600 z-10' : 'hover:opacity-90'
                  }`}
                >
                  <div className="text-xs font-semibold truncate leading-tight">
                    {block.title}
                  </div>
                  <div className="text-[10px] font-mono tabular-nums opacity-85 truncate">
                    {formatMinutesToHHMM(block.startTime)}–
                    {formatMinutesToHHMM(block.endTime)} · {block.project}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Track 5: Tag & Work Category Ribbon */}
        <div className="grid grid-cols-[185px_1fr] gap-4 items-center pt-2.5">
          <div>
            <div className="text-xs font-semibold text-slate-900 dark:text-white">
              5. Work Category & Tags
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Deep work vs. Billable
            </div>
          </div>
          <div className="relative h-8 bg-slate-100/70 dark:bg-slate-800/40 rounded-lg overflow-hidden border border-slate-200/70 dark:border-slate-800">
            {dayBlocks.map((block) => {
              const geom = getTrackGeometry(block.startTime, block.endTime);
              if (!geom) return null;
              const style =
                CATEGORY_RIBBON_STYLES[block.category] ||
                CATEGORY_RIBBON_STYLES.deep_work;

              return (
                <div
                  key={`cat-${block.id}`}
                  style={geom}
                  title={`${CATEGORY_LABELS[block.category]} · Tags: ${block.tags.join(
                    ', '
                  )}`}
                  className={`absolute top-1.5 bottom-1.5 rounded-xs px-2 flex items-center text-[10px] font-medium text-white truncate ${style.bar}`}
                >
                  <span className="truncate">
                    {CATEGORY_LABELS[block.category]}
                    {block.tags.length > 0 ? ` · #${block.tags[0]}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {dayBlocks.length === 0 &&
          daySegments.length === 0 &&
          dayApps.length === 0 &&
          dayDocs.length === 0 && (
            <div className="mt-4 p-4 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/30 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-slate-600 dark:text-slate-300">
                No sessions or time blocks recorded for <span className="font-mono font-semibold">{selectedDate}</span> yet. Click Track 4 above or add a block to get started.
              </span>
              <button
                type="button"
                onClick={() => onOpenQuickLogWithRange(9 * 60, 10 * 60)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-md cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Log First Block</span>
              </button>
            </div>
          )}

        {/* Track Legend */}
        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex flex-wrap items-center gap-4">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              Category Key:
            </span>
            <span>Deep Work (Indigo)</span>
            <span>·</span>
            <span>Billable Delivery (Emerald)</span>
            <span>·</span>
            <span>Collaborative (Amber)</span>
            <span>·</span>
            <span>Admin & Ops (Slate)</span>
            {showDayNowLine && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1.5 font-mono tabular-nums text-rose-600 dark:text-rose-400 font-semibold">
                  <span className="inline-block w-0.5 h-3 bg-rose-400" aria-hidden="true" />
                  <span>Now {formatMinutesToHHMM(nowMinutes)}</span>
                </span>
              </>
            )}
            {isTodaySelected && !showDayNowLine && zoomMode === 'workday' && (
              <>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => setZoomMode('full24')}
                  className="font-mono tabular-nums text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                >
                  Now ({formatMinutesToHHMM(nowMinutes)}) outside 08:00–20:00 · Switch to Full 24h
                </button>
              </>
            )}
          </div>
          <div className="font-mono tabular-nums">
            Showing {formatMinutesToHHMM(rangeStartMin)} to{' '}
            {formatMinutesToHHMM(rangeEndMin)}
          </div>
        </div>
        </div>
      </div>

      {/* Inline Auto-Tracked Attribution Review Strip (ManicTime-style instant tagging on Timeline) */}
      {pendingSuggestedForDay.length > 0 && onResolveTimelineAttribution && (
        <div
          data-testid="timeline-suggested-review-tray"
          className="bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/60 rounded-xl px-4 py-3 space-y-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200 font-semibold">
              <Sparkles className="w-4 h-4 text-amber-600" />
              <span>
                {pendingSuggestedForDay.length} auto-tracked workstation{' '}
                {pendingSuggestedForDay.length === 1 ? 'session' : 'sessions'} awaiting timeline confirmation
              </span>
            </div>
            <button
              type="button"
              onClick={() => setReviewTrayExpanded((prev) => !prev)}
              className="font-semibold text-amber-800 dark:text-amber-300 hover:underline cursor-pointer"
            >
              {reviewTrayExpanded ? 'Hide Review Queue' : 'Review & Confirm Now'}
            </button>
          </div>

          {reviewTrayExpanded && (
            <div className="divide-y divide-amber-200/70 dark:divide-amber-800/50 border-t border-amber-200/70 dark:border-amber-800/50 pt-2">
              {pendingSuggestedForDay.map(({ session, attribution }) => {
                const startDt = new Date(session.startTimeUtc);
                const endDt = new Date(session.endTimeUtc);
                const startMin = startDt.getHours() * 60 + startDt.getMinutes();
                const endMin = Math.max(startMin + 15, endDt.getHours() * 60 + endDt.getMinutes());
                const selectedTaskId =
                  suggestedTaskDraft[session.id] ?? attribution.taskId ?? tasks[0]?.id ?? '';
                return (
                  <div
                    key={session.id}
                    data-testid="review-tray-row"
                    className="py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-semibold text-slate-900 dark:text-white truncate">
                        {session.primaryApp} · {session.primaryTitle}
                      </div>
                      <div className="font-mono text-[11px] tabular-nums text-slate-600 dark:text-slate-400">
                        {formatMinutesToHHMM(startMin)}–{formatMinutesToHHMM(endMin)} ·{' '}
                        {Math.round(attribution.confidence * 100)}% confidence · {attribution.reason}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <select
                        value={selectedTaskId}
                        onChange={(e) =>
                          setSuggestedTaskDraft((prev) => ({
                            ...prev,
                            [session.id]: e.target.value,
                          }))
                        }
                        aria-label={`Assign task for ${session.primaryTitle}`}
                        className="px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-white max-w-[220px]"
                      >
                        <option value="">-- Unlinked Client Session --</option>
                        {tasks.map((t) => (
                          <option key={t.id} value={t.id}>
                            [{t.project}] {t.title}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          onResolveTimelineAttribution({
                            sessionId: session.id,
                            taskId: selectedTaskId || null,
                            status: 'confirmed',
                          })
                        }
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-md cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Confirm to Track 4</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onResolveTimelineAttribution({
                            sessionId: session.id,
                            taskId: null,
                            status: 'dismissed',
                          })
                        }
                        className="inline-flex items-center gap-1 px-2 py-1.5 font-medium text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 rounded-md cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                        <span>Dismiss</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Selected Document Inspector Banner (when clicking Track 3 Document block) */}
      {selectedDoc && (
        <div
          data-testid="selected-doc-inspector"
          className="bg-sky-50/70 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800/60 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-sky-700 dark:text-sky-300 font-medium">
              <span>Captured Document Window</span>
              <span>·</span>
              <span>{selectedDoc.appName}</span>
              <span>·</span>
              <span className="font-mono tabular-nums">
                {formatMinutesToHHMM(selectedDoc.startTime)} –{' '}
                {formatMinutesToHHMM(selectedDoc.endTime)} (
                {formatDuration(selectedDoc.endTime - selectedDoc.startTime)})
              </span>
            </div>
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {selectedDoc.documentTitle}
            </h3>
            <p className="text-xs font-mono text-slate-600 dark:text-slate-400">
              {selectedDoc.domainOrPath}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0 text-xs">
            <select
              value={docQuickTaskId || selectedDoc.linkedTaskId || ''}
              onChange={(e) => setDocQuickTaskId(e.target.value)}
              aria-label="Quick select task for captured document"
              className="px-2.5 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white max-w-[210px]"
            >
              <option value="">Choose task (optional)...</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  [{t.project}] {t.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                onConvertAppDocToBlock({
                  appName: selectedDoc.appName,
                  documentTitle: selectedDoc.documentTitle,
                  startTime: selectedDoc.startTime,
                  endTime: selectedDoc.endTime,
                  linkedTaskId: docQuickTaskId || selectedDoc.linkedTaskId,
                });
                setSelectedDocId(null);
                setDocQuickTaskId('');
              }}
              className="flex items-center gap-1.5 px-3.5 py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <TagIcon className="w-3.5 h-3.5" />
              <span>Tag as Task Time Block</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedDocId(null);
                setDocQuickTaskId('');
              }}
              className="px-3 py-2 font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Selected Block Inspector Banner (when clicking Track 4 Task block) */}
      {selectedBlock && (
        <div
          data-testid="selected-block-inspector"
          className="bg-indigo-50/70 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800/60 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-indigo-700 dark:text-indigo-300 font-medium">
              <span>Selected Timeline Block</span>
              <span>·</span>
              <span className="font-mono tabular-nums">
                {formatMinutesToHHMM(selectedBlock.startTime)} –{' '}
                {formatMinutesToHHMM(selectedBlock.endTime)} (
                {formatDuration(selectedBlock.durationMinutes)})
              </span>
              <span>·</span>
              <span>{selectedBlock.project}</span>
            </div>
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {selectedBlock.title}
            </h3>
            {selectedBlock.notes && (
              <p className="text-xs text-slate-600 dark:text-slate-300">
                {selectedBlock.notes}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0 text-xs">
            {onQuickUpdateTimeBlock && (
              <>
                <button
                  type="button"
                  title="Shorten block end by 15 minutes"
                  disabled={selectedBlock.durationMinutes <= 15}
                  onClick={() => {
                    const nextEnd = Math.max(selectedBlock.startTime + 15, selectedBlock.endTime - 15);
                    onQuickUpdateTimeBlock({
                      ...selectedBlock,
                      endTime: nextEnd,
                      durationMinutes: nextEnd - selectedBlock.startTime,
                    });
                  }}
                  className="px-2.5 py-1.5 font-mono font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                >
                  -15m
                </button>
                <button
                  type="button"
                  title="Extend block end by 15 minutes"
                  disabled={selectedBlock.endTime >= 1440}
                  onClick={() => {
                    const nextEnd = Math.min(1440, selectedBlock.endTime + 15);
                    onQuickUpdateTimeBlock({
                      ...selectedBlock,
                      endTime: nextEnd,
                      durationMinutes: nextEnd - selectedBlock.startTime,
                    });
                  }}
                  className="px-2.5 py-1.5 font-mono font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-40 cursor-pointer"
                >
                  +15m
                </button>
                <select
                  value={selectedBlock.taskId || ''}
                  onChange={(e) => {
                    const task = tasks.find((t) => t.id === e.target.value);
                    onQuickUpdateTimeBlock({
                      ...selectedBlock,
                      taskId: task ? task.id : null,
                      project: task ? task.project : selectedBlock.project,
                      title: task ? task.title : selectedBlock.title,
                    });
                  }}
                  aria-label="Reassign block task"
                  className="px-2.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 max-w-[180px]"
                >
                  <option value="">Unlinked / Custom</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      [{t.project}] {t.title}
                    </option>
                  ))}
                </select>
              </>
            )}
            {selectedBlock.taskId && (
              <button
                type="button"
                onClick={() => onStartTimerForTask(selectedBlock.taskId!)}
                className="flex items-center gap-1.5 px-3 py-1.5 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Resume Task Timer</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onEditTimeBlock(selectedBlock)}
              className="flex items-center gap-1.5 px-3 py-1.5 font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>Edit Block</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onDeleteTimeBlock(selectedBlock.id);
                setSelectedBlockId(null);
                setSelectedBlockAnchor(null);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 font-medium text-rose-600 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-rose-50 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}

      {/* Lower Split: Tabbed Details Log (Left 2/3) + Applications / Documents / Projects Summary (Right 1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left 2 Columns: OnTrack Day Details Log Table (Task Blocks | Applications | Documents) */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <button
                type="button"
                onClick={() => setDetailsTab('blocks')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  detailsTab === 'blocks'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                Task Time Blocks ({dayBlocks.length})
              </button>
              <button
                type="button"
                onClick={() => setDetailsTab('apps')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  detailsTab === 'apps'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                Applications Used ({appSummary.length})
              </button>
              <button
                type="button"
                onClick={() => setDetailsTab('docs')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  detailsTab === 'docs'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                }`}
              >
                Documents Opened ({dayDocs.length})
              </button>
            </div>

            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={detailsSearch}
                  onChange={(e) => setDetailsSearch(e.target.value)}
                  placeholder="Search log..."
                  className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 w-44"
                />
              </div>
              <button
                type="button"
                onClick={() => onOpenQuickLogWithRange(10 * 60, 11 * 60)}
                className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                + Log Entry
              </button>
            </div>
          </div>

          {detailsTab === 'blocks' && (
            <>
              {filteredDayBlocks.length === 0 ? (
                <div className="p-10 text-center">
                  <Clock className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                  <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    No matching time blocks for {selectedDate}
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-sm mx-auto">
                    Start the live task stopwatch above, tag an opened document, or click Track 4 to log a new time block.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-50/60 dark:bg-slate-800/40">
                        <th className="py-2.5 px-4">Time Window</th>
                        <th className="py-2.5 px-4">Task & Metadata</th>
                        <th className="py-2.5 px-4">Source</th>
                        <th className="py-2.5 px-4 text-right">Duration</th>
                        <th className="py-2.5 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {filteredDayBlocks.map((block) => {
                        const linkedTask = tasks.find(
                          (t) => t.id === block.taskId
                        );
                        return (
                          <tr
                            key={block.id}
                            className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                          >
                            <td className="py-3 px-4 font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                              {formatMinutesToHHMM(block.startTime)} –{' '}
                              {formatMinutesToHHMM(block.endTime)}
                            </td>
                            <td className="py-3 px-4">
                              <div className="font-semibold text-slate-900 dark:text-white">
                                {block.title}
                              </div>
                              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                <span className="font-medium text-slate-700 dark:text-slate-300">
                                  {block.project}
                                </span>
                                <span>·</span>
                                <span>{CATEGORY_LABELS[block.category]}</span>
                                {block.appName && (
                                  <>
                                    <span>·</span>
                                    <span>{block.appName}</span>
                                  </>
                                )}
                                {block.isBillable && (
                                  <>
                                    <span>·</span>
                                    <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                                      Billable
                                    </span>
                                  </>
                                )}
                                {block.tags.length > 0 && (
                                  <>
                                    <span>·</span>
                                    <span>
                                      {block.tags.map((t) => `#${t}`).join(' ')}
                                    </span>
                                  </>
                                )}
                              </div>
                              {block.notes && (
                                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 italic">
                                  {block.notes}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-4 text-slate-500 dark:text-slate-400 whitespace-nowrap capitalize">
                              {block.source}
                            </td>
                            <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white whitespace-nowrap">
                              {formatDuration(block.durationMinutes)}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              <div className="inline-flex items-center gap-1">
                                {linkedTask && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onStartTimerForTask(linkedTask.id)
                                    }
                                    title="Start timer for this task"
                                    className="p-1.5 text-slate-500 hover:text-indigo-600 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                                  >
                                    <Play className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => onEditTimeBlock(block)}
                                  title="Edit time block"
                                  className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => onDeleteTimeBlock(block.id)}
                                  title="Delete time block"
                                  className="p-1.5 text-slate-500 hover:text-rose-600 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {detailsTab === 'apps' && (
            <div className="overflow-x-auto">
              {filteredAppSummary.length === 0 ? (
                <div className="p-10 text-center text-xs text-slate-500">
                  No applications recorded for {selectedDate}.
                </div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-50/60 dark:bg-slate-800/40">
                      <th className="py-2.5 px-4">Application Name</th>
                      <th className="py-2.5 px-4">Share of Day</th>
                      <th className="py-2.5 px-4 text-right">Focus Time</th>
                      <th className="py-2.5 px-4 text-right">Inspect Docs</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                    {filteredAppSummary.map((app) => {
                      const style =
                        APP_COLORS[app.appName] || APP_COLORS['Google Chrome'];
                      return (
                        <tr
                          key={app.appName}
                          className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40"
                        >
                          <td className="py-3 px-4 font-semibold text-slate-900 dark:text-white">
                            {app.appName}
                          </td>
                          <td className="py-3 px-4 w-56">
                            <div className="flex items-center gap-2">
                              <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                                <div
                                  style={{ width: `${app.percent}%` }}
                                  className={`h-full rounded-full ${style.bar}`}
                                />
                              </div>
                              <span className="font-mono tabular-nums text-[11px] text-slate-500 w-9 text-right">
                                {app.percent}%
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                            {formatDuration(app.minutes)}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setDetailsTab('docs');
                                setDetailsSearch(app.appName);
                              }}
                              className="text-xs font-semibold text-indigo-600 hover:text-indigo-500 cursor-pointer"
                            >
                              View Docs →
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {detailsTab === 'docs' && (
            <div className="overflow-x-auto">
              {filteredDayDocs.length === 0 ? (
                <div className="p-10 text-center text-xs text-slate-500">
                  No documents or window titles recorded for {selectedDate}.
                </div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400 bg-slate-50/60 dark:bg-slate-800/40">
                      <th className="py-2.5 px-4">Window</th>
                      <th className="py-2.5 px-4">Document / File / URL</th>
                      <th className="py-2.5 px-4">Application</th>
                      <th className="py-2.5 px-4 text-right">Duration</th>
                      <th className="py-2.5 px-4 text-right">Tag Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                    {filteredDayDocs.map((doc) => {
                      const dur = Math.max(1, doc.endTime - doc.startTime);
                      return (
                        <tr
                          key={doc.id}
                          className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40"
                        >
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {formatMinutesToHHMM(doc.startTime)} –{' '}
                            {formatMinutesToHHMM(doc.endTime)}
                          </td>
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {doc.documentTitle}
                            </div>
                            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate max-w-md">
                              {doc.domainOrPath}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-slate-700 dark:text-slate-300 whitespace-nowrap">
                            {doc.appName}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums text-slate-900 dark:text-white whitespace-nowrap">
                            {formatDuration(dur)}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() =>
                                onConvertAppDocToBlock({
                                  appName: doc.appName,
                                  documentTitle: doc.documentTitle,
                                  startTime: doc.startTime,
                                  endTime: doc.endTime,
                                  linkedTaskId: doc.linkedTaskId,
                                })
                              }
                              className="px-2.5 py-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 rounded-md cursor-pointer"
                            >
                              + Tag Task
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Right 1 Column: OnTrack Day Summary (Applications, Documents, Projects, Tags) */}
        <div className="space-y-5">
          {/* Top Applications Used Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3.5">
              <div className="flex items-center gap-2">
                <AppWindow className="w-4 h-4 text-sky-600" />
                <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Top Applications Used
                </h3>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {appSummary.length} apps
              </span>
            </div>

            {appSummary.length === 0 ? (
              <p className="text-xs text-slate-500">No applications logged.</p>
            ) : (
              <div className="space-y-3">
                {appSummary.map((app) => {
                  const style =
                    APP_COLORS[app.appName] || APP_COLORS['Google Chrome'];
                  return (
                    <div key={app.appName} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {app.appName}
                        </span>
                        <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {formatDuration(app.minutes)} ({app.percent}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${app.percent}%` }}
                          className={`h-full rounded-full ${style.bar}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top Documents Opened Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" />
                <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Top Documents Opened
                </h3>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {docSummary.length} docs
              </span>
            </div>

            {docSummary.length === 0 ? (
              <p className="text-xs text-slate-500">No documents opened.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {docSummary.slice(0, 6).map((doc) => (
                  <div
                    key={doc.documentTitle}
                    onClick={() =>
                      onConvertAppDocToBlock({
                        appName: doc.appName,
                        documentTitle: doc.documentTitle,
                        startTime: doc.latestStart,
                        endTime: doc.latestEnd,
                        linkedTaskId: doc.linkedTaskId,
                      })
                    }
                    title="Click to tag this document session as a task time block"
                    className="py-2.5 flex items-start justify-between gap-2 hover:bg-slate-50 dark:hover:bg-slate-800/40 rounded px-1 -mx-1 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                        {doc.documentTitle}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {doc.appName}
                      </div>
                    </div>
                    <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300 font-semibold shrink-0">
                      {formatDuration(doc.minutes)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Project Allocation Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-600" />
                <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                  Project Time Summary
                </h3>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {formatDuration(dayMetrics.totalMinutes)}
              </span>
            </div>

            {projectSummary.length === 0 ? (
              <p className="text-xs text-slate-500">No project hours recorded.</p>
            ) : (
              <div className="space-y-3">
                {projectSummary.map((item) => {
                  const color =
                    PROJECT_COLORS[item.project] ||
                    PROJECT_COLORS['Core Platform'];
                  return (
                    <div key={item.project} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {item.project}
                        </span>
                        <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          {formatDuration(item.minutes)} ({item.percent}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          style={{ width: `${item.percent}%` }}
                          className={`h-full rounded-full ${color.bar}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Tag Distribution Card */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Tag className="w-4 h-4 text-emerald-600" />
              <h3 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                Activity Tag Combos
              </h3>
            </div>

            {tagSummary.length === 0 ? (
              <p className="text-xs text-slate-500">No tags logged today.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
                {tagSummary.map((item) => (
                  <div
                    key={item.tag}
                    className="py-2 flex items-center justify-between"
                  >
                    <span className="text-slate-700 dark:text-slate-300 font-medium">
                      #{item.tag}
                    </span>
                    <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                      {formatDuration(item.minutes)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
};
