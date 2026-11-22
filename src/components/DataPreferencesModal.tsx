import React, { useRef, useState } from 'react';
import {
  X,
  Download,
  Upload,
  RotateCcw,
  SlidersHorizontal,
  Check,
} from 'lucide-react';
import { WorkspacePreferences } from '../types';

interface DataPreferencesModalProps {
  isOpen: boolean;
  preferences: WorkspacePreferences;
  onUpdatePreferences: (updates: Partial<WorkspacePreferences>) => void;
  onExportJson: () => void;
  onImportJson: (jsonText: string) => boolean;
  onResetToSeed: () => void;
  onClose: () => void;
}

export const DataPreferencesModal: React.FC<DataPreferencesModalProps> = ({
  isOpen,
  preferences,
  onUpdatePreferences,
  onExportJson,
  onImportJson,
  onResetToSeed,
  onClose,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importFeedback, setImportFeedback] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      const ok = onImportJson(content);
      setImportFeedback(
        ok
          ? 'Workspace restored from JSON backup.'
          : 'Invalid backup file format.'
      );
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-xl space-y-6">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="w-5 h-5 text-indigo-600" />
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Presence Sensor Preferences & Local JSON Backup
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

        {/* Presence & Idle Threshold Configuration */}
        <div className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-slate-900 dark:text-white mb-1">
              Automatic Idle Detection Threshold
            </label>
            <p className="text-slate-500 dark:text-slate-400 mb-2">
              How long without mouse or keyboard input before onTrack flags an unattended idle gap and opens the reconciliation prompt:
            </p>
            <select
              value={preferences.idleThresholdSeconds}
              onChange={(e) =>
                onUpdatePreferences({
                  idleThresholdSeconds: Number(e.target.value),
                })
              }
              className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white font-mono tabular-nums"
            >
              <option value={30}>30 seconds (Fast Demo Evaluation Mode)</option>
              <option value={60}>1 minute (Recommended Interactive Default)</option>
              <option value={180}>3 minutes</option>
              <option value={300}>5 minutes (Standard ManicTime Threshold)</option>
              <option value={900}>15 minutes</option>
            </select>
          </div>

          <div className="flex items-center justify-between py-2 border-t border-slate-100 dark:border-slate-800">
            <div>
              <div className="font-semibold text-slate-900 dark:text-white">
                Workspace Appearance
              </div>
              <div className="text-slate-500 dark:text-slate-400">
                Switch between high-contrast light canvas and dark slate mode
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                onUpdatePreferences({ darkMode: !preferences.darkMode })
              }
              className="px-3 py-1.5 font-semibold bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg border border-slate-200 dark:border-slate-700 cursor-pointer"
            >
              {preferences.darkMode ? 'Dark Slate Active' : 'Light Canvas Active'}
            </button>
          </div>
        </div>

        {/* LocalStorage JSON Portability */}
        <div className="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
          <div className="font-semibold text-slate-900 dark:text-white">
            Local Browser Storage & JSON Portability
          </div>
          <p className="text-slate-500 dark:text-slate-400">
            All tasks, ManicTime timeline blocks, presence segments, and generated reports are persisted locally in your browser. Export a full snapshot or restore from a JSON file at any time.
          </p>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={onExportJson}
              className="flex items-center gap-1.5 px-3.5 py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export JSON Backup</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3.5 py-2 font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Restore from JSON</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileChange}
              className="hidden"
            />

            <button
              type="button"
              onClick={() => {
                onResetToSeed();
                setImportFeedback('Reset workspace to sample 7-day dataset.');
              }}
              className="flex items-center gap-1.5 px-3 py-2 font-medium text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-lg cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Sample Data</span>
            </button>
          </div>

          {importFeedback && (
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-medium pt-1">
              <Check className="w-4 h-4" />
              <span>{importFeedback}</span>
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-indigo-600 rounded-lg cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
