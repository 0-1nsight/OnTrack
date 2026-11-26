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

const DYNAMIC_PROJECT_PALETTE: ColorStyleTokens[] = [
  PROJECT_COLORS['Core Platform'],
  PROJECT_COLORS['Client Portal'],
  PROJECT_COLORS['Analytics Engine'],
  PROJECT_COLORS['Tax & Close'],
  PROJECT_COLORS['Audit & Assurance'],
  PROJECT_COLORS['Internal Ops'],
];

export function getProjectColorTokens(projectName: string): ColorStyleTokens {
  if (PROJECT_COLORS[projectName]) {
    return PROJECT_COLORS[projectName];
  }
  const normalized = (projectName || '').trim().toLowerCase();
  if (!normalized) return DYNAMIC_PROJECT_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return DYNAMIC_PROJECT_PALETTE[hash % DYNAMIC_PROJECT_PALETTE.length];
}

export const TRACKED_APPS: { name: string; category: AppCategory }[] = [
  { name: 'Google Chrome', category: 'browser' },
  { name: 'Microsoft Excel', category: 'docs' },
  { name: 'QuickBooks Online', category: 'browser' },
  { name: 'CaseWare', category: 'docs' },
  { name: 'Xero', category: 'browser' },
  { name: 'Microsoft Outlook', category: 'comms' },
  { name: 'Microsoft Word', category: 'docs' },
  { name: 'VS Code', category: 'code' },
  { name: 'Terminal', category: 'code' },
  { name: 'Slack', category: 'comms' },
  { name: 'Microsoft Teams', category: 'comms' },
  { name: 'Zoom', category: 'comms' },
  { name: 'Figma', category: 'design' },
  { name: 'Adobe Acrobat', category: 'docs' },
  { name: 'Microsoft Edge', category: 'browser' },
  { name: 'Mozilla Firefox', category: 'browser' },
  { name: 'OnTrack Web', category: 'browser' },
];

export interface AppColorPreset extends ColorStyleTokens {
  id: string;
  label: string;
  hex: string;
  swatchClass: string;
}

export interface ResolvedAppColorTokens extends ColorStyleTokens {
  canonicalName: string;
  presetId: string;
  hex: string;
  isCustom: boolean;
  customHex?: string;
  barTextColor: string;
}

export const APP_PALETTE_PRESETS: AppColorPreset[] = [
  {
    id: 'sky',
    label: 'Sky Blue',
    hex: '#0284c7',
    swatchClass: 'bg-sky-600',
    bg: 'bg-sky-50 dark:bg-sky-950/50',
    border: 'border-sky-200 dark:border-sky-800',
    text: 'text-sky-800 dark:text-sky-200',
    bar: 'bg-sky-600',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    hex: '#059669',
    swatchClass: 'bg-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-950/50',
    border: 'border-emerald-200 dark:border-emerald-800',
    text: 'text-emerald-800 dark:text-emerald-200',
    bar: 'bg-emerald-600',
  },
  {
    id: 'teal',
    label: 'Teal',
    hex: '#0d9488',
    swatchClass: 'bg-teal-600',
    bg: 'bg-teal-50 dark:bg-teal-950/50',
    border: 'border-teal-200 dark:border-teal-800',
    text: 'text-teal-800 dark:text-teal-200',
    bar: 'bg-teal-600',
  },
  {
    id: 'indigo',
    label: 'Indigo',
    hex: '#4f46e5',
    swatchClass: 'bg-indigo-600',
    bg: 'bg-indigo-50 dark:bg-indigo-950/50',
    border: 'border-indigo-200 dark:border-indigo-800',
    text: 'text-indigo-800 dark:text-indigo-200',
    bar: 'bg-indigo-600',
  },
  {
    id: 'slate',
    label: 'Graphite Slate',
    hex: '#334155',
    swatchClass: 'bg-slate-700',
    bg: 'bg-slate-100 dark:bg-slate-800/80',
    border: 'border-slate-300 dark:border-slate-700',
    text: 'text-slate-800 dark:text-slate-200',
    bar: 'bg-slate-700',
  },
  {
    id: 'fuchsia',
    label: 'Fuchsia',
    hex: '#c026d3',
    swatchClass: 'bg-fuchsia-600',
    bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/50',
    border: 'border-fuchsia-200 dark:border-fuchsia-800',
    text: 'text-fuchsia-800 dark:text-fuchsia-200',
    bar: 'bg-fuchsia-600',
  },
  {
    id: 'violet',
    label: 'Violet',
    hex: '#7c3aed',
    swatchClass: 'bg-violet-600',
    bg: 'bg-violet-50 dark:bg-violet-950/50',
    border: 'border-violet-200 dark:border-violet-800',
    text: 'text-violet-800 dark:text-violet-200',
    bar: 'bg-violet-600',
  },
  {
    id: 'rose',
    label: 'Rose',
    hex: '#e11d48',
    swatchClass: 'bg-rose-600',
    bg: 'bg-rose-50 dark:bg-rose-950/50',
    border: 'border-rose-200 dark:border-rose-800',
    text: 'text-rose-800 dark:text-rose-200',
    bar: 'bg-rose-600',
  },
  {
    id: 'amber',
    label: 'Amber',
    hex: '#b45309',
    swatchClass: 'bg-amber-700',
    bg: 'bg-amber-50 dark:bg-amber-950/50',
    border: 'border-amber-200 dark:border-amber-800',
    text: 'text-amber-800 dark:text-amber-200',
    bar: 'bg-amber-700',
  },
  {
    id: 'orange',
    label: 'Burnt Orange',
    hex: '#c2410c',
    swatchClass: 'bg-orange-700',
    bg: 'bg-orange-50 dark:bg-orange-950/50',
    border: 'border-orange-200 dark:border-orange-800',
    text: 'text-orange-800 dark:text-orange-200',
    bar: 'bg-orange-700',
  },
  {
    id: 'cyan',
    label: 'Cyan',
    hex: '#0e7490',
    swatchClass: 'bg-cyan-700',
    bg: 'bg-cyan-50 dark:bg-cyan-950/50',
    border: 'border-cyan-200 dark:border-cyan-800',
    text: 'text-cyan-800 dark:text-cyan-200',
    bar: 'bg-cyan-700',
  },
  {
    id: 'blue',
    label: 'Royal Blue',
    hex: '#2563eb',
    swatchClass: 'bg-blue-600',
    bg: 'bg-blue-50 dark:bg-blue-950/50',
    border: 'border-blue-200 dark:border-blue-800',
    text: 'text-blue-800 dark:text-blue-200',
    bar: 'bg-blue-600',
  },
  {
    id: 'lime',
    label: 'Forest Lime',
    hex: '#4d7c0f',
    swatchClass: 'bg-lime-700',
    bg: 'bg-lime-50 dark:bg-lime-950/50',
    border: 'border-lime-200 dark:border-lime-800',
    text: 'text-lime-800 dark:text-lime-200',
    bar: 'bg-lime-700',
  },
  {
    id: 'crimson',
    label: 'Crimson',
    hex: '#dc2626',
    swatchClass: 'bg-red-600',
    bg: 'bg-red-50 dark:bg-red-950/50',
    border: 'border-red-200 dark:border-red-800',
    text: 'text-red-800 dark:text-red-200',
    bar: 'bg-red-600',
  },
  {
    id: 'ochre',
    label: 'Gold Ochre',
    hex: '#a16207',
    swatchClass: 'bg-yellow-700',
    bg: 'bg-yellow-50 dark:bg-yellow-950/50',
    border: 'border-yellow-200 dark:border-yellow-800',
    text: 'text-yellow-800 dark:text-yellow-200',
    bar: 'bg-yellow-700',
  },
  {
    id: 'plum',
    label: 'Plum',
    hex: '#9333ea',
    swatchClass: 'bg-purple-600',
    bg: 'bg-purple-50 dark:bg-purple-950/50',
    border: 'border-purple-200 dark:border-purple-800',
    text: 'text-purple-800 dark:text-purple-200',
    bar: 'bg-purple-600',
  },
  {
    id: 'cobalt',
    label: 'Cobalt Navy',
    hex: '#1d4ed8',
    swatchClass: 'bg-blue-700',
    bg: 'bg-blue-50 dark:bg-blue-950/50',
    border: 'border-blue-300 dark:border-blue-800',
    text: 'text-blue-900 dark:text-blue-200',
    bar: 'bg-blue-700',
  },
  {
    id: 'mint',
    label: 'Deep Pine',
    hex: '#047857',
    swatchClass: 'bg-emerald-700',
    bg: 'bg-emerald-50 dark:bg-emerald-950/50',
    border: 'border-emerald-300 dark:border-emerald-800',
    text: 'text-emerald-900 dark:text-emerald-200',
    bar: 'bg-emerald-700',
  },
];

export const APP_PALETTE_PRESET_MAP: Record<string, AppColorPreset> = Object.fromEntries(
  APP_PALETTE_PRESETS.map((p) => [p.id, p])
);

const APP_ALIAS_MAP: Record<string, string> = {
  chrome: 'Google Chrome',
  'chrome.exe': 'Google Chrome',
  'google chrome': 'Google Chrome',
  msedge: 'Microsoft Edge',
  'msedge.exe': 'Microsoft Edge',
  'microsoft edge': 'Microsoft Edge',
  edge: 'Microsoft Edge',
  firefox: 'Mozilla Firefox',
  'firefox.exe': 'Mozilla Firefox',
  'mozilla firefox': 'Mozilla Firefox',
  safari: 'Safari',
  excel: 'Microsoft Excel',
  'excel.exe': 'Microsoft Excel',
  'microsoft excel': 'Microsoft Excel',
  winword: 'Microsoft Word',
  'winword.exe': 'Microsoft Word',
  'microsoft word': 'Microsoft Word',
  word: 'Microsoft Word',
  powerpnt: 'Microsoft PowerPoint',
  'powerpnt.exe': 'Microsoft PowerPoint',
  outlook: 'Microsoft Outlook',
  'outlook.exe': 'Microsoft Outlook',
  olk: 'Microsoft Outlook',
  'olk.exe': 'Microsoft Outlook',
  'microsoft outlook': 'Microsoft Outlook',
  code: 'VS Code',
  'code.exe': 'VS Code',
  vscode: 'VS Code',
  'vs code': 'VS Code',
  'visual studio code': 'VS Code',
  terminal: 'Terminal',
  iterm2: 'Terminal',
  'windowsterminal.exe': 'Terminal',
  'powershell.exe': 'Terminal',
  'cmd.exe': 'Terminal',
  warp: 'Terminal',
  slack: 'Slack',
  'slack.exe': 'Slack',
  teams: 'Microsoft Teams',
  'teams.exe': 'Microsoft Teams',
  'ms-teams.exe': 'Microsoft Teams',
  'microsoft teams': 'Microsoft Teams',
  zoom: 'Zoom',
  'zoom.exe': 'Zoom',
  'zoom.us': 'Zoom',
  figma: 'Figma',
  'figma.exe': 'Figma',
  acrobat: 'Adobe Acrobat',
  'acrobat.exe': 'Adobe Acrobat',
  'acrord32.exe': 'Adobe Acrobat',
  'adobe acrobat': 'Adobe Acrobat',
  quickbooks: 'QuickBooks Online',
  'qbw32.exe': 'QuickBooks Online',
  'quickbooks online': 'QuickBooks Online',
  xero: 'Xero',
  caseware: 'CaseWare',
  'cwin64.exe': 'CaseWare',
  'ontrack web': 'OnTrack Web',
  'ontrack': 'OnTrack Web',
  'explorer.exe': 'File Explorer',
  explorer: 'File Explorer',
  finder: 'Finder',
};

const DEFAULT_APP_COLOR_PRESET_MAP: Record<string, string> = {
  'google chrome': 'sky',
  'microsoft excel': 'emerald',
  'quickbooks online': 'teal',
  'vs code': 'indigo',
  terminal: 'slate',
  slack: 'fuchsia',
  'microsoft teams': 'violet',
  figma: 'rose',
  'adobe acrobat': 'amber',
  'microsoft outlook': 'blue',
  'microsoft word': 'cobalt',
  xero: 'cyan',
  zoom: 'orange',
  caseware: 'crimson',
  'ontrack web': 'plum',
  'microsoft edge': 'mint',
  'mozilla firefox': 'ochre',
  'file explorer': 'lime',
  finder: 'lime',
};

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

export function isValidAppColorValue(value: string): boolean {
  const clean = (value || '').trim();
  return Boolean(APP_PALETTE_PRESET_MAP[clean] || HEX_COLOR_REGEX.test(clean));
}

export function canonicalizeAppName(appName: string): string {
  const raw = (appName || '').trim();
  if (!raw) return 'Workstation';
  const stripped = raw.replace(/\.(exe|app)$/i, '').trim();
  const alias =
    APP_ALIAS_MAP[raw.toLowerCase()] || APP_ALIAS_MAP[stripped.toLowerCase()];
  if (alias) return alias;
  return stripped || raw;
}

function computeContrastTextForHex(hex: string): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const toLinear = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance > 0.36 ? '#0f172a' : '#ffffff';
}

function fnv1aHash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getAppColorTokens(
  appName: string,
  customAppColors?: Record<string, string>
): ResolvedAppColorTokens {
  const canonicalName = canonicalizeAppName(appName);
  const canonicalLower = canonicalName.toLowerCase();
  const rawLower = (appName || '').trim().toLowerCase();

  let overrideVal: string | undefined;
  if (customAppColors) {
    overrideVal =
      customAppColors[canonicalName] ??
      customAppColors[appName] ??
      Object.entries(customAppColors).find(([k]) => {
        const kl = k.trim().toLowerCase();
        return kl === canonicalLower || kl === rawLower || canonicalizeAppName(k).toLowerCase() === canonicalLower;
      })?.[1];
  }

  if (overrideVal) {
    const cleanOverride = overrideVal.trim();
    const matchedPreset = APP_PALETTE_PRESET_MAP[cleanOverride];
    if (matchedPreset) {
      return {
        canonicalName,
        presetId: matchedPreset.id,
        hex: matchedPreset.hex,
        isCustom: true,
        bg: matchedPreset.bg,
        border: matchedPreset.border,
        text: matchedPreset.text,
        bar: matchedPreset.bar,
        barTextColor: '#ffffff',
      };
    }
    if (HEX_COLOR_REGEX.test(cleanOverride)) {
      return {
        canonicalName,
        presetId: 'custom',
        hex: cleanOverride.toLowerCase(),
        isCustom: true,
        customHex: cleanOverride.toLowerCase(),
        bg: 'bg-slate-50 dark:bg-slate-800/70',
        border: 'border-slate-300 dark:border-slate-700',
        text: 'text-slate-900 dark:text-slate-100',
        bar: '',
        barTextColor: computeContrastTextForHex(cleanOverride),
      };
    }
  }

  const defaultPresetId = DEFAULT_APP_COLOR_PRESET_MAP[canonicalLower];
  const preset =
    (defaultPresetId ? APP_PALETTE_PRESET_MAP[defaultPresetId] : undefined) ||
    APP_PALETTE_PRESETS[fnv1aHash(canonicalLower) % APP_PALETTE_PRESETS.length];

  return {
    canonicalName,
    presetId: preset.id,
    hex: preset.hex,
    isCustom: false,
    bg: preset.bg,
    border: preset.border,
    text: preset.text,
    bar: preset.bar,
    barTextColor: '#ffffff',
  };
}

export const APP_COLORS: Record<string, ColorStyleTokens> = Object.fromEntries(
  TRACKED_APPS.map((app) => {
    const t = getAppColorTokens(app.name);
    return [app.name, { bg: t.bg, border: t.border, text: t.text, bar: t.bar }];
  })
);

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
  const lower = canonicalizeAppName(appName).toLowerCase();
  if (lower.includes('code') || lower.includes('terminal') || lower.includes('iterm')) {
    return 'code';
  }
  if (
    lower.includes('slack') ||
    lower.includes('teams') ||
    lower.includes('zoom') ||
    lower.includes('outlook')
  ) {
    return 'comms';
  }
  if (lower.includes('figma')) {
    return 'design';
  }
  if (
    lower.includes('excel') ||
    lower.includes('word') ||
    lower.includes('acrobat') ||
    lower.includes('pdf') ||
    lower.includes('caseware')
  ) {
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
