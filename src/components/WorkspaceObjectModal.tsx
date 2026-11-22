import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import {
  BoardSection,
  BoardSectionColor,
  Task,
  TaskPriority,
  TaskStatus,
  WorkCategory,
  WorkspaceBoard,
  WorkspaceHierarchy,
} from '../types';
import { CATEGORY_LABELS } from '../data/seedData';
import {
  createAccountingCloseSections,
  createStandardSections,
  SECTION_COLOR_META,
} from '../utils/taskHierarchy';
import { ObjectModalIntent } from './TaskHierarchySidebar';

interface WorkspaceObjectModalProps {
  intent: ObjectModalIntent;
  hierarchy: WorkspaceHierarchy;
  selectedDate: string;
  onClose: () => void;
  onSaveSpace: (params: { id?: string; name: string; color: BoardSectionColor }) => void;
  onSaveFolder: (params: { id?: string; spaceId: string; name: string }) => void;
  onSaveBoard: (params: {
    id?: string;
    spaceId: string;
    folderId: string | null;
    name: string;
    description: string;
    sections: BoardSection[];
  }) => void;
  onCreateTask: (task: Omit<Task, 'id' | 'createdAt'>) => void;
}

const COLOR_OPTIONS: BoardSectionColor[] = [
  'indigo',
  'emerald',
  'amber',
  'rose',
  'sky',
  'slate',
];

export const WorkspaceObjectModal: React.FC<WorkspaceObjectModalProps> = ({
  intent,
  hierarchy,
  selectedDate,
  onClose,
  onSaveSpace,
  onSaveFolder,
  onSaveBoard,
  onCreateTask,
}) => {
  // Space state
  const [spaceName, setSpaceName] = useState(
    intent.kind === 'edit_space' ? intent.space.name : ''
  );
  const [spaceColor, setSpaceColor] = useState<BoardSectionColor>(
    intent.kind === 'edit_space' ? intent.space.color : 'indigo'
  );

  // Folder state
  const [folderName, setFolderName] = useState(
    intent.kind === 'edit_folder' ? intent.folder.name : ''
  );
  const [folderSpaceId, setFolderSpaceId] = useState(
    intent.kind === 'edit_folder'
      ? intent.folder.spaceId
      : intent.kind === 'create_folder' && intent.defaultSpaceId
      ? intent.defaultSpaceId
      : hierarchy.spaces[0]?.id || ''
  );

  // Board state
  const initialBoard: WorkspaceBoard | null =
    intent.kind === 'edit_board' ? intent.board : null;
  const [boardName, setBoardName] = useState(initialBoard?.name || '');
  const [boardDescription, setBoardDescription] = useState(
    initialBoard?.description || ''
  );
  const [boardSpaceId, setBoardSpaceId] = useState(
    initialBoard?.spaceId ||
      (intent.kind === 'create_board' && intent.defaultSpaceId) ||
      hierarchy.spaces[0]?.id ||
      ''
  );
  const [boardFolderId, setBoardFolderId] = useState<string>(
    initialBoard?.folderId ||
      (intent.kind === 'create_board' && intent.defaultFolderId) ||
      ''
  );
  const [boardSections, setBoardSections] = useState<BoardSection[]>(() =>
    initialBoard
      ? initialBoard.sections.map((s) => ({ ...s }))
      : createStandardSections(`b${Date.now()}`)
  );
  const [newSectionDraft, setNewSectionDraft] = useState('');

  // Task state
  const defaultTaskBoardId =
    (intent.kind === 'create_task' && intent.defaultBoardId) ||
    hierarchy.boards[0]?.id ||
    '';
  const [taskBoardId, setTaskBoardId] = useState(defaultTaskBoardId);
  const activeTaskBoard =
    hierarchy.boards.find((b) => b.id === taskBoardId) || hierarchy.boards[0];
  const [taskSectionId, setTaskSectionId] = useState(
    (intent.kind === 'create_task' && intent.defaultSectionId) ||
      activeTaskBoard?.sections[0]?.id ||
      ''
  );
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskPriority, setTaskPriority] = useState<TaskPriority>('high');
  const [taskCategory, setTaskCategory] = useState<WorkCategory>('deep_work');
  const [taskEstimate, setTaskEstimate] = useState(90);
  const [taskDueDate, setTaskDueDate] = useState(selectedDate);
  const [taskTags, setTaskTags] = useState('deliverable');

  const availableFoldersForBoard = hierarchy.folders.filter(
    (f) => f.spaceId === boardSpaceId
  );

  const handleApplyPreset = (preset: 'standard' | 'close' | 'minimal') => {
    const uid = `b${Date.now()}`;
    if (preset === 'standard') {
      setBoardSections(createStandardSections(uid));
    } else if (preset === 'close') {
      setBoardSections(createAccountingCloseSections(uid));
    } else {
      setBoardSections([
        {
          id: `${uid}-sec-1`,
          name: 'To Do',
          description: 'Initial intake column',
          color: 'slate',
          mappedStatus: 'todo',
        },
        {
          id: `${uid}-sec-2`,
          name: 'In Review',
          description: 'Active work and review',
          color: 'indigo',
          mappedStatus: 'in_progress',
        },
        {
          id: `${uid}-sec-3`,
          name: 'Done',
          description: 'Completed items',
          color: 'emerald',
          mappedStatus: 'completed',
        },
      ]);
    }
  };

  const handleAddBoardSectionDraft = () => {
    const clean = newSectionDraft.trim();
    if (!clean) return;
    setBoardSections((prev) => [
      ...prev,
      {
        id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: clean,
        description: 'Custom workflow section',
        color: COLOR_OPTIONS[prev.length % COLOR_OPTIONS.length],
        mappedStatus: 'in_progress',
      },
    ]);
    setNewSectionDraft('');
  };

  const moveSection = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= boardSections.length) return;
    setBoardSections((prev) => {
      const copy = prev.slice();
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (intent.kind === 'create_space' || intent.kind === 'edit_space') {
      if (!spaceName.trim()) return;
      onSaveSpace({
        id: intent.kind === 'edit_space' ? intent.space.id : undefined,
        name: spaceName.trim(),
        color: spaceColor,
      });
      onClose();
      return;
    }

    if (intent.kind === 'create_folder' || intent.kind === 'edit_folder') {
      if (!folderName.trim() || !folderSpaceId) return;
      onSaveFolder({
        id: intent.kind === 'edit_folder' ? intent.folder.id : undefined,
        spaceId: folderSpaceId,
        name: folderName.trim(),
      });
      onClose();
      return;
    }

    if (intent.kind === 'create_board' || intent.kind === 'edit_board') {
      if (!boardName.trim() || !boardSpaceId || boardSections.length === 0) return;
      const validFolder = availableFoldersForBoard.some(
        (f) => f.id === boardFolderId
      )
        ? boardFolderId
        : null;
      onSaveBoard({
        id: initialBoard?.id,
        spaceId: boardSpaceId,
        folderId: validFolder || null,
        name: boardName.trim(),
        description:
          boardDescription.trim() || 'Custom OnTrack operational board',
        sections: boardSections.map((s) => ({
          ...s,
          name: s.name.trim() || 'Untitled Section',
        })),
      });
      onClose();
      return;
    }

    if (intent.kind === 'create_task') {
      if (!taskTitle.trim() || !activeTaskBoard) return;
      const chosenSection =
        activeTaskBoard.sections.find((s) => s.id === taskSectionId) ||
        activeTaskBoard.sections[0];
      const parsedTags = taskTags
        .split(',')
        .map((s) => s.trim().replace(/^#/, ''))
        .filter(Boolean);

      onCreateTask({
        title: taskTitle.trim(),
        description:
          taskDescription.trim() || 'Created from OnTrack workspace.',
        project: activeTaskBoard.projectTag || activeTaskBoard.name,
        boardId: activeTaskBoard.id,
        sectionId: chosenSection?.id,
        status: chosenSection?.mappedStatus || 'todo',
        priority: taskPriority,
        category: taskCategory,
        tags: parsedTags.length > 0 ? parsedTags : ['work'],
        estimatedMinutes: Math.max(15, Number(taskEstimate) || 60),
        subtasks: [],
        startDate: selectedDate || new Date().toISOString().slice(0, 10),
        dueDate: taskDueDate || selectedDate || new Date().toISOString().slice(0, 10),
      });
      onClose();
    }
  };

  const titleByIntent: Record<ObjectModalIntent['kind'], string> = {
    create_space: 'Create Workspace Space',
    edit_space: 'Edit Space',
    create_folder: 'Create Folder',
    edit_folder: 'Edit Folder',
    create_board: 'Create New Board',
    edit_board: 'Edit Board & Sections',
    create_task: 'Create Task Deliverable',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/55 backdrop-blur-xs">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
            {titleByIntent[intent.kind]}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {(intent.kind === 'create_space' || intent.kind === 'edit_space') && (
            <>
              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Space Name
                </label>
                <input
                  type="text"
                  required
                  value={spaceName}
                  onChange={(e) => setSpaceName(e.target.value)}
                  placeholder="e.g., Tax & Advisory Practice"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Space Accent Color
                </label>
                <div className="flex flex-wrap gap-2">
                  {COLOR_OPTIONS.map((c) => {
                    const meta = SECTION_COLOR_META[c];
                    const active = spaceColor === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setSpaceColor(c)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-colors cursor-pointer ${
                          active
                            ? 'border-indigo-500 bg-indigo-50/70 dark:bg-indigo-950/40 text-slate-900 dark:text-white font-semibold'
                            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                        }`}
                      >
                        <span className={`w-2.5 h-2.5 rounded-sm ${meta.dot}`} />
                        <span>{meta.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {(intent.kind === 'create_folder' || intent.kind === 'edit_folder') && (
            <>
              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Parent Space
                </label>
                <select
                  value={folderSpaceId}
                  onChange={(e) => setFolderSpaceId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                >
                  {hierarchy.spaces.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Folder Name
                </label>
                <input
                  type="text"
                  required
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder="e.g., Q4 Year-End Close"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </>
          )}

          {(intent.kind === 'create_board' || intent.kind === 'edit_board') && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Parent Space
                  </label>
                  <select
                    value={boardSpaceId}
                    onChange={(e) => {
                      const nextSpace = e.target.value;
                      setBoardSpaceId(nextSpace);
                      setBoardFolderId('');
                    }}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    {hierarchy.spaces.map((sp) => (
                      <option key={sp.id} value={sp.id}>
                        {sp.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Folder (Optional)
                  </label>
                  <select
                    value={boardFolderId}
                    onChange={(e) => setBoardFolderId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    <option value="">Root of Space</option>
                    {availableFoldersForBoard.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Board Name
                </label>
                <input
                  type="text"
                  required
                  value={boardName}
                  onChange={(e) => setBoardName(e.target.value)}
                  placeholder="e.g., Audit Readiness Sprint"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Board Description
                </label>
                <input
                  type="text"
                  value={boardDescription}
                  onChange={(e) => setBoardDescription(e.target.value)}
                  placeholder="Purpose, deliverables, or client scope for this board"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                />
              </div>

              {/* Board Sections Manager */}
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    Board Sections ({boardSections.length})
                  </span>
                  {intent.kind === 'create_board' && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleApplyPreset('standard')}
                        className="px-2 py-1 text-[11px] bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded cursor-pointer"
                      >
                        Standard (4)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApplyPreset('close')}
                        className="px-2 py-1 text-[11px] bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded cursor-pointer"
                      >
                        Close Pipeline (5)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleApplyPreset('minimal')}
                        className="px-2 py-1 text-[11px] bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded cursor-pointer"
                      >
                        Simple (3)
                      </button>
                    </div>
                  )}
                </div>

                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {boardSections.map((sec, idx) => (
                    <div
                      key={sec.id}
                      className="flex flex-wrap sm:flex-nowrap items-center gap-2 p-2 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg"
                    >
                      <input
                        type="text"
                        value={sec.name}
                        onChange={(e) =>
                          setBoardSections((prev) =>
                            prev.map((item) =>
                              item.id === sec.id
                                ? { ...item, name: e.target.value }
                                : item
                            )
                          )
                        }
                        aria-label={`Section ${idx + 1} name`}
                        className="flex-1 min-w-[120px] px-2.5 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white"
                      />
                      <select
                        value={sec.color}
                        aria-label={`Section ${idx + 1} color`}
                        onChange={(e) =>
                          setBoardSections((prev) =>
                            prev.map((item) =>
                              item.id === sec.id
                                ? {
                                    ...item,
                                    color: e.target.value as BoardSectionColor,
                                  }
                                : item
                            )
                          )
                        }
                        className="px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-200"
                      >
                        {COLOR_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {SECTION_COLOR_META[c].label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={sec.mappedStatus}
                        aria-label={`Section ${idx + 1} status mapping`}
                        onChange={(e) =>
                          setBoardSections((prev) =>
                            prev.map((item) =>
                              item.id === sec.id
                                ? {
                                    ...item,
                                    mappedStatus: e.target.value as TaskStatus,
                                  }
                                : item
                            )
                          )
                        }
                        className="px-2 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-200"
                      >
                        <option value="todo">Status: Todo</option>
                        <option value="in_progress">Status: In Progress</option>
                        <option value="blocked">Status: Blocked</option>
                        <option value="completed">Status: Completed</option>
                      </select>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveSection(idx, -1)}
                          aria-label="Move section up"
                          className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === boardSections.length - 1}
                          onClick={() => moveSection(idx, 1)}
                          aria-label="Move section down"
                          className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 cursor-pointer"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                        {boardSections.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setBoardSections((prev) =>
                                prev.filter((item) => item.id !== sec.id)
                              )
                            }
                            aria-label="Remove section"
                            className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newSectionDraft}
                    onChange={(e) => setNewSectionDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddBoardSectionDraft();
                      }
                    }}
                    placeholder="Add another section name (e.g., Partner Sign-Off)..."
                    className="flex-1 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={handleAddBoardSectionDraft}
                    className="flex items-center gap-1 px-3 py-1.5 font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 rounded-lg cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Section</span>
                  </button>
                </div>
              </div>
            </>
          )}

          {intent.kind === 'create_task' && (
            <>
              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Task Title
                </label>
                <input
                  type="text"
                  required
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder="e.g., Reconcile October AP clearing sub-ledger"
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Target Board
                  </label>
                  <select
                    value={activeTaskBoard?.id || ''}
                    onChange={(e) => {
                      const nextB = hierarchy.boards.find(
                        (b) => b.id === e.target.value
                      );
                      setTaskBoardId(e.target.value);
                      setTaskSectionId(nextB?.sections[0]?.id || '');
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
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Board Section
                  </label>
                  <select
                    value={taskSectionId}
                    onChange={(e) => setTaskSectionId(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    {(activeTaskBoard?.sections || []).map((sec) => (
                      <option key={sec.id} value={sec.id}>
                        {sec.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Priority
                  </label>
                  <select
                    value={taskPriority}
                    onChange={(e) =>
                      setTaskPriority(e.target.value as TaskPriority)
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
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Category
                  </label>
                  <select
                    value={taskCategory}
                    onChange={(e) =>
                      setTaskCategory(e.target.value as WorkCategory)
                    }
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  >
                    {(Object.keys(CATEGORY_LABELS) as WorkCategory[]).map(
                      (cat) => (
                        <option key={cat} value={cat}>
                          {CATEGORY_LABELS[cat]}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Estimate (Minutes)
                  </label>
                  <input
                    type="number"
                    min={15}
                    step={15}
                    value={taskEstimate}
                    onChange={(e) => setTaskEstimate(Number(e.target.value))}
                    className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                    Due Date
                  </label>
                  <input
                    type="date"
                    value={taskDueDate}
                    onChange={(e) => setTaskDueDate(e.target.value)}
                    className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Tags (comma-separated)
                </label>
                <input
                  type="text"
                  value={taskTags}
                  onChange={(e) => setTaskTags(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Description
                </label>
                <textarea
                  rows={2}
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  placeholder="Optional scope or acceptance criteria..."
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                />
              </div>
            </>
          )}

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors cursor-pointer"
            >
              {intent.kind.startsWith('edit_') ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
