import React from 'react';
import {
  Play,
  Pause,
  Square,
  Clock,
  SlidersHorizontal,
  UserCheck,
  AlertTriangle,
  AppWindow,
  FileCode2,
  Sun,
  Moon,
} from 'lucide-react';
import {
  ActiveTimerState,
  Task,
  WorkCategory,
  WorkspacePreferences,
} from '../types';
import {
  PROJECTS,
  CATEGORY_LABELS,
  TRACKED_APPS,
  formatSecondsToStopwatch,
} from '../data/seedData';

interface ActiveTimerBarProps {
  timer: ActiveTimerState;
  elapsedSeconds: number;
  tasks: Task[];
  selectedDate: string;
  weekDates: string[];
  idleSeconds: number;
  preferences: WorkspacePreferences;
  onSelectDate: (date: string) => void;
  onStartTimer: (taskId?: string | null) => void;
  onPauseTimer: () => void;
  onResumeTimer: () => void;
  onStopAndSaveTimer: () => void;
  onUpdateTimerMeta: (updates: Partial<ActiveTimerState>) => void;
  onLogAppDocSwitch: (appName: string, documentTitle: string) => void;
  onSimulateIdle: () => void;
  onOpenPreferences: () => void;
  onToggleTheme: () => void;
}

export const ActiveTimerBar: React.FC<ActiveTimerBarProps> = ({
  timer,
  elapsedSeconds,
  tasks,
  selectedDate,
  weekDates,
  idleSeconds,
  preferences,
  onSelectDate,
  onStartTimer,
  onPauseTimer,
  onResumeTimer,
  onStopAndSaveTimer,
  onUpdateTimerMeta,
  onLogAppDocSwitch,
  onSimulateIdle,
  onOpenPreferences,
  onToggleTheme,
}) => {
  const activeTasks = tasks.filter((t) => t.status !== 'completed');
  const isApproachingIdle =
    idleSeconds >= Math.max(10, preferences.idleThresholdSeconds * 0.6);

  return (
    <section className="no-print bg-slate-100/80 dark:bg-slate-900/90 border-b border-slate-200 dark:border-slate-800 px-6 py-3">
      <div className="max-w-[1440px] mx-auto space-y-2.5">
        {/* Primary Row: Stopwatch, Task Selector, Presence Sensor, Date & Prefs */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Left: Live Task Timer & Task Binding */}
          <div className="flex flex-wrap items-center gap-3 flex-1 min-w-[320px]">
            {/* Stopwatch Digital Readout */}
            <div
              className={`flex items-center gap-2.5 px-3.5 py-2 rounded-lg border transition-colors ${
                timer.isRunning && !timer.isPaused
                  ? 'bg-indigo-600 text-white border-indigo-700'
                  : timer.isPaused
                  ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/40'
                  : 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 border-slate-200 dark:border-slate-700'
              }`}
            >
              <Clock className="w-4 h-4 shrink-0" />
              <span className="font-mono text-base font-semibold tabular-nums tracking-tight">
                {formatSecondsToStopwatch(elapsedSeconds)}
              </span>
            </div>

            {/* Play / Pause / Stop Controls */}
            <div className="flex items-center gap-1.5">
              {!timer.isRunning ? (
                <button
                  type="button"
                  onClick={() => onStartTimer(timer.taskId)}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Start active task stopwatch"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Start Timer</span>
                </button>
              ) : (
                <>
                  {timer.isPaused ? (
                    <button
                      type="button"
                      onClick={onResumeTimer}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Resume</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={onPauseTimer}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={onStopAndSaveTimer}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    title="Stop timer and log block to timeline"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Log Block</span>
                  </button>
                </>
              )}
            </div>

            {/* Task Selector or Custom Activity Input */}
            <div className="flex items-center gap-2 flex-1 min-w-[240px]">
              <select
                aria-label="Select task to track"
                value={timer.taskId || ''}
                onChange={(e) => {
                  const selectedId = e.target.value || null;
                  if (!selectedId) {
                    onUpdateTimerMeta({ taskId: null });
                    return;
                  }
                  const found = tasks.find((t) => t.id === selectedId);
                  if (found) {
                    onUpdateTimerMeta({
                      taskId: found.id,
                      customTitle: found.title,
                      project: found.project,
                      category: found.category,
                      tags: found.tags,
                      isBillable: found.category === 'billable',
                    });
                  }
                }}
                className="px-3 py-2 text-xs font-medium bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 max-w-[260px] truncate"
              >
                <option value="">Ad-hoc Activity / Custom Session</option>
                {activeTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    [{t.project}] {t.title}
                  </option>
                ))}
              </select>

              {!timer.taskId && (
                <input
                  type="text"
                  value={timer.customTitle}
                  onChange={(e) =>
                    onUpdateTimerMeta({ customTitle: e.target.value })
                  }
                  placeholder="What are you working on right now?"
                  className="px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 flex-1 min-w-[160px]"
                />
              )}

              <select
                aria-label="Project selection"
                value={timer.project}
                onChange={(e) => onUpdateTimerMeta({ project: e.target.value })}
                className="hidden xl:block px-2.5 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
              >
                {PROJECTS.map((proj) => (
                  <option key={proj} value={proj}>
                    {proj}
                  </option>
                ))}
              </select>

              <select
                aria-label="Work category selection"
                value={timer.category}
                onChange={(e) =>
                  onUpdateTimerMeta({
                    category: e.target.value as WorkCategory,
                    isBillable: e.target.value === 'billable',
                  })
                }
                className="hidden lg:block px-2.5 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
              >
                {(Object.keys(CATEGORY_LABELS) as WorkCategory[]).map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Right: ManicTime Presence Sensor, Date Picker & Workspace Settings */}
          <div className="flex items-center gap-3">
            {/* Presence & Idle Sensor Readout */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs">
              {isApproachingIdle ? (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              ) : (
                <UserCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              )}
              <span className="text-slate-600 dark:text-slate-400 whitespace-nowrap">
                Presence:{' '}
                <strong className="font-semibold text-slate-900 dark:text-slate-100">
                  {isApproachingIdle ? 'Idle Soon' : 'Active'}
                </strong>
              </span>
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <span
                className="font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap"
                title="Seconds since last mouse or keyboard activity"
              >
                Idle {idleSeconds}s / {preferences.idleThresholdSeconds}s
              </span>
              <button
                type="button"
                onClick={onSimulateIdle}
                className="ml-1 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-500/20 hover:bg-amber-200/80 rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Trigger ManicTime-style Away/Idle reconciliation prompt to test idle handling"
              >
                Test Idle Prompt
              </button>
            </div>

            {/* Active Date Selector */}
            <select
              aria-label="Select timeline date"
              value={selectedDate}
              onChange={(e) => onSelectDate(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono font-medium tabular-nums bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 cursor-pointer"
            >
              {weekDates.map((d, idx) => {
                const isToday = idx === weekDates.length - 1;
                const isYesterday = idx === weekDates.length - 2;
                const suffix = isToday
                  ? ' (Today)'
                  : isYesterday
                  ? ' (Yesterday)'
                  : '';
                return (
                  <option key={d} value={d}>
                    {d}
                    {suffix}
                  </option>
                );
              })}
            </select>

            {/* Light / Dark Theme Toggle */}
            <button
              type="button"
              onClick={onToggleTheme}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title={
                preferences.darkMode
                  ? 'Switch to Light Theme'
                  : 'Switch to Dark Theme'
              }
              aria-label={
                preferences.darkMode
                  ? 'Switch to Light Theme'
                  : 'Switch to Dark Theme'
              }
            >
              {preferences.darkMode ? (
                <>
                  <Sun className="w-3.5 h-3.5 text-amber-400" />
                  <span>Light</span>
                </>
              ) : (
                <>
                  <Moon className="w-3.5 h-3.5 text-slate-600" />
                  <span>Dark</span>
                </>
              )}
            </button>

            {/* Preferences & Backup Button */}
            <button
              type="button"
              onClick={onOpenPreferences}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Data & Prefs</span>
            </button>
          </div>
        </div>

        {/* Secondary Row: ManicTime Active Application & Document Context Tracker */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200/70 dark:border-slate-800 text-xs">
          <div className="flex flex-wrap items-center gap-2.5 flex-1">
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">
              Active Window Context:
            </span>

            <div className="flex items-center gap-1.5">
              <AppWindow className="w-3.5 h-3.5 text-sky-600 shrink-0" />
              <select
                aria-label="Active foreground application"
                value={timer.activeAppName}
                onChange={(e) =>
                  onUpdateTimerMeta({ activeAppName: e.target.value })
                }
                className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200"
              >
                {TRACKED_APPS.map((app) => (
                  <option key={app.name} value={app.name}>
                    {app.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5 flex-1 min-w-[220px] max-w-md">
              <FileCode2 className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
              <input
                type="text"
                aria-label="Active document or window title"
                value={timer.activeDocumentTitle}
                onChange={(e) =>
                  onUpdateTimerMeta({ activeDocumentTitle: e.target.value })
                }
                placeholder="Opened document, file, or URL title..."
                className="w-full px-2.5 py-1 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            <button
              type="button"
              onClick={() =>
                onLogAppDocSwitch(
                  timer.activeAppName,
                  timer.activeDocumentTitle
                )
              }
              className="px-2.5 py-1 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 border border-indigo-200 dark:border-indigo-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Record current application and opened document onto today's ManicTime timeline"
            >
              Record App & Doc Session
            </button>
          </div>

          <div className="text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap">
            Auto-capturing in-app document navigation & tab focus switches
          </div>
        </div>
      </div>
    </section>
  );
};
