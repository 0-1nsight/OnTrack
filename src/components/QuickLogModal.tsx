import React, { useState } from 'react';
import { X, Clock } from 'lucide-react';
import { Task, TimeBlock, WorkCategory } from '../types';
import {
  PROJECTS,
  CATEGORY_LABELS,
  TRACKED_APPS,
  formatMinutesToHHMM,
  parseHHMMToMinutes,
  formatDuration,
} from '../data/seedData';

interface QuickLogModalProps {
  isOpen: boolean;
  selectedDate: string;
  weekDates: string[];
  tasks: Task[];
  initialBlock: TimeBlock | null;
  initialRange: { startTime: number; endTime: number } | null;
  initialTask: Task | null;
  initialAppDoc?: {
    appName: string;
    documentTitle: string;
    startTime: number;
    endTime: number;
    linkedTaskId?: string | null;
  } | null;
  onSaveBlock: (
    blockData: Omit<TimeBlock, 'id'>,
    existingId?: string
  ) => void;
  onClose: () => void;
}

function buildInitialQuickLog(params: {
  selectedDate: string;
  tasks: Task[];
  initialBlock: TimeBlock | null;
  initialRange: { startTime: number; endTime: number } | null;
  initialTask: Task | null;
  initialAppDoc?: QuickLogModalProps['initialAppDoc'];
}) {
  const { selectedDate, tasks, initialBlock, initialRange, initialTask, initialAppDoc } = params;
  if (initialBlock) {
    return {
      taskId: initialBlock.taskId || '',
      title: initialBlock.title,
      project: initialBlock.project,
      category: initialBlock.category,
      date: initialBlock.date,
      startHHMM: formatMinutesToHHMM(initialBlock.startTime),
      endHHMM: formatMinutesToHHMM(initialBlock.endTime),
      tagsText: initialBlock.tags.join(', '),
      isBillable: initialBlock.isBillable,
      notes: initialBlock.notes,
      appName: initialBlock.appName || 'VS Code',
      documentTitle: initialBlock.documentTitle || '',
    };
  }
  if (initialAppDoc) {
    const linked = initialAppDoc.linkedTaskId
      ? tasks.find((t) => t.id === initialAppDoc.linkedTaskId)
      : null;
    return {
      taskId: linked ? linked.id : '',
      title: linked ? linked.title : initialAppDoc.documentTitle,
      project: linked ? linked.project : 'Core Platform',
      category: linked ? linked.category : ('deep_work' as WorkCategory),
      date: selectedDate,
      startHHMM: formatMinutesToHHMM(initialAppDoc.startTime),
      endHHMM: formatMinutesToHHMM(initialAppDoc.endTime),
      tagsText: linked ? linked.tags.join(', ') : 'captured-window',
      isBillable: linked ? linked.category === 'billable' : false,
      notes: `Captured from ${initialAppDoc.appName}: ${initialAppDoc.documentTitle}`,
      appName: initialAppDoc.appName,
      documentTitle: initialAppDoc.documentTitle,
    };
  }
  if (initialTask) {
    return {
      taskId: initialTask.id,
      title: initialTask.title,
      project: initialTask.project,
      category: initialTask.category,
      date: selectedDate,
      startHHMM: '10:00',
      endHHMM: '11:00',
      tagsText: initialTask.tags.join(', '),
      isBillable: initialTask.category === 'billable',
      notes: '',
      appName: 'VS Code',
      documentTitle: '',
    };
  }
  const sMin = initialRange ? initialRange.startTime : 9 * 60;
  const eMin = initialRange ? initialRange.endTime : 10 * 60;
  return {
    taskId: '',
    title: '',
    project: 'Core Platform',
    category: 'deep_work' as WorkCategory,
    date: selectedDate,
    startHHMM: formatMinutesToHHMM(sMin),
    endHHMM: formatMinutesToHHMM(eMin),
    tagsText: 'focus',
    isBillable: false,
    notes: '',
    appName: 'VS Code',
    documentTitle: '',
  };
}

export const QuickLogModal: React.FC<QuickLogModalProps> = ({
  isOpen,
  selectedDate,
  weekDates: _weekDates,
  tasks,
  initialBlock,
  initialRange,
  initialTask,
  initialAppDoc,
  onSaveBlock,
  onClose,
}) => {
  const [init] = useState(() =>
    buildInitialQuickLog({
      selectedDate,
      tasks,
      initialBlock,
      initialRange,
      initialTask,
      initialAppDoc,
    })
  );
  const [taskId, setTaskId] = useState<string>(init.taskId);
  const [title, setTitle] = useState<string>(init.title);
  const [project, setProject] = useState<string>(init.project);
  const [category, setCategory] = useState<WorkCategory>(init.category);
  const [date, setDate] = useState<string>(init.date);
  const [startHHMM, setStartHHMM] = useState<string>(init.startHHMM);
  const [endHHMM, setEndHHMM] = useState<string>(init.endHHMM);
  const [tagsText, setTagsText] = useState<string>(init.tagsText);
  const [isBillable, setIsBillable] = useState<boolean>(init.isBillable);
  const [notes, setNotes] = useState<string>(init.notes);
  const [appName, setAppName] = useState<string>(init.appName);
  const [documentTitle, setDocumentTitle] = useState<string>(init.documentTitle);

  if (!isOpen) return null;

  const startMins = parseHHMMToMinutes(startHHMM);
  const endMins = Math.max(startMins + 5, parseHHMMToMinutes(endHHMM));
  const durationMinutes = endMins - startMins;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle =
      title.trim() ||
      tasks.find((t) => t.id === taskId)?.title ||
      'Focused Work Session';
    const parsedTags = tagsText
      .split(',')
      .map((s) => s.trim().replace(/^#/, ''))
      .filter(Boolean);

    onSaveBlock(
      {
        taskId: taskId || null,
        title: cleanTitle,
        project,
        category,
        tags: parsedTags.length > 0 ? parsedTags : ['work'],
        date,
        startTime: startMins,
        endTime: endMins,
        durationMinutes,
        source: initialBlock ? initialBlock.source : 'manual',
        isBillable,
        notes: notes.trim(),
        appName: appName || undefined,
        documentTitle: documentTitle.trim() || undefined,
      },
      initialBlock?.id
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Clock className="w-5 h-5 text-indigo-600" />
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {initialBlock
                ? 'Edit Timeline Activity Block'
                : 'Log Timeline Activity Block'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 pt-4 text-xs">
          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Bind to Practice Task (Optional)
            </label>
            <select
              value={taskId}
              onChange={(e) => {
                const id = e.target.value;
                setTaskId(id);
                const found = tasks.find((t) => t.id === id);
                if (found) {
                  setTitle(found.title);
                  setProject(found.project);
                  setCategory(found.category);
                  setTagsText(found.tags.join(', '));
                  setIsBillable(found.category === 'billable');
                }
              }}
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
            >
              <option value="">-- Custom / Unlinked Timeline Entry --</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  [{t.project}] {t.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Activity / Session Title
            </label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Implement OAuth2 token rotation"
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Date
              </label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                className="w-full px-2.5 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Start (HH:MM)
              </label>
              <input
                type="time"
                value={startHHMM}
                onChange={(e) => setStartHHMM(e.target.value)}
                className="w-full px-2.5 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                End (HH:MM)
              </label>
              <input
                type="time"
                value={endHHMM}
                onChange={(e) => setEndHHMM(e.target.value)}
                className="w-full px-2.5 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Project
              </label>
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              >
                {PROJECTS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Work Mode Category
              </label>
              <select
                value={category}
                onChange={(e) => {
                  const cat = e.target.value as WorkCategory;
                  setCategory(cat);
                  if (cat === 'billable') setIsBillable(true);
                }}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              >
                {(Object.keys(CATEGORY_LABELS) as WorkCategory[]).map((cat) => (
                  <option key={cat} value={cat}>
                    {CATEGORY_LABELS[cat]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-center">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Activity Tags (comma-separated)
              </label>
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="architecture, sprint-4"
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              />
            </div>

            <div className="pt-5">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isBillable}
                  onChange={(e) => setIsBillable(e.target.checked)}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  Mark as Billable Client Time
                </span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Application Used
              </label>
              <select
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              >
                {TRACKED_APPS.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Document / Window Title
              </label>
              <input
                type="text"
                value={documentTitle}
                onChange={(e) => setDocumentTitle(e.target.value)}
                placeholder="e.g., src/engine/intervalTree.ts"
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
              Session Notes / Accomplishments
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional summary of what was accomplished in this block..."
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
            />
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <span className="font-mono tabular-nums text-slate-600 dark:text-slate-400">
              Calculated Duration:{' '}
              <strong className="text-slate-900 dark:text-white">
                {formatDuration(durationMinutes)}
              </strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
              >
                {initialBlock ? 'Update Block' : 'Log to Timeline'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
