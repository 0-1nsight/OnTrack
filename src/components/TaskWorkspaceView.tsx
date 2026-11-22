import React, { useState, useMemo } from 'react';
import {
  Play,
  Pause,
  Plus,
  Search,
  CheckSquare,
  Square,
  AlertOctagon,
  LayoutList,
  Columns3,
  GanttChartSquare,
  CalendarDays,
  Trash2,
  X,
  CheckCircle2,
} from 'lucide-react';
import {
  Task,
  TaskPriority,
  TaskStatus,
  TimeBlock,
  WorkCategory,
} from '../types';
import {
  PROJECTS,
  CATEGORY_LABELS,
  formatDuration,
  formatMinutesToHHMM,
} from '../data/seedData';
import { TaskGanttView } from './TaskGanttView';
import { TaskCalendarView } from './TaskCalendarView';

interface TaskWorkspaceViewProps {
  tasks: Task[];
  timeBlocks: TimeBlock[];
  selectedDate: string;
  activeTimerTaskId: string | null;
  isTimerRunning: boolean;
  onStartTimerForTask: (taskId: string) => void;
  onPauseTimer: () => void;
  onCreateTask: (newTask: Omit<Task, 'id' | 'createdAt'>) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenQuickLogForTask: (task: Task) => void;
  onOpenQuickLogForDate: (date: string) => void;
  onJumpToTimelineDate: (date: string) => void;
}

const STATUS_GROUPS: { status: TaskStatus; label: string; description: string }[] = [
  {
    status: 'in_progress',
    label: 'In Progress',
    description: 'Active workstreams currently being executed',
  },
  {
    status: 'blocked',
    label: 'Blocked & At Risk',
    description: 'Tasks awaiting external dependencies or unblocking',
  },
  {
    status: 'todo',
    label: 'Queued / Todo',
    description: 'Planned deliverables scoped for this week',
  },
  {
    status: 'completed',
    label: 'Completed',
    description: 'Shipped and verified tasks ready for weekly review',
  },
];

const PRIORITY_TEXT: Record<TaskPriority, { label: string; color: string }> = {
  urgent: { label: 'Urgent P0', color: 'text-rose-600 dark:text-rose-400 font-semibold' },
  high: { label: 'High P1', color: 'text-amber-700 dark:text-amber-400 font-medium' },
  medium: { label: 'Medium P2', color: 'text-indigo-600 dark:text-indigo-400' },
  low: { label: 'Low P3', color: 'text-slate-500 dark:text-slate-400' },
};

export const TaskWorkspaceView: React.FC<TaskWorkspaceViewProps> = ({
  tasks,
  timeBlocks,
  selectedDate,
  activeTimerTaskId,
  isTimerRunning,
  onStartTimerForTask,
  onPauseTimer,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onOpenQuickLogForTask,
  onOpenQuickLogForDate,
  onJumpToTimelineDate,
}) => {
  const [viewMode, setViewMode] = useState<'list' | 'board' | 'gantt' | 'calendar'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Quick inline task creation form state
  const [newTitle, setNewTitle] = useState('');
  const [newProject, setNewProject] = useState<string>('Core Platform');
  const [newPriority, setNewPriority] = useState<TaskPriority>('high');
  const [newCategory, setNewCategory] = useState<WorkCategory>('deep_work');
  const [newEstimate, setNewEstimate] = useState<number>(120);
  const [newDueDate, setNewDueDate] = useState<string>('');
  const [newTags, setNewTags] = useState<string>('engineering');

  // Subtask input inside detail drawer
  const [subtaskInput, setSubtaskInput] = useState('');

  // Map taskId -> total logged minutes from timeBlocks
  const loggedMinutesByTask = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of timeBlocks) {
      if (b.taskId) {
        map.set(b.taskId, (map.get(b.taskId) || 0) + b.durationMinutes);
      }
    }
    return map;
  }, [timeBlocks]);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (projectFilter !== 'all' && t.project !== projectFilter) return false;
      if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = t.title.toLowerCase().includes(q);
        const matchProj = t.project.toLowerCase().includes(q);
        const matchTag = t.tags.some((tag) => tag.toLowerCase().includes(q));
        if (!matchTitle && !matchProj && !matchTag) return false;
      }
      return true;
    });
  }, [tasks, projectFilter, categoryFilter, searchQuery]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );

  const selectedTaskBlocks = useMemo(() => {
    if (!selectedTaskId) return [];
    return timeBlocks
      .filter((b) => b.taskId === selectedTaskId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.startTime - a.startTime);
  }, [timeBlocks, selectedTaskId]);

  const handleQuickCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    const parsedTags = newTags
      .split(',')
      .map((s) => s.trim().replace(/^#/, ''))
      .filter(Boolean);

    onCreateTask({
      title: newTitle.trim(),
      description: 'Created from ClickUp task workspace.',
      project: newProject,
      status: 'todo',
      priority: newPriority,
      category: newCategory,
      tags: parsedTags.length > 0 ? parsedTags : ['work'],
      estimatedMinutes: Math.max(15, Number(newEstimate) || 60),
      subtasks: [],
      startDate: selectedDate || new Date().toISOString().slice(0, 10),
      dueDate: newDueDate || selectedDate || new Date().toISOString().slice(0, 10),
    });
    setNewTitle('');
    setNewDueDate('');
  };

  return (
    <div className="space-y-6">
      {/* Header & View Switcher */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-2 border-b border-slate-200 dark:border-slate-800">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight">
            ClickUp Task & Time Workspace
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Manage deliverables, compare planned estimates vs. actual timeline logs, and launch live timers
          </p>
        </div>

        {/* View Switcher & Filters */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter tasks or #tags..."
              className="pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-48"
            />
          </div>

          <select
            aria-label="Filter by project"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300"
          >
            <option value="all">All Projects</option>
            {PROJECTS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by work category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300"
          >
            <option value="all">All Categories</option>
            {(Object.keys(CATEGORY_LABELS) as WorkCategory[]).map((cat) => (
              <option key={cat} value={cat}>
                {CATEGORY_LABELS[cat]}
              </option>
            ))}
          </select>

          {/* List vs Board vs Gantt vs Calendar Segmented Control */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <LayoutList className="w-3.5 h-3.5" />
              <span>List</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('board')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'board'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Columns3 className="w-3.5 h-3.5" />
              <span>Board</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('gantt')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'gantt'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <GanttChartSquare className="w-3.5 h-3.5" />
              <span>Gantt</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('calendar')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'calendar'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>Calendar</span>
            </button>
          </div>
        </div>
      </div>

      {/* Inline Quick Task Creator Bar */}
      <form
        onSubmit={handleQuickCreateSubmit}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center gap-3"
      >
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add a new task deliverable (e.g., Optimize Postgres query latency)..."
          className="flex-1 min-w-[240px] px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <select
          aria-label="New task project"
          value={newProject}
          onChange={(e) => setNewProject(e.target.value)}
          className="px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
        >
          {PROJECTS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          aria-label="New task priority"
          value={newPriority}
          onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
          className="px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
        >
          <option value="urgent">Urgent P0</option>
          <option value="high">High P1</option>
          <option value="medium">Medium P2</option>
          <option value="low">Low P3</option>
        </select>
        <select
          aria-label="New task category"
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value as WorkCategory)}
          className="px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
        >
          {(Object.keys(CATEGORY_LABELS) as WorkCategory[]).map((cat) => (
            <option key={cat} value={cat}>
              {CATEGORY_LABELS[cat]}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500">Est (m):</span>
          <input
            type="number"
            min={15}
            step={15}
            value={newEstimate}
            onChange={(e) => setNewEstimate(Number(e.target.value))}
            className="w-20 px-2.5 py-2 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500">Due:</span>
          <input
            type="date"
            aria-label="New task due date"
            value={newDueDate}
            onChange={(e) => setNewDueDate(e.target.value)}
            className="px-2 py-2 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
          />
        </div>
        <input
          type="text"
          value={newTags}
          onChange={(e) => setNewTags(e.target.value)}
          placeholder="tags (comma-sep)"
          className="w-28 px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
        />
        <button
          type="submit"
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Task</span>
        </button>
      </form>

      {/* Main Content Area: Grouped List | Kanban Board | Gantt Chart | Calendar */}
      {viewMode === 'list' ? (
        <div className="space-y-6">
          {STATUS_GROUPS.map((group) => {
            const groupTasks = filteredTasks.filter(
              (t) => t.status === group.status
            );
            const groupLoggedMins = groupTasks.reduce(
              (acc, t) => acc + (loggedMinutesByTask.get(t.id) || 0),
              0
            );
            const groupEstMins = groupTasks.reduce(
              (acc, t) => acc + t.estimatedMinutes,
              0
            );

            return (
              <div
                key={group.status}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
              >
                {/* Status Section Header */}
                <div className="px-5 py-3.5 bg-slate-50/70 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                      {group.label} ({groupTasks.length})
                    </h2>
                    <span className="text-slate-300 dark:text-slate-700">·</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {group.description}
                    </span>
                  </div>
                  <div className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                    Logged {formatDuration(groupLoggedMins)} / Est{' '}
                    {formatDuration(groupEstMins)}
                  </div>
                </div>

                {groupTasks.length === 0 ? (
                  <div className="px-5 py-6 text-xs text-slate-500 dark:text-slate-400">
                    No tasks in {group.label.toLowerCase()}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                          <th className="py-2.5 px-4 w-10">Done</th>
                          <th className="py-2.5 px-4">Task Deliverable & Metadata</th>
                          <th className="py-2.5 px-4">Priority</th>
                          <th className="py-2.5 px-4">Status</th>
                          <th className="py-2.5 px-4 text-right">Planned Est</th>
                          <th className="py-2.5 px-4 text-right">Actual Logged</th>
                          <th className="py-2.5 px-4 text-right">Timer & Log</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                        {groupTasks.map((task) => {
                          const loggedMins = loggedMinutesByTask.get(task.id) || 0;
                          const isOverEstimate = loggedMins > task.estimatedMinutes;
                          const isThisTaskRunning =
                            isTimerRunning && activeTimerTaskId === task.id;
                          const prio = PRIORITY_TEXT[task.priority];
                          const completedSubtasks = task.subtasks.filter(
                            (s) => s.completed
                          ).length;

                          return (
                            <tr
                              key={task.id}
                              onClick={() => setSelectedTaskId(task.id)}
                              className="hover:bg-slate-50/90 dark:hover:bg-slate-800/50 transition-colors cursor-pointer"
                            >
                              <td
                                className="py-3 px-4"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const nextStatus: TaskStatus =
                                    task.status === 'completed'
                                      ? 'in_progress'
                                      : 'completed';
                                  onUpdateTask(task.id, {
                                    status: nextStatus,
                                    completedAt:
                                      nextStatus === 'completed'
                                        ? new Date().toISOString().slice(0, 10)
                                        : undefined,
                                  });
                                }}
                              >
                                {task.status === 'completed' ? (
                                  <CheckSquare className="w-4 h-4 text-emerald-600" />
                                ) : (
                                  <Square className="w-4 h-4 text-slate-400 hover:text-indigo-600" />
                                )}
                              </td>
                              <td className="py-3 px-4">
                                <div
                                  className={`font-semibold ${
                                    task.status === 'completed'
                                      ? 'line-through text-slate-400 dark:text-slate-500'
                                      : 'text-slate-900 dark:text-white'
                                  }`}
                                >
                                  {task.title}
                                </div>
                                {/* Zero-Pill Metadata row */}
                                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                  <span className="font-medium text-slate-700 dark:text-slate-300">
                                    {task.project}
                                  </span>
                                  <span>·</span>
                                  <span>{CATEGORY_LABELS[task.category]}</span>
                                  {task.subtasks.length > 0 && (
                                    <>
                                      <span>·</span>
                                      <span className="font-mono tabular-nums">
                                        Subtasks {completedSubtasks}/
                                        {task.subtasks.length}
                                      </span>
                                    </>
                                  )}
                                  {task.tags.length > 0 && (
                                    <>
                                      <span>·</span>
                                      <span>
                                        {task.tags.map((t) => `#${t}`).join(' ')}
                                      </span>
                                    </>
                                  )}
                                </div>
                                {task.blockerNote && (
                                  <div className="flex items-center gap-1.5 text-[11px] text-rose-600 dark:text-rose-400 mt-1 font-medium">
                                    <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
                                    <span>Blocker: {task.blockerNote}</span>
                                  </div>
                                )}
                              </td>
                              <td className="py-3 px-4 whitespace-nowrap">
                                <span className={prio.color}>{prio.label}</span>
                              </td>
                              <td
                                className="py-3 px-4 whitespace-nowrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <select
                                  aria-label="Task status"
                                  value={task.status}
                                  onChange={(e) => {
                                    const nextStatus = e.target
                                      .value as TaskStatus;
                                    onUpdateTask(task.id, {
                                      status: nextStatus,
                                      completedAt:
                                        nextStatus === 'completed'
                                          ? new Date().toISOString().slice(0, 10)
                                          : undefined,
                                    });
                                  }}
                                  className="px-2 py-1 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200"
                                >
                                  <option value="in_progress">In Progress</option>
                                  <option value="todo">Todo</option>
                                  <option value="blocked">Blocked</option>
                                  <option value="completed">Completed</option>
                                </select>
                              </td>
                              <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-600 dark:text-slate-400 whitespace-nowrap">
                                {formatDuration(task.estimatedMinutes)}
                              </td>
                              <td className="py-3 px-4 text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                                <span
                                  className={
                                    isOverEstimate
                                      ? 'text-amber-700 dark:text-amber-400'
                                      : 'text-slate-900 dark:text-white'
                                  }
                                >
                                  {formatDuration(loggedMins)}
                                </span>
                              </td>
                              <td
                                className="py-3 px-4 text-right whitespace-nowrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="inline-flex items-center gap-1.5">
                                  {isThisTaskRunning ? (
                                    <button
                                      type="button"
                                      onClick={onPauseTimer}
                                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-md cursor-pointer"
                                    >
                                      <Pause className="w-3 h-3" />
                                      <span>Running</span>
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => onStartTimerForTask(task.id)}
                                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 rounded-md cursor-pointer"
                                    >
                                      <Play className="w-3 h-3 fill-current" />
                                      <span>Track</span>
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => onOpenQuickLogForTask(task)}
                                    title="Log manual time block for this task"
                                    className="px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer"
                                  >
                                    +Block
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
              </div>
            );
          })}
        </div>
      ) : viewMode === 'board' ? (
        /* Kanban Board View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-start">
          {STATUS_GROUPS.map((group) => {
            const colTasks = filteredTasks.filter(
              (t) => t.status === group.status
            );
            return (
              <div
                key={group.status}
                className="bg-slate-100/70 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between px-1">
                  <h3 className="font-display text-xs font-bold text-slate-900 dark:text-white">
                    {group.label}
                  </h3>
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {colTasks.length}
                  </span>
                </div>

                <div className="space-y-2.5">
                  {colTasks.map((task) => {
                    const loggedMins = loggedMinutesByTask.get(task.id) || 0;
                    const prio = PRIORITY_TEXT[task.priority];
                    const isThisTaskRunning =
                      isTimerRunning && activeTimerTaskId === task.id;

                    return (
                      <div
                        key={task.id}
                        onClick={() => setSelectedTaskId(task.id)}
                        className="p-3.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-indigo-400 transition-colors cursor-pointer space-y-2"
                      >
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-between">
                          <span className="font-medium text-slate-700 dark:text-slate-300">
                            {task.project}
                          </span>
                          <span className={prio.color}>{prio.label}</span>
                        </div>

                        <div className="text-xs font-semibold text-slate-900 dark:text-white leading-snug">
                          {task.title}
                        </div>

                        {task.blockerNote && (
                          <div className="text-[11px] text-rose-600 dark:text-rose-400 line-clamp-2">
                            Blocker: {task.blockerNote}
                          </div>
                        )}

                        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11px]">
                          <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
                            {formatDuration(loggedMins)} /{' '}
                            {formatDuration(task.estimatedMinutes)}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isThisTaskRunning) {
                                onPauseTimer();
                              } else {
                                onStartTimerForTask(task.id);
                              }
                            }}
                            className={`px-2 py-1 rounded font-semibold cursor-pointer ${
                              isThisTaskRunning
                                ? 'bg-amber-500 text-white'
                                : 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100'
                            }`}
                          >
                            {isThisTaskRunning ? 'Pause' : 'Start Timer'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : viewMode === 'gantt' ? (
        <TaskGanttView
          tasks={filteredTasks}
          loggedMinutesByTask={loggedMinutesByTask}
          activeTimerTaskId={activeTimerTaskId}
          isTimerRunning={isTimerRunning}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          onUpdateTask={onUpdateTask}
          onStartTimerForTask={onStartTimerForTask}
          onPauseTimer={onPauseTimer}
        />
      ) : (
        <TaskCalendarView
          tasks={filteredTasks}
          timeBlocks={timeBlocks}
          selectedDate={selectedDate}
          loggedMinutesByTask={loggedMinutesByTask}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          onJumpToTimelineDate={onJumpToTimelineDate}
          onOpenQuickLogForDate={onOpenQuickLogForDate}
          onStartTimerForTask={onStartTimerForTask}
        />
      )}

      {/* Task Detail Slide-Over Drawer */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 backdrop-blur-xs">
          <div className="bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 w-full max-w-xl h-full overflow-y-auto p-6 flex flex-col justify-between">
            <div className="space-y-6">
              {/* Top Drawer Bar */}
              <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
                <div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {selectedTask.project} · {CATEGORY_LABELS[selectedTask.category]}
                  </div>
                  <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mt-1">
                    {selectedTask.title}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTaskId(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Editable Task Fields */}
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Status
                  </label>
                  <select
                    value={selectedTask.status}
                    onChange={(e) =>
                      onUpdateTask(selectedTask.id, {
                        status: e.target.value as TaskStatus,
                      })
                    }
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    <option value="in_progress">In Progress</option>
                    <option value="todo">Todo</option>
                    <option value="blocked">Blocked</option>
                    <option value="completed">Completed</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Priority
                  </label>
                  <select
                    value={selectedTask.priority}
                    onChange={(e) =>
                      onUpdateTask(selectedTask.id, {
                        priority: e.target.value as TaskPriority,
                      })
                    }
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    <option value="urgent">Urgent P0</option>
                    <option value="high">High P1</option>
                    <option value="medium">Medium P2</option>
                    <option value="low">Low P3</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Planned Estimate (Minutes)
                  </label>
                  <input
                    type="number"
                    min={15}
                    step={15}
                    value={selectedTask.estimatedMinutes}
                    onChange={(e) =>
                      onUpdateTask(selectedTask.id, {
                        estimatedMinutes: Math.max(
                          15,
                          Number(e.target.value) || 60
                        ),
                      })
                    }
                    className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Actual Logged Time
                  </label>
                  <div className="px-3 py-2 font-mono font-semibold tabular-nums bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white">
                    {formatDuration(loggedMinutesByTask.get(selectedTask.id) || 0)}
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Gantt Start Date
                  </label>
                  <input
                    type="date"
                    value={selectedTask.startDate || selectedTask.createdAt || ''}
                    onChange={(e) =>
                      onUpdateTask(selectedTask.id, {
                        startDate: e.target.value || undefined,
                      })
                    }
                    className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Target Due Date
                  </label>
                  <input
                    type="date"
                    value={selectedTask.dueDate || selectedTask.startDate || selectedTask.createdAt || ''}
                    onChange={(e) =>
                      onUpdateTask(selectedTask.id, {
                        dueDate: e.target.value || undefined,
                      })
                    }
                    className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              {/* Description & Blocker Notes */}
              <div className="space-y-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Description & Acceptance Criteria
                  </label>
                  <textarea
                    rows={2}
                    value={selectedTask.description}
                    onChange={(e) =>
                      onUpdateTask(selectedTask.id, {
                        description: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block font-medium text-rose-600 dark:text-rose-400 mb-1">
                    Blocker / Escalation Note (Included in Weekly AI Review)
                  </label>
                  <input
                    type="text"
                    value={selectedTask.blockerNote || ''}
                    onChange={(e) =>
                      onUpdateTask(selectedTask.id, {
                        blockerNote: e.target.value || undefined,
                      })
                    }
                    placeholder="Optional blocker note if task is delayed or waiting on dependencies..."
                    className="w-full px-3 py-2 bg-rose-50/40 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800/50 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              {/* Subtasks Checklist */}
              <div className="space-y-2.5">
                <h3 className="font-display text-xs font-bold text-slate-900 dark:text-white">
                  Subtasks ({selectedTask.subtasks.filter((s) => s.completed).length}/
                  {selectedTask.subtasks.length})
                </h3>
                <div className="space-y-1.5">
                  {selectedTask.subtasks.map((sub) => (
                    <div
                      key={sub.id}
                      onClick={() => {
                        const updated = selectedTask.subtasks.map((item) =>
                          item.id === sub.id
                            ? { ...item, completed: !item.completed }
                            : item
                        );
                        onUpdateTask(selectedTask.id, { subtasks: updated });
                      }}
                      className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-xs"
                    >
                      {sub.completed ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-400 shrink-0" />
                      )}
                      <span
                        className={
                          sub.completed
                            ? 'line-through text-slate-400'
                            : 'text-slate-800 dark:text-slate-200'
                        }
                      >
                        {sub.title}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={subtaskInput}
                    onChange={(e) => setSubtaskInput(e.target.value)}
                    placeholder="Add subtask step..."
                    className="flex-1 px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!subtaskInput.trim()) return;
                      onUpdateTask(selectedTask.id, {
                        subtasks: [
                          ...selectedTask.subtasks,
                          {
                            id: `sub-${Date.now()}`,
                            title: subtaskInput.trim(),
                            completed: false,
                          },
                        ],
                      });
                      setSubtaskInput('');
                    }}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-lg cursor-pointer"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Linked Timeline Blocks History */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="font-display text-xs font-bold text-slate-900 dark:text-white">
                    Logged Timeline Sessions ({selectedTaskBlocks.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => onOpenQuickLogForTask(selectedTask)}
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-500 cursor-pointer"
                  >
                    + Log Manual Session
                  </button>
                </div>
                {selectedTaskBlocks.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No timeline blocks logged for this task yet.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden text-xs">
                    {selectedTaskBlocks.map((b) => (
                      <div
                        key={b.id}
                        className="p-2.5 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/30"
                      >
                        <div>
                          <div className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                            {b.date} · {formatMinutesToHHMM(b.startTime)}–
                            {formatMinutesToHHMM(b.endTime)}
                          </div>
                          {b.notes && (
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {b.notes}
                            </div>
                          )}
                        </div>
                        <span className="font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                          {formatDuration(b.durationMinutes)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Drawer Actions */}
            <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  onDeleteTask(selectedTask.id);
                  setSelectedTaskId(null);
                }}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete Task</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedTaskId(null)}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-indigo-600 rounded-lg cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
