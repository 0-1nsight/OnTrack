import { ClientDictionaryEntry } from '../engine/types';
import {
  ActivitySegment,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  Task,
  TimeBlock,
} from '../types';

export interface DailyFocusPoint {
  date: string;
  shortDay: string;
  totalMins: number;
  deepMins: number;
  billableMins: number;
  collabMins: number;
  adminMins: number;
}

export interface ProjectComparisonRow {
  project: string;
  isConfiguredClient: boolean;
  taskCount: number;
  completedTasks: number;
  blockedTasks: number;
  plannedMins: number;
  actualMins: number;
  billableMins: number;
  utilizationPercent: number | null;
}

export interface PresenceSummaryStats {
  activeMins: number;
  idleMins: number;
  awayMins: number;
  focusEfficiency: number;
}

export interface WeeklyAppSummaryRow {
  appName: string;
  mins: number;
  sharePct: number;
}

export interface WeeklyDocSummaryRow {
  documentTitle: string;
  appName: string;
  domainOrPath: string;
  mins: number;
}

export function deriveDynamicWorkstreams(params: {
  clients?: ClientDictionaryEntry[];
  tasks: Task[];
  timeBlocks: TimeBlock[];
  fallbackDefaults?: string[];
}): string[] {
  const { clients = [], tasks, timeBlocks, fallbackDefaults = [] } = params;
  const seen = new Map<string, string>();

  const register = (raw?: string | null) => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, trimmed);
    }
  };

  for (const c of clients) {
    register(c.legalName);
  }
  for (const t of tasks) {
    register(t.project);
  }
  for (const b of timeBlocks) {
    register(b.project);
  }

  if (seen.size === 0) {
    for (const def of fallbackDefaults) {
      register(def);
    }
  }

  return Array.from(seen.values());
}

export function buildDailyFocusSeries(params: {
  weekDates: string[];
  timeBlocks: TimeBlock[];
}): DailyFocusPoint[] {
  const { weekDates, timeBlocks } = params;
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
      shortDay: date.slice(5),
      totalMins,
      deepMins,
      billableMins,
      collabMins,
      adminMins,
    };
  });
}

export function buildProjectComparison(params: {
  clients?: ClientDictionaryEntry[];
  tasks: Task[];
  timeBlocks: TimeBlock[];
  weekDates?: string[];
  searchQuery?: string;
}): ProjectComparisonRow[] {
  const { clients = [], tasks, timeBlocks, weekDates, searchQuery = '' } = params;
  const clientNameSet = new Set(
    clients.map((c) => c.legalName.trim().toLowerCase()).filter(Boolean)
  );
  const workstreams = deriveDynamicWorkstreams({
    clients,
    tasks,
    timeBlocks,
  });

  const dateSet = weekDates && weekDates.length > 0 ? new Set(weekDates) : null;
  const scopedBlocks = dateSet
    ? timeBlocks.filter((b) => dateSet.has(b.date))
    : timeBlocks;

  const q = searchQuery.trim().toLowerCase();

  const rows = workstreams
    .map((proj): ProjectComparisonRow => {
      const projKey = proj.trim().toLowerCase();
      const projTasks = tasks.filter(
        (t) => t.project.trim().toLowerCase() === projKey
      );
      const projBlocks = scopedBlocks.filter(
        (b) => b.project.trim().toLowerCase() === projKey
      );

      const plannedMins = projTasks.reduce((s, t) => s + t.estimatedMinutes, 0);
      const actualMins = projBlocks.reduce((s, b) => s + b.durationMinutes, 0);
      const billableMins = projBlocks
        .filter((b) => b.isBillable || b.category === 'billable')
        .reduce((s, b) => s + b.durationMinutes, 0);
      const completedTasks = projTasks.filter((t) => t.status === 'completed').length;
      const blockedTasks = projTasks.filter((t) => t.status === 'blocked').length;

      return {
        project: proj,
        isConfiguredClient: clientNameSet.has(projKey),
        taskCount: projTasks.length,
        completedTasks,
        blockedTasks,
        plannedMins,
        actualMins,
        billableMins,
        utilizationPercent:
          plannedMins > 0 ? Math.round((actualMins / plannedMins) * 100) : null,
      };
    })
    .filter((row) => {
      if (!q) return true;
      if (row.project.toLowerCase().includes(q)) return true;
      const projKey = row.project.toLowerCase();
      const matchesTask = tasks.some(
        (t) =>
          t.project.trim().toLowerCase() === projKey &&
          (t.title.toLowerCase().includes(q) ||
            t.tags.some((tag) => tag.toLowerCase().includes(q)))
      );
      const matchesBlock = scopedBlocks.some(
        (b) =>
          b.project.trim().toLowerCase() === projKey &&
          b.title.toLowerCase().includes(q)
      );
      return matchesTask || matchesBlock;
    });

  return rows.sort((a, b) => {
    if (b.actualMins !== a.actualMins) return b.actualMins - a.actualMins;
    if (b.plannedMins !== a.plannedMins) return b.plannedMins - a.plannedMins;
    if (b.taskCount !== a.taskCount) return b.taskCount - a.taskCount;
    return a.project.localeCompare(b.project);
  });
}

export function buildPresenceStats(
  activitySegments: ActivitySegment[],
  weekDates?: string[]
): PresenceSummaryStats {
  const dateSet = weekDates && weekDates.length > 0 ? new Set(weekDates) : null;
  const scoped = dateSet
    ? activitySegments.filter((s) => dateSet.has(s.date))
    : activitySegments;

  const activeMins = scoped
    .filter((s) => s.state === 'active')
    .reduce((s, seg) => s + Math.max(0, seg.endTime - seg.startTime), 0);
  const idleMins = scoped
    .filter((s) => s.state === 'idle')
    .reduce((s, seg) => s + Math.max(0, seg.endTime - seg.startTime), 0);
  const awayMins = scoped
    .filter((s) => s.state === 'away')
    .reduce((s, seg) => s + Math.max(0, seg.endTime - seg.startTime), 0);
  const totalObserved = activeMins + idleMins + awayMins;
  const focusEfficiency =
    totalObserved > 0 ? Math.round((activeMins / totalObserved) * 100) : 0;

  return { activeMins, idleMins, awayMins, focusEfficiency };
}

export function buildWeeklyAppSummary(params: {
  appSegments: ApplicationUsageSegment[];
  weekDates: string[];
  searchQuery?: string;
}): WeeklyAppSummaryRow[] {
  const { appSegments, weekDates, searchQuery = '' } = params;
  const dateSet = new Set(weekDates);
  const q = searchQuery.trim().toLowerCase();
  const map = new Map<string, number>();
  let total = 0;

  appSegments
    .filter((seg) => dateSet.has(seg.date))
    .filter((seg) => !q || seg.appName.toLowerCase().includes(q))
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
}

export function buildWeeklyDocSummary(params: {
  documentSegments: DocumentUsageSegment[];
  weekDates: string[];
  searchQuery?: string;
  limit?: number;
}): WeeklyDocSummaryRow[] {
  const { documentSegments, weekDates, searchQuery = '', limit = 8 } = params;
  const dateSet = new Set(weekDates);
  const q = searchQuery.trim().toLowerCase();
  const map = new Map<string, WeeklyDocSummaryRow>();

  documentSegments
    .filter((seg) => dateSet.has(seg.date))
    .filter(
      (seg) =>
        !q ||
        seg.documentTitle.toLowerCase().includes(q) ||
        seg.appName.toLowerCase().includes(q) ||
        seg.domainOrPath.toLowerCase().includes(q)
    )
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
    .slice(0, limit);
}
