import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  LayoutGrid,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  BoardSectionColor,
  Task,
  WorkspaceBoard,
  WorkspaceFolder,
  WorkspaceHierarchy,
  WorkspaceSpace,
} from '../types';
import {
  resolveBoardForTask,
  SECTION_COLOR_META,
} from '../utils/taskHierarchy';

export type SidebarSelection =
  | { kind: 'all' }
  | { kind: 'space'; spaceId: string }
  | { kind: 'folder'; folderId: string; spaceId: string }
  | { kind: 'board'; boardId: string };

export type ObjectModalIntent =
  | { kind: 'create_space' }
  | { kind: 'edit_space'; space: WorkspaceSpace }
  | { kind: 'create_folder'; defaultSpaceId?: string }
  | { kind: 'edit_folder'; folder: WorkspaceFolder }
  | { kind: 'create_board'; defaultSpaceId?: string; defaultFolderId?: string | null }
  | { kind: 'edit_board'; board: WorkspaceBoard }
  | { kind: 'create_task'; defaultBoardId?: string; defaultSectionId?: string };

interface TaskHierarchySidebarProps {
  hierarchy: WorkspaceHierarchy;
  tasks: Task[];
  selection: SidebarSelection;
  onSelect: (next: SidebarSelection) => void;
  onToggleSpaceCollapse: (spaceId: string) => void;
  onToggleFolderCollapse: (folderId: string) => void;
  onOpenObjectModal: (intent: ObjectModalIntent) => void;
  onDeleteSpace: (spaceId: string) => void;
  onDeleteFolder: (folderId: string) => void;
  onDeleteBoard: (boardId: string) => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
}

export const TaskHierarchySidebar: React.FC<TaskHierarchySidebarProps> = ({
  hierarchy,
  tasks,
  selection,
  onSelect,
  onToggleSpaceCollapse,
  onToggleFolderCollapse,
  onOpenObjectModal,
  onDeleteSpace,
  onDeleteFolder,
  onDeleteBoard,
  isOpenMobile,
  onCloseMobile,
}) => {
  const [objectSearch, setObjectSearch] = useState('');
  const [createMenuOpen, setCreateMenuOpen] = useState(false);

  const taskCountByBoard = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      const b = resolveBoardForTask(t, hierarchy.boards);
      if (b) {
        counts.set(b.id, (counts.get(b.id) || 0) + 1);
      }
    }
    return counts;
  }, [tasks, hierarchy.boards]);

  const query = objectSearch.trim().toLowerCase();

  const filteredSpaces = useMemo(() => {
    if (!query) return hierarchy.spaces;
    return hierarchy.spaces.filter((sp) => {
      if (sp.name.toLowerCase().includes(query)) return true;
      const spaceFolders = hierarchy.folders.filter((f) => f.spaceId === sp.id);
      if (spaceFolders.some((f) => f.name.toLowerCase().includes(query))) return true;
      const spaceBoards = hierarchy.boards.filter((b) => b.spaceId === sp.id);
      return spaceBoards.some((b) => b.name.toLowerCase().includes(query));
    });
  }, [hierarchy, query]);

  const renderBoardRow = (board: WorkspaceBoard, nestedInFolder: boolean) => {
    const isSelected = selection.kind === 'board' && selection.boardId === board.id;
    const count = taskCountByBoard.get(board.id) || 0;

    return (
      <div
        key={board.id}
        className={`group flex items-center justify-between gap-1.5 rounded-lg pr-1.5 transition-colors ${
          nestedInFolder ? 'pl-8' : 'pl-5'
        } ${
          isSelected
            ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-200 font-semibold'
            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
        }`}
      >
        <button
          type="button"
          onClick={() => {
            onSelect({ kind: 'board', boardId: board.id });
            onCloseMobile();
          }}
          className="flex-1 min-w-0 flex items-center gap-2 py-1.5 text-left text-xs cursor-pointer"
        >
          <Columns3
            className={`w-3.5 h-3.5 shrink-0 ${
              isSelected
                ? 'text-indigo-600 dark:text-indigo-400'
                : 'text-slate-400 dark:text-slate-500'
            }`}
          />
          <span className="truncate">{board.name}</span>
        </button>

        <div className="flex items-center gap-0.5 shrink-0">
          <div className="hidden group-hover:flex items-center gap-0.5">
            <button
              type="button"
              title="Edit board"
              aria-label={`Edit ${board.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenObjectModal({ kind: 'edit_board', board });
              }}
              className="p-1 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 rounded cursor-pointer"
            >
              <Pencil className="w-3 h-3" />
            </button>
            {hierarchy.boards.length > 1 && (
              <button
                type="button"
                title="Delete board"
                aria-label={`Delete ${board.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteBoard(board.id);
                }}
                className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
          <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-slate-400 px-1">
            {count}
          </span>
        </div>
      </div>
    );
  };

  const renderSidebarBody = () => (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      {/* Sidebar Top Header */}
      <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span className="font-display text-sm font-bold text-slate-900 dark:text-white truncate">
              Spaces &amp; Boards
            </span>
          </div>

          <div className="flex items-center gap-1 shrink-0 relative">
            <button
              type="button"
              onClick={() => setCreateMenuOpen((prev) => !prev)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create</span>
            </button>

            {isOpenMobile && (
              <button
                type="button"
                onClick={onCloseMobile}
                aria-label="Close workspace sidebar"
                className="lg:hidden p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}

            {createMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg py-1.5 z-30">
                <button
                  type="button"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onOpenObjectModal({
                      kind: 'create_board',
                      defaultSpaceId:
                        selection.kind === 'space'
                          ? selection.spaceId
                          : selection.kind === 'folder'
                          ? selection.spaceId
                          : undefined,
                      defaultFolderId:
                        selection.kind === 'folder' ? selection.folderId : null,
                    });
                  }}
                  className="w-full px-3 py-2 text-left text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                >
                  <Columns3 className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>New Board</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onOpenObjectModal({ kind: 'create_space' });
                  }}
                  className="w-full px-3 py-2 text-left text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>New Space</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onOpenObjectModal({
                      kind: 'create_folder',
                      defaultSpaceId:
                        selection.kind === 'space'
                          ? selection.spaceId
                          : selection.kind === 'folder'
                          ? selection.spaceId
                          : hierarchy.spaces[0]?.id,
                    });
                  }}
                  className="w-full px-3 py-2 text-left text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2 cursor-pointer"
                >
                  <FolderPlus className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  <span>New Folder</span>
                </button>
                <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
                <button
                  type="button"
                  onClick={() => {
                    setCreateMenuOpen(false);
                    onOpenObjectModal({
                      kind: 'create_task',
                      defaultBoardId:
                        selection.kind === 'board'
                          ? selection.boardId
                          : hierarchy.boards[0]?.id,
                    });
                  }}
                  className="w-full px-3 py-2 text-left text-xs font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50/70 dark:hover:bg-indigo-950/50 flex items-center gap-2 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Task Deliverable</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Search Objects */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={objectSearch}
            onChange={(e) => setObjectSearch(e.target.value)}
            placeholder="Find space, folder, board..."
            className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Hierarchy Navigation Tree */}
      <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
        {/* All Workspaces Overview */}
        <button
          type="button"
          onClick={() => {
            onSelect({ kind: 'all' });
            onCloseMobile();
          }}
          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs transition-colors cursor-pointer ${
            selection.kind === 'all'
              ? 'bg-slate-900 dark:bg-indigo-600 text-white font-semibold'
              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
          }`}
        >
          <span className="flex items-center gap-2 truncate">
            <LayoutGrid className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">All Workspaces</span>
          </span>
          <span
            className={`font-mono tabular-nums text-[11px] ${
              selection.kind === 'all' ? 'text-slate-200' : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            {tasks.length}
          </span>
        </button>

        <div className="pt-1 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
          {filteredSpaces.length === 0 ? (
            <div className="px-2.5 py-4 text-xs text-slate-500 dark:text-slate-400">
              No matching spaces or boards.
            </div>
          ) : (
            filteredSpaces.map((space) => {
              const colorMeta =
                SECTION_COLOR_META[space.color as BoardSectionColor] ||
                SECTION_COLOR_META.indigo;
              const spaceFolders = hierarchy.folders.filter(
                (f) =>
                  f.spaceId === space.id &&
                  (!query ||
                    f.name.toLowerCase().includes(query) ||
                    hierarchy.boards.some(
                      (b) => b.folderId === f.id && b.name.toLowerCase().includes(query)
                    ) ||
                    space.name.toLowerCase().includes(query))
              );
              const rootBoards = hierarchy.boards.filter(
                (b) =>
                  b.spaceId === space.id &&
                  !b.folderId &&
                  (!query ||
                    b.name.toLowerCase().includes(query) ||
                    space.name.toLowerCase().includes(query))
              );
              const isSpaceSelected =
                selection.kind === 'space' && selection.spaceId === space.id;
              const isExpanded = query ? true : !space.collapsed;

              return (
                <div key={space.id} className="space-y-0.5">
                  {/* Space Row */}
                  <div
                    className={`group flex items-center justify-between gap-1 rounded-lg px-1.5 py-1 transition-colors ${
                      isSpaceSelected
                        ? 'bg-indigo-50/80 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-200'
                        : 'text-slate-800 dark:text-slate-200 hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-1 min-w-0 flex-1">
                      <button
                        type="button"
                        aria-label={isExpanded ? `Collapse ${space.name}` : `Expand ${space.name}`}
                        onClick={() => onToggleSpaceCollapse(space.id)}
                        className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded cursor-pointer shrink-0"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect({ kind: 'space', spaceId: space.id });
                          onCloseMobile();
                        }}
                        className="flex items-center gap-2 min-w-0 flex-1 text-left py-0.5 text-xs font-semibold cursor-pointer"
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-sm shrink-0 ${colorMeta.dot}`}
                        />
                        <span className="truncate">{space.name}</span>
                      </button>
                    </div>

                    <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        title="Add board to space"
                        aria-label={`Add board to ${space.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenObjectModal({
                            kind: 'create_board',
                            defaultSpaceId: space.id,
                            defaultFolderId: null,
                          });
                        }}
                        className="p-1 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 rounded cursor-pointer"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title="Add folder to space"
                        aria-label={`Add folder to ${space.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenObjectModal({
                            kind: 'create_folder',
                            defaultSpaceId: space.id,
                          });
                        }}
                        className="p-1 text-slate-400 hover:text-amber-600 dark:hover:text-amber-300 rounded cursor-pointer"
                      >
                        <FolderPlus className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        title="Edit space"
                        aria-label={`Edit ${space.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenObjectModal({ kind: 'edit_space', space });
                        }}
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded cursor-pointer"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      {hierarchy.spaces.length > 1 && (
                        <button
                          type="button"
                          title="Delete space"
                          aria-label={`Delete ${space.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteSpace(space.id);
                          }}
                          className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded cursor-pointer"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded Space Contents */}
                  {isExpanded && (
                    <div className="space-y-0.5">
                      {spaceFolders.map((folder) => {
                        const folderBoards = hierarchy.boards.filter(
                          (b) =>
                            b.folderId === folder.id &&
                            (!query ||
                              b.name.toLowerCase().includes(query) ||
                              folder.name.toLowerCase().includes(query) ||
                              space.name.toLowerCase().includes(query))
                        );
                        const isFolderSelected =
                          selection.kind === 'folder' &&
                          selection.folderId === folder.id;
                        const isFolderOpen = query ? true : !folder.collapsed;

                        return (
                          <div key={folder.id} className="space-y-0.5">
                            <div
                              className={`group flex items-center justify-between gap-1 rounded-lg pl-4 pr-1.5 py-1 transition-colors ${
                                isFolderSelected
                                  ? 'bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-200 font-medium'
                                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100/80 dark:hover:bg-slate-800/60'
                              }`}
                            >
                              <div className="flex items-center gap-1 min-w-0 flex-1">
                                <button
                                  type="button"
                                  aria-label={
                                    isFolderOpen
                                      ? `Collapse ${folder.name}`
                                      : `Expand ${folder.name}`
                                  }
                                  onClick={() => onToggleFolderCollapse(folder.id)}
                                  className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded cursor-pointer shrink-0"
                                >
                                  {isFolderOpen ? (
                                    <ChevronDown className="w-3 h-3" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSelect({
                                      kind: 'folder',
                                      folderId: folder.id,
                                      spaceId: space.id,
                                    });
                                    onCloseMobile();
                                  }}
                                  className="flex items-center gap-1.5 min-w-0 flex-1 text-left py-0.5 text-xs cursor-pointer"
                                >
                                  {isFolderOpen ? (
                                    <FolderOpen className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                                  ) : (
                                    <Folder className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                                  )}
                                  <span className="truncate">{folder.name}</span>
                                </button>
                              </div>

                              <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                                <button
                                  type="button"
                                  title="New board inside folder"
                                  aria-label={`New board in ${folder.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenObjectModal({
                                      kind: 'create_board',
                                      defaultSpaceId: space.id,
                                      defaultFolderId: folder.id,
                                    });
                                  }}
                                  className="p-1 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-300 rounded cursor-pointer"
                                >
                                  <Plus className="w-3 h-3" />
                                </button>
                                <button
                                  type="button"
                                  title="Edit folder"
                                  aria-label={`Edit ${folder.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenObjectModal({
                                      kind: 'edit_folder',
                                      folder,
                                    });
                                  }}
                                  className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded cursor-pointer"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                                <button
                                  type="button"
                                  title="Delete folder"
                                  aria-label={`Delete ${folder.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteFolder(folder.id);
                                  }}
                                  className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>

                            {isFolderOpen &&
                              folderBoards.map((board) => renderBoardRow(board, true))}
                          </div>
                        );
                      })}

                      {rootBoards.map((board) => renderBoardRow(board, false))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Bottom Quick-Action Footer */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() =>
            onOpenObjectModal({
              kind: 'create_board',
              defaultSpaceId:
                selection.kind === 'space'
                  ? selection.spaceId
                  : selection.kind === 'folder'
                  ? selection.spaceId
                  : hierarchy.spaces[0]?.id,
              defaultFolderId:
                selection.kind === 'folder' ? selection.folderId : null,
            })
          }
          className="flex items-center justify-center gap-1.5 px-2.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-400 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
        >
          <Columns3 className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
          <span>New Board</span>
        </button>
        <button
          type="button"
          onClick={() =>
            onOpenObjectModal({
              kind: 'create_task',
              defaultBoardId:
                selection.kind === 'board'
                  ? selection.boardId
                  : hierarchy.boards[0]?.id,
            })
          }
          className="flex items-center justify-center gap-1.5 px-2.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-indigo-400 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
          <span>New Task</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Docked Sidebar */}
      <aside className="hidden lg:block w-72 shrink-0 sticky top-4 max-h-[calc(100vh-140px)]">
        {renderSidebarBody()}
      </aside>

      {/* Mobile Slide-Over Drawer */}
      {isOpenMobile && (
        <div className="lg:hidden fixed inset-0 z-50 flex bg-slate-950/50 backdrop-blur-xs">
          <div className="w-80 max-w-[85vw] h-full p-3">{renderSidebarBody()}</div>
          <div className="flex-1" onClick={onCloseMobile} />
        </div>
      )}
    </>
  );
};
