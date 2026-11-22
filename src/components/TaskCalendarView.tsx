import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Clock,
  ArrowUpRight,
  Play,
  AlertOctagon,
  CheckCircle2,
} from 'lucide-react';
import { Task, TimeBlock } from '../types';
import {
  PROJECT_COLORS,
  CATEGORY_LABELS,
  formatDuration,
  formatMinutesToHHMM,
} from '../data/seedData';

interface TaskCalendarViewProps {
  tasks: Task[];
  timeBlocks: TimeBlock[];
  selectedDate: string;
  loggedMinutesByTask: Map<string, number>;
  onSelectTask: (taskId: string) => void;
  onJumpToTimelineDate: (date: string) => void;
  onOpenQuickLogForDate: (date: string) => void;
  onStartTimerForTask: (taskId: string) => void;
}

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

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const TaskCalendarView: React.FC<TaskCalendarViewProps> = ({
  tasks,
  timeBlocks,
  selectedDate,
  loggedMinutesByTask,
  onSelectTask,
  onJumpToTimelineDate,
  onOpenQuickLogForDate,
  onStartTimerForTask,
}) => {
  const todayYMD = useMemo(() => toYMD(new Date()), []);
  const [agendaDate, setAgendaDate] = useState<string>(selectedDate || todayYMD);
  const [cursorMonth, setCursorMonth] = useState<Date>(() => {
    const base = parseYMD(selectedDate || toYMD(new Date()));
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const monthLabel = useMemo(
    () =>
      cursorMonth.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      }),
    [cursorMonth]
  );

  const calendarCells = useMemo(() => {
    const year = cursorMonth.getFullYear();
    const month = cursorMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOffset = firstDay.getDay(); // 0 (Sun) - 6 (Sat)
    const gridStart = new Date(year, month, 1 - startOffset);

    const cells: {
      ymd: string;
      dayNum: number;
      inCurrentMonth: boolean;
      isToday: boolean;
    }[] = [];

    for (let i = 0; i < 42; i++) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + i);
      const ymd = toYMD(cellDate);
      cells.push({
        ymd,
        dayNum: cellDate.getDate(),
        inCurrentMonth: cellDate.getMonth() === month,
        isToday: ymd === todayYMD,
      });
    }
    return cells;
  }, [cursorMonth, todayYMD]);

  // Index time blocks by YYYY-MM-DD
  const blocksByDate = useMemo(() => {
    const map = new Map<string, TimeBlock[]>();
    for (const b of timeBlocks) {
      const list = map.get(b.date) || [];
      list.push(b);
      map.set(b.date, list);
    }
    for (const [k, list] of map.entries()) {
      map.set(
        k,
        list.slice().sort((a, b) => a.startTime - b.startTime)
      );
    }
    return map;
  }, [timeBlocks]);

  // Helper to get tasks active or due on a given date
  const getTasksForDate = (ymd: string): { dueToday: Task[]; activeSpan: Task[] } => {
    const dueToday: Task[] = [];
    const activeSpan: Task[] = [];
    for (const t of tasks) {
      const start = t.startDate || t.createdAt;
      const due = t.dueDate || start;
      if (due === ymd) {
        dueToday.push(t);
      } else if (start && due && start <= ymd && ymd < due) {
        activeSpan.push(t);
      }
    }
    return { dueToday, activeSpan };
  };

  const agendaDayBlocks = blocksByDate.get(agendaDate) || [];
  const agendaLoggedMins = agendaDayBlocks.reduce(
    (acc, b) => acc + b.durationMinutes,
    0
  );
  const { dueToday: agendaDueTasks, activeSpan: agendaSpanTasks } = useMemo(
    () => getTasksForDate(agendaDate),
    [tasks, agendaDate]
  );

  const shiftMonth = (delta: number) => {
    setCursorMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6 items-start">
      {/* Left: Monthly Calendar Grid */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {/* Calendar Header Controls */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70 dark:bg-slate-800/40">
          <div>
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {monthLabel}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Task due dates, multi-day spans, and daily ManicTime logged hours
            </p>
          </div>

          <div className="flex items-center border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              className="px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Prev</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                setCursorMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                setAgendaDate(todayYMD);
              }}
              className="px-3 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 border-x border-slate-200 dark:border-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 cursor-pointer"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              className="px-2.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer flex items-center gap-1"
            >
              <span>Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Weekday Column Labels */}
        <div className="grid grid-cols-7 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/60">
          {WEEKDAYS.map((day) => (
            <div
              key={day}
              className="py-2 px-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400 border-r last:border-r-0 border-slate-200/70 dark:border-slate-800"
            >
              {day}
            </div>
          ))}
        </div>

        {/* 6x7 Date Cells */}
        <div className="grid grid-cols-7 divide-x divide-y divide-slate-200/70 dark:divide-slate-800">
          {calendarCells.map((cell) => {
            const dayBlocks = blocksByDate.get(cell.ymd) || [];
            const dayLogged = dayBlocks.reduce((acc, b) => acc + b.durationMinutes, 0);
            const { dueToday, activeSpan } = getTasksForDate(cell.ymd);
            const combinedTasks = [...dueToday, ...activeSpan];
            const isSelected = agendaDate === cell.ymd;

            return (
              <div
                key={cell.ymd}
                onClick={() => setAgendaDate(cell.ymd)}
                className={`min-h-[112px] p-2 transition-colors cursor-pointer flex flex-col justify-between ${
                  isSelected
                    ? 'bg-indigo-50/60 dark:bg-indigo-950/30 ring-1 ring-inset ring-indigo-500'
                    : cell.inCurrentMonth
                    ? 'bg-white dark:bg-slate-900 hover:bg-slate-50/80 dark:hover:bg-slate-800/40'
                    : 'bg-slate-50/70 dark:bg-slate-950/60 text-slate-400'
                }`}
              >
                <div className="space-y-1.5">
                  {/* Top Row: Day Num + Logged Hours */}
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`inline-flex items-center justify-center w-6 h-6 text-xs font-mono tabular-nums rounded-md ${
                        cell.isToday
                          ? 'bg-indigo-600 text-white font-bold'
                          : cell.inCurrentMonth
                          ? 'text-slate-800 dark:text-slate-200 font-semibold'
                          : 'text-slate-400 dark:text-slate-600'
                      }`}
                    >
                      {cell.dayNum}
                    </span>
                    {dayLogged > 0 && (
                      <span className="text-[10px] font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200/70 dark:border-emerald-800/50 px-1.5 py-0.5 rounded-xs">
                        {formatDuration(dayLogged)}
                      </span>
                    )}
                  </div>

                  {/* Task Rectangular Chips */}
                  <div className="space-y-1">
                    {combinedTasks.slice(0, 3).map((t) => {
                      const pColor =
                        PROJECT_COLORS[t.project] || PROJECT_COLORS['Core Platform'];
                      const isDue = (t.dueDate || t.startDate || t.createdAt) === cell.ymd;
                      return (
                        <button
                          key={`${cell.ymd}-${t.id}`}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectTask(t.id);
                          }}
                          title={`${t.title} (${t.project})`}
                          className={`w-full text-left px-1.5 py-0.5 rounded-xs border text-[10px] font-medium truncate flex items-center gap-1 cursor-pointer ${
                            t.status === 'completed'
                              ? 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400 line-through'
                              : isDue
                              ? `${pColor.bg} ${pColor.border} ${pColor.text}`
                              : 'bg-slate-50 dark:bg-slate-800/70 border-slate-200/80 dark:border-slate-700/80 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {isDue && (
                            <span className="font-mono font-bold uppercase text-[9px] shrink-0">
                              Due
                            </span>
                          )}
                          <span className="truncate">{t.title}</span>
                        </button>
                      );
                    })}
                    {combinedTasks.length > 3 && (
                      <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 px-1">
                        +{combinedTasks.length - 3} more
                      </div>
                    )}
                  </div>
                </div>

                {/* Bottom Subtle Session Count */}
                {dayBlocks.length > 0 && (
                  <div className="pt-1 text-[10px] font-mono tabular-nums text-slate-400 dark:text-slate-500">
                    {dayBlocks.length} {dayBlocks.length === 1 ? 'block' : 'blocks'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Selected Day Agenda & Activity Inspector */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
        <div className="border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Selected Day Agenda
              </div>
              <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white font-mono tabular-nums">
                {agendaDate}
              </h3>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Logged Time
              </div>
              <div className="font-mono text-base font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
                {formatDuration(agendaLoggedMins)}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenQuickLogForDate(agendaDate)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Log Block</span>
            </button>
            <button
              type="button"
              onClick={() => onJumpToTimelineDate(agendaDate)}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer"
            >
              <span>Day Timeline</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Tasks Due / Active on Selected Day */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="font-display text-xs font-bold text-slate-900 dark:text-white">
              Tasks Due & Scheduled ({agendaDueTasks.length + agendaSpanTasks.length})
            </h4>
          </div>

          {agendaDueTasks.length === 0 && agendaSpanTasks.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-2">
              No tasks scheduled or due on {agendaDate}.
            </p>
          ) : (
            <div className="space-y-2">
              {[...agendaDueTasks, ...agendaSpanTasks].map((task) => {
                const isDue = (task.dueDate || task.startDate || task.createdAt) === agendaDate;
                const loggedMins = loggedMinutesByTask.get(task.id) || 0;
                return (
                  <div
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                    className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-indigo-400 bg-slate-50/60 dark:bg-slate-800/40 cursor-pointer space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="font-medium text-slate-600 dark:text-slate-300">
                        {task.project}
                      </span>
                      <span
                        className={`font-mono font-semibold ${
                          isDue
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-slate-500 dark:text-slate-400'
                        }`}
                      >
                        {isDue ? 'Due Today' : 'In Span'}
                      </span>
                    </div>
                    <div className="flex items-start gap-1.5">
                      {task.status === 'completed' && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                      )}
                      {task.status === 'blocked' && (
                        <AlertOctagon className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                      )}
                      <div className="text-xs font-semibold text-slate-900 dark:text-white leading-snug">
                        {task.title}
                      </div>
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t border-slate-200/70 dark:border-slate-700/60 text-[11px]">
                      <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                        {formatDuration(loggedMins)} / {formatDuration(task.estimatedMinutes)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStartTimerForTask(task.id);
                        }}
                        className="flex items-center gap-1 text-indigo-600 dark:text-indigo-400 font-semibold hover:underline cursor-pointer"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>Track</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Logged Time Blocks for Selected Day */}
        <div className="space-y-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-slate-500" />
            <h4 className="font-display text-xs font-bold text-slate-900 dark:text-white">
              Logged Time Blocks ({agendaDayBlocks.length})
            </h4>
          </div>

          {agendaDayBlocks.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No time blocks recorded on {agendaDate}.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden text-xs">
              {agendaDayBlocks.map((b) => (
                <div
                  key={b.id}
                  className="p-2.5 flex items-start justify-between gap-2 bg-slate-50/40 dark:bg-slate-800/30"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-white truncate">
                      {b.title}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                      {formatMinutesToHHMM(b.startTime)}–{formatMinutesToHHMM(b.endTime)} ·{' '}
                      <span className="font-sans">{CATEGORY_LABELS[b.category]}</span>
                    </div>
                  </div>
                  <span className="font-mono font-semibold tabular-nums text-slate-800 dark:text-slate-200 shrink-0">
                    {formatDuration(b.durationMinutes)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
