import React, { useMemo, useRef, useState } from 'react';
import {
  AlertOctagon,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare,
  Columns3,
  FolderKanban,
  GanttChartSquare,
  GripVertical,
  LayoutList,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  BoardSection,
  BoardSectionColor,
  Task,
  TaskPriority,
  TaskStatus,
  TimeBlock,
  WorkCategory,
  WorkspaceBoard,
  WorkspaceHierarchy,
} from '../types';
import {
  CATEGORY_LABELS,
  formatDuration,
  formatMinutesToHHMM,
} from '../utils/workspaceConstants';
import {
  resolveBoardForTask,
  resolveSectionForTask,
  SECTION_COLOR_META,
} from '../utils/taskHierarchy';
import {
  ObjectModalIntent,
  SidebarSelection,
  TaskHierarchySidebar,
} from './TaskHierarchySidebar';
import { WorkspaceObjectModal } from './WorkspaceObjectModal';
import { TaskGanttView } from './TaskGanttView';
import { TaskCalendarView } from './TaskCalendarView';

interface TaskWorkspaceViewProps {
  tasks: Task[];
  timeBlocks: TimeBlock[];
  hierarchy: WorkspaceHierarchy;
  selectedDate: string;
  activeTimerTaskId: string | null;
  isTimerRunning: boolean;
  onStartTimerForTask: (taskId: string) => void;
  onPauseTimer: () => void;
  onCreateTask: (newTask: Omit<Task, 'id' | 'createdAt'>) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onDeleteTask: (taskId: string) => void;
  onUpdateHierarchy: (
    updater:
      | WorkspaceHierarchy
      | ((prev: WorkspaceHierarchy) => WorkspaceHierarchy)
  ) => void;
  onOpenQuickLogForTask: (task: Task) => void;
  onOpenQuickLogForDate: (date: string) => void;
  onJumpToTimelineDate: (date: string) => void;
  onNotify?: (msg: string) => void;
}

const PRIORITY_TEXT: Record<TaskPriority, { label: string; color: string }> = {
  urgent: {
    label: 'Urgent P0',
    color: 'text-rose-600 dark:text-rose-400 font-semibold',
  },
  high: {
    label: 'High P1',
    color: 'text-amber-700 dark:text-amber-400 font-medium',
  },
  medium: {
    label: 'Medium P2',
    color: 'text-indigo-600 dark:text-indigo-400',
  },
  low: {
    label: 'Low P3',
    color: 'text-slate-500 dark:text-slate-400',
  },
};

const COLOR_OPTIONS: BoardSectionColor[] = [
  'indigo',
  'emerald',
  'amber',
  'rose',
  'sky',
  'slate',
];

export const TaskWorkspaceView: React.FC<TaskWorkspaceViewProps> = ({
  tasks,
  timeBlocks,
  hierarchy,
  selectedDate,
  activeTimerTaskId,
  isTimerRunning,
  onStartTimerForTask,
  onPauseTimer,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onUpdateHierarchy,
  onOpenQuickLogForTask,
  onOpenQuickLogForDate,
  onJumpToTimelineDate,
  onNotify,
}) => {
  const [viewMode, setViewMode] = useState<'board' | 'list' | 'gantt' | 'calendar'>('board');
  const [selection, setSelection] = useState<SidebarSelection>(() =>
    hierarchy.boards[0]
      ? { kind: 'board', boardId: hierarchy.boards[0].id }
      : { kind: 'all' }
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [objectModal, setObjectModal] = useState<ObjectModalIntent | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Quick inline task creation form state
  const quickTitleInputRef = useRef<HTMLInputElement | null>(null);
  const [quickTitleError, setQuickTitleError] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSectionId, setNewSectionId] = useState<string>('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('high');
  const [newCategory, setNewCategory] = useState<WorkCategory>('deep_work');
  const [newEstimate, setNewEstimate] = useState<number>(120);
  const [newDueDate, setNewDueDate] = useState<string>('');
  const [newTags, setNewTags] = useState<string>('deliverable');

  // Board Section inline creation & editing state
  const [addingSectionOpen, setAddingSectionOpen] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  const [newSectionDesc, setNewSectionDesc] = useState('');
  const [newSectionColor, setNewSectionColor] =
    useState<BoardSectionColor>('indigo');
  const [newSectionStatus, setNewSectionStatus] =
    useState<TaskStatus>('in_progress');

  const [editingSectionKey, setEditingSectionKey] = useState<string | null>(null);
  const [editSecName, setEditSecName] = useState('');
  const [editSecDesc, setEditSecDesc] = useState('');
  const [editSecColor, setEditSecColor] =
    useState<BoardSectionColor>('indigo');
  const [editSecStatus, setEditSecStatus] =
    useState<TaskStatus>('in_progress');

  // Inline quick-add task inside a specific board section
  const [sectionTaskDraftId, setSectionTaskDraftId] = useState<string | null>(
    null
  );
  const [sectionTaskDraftTitle, setSectionTaskDraftTitle] = useState('');

  // Drag & Drop state across board sections
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(
    null
  );

  // Subtask input inside detail drawer
  const [subtaskInput, setSubtaskInput] = useState('');

  // Active board(s) derived from sidebar selection
  const scopedBoards = useMemo(() => {
    if (selection.kind === 'board') {
      const match = hierarchy.boards.find((b) => b.id === selection.boardId);
      return match ? [match] : hierarchy.boards.slice(0, 1);
    }
    if (selection.kind === 'folder') {
      return hierarchy.boards.filter((b) => b.folderId === selection.folderId);
    }
    if (selection.kind === 'space') {
      return hierarchy.boards.filter((b) => b.spaceId === selection.spaceId);
    }
    return hierarchy.boards;
  }, [hierarchy.boards, selection]);

  const primaryBoard: WorkspaceBoard | undefined = useMemo(() => {
    if (selection.kind === 'board') {
      return (
        hierarchy.boards.find((b) => b.id === selection.boardId) ||
        hierarchy.boards[0]
      );
    }
    return scopedBoards[0] || hierarchy.boards[0];
  }, [hierarchy.boards, scopedBoards, selection]);

  const breadcrumbParts = useMemo(() => {
    if (selection.kind === 'all') {
      return ['OnTrack Workspace', 'All Spaces & Boards'];
    }
    if (selection.kind === 'space') {
      const sp = hierarchy.spaces.find((s) => s.id === selection.spaceId);
      return ['Spaces', sp?.name || 'Space'];
    }
    if (selection.kind === 'folder') {
      const sp = hierarchy.spaces.find((s) => s.id === selection.spaceId);
      const fld = hierarchy.folders.find((f) => f.id === selection.folderId);
      return [sp?.name || 'Space', fld?.name || 'Folder'];
    }
    const board = hierarchy.boards.find((b) => b.id === selection.boardId);
    if (!board) return ['Workspace'];
    const sp = hierarchy.spaces.find((s) => s.id === board.spaceId);
    const fld = board.folderId
      ? hierarchy.folders.find((f) => f.id === board.folderId)
      : null;
    return [sp?.name || 'Space', ...(fld ? [fld.name] : []), board.name];
  }, [hierarchy, selection]);

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

  const scopedBoardIds = useMemo(
    () => new Set(scopedBoards.map((b) => b.id)),
    [scopedBoards]
  );

  // Filter tasks by sidebar scope + search + category
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      const resolvedBoard = resolveBoardForTask(t, hierarchy.boards);
      if (
        selection.kind !== 'all' &&
        (!resolvedBoard || !scopedBoardIds.has(resolvedBoard.id))
      ) {
        return false;
      }
      if (categoryFilter !== 'all' && t.category !== categoryFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = t.title.toLowerCase().includes(q);
        const matchProj = t.project.toLowerCase().includes(q);
        const matchBoard = resolvedBoard?.name.toLowerCase().includes(q);
        const matchTag = t.tags.some((tag) => tag.toLowerCase().includes(q));
        if (!matchTitle && !matchProj && !matchBoard && !matchTag) {
          return false;
        }
      }
      return true;
    });
  }, [
    tasks,
    hierarchy.boards,
    selection.kind,
    scopedBoardIds,
    categoryFilter,
    searchQuery,
  ]);

  // Sections rendered in Board & List views:
  // - Single Board selected: exact sections[] on that board (full edit/reorder/delete/add)
  // - Space/Folder/All selected: sections from the primary scoped board or unified columns
  const displayedSections = useMemo(() => {
    if (selection.kind === 'board' && primaryBoard) {
      return primaryBoard.sections.map((sec, index) => ({
        section: sec,
        boardId: primaryBoard.id,
        index,
        totalInBoard: primaryBoard.sections.length,
        editable: true,
      }));
    }
    if (!primaryBoard) return [];
    return primaryBoard.sections.map((sec, index) => ({
      section: sec,
      boardId: primaryBoard.id,
      index,
      totalInBoard: primaryBoard.sections.length,
      editable: true,
    }));
  }, [selection.kind, primaryBoard]);

  // Group filteredTasks cleanly into displayedSections
  const tasksBySectionId = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const item of displayedSections) {
      map.set(item.section.id, []);
    }
    const fallbackSecId = displayedSections[0]?.section.id;
    for (const t of filteredTasks) {
      const tBoard = resolveBoardForTask(t, hierarchy.boards);
      if (selection.kind === 'board' && primaryBoard) {
        const sec = resolveSectionForTask(t, primaryBoard);
        const targetId = sec?.id || fallbackSecId;
        if (targetId && map.has(targetId)) {
          map.get(targetId)!.push(t);
        }
      } else {
        // Multi-board scope: match by direct sectionId, else by section name, else by mappedStatus
        const exactDirect =
          t.sectionId && map.has(t.sectionId) ? t.sectionId : null;
        if (exactDirect) {
          map.get(exactDirect)!.push(t);
          continue;
        }
        const tSec = resolveSectionForTask(t, tBoard);
        const byName = displayedSections.find(
          (d) =>
            tSec && d.section.name.toLowerCase() === tSec.name.toLowerCase()
        );
        const byStatus = displayedSections.find(
          (d) => d.section.mappedStatus === t.status
        );
        const targetId =
          byName?.section.id || byStatus?.section.id || fallbackSecId;
        if (targetId && map.has(targetId)) {
          map.get(targetId)!.push(t);
        }
      }
    }
    return map;
  }, [
    displayedSections,
    filteredTasks,
    hierarchy.boards,
    selection.kind,
    primaryBoard,
  ]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );

  const selectedTaskBoard = useMemo(
    () =>
      selectedTask
        ? resolveBoardForTask(selectedTask, hierarchy.boards)
        : undefined,
    [selectedTask, hierarchy.boards]
  );

  const selectedTaskSection = useMemo(
    () =>
      selectedTask
        ? resolveSectionForTask(selectedTask, selectedTaskBoard)
        : undefined,
    [selectedTask, selectedTaskBoard]
  );

  const selectedTaskBlocks = useMemo(() => {
    if (!selectedTaskId) return [];
    return timeBlocks
      .filter((b) => b.taskId === selectedTaskId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.startTime - a.startTime);
  }, [timeBlocks, selectedTaskId]);

  const notify = (msg: string) => {
    onNotify?.(msg);
  };

  // Board Section CRUD handlers
  const handleAddSection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!primaryBoard || !newSectionName.trim()) return;
    const created: BoardSection = {
      id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: newSectionName.trim(),
      description:
        newSectionDesc.trim() || 'Custom workflow section on this board',
      color: newSectionColor,
      mappedStatus: newSectionStatus,
    };
    onUpdateHierarchy((prev) => ({
      ...prev,
      boards: prev.boards.map((b) =>
        b.id === primaryBoard.id
          ? { ...b, sections: [...b.sections, created] }
          : b
      ),
    }));
    setNewSectionName('');
    setNewSectionDesc('');
    setAddingSectionOpen(false);
    notify(`Section "${created.name}" added to ${primaryBoard.name}.`);
  };

  const startEditingSection = (sec: BoardSection) => {
    setEditingSectionKey(sec.id);
    setEditSecName(sec.name);
    setEditSecDesc(sec.description);
    setEditSecColor(sec.color);
    setEditSecStatus(sec.mappedStatus);
  };

  const handleSaveSectionEdit = (boardId: string, secId: string) => {
    if (!editSecName.trim()) return;
    onUpdateHierarchy((prev) => ({
      ...prev,
      boards: prev.boards.map((b) =>
        b.id === boardId
          ? {
              ...b,
              sections: b.sections.map((s) =>
                s.id === secId
                  ? {
                      ...s,
                      name: editSecName.trim(),
                      description: editSecDesc.trim(),
                      color: editSecColor,
                      mappedStatus: editSecStatus,
                    }
                  : s
              ),
            }
          : b
      ),
    }));
    setEditingSectionKey(null);
    notify(`Updated section "${editSecName.trim()}".`);
  };

  const handleReorderSection = (
    boardId: string,
    index: number,
    delta: -1 | 1
  ) => {
    onUpdateHierarchy((prev) => ({
      ...prev,
      boards: prev.boards.map((b) => {
        if (b.id !== boardId) return b;
        const target = index + delta;
        if (target < 0 || target >= b.sections.length) return b;
        const next = b.sections.slice();
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        return { ...b, sections: next };
      }),
    }));
  };

  const handleDeleteSection = (boardId: string, secId: string) => {
    const board = hierarchy.boards.find((b) => b.id === boardId);
    if (!board || board.sections.length <= 1) return;
    const remaining = board.sections.filter((s) => s.id !== secId);
    const fallback = remaining[0];
    // Reassign tasks in deleted section to fallback section cleanly
    for (const t of tasks) {
      if (t.sectionId === secId) {
        onUpdateTask(t.id, {
          boardId,
          sectionId: fallback.id,
          status: fallback.mappedStatus,
        });
      }
    }
    onUpdateHierarchy((prev) => ({
      ...prev,
      boards: prev.boards.map((b) =>
        b.id === boardId ? { ...b, sections: remaining } : b
      ),
    }));
    setEditingSectionKey(null);
    notify(`Section removed; tasks moved to "${fallback.name}".`);
  };

  // Move task between sections (via drag-drop or drawer selector)
  const handleMoveTaskToSection = (
    taskId: string,
    targetBoard: WorkspaceBoard,
    targetSection: BoardSection
  ) => {
    onUpdateTask(taskId, {
      boardId: targetBoard.id,
      project: targetBoard.projectTag || targetBoard.name,
      sectionId: targetSection.id,
      status: targetSection.mappedStatus,
      completedAt:
        targetSection.mappedStatus === 'completed'
          ? new Date().toISOString().slice(0, 10)
          : undefined,
    });
  };

  // Inline quick-create bar submit
  const handleQuickCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!primaryBoard) {
      notify('Create a board first before adding tasks.');
      return;
    }
    const cleanTitle = newTitle.trim();
    if (!cleanTitle) {
      setQuickTitleError(true);
      quickTitleInputRef.current?.focus();
      notify('Enter a task title first before clicking Add Task.');
      return;
    }
    setQuickTitleError(false);

    const chosenSection =
      primaryBoard.sections.find((s) => s.id === newSectionId) ||
      primaryBoard.sections[0];
    const parsedTags = newTags
      .split(',')
      .map((s) => s.trim().replace(/^#/, ''))
      .filter(Boolean);

    if (categoryFilter !== 'all' && categoryFilter !== newCategory) {
      setCategoryFilter('all');
    }
    if (
      searchQuery.trim() &&
      !cleanTitle.toLowerCase().includes(searchQuery.trim().toLowerCase()) &&
      !(primaryBoard.projectTag || primaryBoard.name)
        .toLowerCase()
        .includes(searchQuery.trim().toLowerCase())
    ) {
      setSearchQuery('');
    }
    if (
      (selection.kind === 'space' || selection.kind === 'folder') &&
      scopedBoards.length === 0
    ) {
      setSelection({ kind: 'board', boardId: primaryBoard.id });
    }

    onCreateTask({
      title: cleanTitle,
      description: 'Created from OnTrack task workspace.',
      project: primaryBoard.projectTag || primaryBoard.name,
      boardId: primaryBoard.id,
      sectionId: chosenSection?.id,
      status: chosenSection?.mappedStatus || 'todo',
      priority: newPriority,
      category: newCategory,
      tags: parsedTags.length > 0 ? parsedTags : ['work'],
      estimatedMinutes: Math.max(5, Number(newEstimate) || 60),
      subtasks: [],
      startDate: selectedDate || new Date().toISOString().slice(0, 10),
      dueDate:
        newDueDate || selectedDate || new Date().toISOString().slice(0, 10),
    });
    setNewTitle('');
    setNewDueDate('');
  };

  // Quick-add card directly inside a board or list section
  const handleCreateTaskInSection = (
    e: React.FormEvent,
    board: WorkspaceBoard,
    sec: BoardSection
  ) => {
    e.preventDefault();
    const cleanTitle = sectionTaskDraftTitle.trim();
    if (!cleanTitle) {
      notify('Enter a task title before saving.');
      return;
    }
    const targetCategory: WorkCategory =
      categoryFilter !== 'all' ? (categoryFilter as WorkCategory) : 'deep_work';
    if (
      searchQuery.trim() &&
      !cleanTitle.toLowerCase().includes(searchQuery.trim().toLowerCase()) &&
      !(board.projectTag || board.name)
        .toLowerCase()
        .includes(searchQuery.trim().toLowerCase())
    ) {
      setSearchQuery('');
    }
    if (
      (selection.kind === 'space' || selection.kind === 'folder') &&
      scopedBoards.length === 0
    ) {
      setSelection({ kind: 'board', boardId: board.id });
    }

    onCreateTask({
      title: cleanTitle,
      description: `Added to ${sec.name} on ${board.name}.`,
      project: board.projectTag || board.name,
      boardId: board.id,
      sectionId: sec.id,
      status: sec.mappedStatus,
      priority: 'medium',
      category: targetCategory,
      tags: ['board'],
      estimatedMinutes: 60,
      subtasks: [],
      startDate: selectedDate || new Date().toISOString().slice(0, 10),
      dueDate: selectedDate || new Date().toISOString().slice(0, 10),
    });
    setSectionTaskDraftTitle('');
    setSectionTaskDraftId(null);
  };

  // Sidebar Object Modal CRUD handlers
  const handleSaveSpace = (params: {
    id?: string;
    name: string;
    color: BoardSectionColor;
  }) => {
    if (params.id) {
      onUpdateHierarchy((prev) => ({
        ...prev,
        spaces: prev.spaces.map((s) =>
          s.id === params.id
            ? { ...s, name: params.name, color: params.color }
            : s
        ),
      }));
      notify(`Updated space "${params.name}".`);
    } else {
      const id = `spc-${Date.now()}`;
      onUpdateHierarchy((prev) => ({
        ...prev,
        spaces: [
          ...prev.spaces,
          { id, name: params.name, color: params.color, collapsed: false },
        ],
      }));
      setSelection({ kind: 'space', spaceId: id });
      notify(`Space "${params.name}" created.`);
    }
  };

  const handleSaveFolder = (params: {
    id?: string;
    spaceId: string;
    name: string;
  }) => {
    if (params.id) {
      onUpdateHierarchy((prev) => ({
        ...prev,
        folders: prev.folders.map((f) =>
          f.id === params.id
            ? { ...f, spaceId: params.spaceId, name: params.name }
            : f
        ),
      }));
      notify(`Updated folder "${params.name}".`);
    } else {
      const id = `fld-${Date.now()}`;
      onUpdateHierarchy((prev) => ({
        ...prev,
        folders: [
          ...prev.folders,
          { id, spaceId: params.spaceId, name: params.name, collapsed: false },
        ],
      }));
      setSelection({ kind: 'folder', folderId: id, spaceId: params.spaceId });
      notify(`Folder "${params.name}" created.`);
    }
  };

  const handleSaveBoard = (params: {
    id?: string;
    spaceId: string;
    folderId: string | null;
    name: string;
    description: string;
    sections: BoardSection[];
  }) => {
    if (params.id) {
      onUpdateHierarchy((prev) => ({
        ...prev,
        boards: prev.boards.map((b) =>
          b.id === params.id
            ? {
                ...b,
                spaceId: params.spaceId,
                folderId: params.folderId,
                name: params.name,
                description: params.description,
                sections: params.sections,
              }
            : b
        ),
      }));
      setSelection({ kind: 'board', boardId: params.id });
      notify(`Updated board "${params.name}".`);
    } else {
      const id = `brd-${Date.now()}`;
      const created: WorkspaceBoard = {
        id,
        spaceId: params.spaceId,
        folderId: params.folderId,
        name: params.name,
        description: params.description,
        projectTag: params.name,
        sections: params.sections,
        createdAt: new Date().toISOString().slice(0, 10),
      };
      onUpdateHierarchy((prev) => ({
        ...prev,
        boards: [...prev.boards, created],
      }));
      setSelection({ kind: 'board', boardId: id });
      setViewMode('board');
      notify(`Board "${params.name}" created with ${params.sections.length} sections.`);
    }
  };

  const handleDeleteSpace = (spaceId: string) => {
    if (hierarchy.spaces.length <= 1) return;
    const remainingSpaces = hierarchy.spaces.filter((s) => s.id !== spaceId);
    const fallbackSpace = remainingSpaces[0];
    onUpdateHierarchy((prev) => ({
      spaces: remainingSpaces,
      folders: prev.folders.filter((f) => f.spaceId !== spaceId),
      boards: prev.boards.map((b) =>
        b.spaceId === spaceId
          ? { ...b, spaceId: fallbackSpace.id, folderId: null }
          : b
      ),
    }));
    if (selection.kind === 'space' && selection.spaceId === spaceId) {
      setSelection({ kind: 'all' });
    }
    notify('Space deleted; boards moved to active workspace.');
  };

  const handleDeleteFolder = (folderId: string) => {
    onUpdateHierarchy((prev) => ({
      ...prev,
      folders: prev.folders.filter((f) => f.id !== folderId),
      boards: prev.boards.map((b) =>
        b.folderId === folderId ? { ...b, folderId: null } : b
      ),
    }));
    if (selection.kind === 'folder' && selection.folderId === folderId) {
      setSelection({ kind: 'all' });
    }
    notify('Folder removed; boards kept inside parent space.');
  };

  const handleDeleteBoard = (boardId: string) => {
    if (hierarchy.boards.length <= 1) return;
    const remaining = hierarchy.boards.filter((b) => b.id !== boardId);
    const fallback = remaining[0];
    for (const t of tasks) {
      if (t.boardId === boardId) {
        onUpdateTask(t.id, {
          boardId: fallback.id,
          project: fallback.projectTag || fallback.name,
          sectionId: fallback.sections[0]?.id,
        });
      }
    }
    onUpdateHierarchy((prev) => ({
      ...prev,
      boards: remaining,
    }));
    if (selection.kind === 'board' && selection.boardId === boardId) {
      setSelection({ kind: 'board', boardId: fallback.id });
    }
    notify(`Board deleted; tasks reassigned to "${fallback.name}".`);
  };

  const totalFilteredLoggedMins = useMemo(
    () =>
      filteredTasks.reduce(
        (sum, t) => sum + (loggedMinutesByTask.get(t.id) || 0),
        0
      ),
    [filteredTasks, loggedMinutesByTask]
  );
  const totalFilteredEstMins = useMemo(
    () => filteredTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0),
    [filteredTasks]
  );

  return (
    <div className="flex items-start gap-5">
      {/* Left Hierarchy Sidebar (Spaces -> Folders -> Boards -> Objects) */}
      <TaskHierarchySidebar
        hierarchy={hierarchy}
        tasks={tasks}
        selection={selection}
        onSelect={setSelection}
        onToggleSpaceCollapse={(spaceId) =>
          onUpdateHierarchy((prev) => ({
            ...prev,
            spaces: prev.spaces.map((s) =>
              s.id === spaceId ? { ...s, collapsed: !s.collapsed } : s
            ),
          }))
        }
        onToggleFolderCollapse={(folderId) =>
          onUpdateHierarchy((prev) => ({
            ...prev,
            folders: prev.folders.map((f) =>
              f.id === folderId ? { ...f, collapsed: !f.collapsed } : f
            ),
          }))
        }
        onOpenObjectModal={(intent) => setObjectModal(intent)}
        onDeleteSpace={handleDeleteSpace}
        onDeleteFolder={handleDeleteFolder}
        onDeleteBoard={handleDeleteBoard}
        isOpenMobile={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      {/* Main Board & Task Content Viewport */}
      <div className="flex-1 min-w-0 space-y-5">
        {/* Top Workspace Header + Breadcrumb */}
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 pb-3 border-b border-slate-200 dark:border-slate-800">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(true)}
                className="lg:hidden inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded-md cursor-pointer"
              >
                <PanelLeft className="w-3.5 h-3.5" />
                <span>Spaces &amp; Boards</span>
              </button>
              <span className="truncate">{breadcrumbParts.join(' / ')}</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white tracking-tight truncate">
                {selection.kind === 'board' && primaryBoard
                  ? primaryBoard.name
                  : selection.kind === 'folder'
                  ? hierarchy.folders.find((f) => f.id === selection.folderId)
                      ?.name || 'Folder Overview'
                  : selection.kind === 'space'
                  ? hierarchy.spaces.find((s) => s.id === selection.spaceId)
                      ?.name || 'Space Overview'
                  : 'All Workspaces & Deliverables'}
              </h1>

              {selection.kind === 'board' && primaryBoard && (
                <button
                  type="button"
                  onClick={() =>
                    setObjectModal({ kind: 'edit_board', board: primaryBoard })
                  }
                  title="Edit board name & sections"
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors cursor-pointer"
                >
                  <Pencil className="w-3 h-3" />
                  <span>Edit Board</span>
                </button>
              )}
            </div>

            {/* Clean Zero-Pill Metadata Strip */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>
                {selection.kind === 'board' && primaryBoard
                  ? primaryBoard.description
                  : 'Manage custom boards, unlimited workflow sections, estimates, and live timers'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {displayedSections.length} sections
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {filteredTasks.length} deliverables
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                Logged {formatDuration(totalFilteredLoggedMins)} / Est{' '}
                {formatDuration(totalFilteredEstMins)}
              </span>
            </div>
          </div>

          {/* Filters, View Switcher & Primary Board/Section Actions */}
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter tasks or #tags..."
                className="pl-8 pr-3 py-1.5 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-44"
              />
            </div>

            <select
              aria-label="Filter by work category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-2.5 py-1.5 text-xs font-medium bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300"
            >
              <option value="all">All Categories</option>
              {(Object.keys(CATEGORY_LABELS) as WorkCategory[]).map((cat) => (
                <option key={cat} value={cat}>
                  {CATEGORY_LABELS[cat]}
                </option>
              ))}
            </select>

            {/* Board | List | Gantt | Calendar Segmented Control */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
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

            <button
              type="button"
              onClick={() =>
                setObjectModal({
                  kind: 'create_board',
                  defaultSpaceId:
                    selection.kind === 'space'
                      ? selection.spaceId
                      : selection.kind === 'folder'
                      ? selection.spaceId
                      : primaryBoard?.spaceId,
                  defaultFolderId:
                    selection.kind === 'folder'
                      ? selection.folderId
                      : primaryBoard?.folderId ?? null,
                })
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FolderKanban className="w-3.5 h-3.5" />
              <span>New Board</span>
            </button>
          </div>
        </div>

        {/* Multi-board switcher strip when viewing All / Space / Folder */}
        {selection.kind !== 'board' && scopedBoards.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500 dark:text-slate-400 font-medium">
              Boards in scope:
            </span>
            {scopedBoards.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelection({ kind: 'board', boardId: b.id })}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-indigo-400 rounded-lg text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
              >
                <Columns3 className="w-3 h-3 text-indigo-500" />
                <span>{b.name}</span>
                <span className="font-mono tabular-nums text-[11px] text-slate-400">
                  {b.sections.length}s
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Inline Quick Task Creator Bar */}
        <form
          onSubmit={handleQuickCreateSubmit}
          noValidate
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 flex flex-wrap items-center gap-2.5"
        >
          <input
            ref={quickTitleInputRef}
            type="text"
            value={newTitle}
            onChange={(e) => {
              setNewTitle(e.target.value);
              if (quickTitleError && e.target.value.trim()) {
                setQuickTitleError(false);
              }
            }}
            placeholder={
              quickTitleError
                ? 'Type a task title here to add...'
                : `Add task to ${primaryBoard?.name || 'board'}...`
            }
            className={`flex-1 min-w-[210px] px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-2 ${
              quickTitleError
                ? 'border-rose-500 ring-2 ring-rose-500/30 focus:ring-rose-500'
                : 'border-slate-200 dark:border-slate-700 focus:ring-indigo-500'
            }`}
          />
          <select
            aria-label="Target board section"
            value={
              primaryBoard?.sections.some((s) => s.id === newSectionId)
                ? newSectionId
                : primaryBoard?.sections[0]?.id || ''
            }
            onChange={(e) => setNewSectionId(e.target.value)}
            className="px-2.5 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
          >
            {(primaryBoard?.sections || []).map((sec) => (
              <option key={sec.id} value={sec.id}>
                Section: {sec.name}
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
              min={5}
              value={newEstimate}
              onChange={(e) => setNewEstimate(Number(e.target.value))}
              className="w-18 px-2 py-2 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
            />
          </div>
          <input
            type="date"
            aria-label="New task due date"
            value={newDueDate}
            onChange={(e) => setNewDueDate(e.target.value)}
            className="px-2 py-2 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
          />
          <input
            type="text"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            placeholder="tags (comma-sep)"
            className="w-24 px-2 py-2 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
          />
          <button
            type="submit"
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Task</span>
          </button>
        </form>

        {/* Empty State Notice */}
        {filteredTasks.length === 0 && (
          <div className="bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 rounded-xl px-4 py-3 text-xs text-slate-600 dark:text-slate-300 flex flex-wrap items-center justify-between gap-2">
            <span>
              No deliverables match the current board or filter yet. Use the quick-add bar above or add a card directly inside any section below.
            </span>
            {(searchQuery || categoryFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setCategoryFilter('all');
                }}
                className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
              >
                Reset Filters
              </button>
            )}
          </div>
        )}

        {/* Main View Modes */}
        {viewMode === 'board' ? (
          /* Unlimited Dynamic Kanban Board Sections */
          <div className="flex items-start gap-4 overflow-x-auto pb-4">
            {displayedSections.map(({ section, boardId, index, totalInBoard }) => {
              const colTasks = tasksBySectionId.get(section.id) || [];
              const colorMeta =
                SECTION_COLOR_META[section.color] || SECTION_COLOR_META.indigo;
              const isEditing = editingSectionKey === section.id;
              const isDropTarget = dragOverSectionId === section.id;
              const targetBoard =
                hierarchy.boards.find((b) => b.id === boardId) || primaryBoard;

              return (
                <div
                  key={section.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    if (dragOverSectionId !== section.id) {
                      setDragOverSectionId(section.id);
                    }
                  }}
                  onDragLeave={() => {
                    if (dragOverSectionId === section.id) {
                      setDragOverSectionId(null);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverSectionId(null);
                    if (draggingTaskId && targetBoard) {
                      handleMoveTaskToSection(
                        draggingTaskId,
                        targetBoard,
                        section
                      );
                    }
                    setDraggingTaskId(null);
                  }}
                  className={`w-[310px] shrink-0 bg-slate-100/80 dark:bg-slate-900/70 border border-t-2 ${
                    colorMeta.topRule
                  } ${
                    isDropTarget
                      ? 'border-indigo-500 ring-2 ring-indigo-500/30'
                      : 'border-slate-200 dark:border-slate-800'
                  } rounded-xl p-3 space-y-3 transition-colors`}
                >
                  {/* Section Column Header OR Inline Editor */}
                  {isEditing ? (
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-2.5 space-y-2 text-xs">
                      <input
                        type="text"
                        value={editSecName}
                        onChange={(e) => setEditSecName(e.target.value)}
                        aria-label="Edit section name"
                        placeholder="Section name"
                        className="w-full px-2.5 py-1.5 font-semibold bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white"
                      />
                      <input
                        type="text"
                        value={editSecDesc}
                        onChange={(e) => setEditSecDesc(e.target.value)}
                        aria-label="Edit section description"
                        placeholder="Section description"
                        className="w-full px-2.5 py-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-300"
                      />
                      <div className="grid grid-cols-2 gap-1.5">
                        <select
                          aria-label="Section color"
                          value={editSecColor}
                          onChange={(e) =>
                            setEditSecColor(e.target.value as BoardSectionColor)
                          }
                          className="px-2 py-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-200"
                        >
                          {COLOR_OPTIONS.map((c) => (
                            <option key={c} value={c}>
                              {SECTION_COLOR_META[c].label}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label="Section status mapping"
                          value={editSecStatus}
                          onChange={(e) =>
                            setEditSecStatus(e.target.value as TaskStatus)
                          }
                          className="px-2 py-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-200"
                        >
                          <option value="todo">Todo</option>
                          <option value="in_progress">In Progress</option>
                          <option value="blocked">Blocked</option>
                          <option value="completed">Completed</option>
                        </select>
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() =>
                              handleReorderSection(boardId, index, -1)
                            }
                            title="Move section left"
                            className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 rounded cursor-pointer"
                          >
                            <ArrowLeft className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={index === totalInBoard - 1}
                            onClick={() =>
                              handleReorderSection(boardId, index, 1)
                            }
                            title="Move section right"
                            className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 rounded cursor-pointer"
                          >
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                          {totalInBoard > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                handleDeleteSection(boardId, section.id)
                              }
                              title="Delete section"
                              className="p-1 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => setEditingSectionKey(null)}
                            className="px-2 py-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleSaveSectionEdit(boardId, section.id)
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer"
                          >
                            <Check className="w-3 h-3" />
                            <span>Save</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2 px-0.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-sm shrink-0 ${colorMeta.dot}`}
                          />
                          <h3 className="font-display text-xs font-bold text-slate-900 dark:text-white truncate">
                            {section.name}
                          </h3>
                          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                            {colTasks.length}
                          </span>
                        </div>
                        {section.description && (
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                            {section.description}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditingSection(section)}
                          title={`Edit ${section.name}`}
                          aria-label={`Edit section ${section.name}`}
                          className="p-1 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 rounded cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setSectionTaskDraftId(section.id);
                            setSectionTaskDraftTitle('');
                          }}
                          title={`Add task to ${section.name}`}
                          aria-label={`Add task to ${section.name}`}
                          className="p-1 text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-300 rounded cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Inline Quick Task Input Inside Section */}
                  {sectionTaskDraftId === section.id && targetBoard && (
                    <form
                      onSubmit={(e) =>
                        handleCreateTaskInSection(e, targetBoard, section)
                      }
                      className="bg-white dark:bg-slate-900 border border-indigo-400 rounded-lg p-2.5 space-y-2"
                    >
                      <input
                        type="text"
                        autoFocus
                        value={sectionTaskDraftTitle}
                        onChange={(e) =>
                          setSectionTaskDraftTitle(e.target.value)
                        }
                        placeholder={`New task in ${section.name}...`}
                        className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white focus:outline-none"
                      />
                      <div className="flex items-center justify-end gap-1.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setSectionTaskDraftId(null)}
                          className="px-2 py-1 text-slate-500 hover:text-slate-800 cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="px-2.5 py-1 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer"
                        >
                          Add
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Task Cards in Section */}
                  <div className="space-y-2.5 min-h-[48px]">
                    {colTasks.length === 0 ? (
                      <div className="px-3 py-5 text-center text-[11px] text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
                        Drop tasks here or click + to add
                      </div>
                    ) : (
                      colTasks.map((task) => {
                        const loggedMins =
                          loggedMinutesByTask.get(task.id) || 0;
                        const prio = PRIORITY_TEXT[task.priority];
                        const isThisTaskRunning =
                          isTimerRunning && activeTimerTaskId === task.id;
                        const completedSubtasks = task.subtasks.filter(
                          (s) => s.completed
                        ).length;

                        return (
                          <div
                            key={task.id}
                            draggable
                            onDragStart={() => setDraggingTaskId(task.id)}
                            onDragEnd={() => {
                              setDraggingTaskId(null);
                              setDragOverSectionId(null);
                            }}
                            onClick={() => setSelectedTaskId(task.id)}
                            className="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-indigo-400 transition-colors cursor-pointer space-y-2"
                          >
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2">
                              <span className="flex items-center gap-1 min-w-0">
                                <GripVertical className="w-3 h-3 text-slate-300 dark:text-slate-600 shrink-0" />
                                <span className="font-medium text-slate-700 dark:text-slate-300 truncate">
                                  {task.project}
                                </span>
                              </span>
                              <span className={`${prio.color} shrink-0`}>
                                {prio.label}
                              </span>
                            </div>

                            <div
                              className={`text-xs font-semibold leading-snug ${
                                task.status === 'completed'
                                  ? 'line-through text-slate-400 dark:text-slate-500'
                                  : 'text-slate-900 dark:text-white'
                              }`}
                            >
                              {task.title}
                            </div>

                            {(task.subtasks.length > 0 || task.dueDate) && (
                              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                                {task.dueDate && (
                                  <span className="font-mono tabular-nums">
                                    Due {task.dueDate}
                                  </span>
                                )}
                                {task.subtasks.length > 0 && task.dueDate && (
                                  <span>·</span>
                                )}
                                {task.subtasks.length > 0 && (
                                  <span className="font-mono tabular-nums">
                                    {completedSubtasks}/{task.subtasks.length}{' '}
                                    steps
                                  </span>
                                )}
                              </div>
                            )}

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
                      })
                    )}
                  </div>
                </div>
              );
            })}

            {/* Trailing + Add Section Column (Unlimited Sections) */}
            {primaryBoard && (
              <div className="w-[290px] shrink-0">
                {addingSectionOpen ? (
                  <form
                    onSubmit={handleAddSection}
                    className="bg-white dark:bg-slate-900 border border-indigo-400 rounded-xl p-3.5 space-y-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-display font-bold text-slate-900 dark:text-white">
                        New Section on {primaryBoard.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAddingSectionOpen(false)}
                        className="text-slate-400 hover:text-slate-700 cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <input
                      type="text"
                      autoFocus
                      required
                      value={newSectionName}
                      onChange={(e) => setNewSectionName(e.target.value)}
                      placeholder="Section name (e.g., Partner Review)"
                      className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                    />
                    <input
                      type="text"
                      value={newSectionDesc}
                      onChange={(e) => setNewSectionDesc(e.target.value)}
                      placeholder="Optional description..."
                      className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        aria-label="New section color"
                        value={newSectionColor}
                        onChange={(e) =>
                          setNewSectionColor(e.target.value as BoardSectionColor)
                        }
                        className="px-2 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200"
                      >
                        {COLOR_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {SECTION_COLOR_META[c].label}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="New section mapped status"
                        value={newSectionStatus}
                        onChange={(e) =>
                          setNewSectionStatus(e.target.value as TaskStatus)
                        }
                        className="px-2 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-200"
                      >
                        <option value="todo">Status: Todo</option>
                        <option value="in_progress">Status: In Progress</option>
                        <option value="blocked">Status: Blocked</option>
                        <option value="completed">Status: Completed</option>
                      </select>
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setAddingSectionOpen(false)}
                        className="px-2.5 py-1.5 text-slate-500 hover:text-slate-800 cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-3 py-1.5 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
                      >
                        Create Section
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingSectionOpen(true)}
                    className="w-full py-4 px-4 border border-dashed border-slate-300 dark:border-slate-700 hover:border-indigo-500 dark:hover:border-indigo-400 bg-slate-50/70 dark:bg-slate-900/40 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-indigo-700 dark:hover:text-indigo-300 flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Add Section</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : viewMode === 'list' ? (
          /* Grouped Section List View */
          <div className="space-y-5">
            {displayedSections.map(({ section, boardId, index, totalInBoard }) => {
              const groupTasks = tasksBySectionId.get(section.id) || [];
              const groupLoggedMins = groupTasks.reduce(
                (acc, t) => acc + (loggedMinutesByTask.get(t.id) || 0),
                0
              );
              const groupEstMins = groupTasks.reduce(
                (acc, t) => acc + t.estimatedMinutes,
                0
              );
              const colorMeta =
                SECTION_COLOR_META[section.color] || SECTION_COLOR_META.indigo;
              const isEditing = editingSectionKey === section.id;
              const targetBoard =
                hierarchy.boards.find((b) => b.id === boardId) || primaryBoard;

              return (
                <div
                  key={section.id}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
                >
                  <div className="px-5 py-3.5 bg-slate-50/70 dark:bg-slate-800/40 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                    {isEditing ? (
                      <div className="flex flex-wrap items-center gap-2 flex-1 text-xs">
                        <input
                          type="text"
                          value={editSecName}
                          onChange={(e) => setEditSecName(e.target.value)}
                          className="px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded font-semibold text-slate-900 dark:text-white"
                        />
                        <input
                          type="text"
                          value={editSecDesc}
                          onChange={(e) => setEditSecDesc(e.target.value)}
                          placeholder="Description..."
                          className="flex-1 min-w-[160px] px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded text-slate-700 dark:text-slate-300"
                        />
                        <select
                          value={editSecColor}
                          onChange={(e) =>
                            setEditSecColor(e.target.value as BoardSectionColor)
                          }
                          className="px-2 py-1 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded"
                        >
                          {COLOR_OPTIONS.map((c) => (
                            <option key={c} value={c}>
                              {SECTION_COLOR_META[c].label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            handleSaveSectionEdit(boardId, section.id)
                          }
                          className="px-2.5 py-1 bg-indigo-600 text-white font-semibold rounded cursor-pointer"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingSectionKey(null)}
                          className="px-2 py-1 text-slate-500 cursor-pointer"
                        >
                          Cancel
                        </button>
                        {totalInBoard > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              handleDeleteSection(boardId, section.id)
                            }
                            className="px-2 py-1 text-rose-600 cursor-pointer"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`w-2.5 h-2.5 rounded-sm shrink-0 ${colorMeta.dot}`}
                          />
                          <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white">
                            {section.name} ({groupTasks.length})
                          </h2>
                          <span className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {section.description}
                          </span>
                          <button
                            type="button"
                            onClick={() => startEditingSection(section)}
                            title="Edit section"
                            className="p-1 text-slate-400 hover:text-indigo-600 rounded cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-400">
                          <span>
                            Logged {formatDuration(groupLoggedMins)} / Est{' '}
                            {formatDuration(groupEstMins)}
                          </span>
                          {index > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                handleReorderSection(boardId, index, -1)
                              }
                              className="font-sans text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                            >
                              Move Up
                            </button>
                          )}
                          {targetBoard && (
                            <button
                              type="button"
                              onClick={() => {
                                setSectionTaskDraftId(section.id);
                                setSectionTaskDraftTitle('');
                              }}
                              aria-label={`Add task to ${section.name}`}
                              className="font-sans inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 rounded-md transition-colors cursor-pointer"
                            >
                              <Plus className="w-3.5 h-3.5" />
                              <span>Add Task</span>
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {sectionTaskDraftId === section.id && targetBoard && (
                    <form
                      onSubmit={(e) =>
                        handleCreateTaskInSection(e, targetBoard, section)
                      }
                      className="px-5 py-3 bg-indigo-50/40 dark:bg-indigo-950/20 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2 text-xs"
                    >
                      <input
                        type="text"
                        autoFocus
                        value={sectionTaskDraftTitle}
                        onChange={(e) =>
                          setSectionTaskDraftTitle(e.target.value)
                        }
                        placeholder={`New task in ${section.name}...`}
                        className="flex-1 min-w-[200px] px-3 py-1.5 bg-white dark:bg-slate-900 border border-indigo-300 dark:border-indigo-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
                      >
                        Add to {section.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => setSectionTaskDraftId(null)}
                        className="px-2.5 py-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </form>
                  )}

                  {groupTasks.length === 0 ? (
                    <div className="px-5 py-5 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between gap-3">
                      <span>No tasks in {section.name.toLowerCase()}.</span>
                      {targetBoard && sectionTaskDraftId !== section.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setSectionTaskDraftId(section.id);
                            setSectionTaskDraftTitle('');
                          }}
                          className="inline-flex items-center gap-1 font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Add task to {section.name}</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                            <th className="py-2.5 px-4 w-10">Done</th>
                            <th className="py-2.5 px-4">
                              Task Deliverable &amp; Metadata
                            </th>
                            <th className="py-2.5 px-4">Priority</th>
                            <th className="py-2.5 px-4">Section</th>
                            <th className="py-2.5 px-4 text-right">
                              Planned Est
                            </th>
                            <th className="py-2.5 px-4 text-right">
                              Actual Logged
                            </th>
                            <th className="py-2.5 px-4 text-right">
                              Timer &amp; Log
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                          {groupTasks.map((task) => {
                            const loggedMins =
                              loggedMinutesByTask.get(task.id) || 0;
                            const isOverEstimate =
                              loggedMins > task.estimatedMinutes;
                            const isThisTaskRunning =
                              isTimerRunning && activeTimerTaskId === task.id;
                            const prio = PRIORITY_TEXT[task.priority];
                            const completedSubtasks = task.subtasks.filter(
                              (s) => s.completed
                            ).length;
                            const taskBoard =
                              resolveBoardForTask(task, hierarchy.boards) ||
                              primaryBoard;

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
                                    const matchingSec = taskBoard?.sections.find(
                                      (s) => s.mappedStatus === nextStatus
                                    );
                                    onUpdateTask(task.id, {
                                      status: nextStatus,
                                      sectionId:
                                        matchingSec?.id || task.sectionId,
                                      completedAt:
                                        nextStatus === 'completed'
                                          ? new Date()
                                              .toISOString()
                                              .slice(0, 10)
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
                                          {task.tags
                                            .map((t) => `#${t}`)
                                            .join(' ')}
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
                                  <span className={prio.color}>
                                    {prio.label}
                                  </span>
                                </td>
                                <td
                                  className="py-3 px-4 whitespace-nowrap"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <select
                                    aria-label="Task board section"
                                    value={section.id}
                                    onChange={(e) => {
                                      const destBoard =
                                        hierarchy.boards.find(
                                          (b) => b.id === boardId
                                        ) || taskBoard;
                                      const destSec = destBoard?.sections.find(
                                        (s) => s.id === e.target.value
                                      );
                                      if (destBoard && destSec) {
                                        handleMoveTaskToSection(
                                          task.id,
                                          destBoard,
                                          destSec
                                        );
                                      }
                                    }}
                                    className="px-2 py-1 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-200"
                                  >
                                    {displayedSections.map((d) => (
                                      <option
                                        key={d.section.id}
                                        value={d.section.id}
                                      >
                                        {d.section.name}
                                      </option>
                                    ))}
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
                                        onClick={() =>
                                          onStartTimerForTask(task.id)
                                        }
                                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 rounded-md cursor-pointer"
                                      >
                                        <Play className="w-3 h-3 fill-current" />
                                        <span>Track</span>
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onOpenQuickLogForTask(task)
                                      }
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

            {primaryBoard && (
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('board');
                    setAddingSectionOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 rounded-lg cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Section on {primaryBoard.name}</span>
                </button>
              </div>
            )}
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
      </div>

      {/* Create / Edit Workspace Object Modal */}
      {objectModal && (
        <WorkspaceObjectModal
          intent={objectModal}
          hierarchy={hierarchy}
          selectedDate={selectedDate}
          onClose={() => setObjectModal(null)}
          onSaveSpace={handleSaveSpace}
          onSaveFolder={handleSaveFolder}
          onSaveBoard={handleSaveBoard}
          onCreateTask={onCreateTask}
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
                    {selectedTaskBoard?.name || selectedTask.project} ·{' '}
                    {CATEGORY_LABELS[selectedTask.category]}
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

              {/* Editable Task Fields (Board, Section, Status, Priority, Estimates, Dates) */}
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Board
                  </label>
                  <select
                    value={selectedTaskBoard?.id || ''}
                    onChange={(e) => {
                      const nextBoard = hierarchy.boards.find(
                        (b) => b.id === e.target.value
                      );
                      if (!nextBoard) return;
                      const firstSec = nextBoard.sections[0];
                      onUpdateTask(selectedTask.id, {
                        boardId: nextBoard.id,
                        project: nextBoard.projectTag || nextBoard.name,
                        sectionId: firstSec?.id,
                        status: firstSec?.mappedStatus || selectedTask.status,
                      });
                    }}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    {hierarchy.boards.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Board Section
                  </label>
                  <select
                    value={selectedTaskSection?.id || ''}
                    onChange={(e) => {
                      if (!selectedTaskBoard) return;
                      const sec = selectedTaskBoard.sections.find(
                        (s) => s.id === e.target.value
                      );
                      if (sec) {
                        handleMoveTaskToSection(
                          selectedTask.id,
                          selectedTaskBoard,
                          sec
                        );
                      }
                    }}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    {(selectedTaskBoard?.sections || []).map((sec) => (
                      <option key={sec.id} value={sec.id}>
                        {sec.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Workflow Status
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
                    {formatDuration(
                      loggedMinutesByTask.get(selectedTask.id) || 0
                    )}
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    value={
                      selectedTask.startDate || selectedTask.createdAt || ''
                    }
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
                    value={
                      selectedTask.dueDate ||
                      selectedTask.startDate ||
                      selectedTask.createdAt ||
                      ''
                    }
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
                    Description &amp; Acceptance Criteria
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
                    Blocker / Escalation Note
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
                  Subtasks (
                  {selectedTask.subtasks.filter((s) => s.completed).length}/
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
