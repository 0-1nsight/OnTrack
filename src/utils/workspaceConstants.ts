import {
  ActivitySegment,
  AppCategory,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  Task,
  TimeBlock,
  WeeklyReport,
  WorkCategory,
  WorkspacePreferences,
} from '../types';

export const DEFAULT_PREFERENCES: WorkspacePreferences = {
  idleThresholdSeconds: 300,
  workdayStartHour: 8,
  workdayEndHour: 19,
  darkMode: false,
  autoPauseOnIdle: true,
};

export const PROJECTS: string[] = [
  'Core Platform',
  'Client Portal',
  'Analytics Engine',
  'Internal Ops',
  'Tax & Close',
  'Audit & Assurance',
];

export interface ColorStyleTokens {
  bg: string;
  border: string;
  text: string;
  bar: string;
}

export const PROJECT_COLORS: Record<string, ColorStyleTokens> = {
  'Core Platform': {
    bg: 'bg-indigo-50 dark:bg-indigo-950/50',
    border: 'border-indigo-200 dark:border-indigo-800',
    text: 'text-indigo-800 dark:text-indigo-200',
    bar: 'bg-indigo-600',
  },
  'Client Portal': {
    bg: 'bg-emerald-50 dark:bg-emerald-950/50',
    border: 'border-emerald-200 dark:border-emerald-800',
    text: 'text-emerald-800 dark:text-emerald-200',
    bar: 'bg-emerald-600',
  },
  'Analytics Engine': {
    bg: 'bg-amber-50 dark:bg-amber-950/50',
    border: 'border-amber-200 dark:border-amber-800',
    text: 'text-amber-800 dark:text-amber-200',
    bar: 'bg-amber-500',
  },
  'Internal Ops': {
    bg: 'bg-slate-100 dark:bg-slate-800/70',
    border: 'border-slate-300 dark:border-slate-700',
    text: 'text-slate-800 dark:text-slate-200',
    bar: 'bg-slate-600',
  },
  'Tax & Close': {
    bg: 'bg-sky-50 dark:bg-sky-950/50',
    border: 'border-sky-200 dark:border-sky-800',
    text: 'text-sky-800 dark:text-sky-200',
    bar: 'bg-sky-600',
  },
  'Audit & Assurance': {
    bg: 'bg-rose-50 dark:bg-rose-950/50',
    border: 'border-rose-200 dark:border-rose-800',
    text: 'text-rose-800 dark:text-rose-200',
    bar: 'bg-rose-600',
  },
};

export const TRACKED_APPS: { name: string; category: AppCategory }[] = [
  { name: 'Google Chrome', category: 'browser' },
  { name: 'Microsoft Excel', category: 'docs' },
  { name: 'QuickBooks Online', category: 'browser' },
  { name: 'VS Code', category: 'code' },
  { name: 'Terminal', category: 'code' },
  { name: 'Slack', category: 'comms' },
  { name: 'Microsoft Teams', category: 'comms' },
  { name: 'Figma', category: 'design' },
  { name: 'Adobe Acrobat', category: 'docs' },
  { name: 'OnTrack Web', category: 'browser' },
];

export const APP_COLORS: Record<string, ColorStyleTokens> = {
  'Google Chrome': {
    bg: 'bg-sky-50 dark:bg-sky-950/50',
    border: 'border-sky-200 dark:border-sky-800',
    text: 'text-sky-800 dark:text-sky-200',
    bar: 'bg-sky-600',
  },
  'Microsoft Excel': {
    bg: 'bg-emerald-50 dark:bg-emerald-950/50',
    border: 'border-emerald-200 dark:border-emerald-800',
    text: 'text-emerald-800 dark:text-emerald-200',
    bar: 'bg-emerald-600',
  },
  'QuickBooks Online': {
    bg: 'bg-teal-50 dark:bg-teal-950/50',
    border: 'border-teal-200 dark:border-teal-800',
    text: 'text-teal-800 dark:text-teal-200',
    bar: 'bg-teal-600',
  },
  'VS Code': {
    bg: 'bg-indigo-50 dark:bg-indigo-950/50',
    border: 'border-indigo-200 dark:border-indigo-800',
    text: 'text-indigo-800 dark:text-indigo-200',
    bar: 'bg-indigo-600',
  },
  Terminal: {
    bg: 'bg-slate-100 dark:bg-slate-800/80',
    border: 'border-slate-300 dark:border-slate-700',
    text: 'text-slate-800 dark:text-slate-200',
    bar: 'bg-slate-700',
  },
  Slack: {
    bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/50',
    border: 'border-fuchsia-200 dark:border-fuchsia-800',
    text: 'text-fuchsia-800 dark:text-fuchsia-200',
    bar: 'bg-fuchsia-600',
  },
  'Microsoft Teams': {
    bg: 'bg-violet-50 dark:bg-violet-950/50',
    border: 'border-violet-200 dark:border-violet-800',
    text: 'text-violet-800 dark:text-violet-200',
    bar: 'bg-violet-600',
  },
  Figma: {
    bg: 'bg-rose-50 dark:bg-rose-950/50',
    border: 'border-rose-200 dark:border-rose-800',
    text: 'text-rose-800 dark:text-rose-200',
    bar: 'bg-rose-600',
  },
  'Adobe Acrobat': {
    bg: 'bg-amber-50 dark:bg-amber-950/50',
    border: 'border-amber-200 dark:border-amber-800',
    text: 'text-amber-800 dark:text-amber-200',
    bar: 'bg-amber-600',
  },
  'OnTrack Web': {
    bg: 'bg-indigo-50 dark:bg-indigo-950/50',
    border: 'border-indigo-200 dark:border-indigo-800',
    text: 'text-indigo-800 dark:text-indigo-200',
    bar: 'bg-indigo-500',
  },
};

export const CATEGORY_LABELS: Record<WorkCategory, string> = {
  deep_work: 'Deep Work',
  collaborative: 'Collaborative',
  billable: 'Billable Client',
  admin: 'Firm Admin',
};

export const CATEGORY_RIBBON_STYLES: Record<WorkCategory, { bar: string }> = {
  deep_work: { bar: 'bg-indigo-600' },
  collaborative: { bar: 'bg-sky-600' },
  billable: { bar: 'bg-emerald-600' },
  admin: { bar: 'bg-slate-500' },
};

export function inferAppCategory(appName: string): AppCategory {
  const lower = appName.toLowerCase();
  if (lower.includes('code') || lower.includes('terminal') || lower.includes('iterm')) {
    return 'code';
  }
  if (lower.includes('slack') || lower.includes('teams') || lower.includes('zoom')) {
    return 'comms';
  }
  if (lower.includes('figma')) {
    return 'design';
  }
  if (lower.includes('excel') || lower.includes('word') || lower.includes('acrobat') || lower.includes('pdf')) {
    return 'docs';
  }
  return 'browser';
}

export function formatDuration(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatMinutesToHHMM(minuteOfDay: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minuteOfDay)));
  const hh = Math.floor(clamped / 60) % 24;
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function parseHHMMToMinutes(hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return 0;
  const hh = Math.max(0, Math.min(23, Number(match[1])));
  const mm = Math.max(0, Math.min(59, Number(match[2])));
  return hh * 60 + mm;
}

export function formatSecondsToStopwatch(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function getRecentWeekDates(): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let offset = 6; offset >= 0; offset -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}

export function createEmptyWorkspaceDataset(): {
  tasks: Task[];
  timeBlocks: TimeBlock[];
  activitySegments: ActivitySegment[];
  appSegments: ApplicationUsageSegment[];
  documentSegments: DocumentUsageSegment[];
  reports: WeeklyReport[];
} {
  return {
    tasks: [],
    timeBlocks: [],
    activitySegments: [],
    appSegments: [],
    documentSegments: [],
    reports: [],
  };
}
