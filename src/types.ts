export type TaskStatus = 'in_progress' | 'todo' | 'blocked' | 'completed';
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';
export type WorkCategory = 'deep_work' | 'collaborative' | 'billable' | 'admin';

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  project: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: WorkCategory;
  tags: string[];
  estimatedMinutes: number;
  blockerNote?: string;
  subtasks: Subtask[];
  createdAt: string;
  startDate?: string;
  dueDate?: string;
  completedAt?: string;
}

export interface TimeBlock {
  id: string;
  taskId: string | null;
  title: string;
  project: string;
  category: WorkCategory;
  tags: string[];
  date: string; // YYYY-MM-DD
  startTime: number; // minutes from midnight (0 - 1440)
  endTime: number; // minutes from midnight (0 - 1440)
  durationMinutes: number;
  source: 'timer' | 'manual' | 'reconciled';
  isBillable: boolean;
  notes: string;
  appName?: string;
  documentTitle?: string;
}

export type PresenceState = 'active' | 'idle' | 'away';

export interface ActivitySegment {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: number; // minutes from midnight
  endTime: number; // minutes from midnight
  state: PresenceState;
  label: string;
  reconciled: boolean;
}

export type AppCategory = 'code' | 'browser' | 'design' | 'comms' | 'docs';

export interface ApplicationUsageSegment {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: number; // minutes from midnight
  endTime: number; // minutes from midnight
  appName: string; // e.g., 'VS Code', 'Google Chrome', 'Figma', 'Terminal', 'Slack'
  appCategory: AppCategory;
}

export interface DocumentUsageSegment {
  id: string;
  date: string; // YYYY-MM-DD
  startTime: number; // minutes from midnight
  endTime: number; // minutes from midnight
  appName: string;
  documentTitle: string; // e.g., 'intervalTree.ts — ontrack', 'PR #418 — GitHub'
  domainOrPath: string; // e.g., '~/dev/ontrack/src', 'github.com/acme/portal'
  linkedTaskId?: string | null;
}

export type ReportTone = 'executive' | 'standup' | 'client';

export interface WeeklyMetricsSnapshot {
  totalMinutes: number;
  totalHours: number;
  plannedMinutes: number;
  plannedHours: number;
  deepWorkMinutes: number;
  deepWorkPercent: number;
  billableMinutes: number;
  billablePercent: number;
  completedCount: number;
  totalTasksCount: number;
  completionRate: number;
  estimationAccuracyPercent: number;
}

export interface WeeklyReport {
  id: string;
  weekStartDate: string;
  weekEndDate: string;
  generatedAt: string;
  tone: ReportTone;
  executiveSummary: string;
  accomplishments: string[];
  blockersAndRisks: string[];
  velocityInsights: string;
  nextWeekFocus: string[];
  metricsSnapshot: WeeklyMetricsSnapshot;
  isAiGenerated: boolean;
}

export interface ActiveTimerState {
  isRunning: boolean;
  isPaused: boolean;
  taskId: string | null;
  customTitle: string;
  project: string;
  category: WorkCategory;
  tags: string[];
  isBillable: boolean;
  startedAtMs: number | null;
  accumulatedSeconds: number;
  startMinuteOfDay: number;
  activeAppName: string;
  activeDocumentTitle: string;
}

export interface IdleAlertState {
  isOpen: boolean;
  idleStartedAtMs: number;
  idleDurationSeconds: number;
  activeTaskTitle: string;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
}

export interface WorkspacePreferences {
  idleThresholdSeconds: number; // e.g., 30 (Demo), 120, 300, 900
  workdayStartHour: number; // e.g. 8
  workdayEndHour: number; // e.g. 20
  darkMode: boolean;
  autoPauseOnIdle: boolean;
}

export interface UserProfile {
  ownerId: string;
  email: string;
  displayName: string;
  jobTitle?: string;
  photoURL?: string;
  hourlyRate?: number;
  currency?: string;
  preferences: WorkspacePreferences;
}

export type NavigationTab = 'timeline' | 'tasks' | 'autotrack' | 'report' | 'analytics';
