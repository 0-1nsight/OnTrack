import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  AlertOctagon,
  CheckCircle2,
  Play,
  Pause,
  Calendar,
} from 'lucide-react';
import { Task, TaskPriority } from '../types';
import {
  PROJECTS,
  PROJECT_COLORS,
  formatDuration,
} from '../utils/workspaceConstants';

interface TaskGanttViewProps {
  tasks: Task[];
  loggedMinutesByTask: Map<string, number>;
  activeTimerTaskId: string | null;
  isTimerRunning: boolean;
  onSelectTask: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onStartTimerForTask: (taskId: string) => void;
  onPauseTimer: () => void;
}

const PRIORITY_TEXT: Record<TaskPriority, { label: string; color: string }> = {
  urgent: { label: 'P0', color: 'text-rose-600 dark:text-rose-400 font-bold' },
  high: { label: 'P1', color: 'text-amber-700 dark:text-amber-400 font-semibold' },
  medium: { label: 'P2', color: 'text-indigo-600 dark:text-indigo-400 font-medium' },
  low: { label: 'P3', color: 'text-slate-500 dark:text-slate-400' },
};

function toYMD(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseYMD(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

function addDaysYMD(ymd: string, delta: number): string {
  const d = parseYMD(ymd);
  d.setDate(d.getDate() + delta);
  return toYMD(d);
}

function diffDaysYMD(a: string, b: string): number {
  const msA = parseYMD(a).getTime();
  const msB = parseYMD(b).getTime();
  return Math.round((msB - msA) / (24 * 60 * 60 * 1000));
}

export const TaskGanttView: React.FC<TaskGanttViewProps> = ({
  tasks,
  loggedMinutesByTask,
  activeTimerTaskId,
  isTimerRunning,
  onSelectTask,
  onUpdateTask,
  onStartTimerForTask,
  onPauseTimer,
}) => {
  const todayYMD = useMemo(() => toYMD(new Date()), []);
  const [windowStartYMD, setWindowStartYMD] = useState<string>(() =>
    addDaysYMD(toYMD(new Date()), -5)
  );
  const horizonDays = 14;

  const days = useMemo(() => {
    const arr: { ymd: string; weekday: string; dayNum: string; monthShort: string; isWeekend: boolean; isToday: boolean }[] = [];
    for (let i = 0; i < horizonDays; i++) {
      const ymd = addDaysYMD(windowStartYMD, i);
      const dt = parseYMD(ymd);
      const dow = dt.getDay();
      arr.push({
        ymd,
        weekday: dt.toLocaleDateString('en-US', { weekday: 'short' }),
        dayNum: String(dt.getDate()).padStart(2, '0'),
        monthShort: dt.toLocaleDateString('en-US', { month: 'short' }),
        isWeekend: dow === 0 || dow === 6,
        isToday: ymd === todayYMD,
      });
    }
    return arr;
  }, [windowStartYMD, todayYMD]);

  const windowEndYMD = days[days.length - 1].ymd;

  const groupedProjects = useMemo(() => {
    const projectOrder = Array.from(
      new Set([...PROJECTS, ...tasks.map((t) => t.project)])
    );
    return projectOrder
      .map((project) => ({
        project,
        tasks: tasks
          .filter((t) => t.project === project)
          .sort((a, b) => {
            const aStart = a.startDate || a.createdAt;
            const bStart = b.startDate || b.createdAt;
            return aStart.localeCompare(bStart);
          }),
      }))
      .filter((g) => g.tasks.length > 0);
  }, [tasks]);

  const handleShiftTask = (task: Task, deltaDays: number) => {
    const baseStart = task.startDate || task.createdAt || todayYMD;
    const baseEnd = task.dueDate || baseStart;
    onUpdateTask(task.id, {
      startDate: addDaysYMD(baseStart, deltaDays),
      dueDate: addDaysYMD(baseEnd, deltaDays),
    });
  };

  const handleExtendDue = (task: Task, deltaDays: number) => {
    const baseStart = task.startDate || task.createdAt || todayYMD;
    const baseEnd = task.dueDate || baseStart;
    const candidateEnd = addDaysYMD(baseEnd, deltaDays);
    if (diffDaysYMD(baseStart, candidateEnd) < 0) return;
    onUpdateTask(task.id, {
      startDate: baseStart,
      dueDate: candidateEnd,
    });
  };

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      {/* Gantt Toolbar */}
      <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-800/40">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
              Project Gantt Timeline (14-Day Horizon)
            </h2>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {windowStartYMD} → {windowEndYMD}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
            <button
              type="button"
              onClick={() => setWindowStartYMD((prev) => addDaysYMD(prev, -7))}
              title="Previous 7 days"
              className="px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev Week</span>
            </button>
            <button
              type="button"
              onClick={() => setWindowStartYMD(addDaysYMD(todayYMD, -5))}
              className="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 border-x border-slate-200 dark:border-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 cursor-pointer"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setWindowStartYMD((prev) => addDaysYMD(prev, 7))}
              title="Next 7 days"
              className="px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1"
            >
              <span>Next Week</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {filteredEmptyCheck(groupedProjects) ? (
        <div className="p-10 text-center text-xs text-slate-500 dark:text-slate-400">
          No tasks match your current filters. Adjust filters or create a task above.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[1080px]">
            {/* Timeline Grid Header */}
            <div className="grid grid-cols-[310px_1fr] border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/80">
              <div className="px-4 py-2.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400 border-r border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <span>Deliverable & Schedule Shift</span>
                <span className="font-mono">Logged / Est</span>
              </div>
              <div className="grid grid-cols-[repeat(14,minmax(0,1fr))]">
                {days.map((d) => (
                  <div
                    key={d.ymd}
                    className={`py-2 px-1 text-center border-r last:border-r-0 border-slate-200/70 dark:border-slate-800 ${
                      d.isToday
                        ? 'bg-indigo-50/90 dark:bg-indigo-950/40'
                        : d.isWeekend
                        ? 'bg-slate-100/70 dark:bg-slate-800/30'
                        : ''
                    }`}
                  >
                    <div
                      className={`text-[10px] font-medium ${
                        d.isToday
                          ? 'text-indigo-700 dark:text-indigo-300 font-bold'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {d.weekday}
                    </div>
                    <div
                      className={`text-xs font-mono tabular-nums mt-0.5 ${
                        d.isToday
                          ? 'text-indigo-700 dark:text-indigo-300 font-bold underline decoration-indigo-500 underline-offset-2'
                          : 'text-slate-800 dark:text-slate-200 font-semibold'
                      }`}
                    >
                      {d.monthShort} {d.dayNum}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Project Groups & Task Rows */}
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {groupedProjects.map((group) => {
                const pColor =
                  PROJECT_COLORS[group.project] || PROJECT_COLORS['Core Platform'];

                return (
                  <React.Fragment key={group.project}>
                    {/* Project Group Header Row */}
                    <div className="grid grid-cols-[310px_1fr] bg-slate-50/80 dark:bg-slate-800/40">
                      <div className="px-4 py-2 border-r border-slate-200 dark:border-slate-800 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-xs ${pColor.bar}`} />
                          <span className="font-display text-xs font-bold text-slate-900 dark:text-white">
                            {group.project}
                          </span>
                        </div>
                        <span className="text-[11px] font-mono tabular-nums text-slate-500">
                          {group.tasks.length} tasks
                        </span>
                      </div>
                      <div className="grid grid-cols-[repeat(14,minmax(0,1fr))]">
                        {days.map((d) => (
                          <div
                            key={`${group.project}-${d.ymd}`}
                            className={`border-r last:border-r-0 border-slate-200/50 dark:border-slate-800/60 ${
                              d.isToday
                                ? 'bg-indigo-50/40 dark:bg-indigo-950/20'
                                : d.isWeekend
                                ? 'bg-slate-100/40 dark:bg-slate-800/20'
                                : ''
                            }`}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Task Gantt Rows */}
                    {group.tasks.map((task) => {
                      const loggedMins = loggedMinutesByTask.get(task.id) || 0;
                      const progressPct = Math.min(
                        100,
                        task.estimatedMinutes > 0
                          ? Math.round((loggedMins / task.estimatedMinutes) * 100)
                          : 0
                      );
                      const prio = PRIORITY_TEXT[task.priority];
                      const isThisRunning =
                        isTimerRunning && activeTimerTaskId === task.id;

                      const startYMD = task.startDate || task.createdAt || todayYMD;
                      const endYMD = task.dueDate || startYMD;
                      const safeEndYMD =
                        diffDaysYMD(startYMD, endYMD) >= 0 ? endYMD : startYMD;

                      const rawStartIdx = diffDaysYMD(windowStartYMD, startYMD);
                      const rawEndIdx = diffDaysYMD(windowStartYMD, safeEndYMD);

                      const visibleStartIdx = Math.max(0, rawStartIdx);
                      const visibleEndIdx = Math.min(horizonDays - 1, rawEndIdx);
                      const isVisible =
                        visibleEndIdx >= 0 &&
                        visibleStartIdx <= horizonDays - 1 &&
                        rawEndIdx >= 0 &&
                        rawStartIdx <= horizonDays - 1;

                      const leftPct = (visibleStartIdx / horizonDays) * 100;
                      const spanCols = visibleEndIdx - visibleStartIdx + 1;
                      const widthPct = (spanCols / horizonDays) * 100;

                      const clippedLeft = rawStartIdx < 0;
                      const clippedRight = rawEndIdx > horizonDays - 1;

                      return (
                        <div
                          key={task.id}
                          className="grid grid-cols-[310px_1fr] hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors group"
                        >
                          {/* Left Sticky Deliverable Cell */}
                          <div
                            onClick={() => onSelectTask(task.id)}
                            className="px-4 py-2.5 border-r border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 cursor-pointer min-w-0"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className={`text-[10px] font-mono ${prio.color}`}>
                                  {prio.label}
                                </span>
                                {task.status === 'completed' && (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                )}
                                {task.status === 'blocked' && (
                                  <AlertOctagon className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                                )}
                                <span
                                  className={`text-xs font-medium truncate ${
                                    task.status === 'completed'
                                      ? 'line-through text-slate-400 dark:text-slate-500'
                                      : 'text-slate-900 dark:text-white'
                                  }`}
                                  title={task.title}
                                >
                                  {task.title}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-2 text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                                <span>
                                  {startYMD.slice(5)} → {safeEndYMD.slice(5)}
                                </span>
                                <span>·</span>
                                <span>
                                  {formatDuration(loggedMins)} /{' '}
                                  {formatDuration(task.estimatedMinutes)}
                                </span>
                              </div>
                            </div>

                            {/* Quick Row Controls: Shift & Timer */}
                            <div
                              className="flex items-center gap-1 shrink-0"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                onClick={() => handleShiftTask(task, -1)}
                                title="Shift task schedule earlier by 1 day"
                                className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded cursor-pointer"
                              >
                                -1d
                              </button>
                              <button
                                type="button"
                                onClick={() => handleShiftTask(task, 1)}
                                title="Shift task schedule later by 1 day"
                                className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded cursor-pointer"
                              >
                                +1d
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  isThisRunning
                                    ? onPauseTimer()
                                    : onStartTimerForTask(task.id)
                                }
                                title={
                                  isThisRunning ? 'Pause active timer' : 'Start timer'
                                }
                                className={`p-1 rounded cursor-pointer ${
                                  isThisRunning
                                    ? 'bg-amber-500 text-white'
                                    : 'text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/60'
                                }`}
                              >
                                {isThisRunning ? (
                                  <Pause className="w-3 h-3" />
                                ) : (
                                  <Play className="w-3 h-3 fill-current" />
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Right Gantt Bar Canvas */}
                          <div className="relative grid grid-cols-14 items-center min-h-[46px]">
                            {/* Background Day Grid Cells */}
                            {days.map((d) => (
                              <div
                                key={`${task.id}-${d.ymd}`}
                                className={`h-full border-r last:border-r-0 border-slate-200/50 dark:border-slate-800/60 ${
                                  d.isToday
                                    ? 'bg-indigo-50/40 dark:bg-indigo-950/20'
                                    : d.isWeekend
                                    ? 'bg-slate-100/40 dark:bg-slate-800/20'
                                    : ''
                                }`}
                              />
                            ))}

                            {/* Positioned Gantt Bar */}
                            {isVisible ? (
                              <div
                                style={{
                                  left: `calc(${leftPct}% + 4px)`,
                                  width: `calc(${widthPct}% - 8px)`,
                                }}
                                onClick={() => onSelectTask(task.id)}
                                title={`${task.title}\nSchedule: ${startYMD} to ${safeEndYMD}\nLogged: ${formatDuration(
                                  loggedMins
                                )} / Est: ${formatDuration(task.estimatedMinutes)} (${progressPct}%)`}
                                className={`absolute top-2 bottom-2 rounded-md border overflow-hidden cursor-pointer transition-all hover:shadow-sm flex items-center justify-between px-2 ${
                                  task.status === 'blocked'
                                    ? 'bg-rose-500/15 dark:bg-rose-500/20 border-rose-500/50 text-rose-800 dark:text-rose-200'
                                    : task.status === 'completed'
                                    ? 'bg-emerald-500/15 dark:bg-emerald-500/20 border-emerald-500/40 text-emerald-800 dark:text-emerald-200'
                                    : `${pColor.bg} ${pColor.border} ${pColor.text}`
                                }`}
                              >
                                {/* Inner Completion Fill */}
                                <div
                                  style={{ width: `${progressPct}%` }}
                                  className={`absolute inset-y-0 left-0 opacity-20 pointer-events-none ${
                                    task.status === 'blocked'
                                      ? 'bg-rose-600'
                                      : task.status === 'completed'
                                      ? 'bg-emerald-600'
                                      : pColor.bar
                                  }`}
                                />
                                <div className="relative z-10 flex items-center gap-1.5 min-w-0">
                                  {clippedLeft && (
                                    <span className="text-[10px] font-mono opacity-75">
                                      «
                                    </span>
                                  )}
                                  <span className="text-[11px] font-semibold truncate">
                                    {task.title}
                                  </span>
                                </div>
                                <div className="relative z-10 flex items-center gap-1.5 shrink-0 ml-2">
                                  <span className="text-[10px] font-mono tabular-nums opacity-85">
                                    {progressPct}%
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleExtendDue(task, 1);
                                    }}
                                    title="Extend due date +1 day"
                                    className="opacity-0 group-hover:opacity-100 px-1 py-0.5 text-[9px] font-mono bg-white/70 dark:bg-slate-900/70 rounded border border-current/20 cursor-pointer transition-opacity"
                                  >
                                    +1d
                                  </button>
                                  {clippedRight && (
                                    <span className="text-[10px] font-mono opacity-75">
                                      »
                                    </span>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  setWindowStartYMD(addDaysYMD(startYMD, -2))
                                }
                                className="absolute left-3 text-[10px] font-mono text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                              >
                                {rawEndIdx < 0
                                  ? `← Scheduled earlier (${startYMD} → ${safeEndYMD}) · Jump`
                                  : `Scheduled later (${startYMD} → ${safeEndYMD}) · Jump →`}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Footer Legend */}
      <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/60 flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-500 dark:text-slate-400">
        <div className="flex flex-wrap items-center gap-3">
          <span>Click any Gantt bar to edit start/due dates or subtasks</span>
          <span>·</span>
          <span>Bar fill indicates actual logged hours vs. planned estimate</span>
        </div>
        <div className="flex items-center gap-3 font-medium">
          <span className="text-indigo-600 dark:text-indigo-400">Core Platform</span>
          <span>·</span>
          <span className="text-emerald-700 dark:text-emerald-400">Client Portal</span>
          <span>·</span>
          <span className="text-amber-700 dark:text-amber-400">Analytics Engine</span>
          <span>·</span>
          <span className="text-rose-600 dark:text-rose-400">Blocked</span>
        </div>
      </div>
    </div>
  );
};

function filteredEmptyCheck(groups: { tasks: Task[] }[]): boolean {
  return groups.every((g) => g.tasks.length === 0);
}
