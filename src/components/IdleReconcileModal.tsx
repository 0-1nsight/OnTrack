import React, { useState } from 'react';
import { Clock, Scissors, CheckCircle2, Users, X } from 'lucide-react';
import { IdleAlertState, WorkCategory } from '../types';
import {
  PROJECTS,
  formatMinutesToHHMM,
  formatDuration,
} from '../utils/workspaceConstants';

interface IdleReconcileModalProps {
  idleAlert: IdleAlertState;
  onDiscardIdle: () => void;
  onKeepAsActive: () => void;
  onReassignIdle: (payload: {
    title: string;
    project: string;
    category: WorkCategory;
    notes: string;
  }) => void;
  onClose: () => void;
}

export const IdleReconcileModal: React.FC<IdleReconcileModalProps> = ({
  idleAlert,
  onDiscardIdle,
  onKeepAsActive,
  onReassignIdle,
  onClose,
}) => {
  const [reassignTitle, setReassignTitle] = useState(
    'Ad-hoc Stakeholder Sync / Offline Discussion'
  );
  const [reassignProject, setReassignProject] = useState<string>('Internal Ops');
  const [reassignCategory, setReassignCategory] =
    useState<WorkCategory>('collaborative');
  const [reassignNotes, setReassignNotes] = useState(
    'Reconciled away interval detected by OnTrack presence sensor.'
  );
  const [showReassignForm, setShowReassignForm] = useState(false);

  if (!idleAlert.isOpen) return null;

  const durationMinutes = Math.max(
    1,
    Math.round(idleAlert.idleDurationSeconds / 60)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
              <Clock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                Unattended / Idle Activity Detected
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                OnTrack workstation presence monitor flagged an away interval
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary of Idle Window */}
        <div className="my-4 p-4 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Detected Window</span>
            <span className="font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
              {formatMinutesToHHMM(idleAlert.startMinuteOfDay)} –{' '}
              {formatMinutesToHHMM(idleAlert.endMinuteOfDay)} (
              {formatDuration(durationMinutes)})
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mt-2">
            <span>Running Context</span>
            <span className="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[260px]">
              {idleAlert.activeTaskTitle || 'Unassigned Workstation Session'}
            </span>
          </div>
        </div>

        {!showReassignForm ? (
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={onDiscardIdle}
              className="w-full flex items-center justify-between p-3.5 text-left rounded-lg border border-slate-200 dark:border-slate-700 hover:border-rose-400 dark:hover:border-rose-500/60 hover:bg-rose-50/40 dark:hover:bg-rose-950/20 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <Scissors className="w-4 h-4 text-rose-600 shrink-0" />
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    Trim Idle Time & Mark as Away
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Deduct {formatDuration(durationMinutes)} from active timer and record an Away gap on Track 1
                  </div>
                </div>
              </div>
              <span className="text-xs font-mono font-semibold text-rose-600 whitespace-nowrap">
                -{formatDuration(durationMinutes)}
              </span>
            </button>

            <button
              type="button"
              onClick={onKeepAsActive}
              className="w-full flex items-center justify-between p-3.5 text-left rounded-lg border border-slate-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-500/60 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    Keep as Active Work on Current Task
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    I was reading specs, reviewing diagrams, or thinking at my desk
                  </div>
                </div>
              </div>
              <span className="text-xs font-mono font-semibold text-emerald-600 whitespace-nowrap">
                +{formatDuration(durationMinutes)}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setShowReassignForm(true)}
              className="w-full flex items-center justify-between p-3.5 text-left rounded-lg border border-slate-200 dark:border-slate-700 hover:border-indigo-400 dark:hover:border-indigo-500/60 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-3">
                <Users className="w-4 h-4 text-indigo-600 shrink-0" />
                <div>
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    Reassign Interval to Offline Meeting / Another Activity
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Convert this away block into a tagged timeline entry
                  </div>
                </div>
              </div>
              <span className="text-xs font-semibold text-indigo-600 whitespace-nowrap">
                Configure →
              </span>
            </button>
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Activity / Meeting Title
              </label>
              <input
                type="text"
                value={reassignTitle}
                onChange={(e) => setReassignTitle(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Project
                </label>
                <select
                  value={reassignProject}
                  onChange={(e) => setReassignProject(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                >
                  {PROJECTS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Work Mode
                </label>
                <select
                  value={reassignCategory}
                  onChange={(e) =>
                    setReassignCategory(e.target.value as WorkCategory)
                  }
                  className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
                >
                  <option value="collaborative">Collaborative</option>
                  <option value="deep_work">Deep Work</option>
                  <option value="billable">Billable Delivery</option>
                  <option value="admin">Admin & Ops</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Reconciliation Notes
              </label>
              <input
                type="text"
                value={reassignNotes}
                onChange={(e) => setReassignNotes(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowReassignForm(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 cursor-pointer"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() =>
                  onReassignIdle({
                    title: reassignTitle.trim() || 'Offline Meeting',
                    project: reassignProject,
                    category: reassignCategory,
                    notes: reassignNotes,
                  })
                }
                className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
              >
                Save Reconciled Block
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
