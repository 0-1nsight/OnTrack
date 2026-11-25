import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  EyeOff,
  FileSearch,
  KeyRound,
  Monitor,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { DeviceFreshnessRecord } from '../engine/types';
import {
  AgentCaptureHealth,
  AgentRecordedEvent,
  AgentScheduleWindow,
  AgentTrackingControls,
  applyAgentControl,
  fetchAgentCaptureHealth,
  fetchAgentControls,
  fetchAgentRecentEvents,
  getSavedBridgeConfig,
  LocalAgentHealth,
  probeLocalDesktopAgentBridge,
  saveBridgeConfig,
} from '../services/engineClient';

interface WorkstationCapturePanelProps {
  workstationDevices: DeviceFreshnessRecord[];
  syncStatus?: 'idle' | 'syncing' | 'error';
  onNotify?: (message: string) => void;
  onOpenInstallers?: () => void;
}

type ActiveDrawer = null | 'health' | 'recorded' | 'schedule' | 'pair';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatShortTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytesKb(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 KB';
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const WorkstationCapturePanel: React.FC<WorkstationCapturePanelProps> = ({
  workstationDevices,
  syncStatus = 'idle',
  onNotify,
  onOpenInstallers,
}) => {
  const [bridgeHealth, setBridgeHealth] = useState<LocalAgentHealth>({ online: false });
  const [controls, setControls] = useState<AgentTrackingControls | null>(null);
  const [captureHealth, setCaptureHealth] = useState<AgentCaptureHealth | null>(null);
  const [recentEvents, setRecentEvents] = useState<AgentRecordedEvent[]>([]);
  const [recentSearch, setRecentSearch] = useState('');
  const [loadingRecent, setLoadingRecent] = useState(false);

  const [savedConfig, setSavedConfig] = useState(() => getSavedBridgeConfig());
  const [pairUrlInput, setPairUrlInput] = useState(() => getSavedBridgeConfig().bridgeUrl);
  const [pairSecretInput, setPairSecretInput] = useState(() => getSavedBridgeConfig().bridgeSecret);
  const [bridgeAuthState, setBridgeAuthState] = useState<
    'unknown' | 'paired' | 'missing_secret' | 'unauthorized'
  >(() => (getSavedBridgeConfig().bridgeSecret ? 'unknown' : 'missing_secret'));

  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);
  const [pauseMenuOpen, setPauseMenuOpen] = useState(false);
  const [customPauseMinutes, setCustomPauseMinutes] = useState('25');
  const [applyingControl, setApplyingControl] = useState(false);

  const [scheduleDays, setScheduleDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [scheduleStart, setScheduleStart] = useState('08:00');
  const [scheduleEnd, setScheduleEnd] = useState('18:00');

  const refreshLocalBridge = useCallback(async () => {
    await Promise.resolve();
    const cfg = getSavedBridgeConfig();
    setSavedConfig(cfg);
    const health = await probeLocalDesktopAgentBridge(cfg.bridgeUrl);
    setBridgeHealth(health);

    if (!cfg.bridgeSecret) {
      setBridgeAuthState('missing_secret');
      setControls(null);
      setCaptureHealth(null);
      return;
    }

    const [ctrlRes, capRes] = await Promise.all([
      fetchAgentControls(cfg.bridgeSecret, cfg.bridgeUrl),
      fetchAgentCaptureHealth(cfg.bridgeSecret, cfg.bridgeUrl),
    ]);

    if (ctrlRes.unauthorized || capRes.unauthorized) {
      setBridgeAuthState('unauthorized');
      setControls(null);
      setCaptureHealth(null);
      return;
    }

    if (ctrlRes.ok && ctrlRes.controls) {
      setBridgeAuthState('paired');
      setControls(ctrlRes.controls);
      if (ctrlRes.controls.schedule && ctrlRes.controls.schedule.length > 0) {
        setScheduleDays(ctrlRes.controls.schedule[0].days);
        setScheduleStart(ctrlRes.controls.schedule[0].start);
        setScheduleEnd(ctrlRes.controls.schedule[0].end);
      }
    } else if (ctrlRes.missingSecret) {
      setBridgeAuthState('missing_secret');
    }

    if (capRes.ok && capRes.health) {
      setCaptureHealth(capRes.health);
    }
  }, []);

  useEffect(() => {
    const initTimer = window.setTimeout(() => {
      void refreshLocalBridge();
    }, 0);
    const timer = window.setInterval(() => {
      void refreshLocalBridge();
    }, 8000);
    return () => {
      window.clearTimeout(initTimer);
      window.clearInterval(timer);
    };
  }, [refreshLocalBridge]);

  const loadRecentEvents = useCallback(async () => {
    const cfg = getSavedBridgeConfig();
    if (!cfg.bridgeSecret) return;
    await Promise.resolve();
    setLoadingRecent(true);
    try {
      const res = await fetchAgentRecentEvents(100, cfg.bridgeSecret, cfg.bridgeUrl);
      if (res.unauthorized) {
        setBridgeAuthState('unauthorized');
      } else if (res.ok) {
        setBridgeAuthState('paired');
        setRecentEvents(res.events);
      }
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    if (activeDrawer !== 'recorded') return;
    const t = window.setTimeout(() => {
      void loadRecentEvents();
    }, 0);
    return () => window.clearTimeout(t);
  }, [activeDrawer, loadRecentEvents]);

  const handleControlAction = async (
    payload:
      | { action: 'pause'; minutes: number }
      | { action: 'offTheRecord'; enabled: boolean }
      | { action: 'resume' }
      | { action: 'setSchedule'; schedule: AgentScheduleWindow[] },
    toastText: string
  ) => {
    const cfg = getSavedBridgeConfig();
    if (!cfg.bridgeSecret) {
      setActiveDrawer('pair');
      onNotify?.('Enter your workstation bridge secret to manage background capture.');
      return;
    }
    setApplyingControl(true);
    setPauseMenuOpen(false);
    try {
      const res = await applyAgentControl(payload, cfg.bridgeSecret, cfg.bridgeUrl);
      if (res.unauthorized) {
        setBridgeAuthState('unauthorized');
        setActiveDrawer('pair');
      }
      if (!res.ok) {
        onNotify?.(res.error || 'Unable to apply capture control.');
        return;
      }
      if (res.controls) {
        setControls(res.controls);
      }
      await refreshLocalBridge();
      onNotify?.(toastText);
    } finally {
      setApplyingControl(false);
    }
  };

  const handleSavePairing = async (e: React.FormEvent) => {
    e.preventDefault();
    const saved = saveBridgeConfig({
      bridgeUrl: pairUrlInput,
      bridgeSecret: pairSecretInput,
    });
    setSavedConfig(saved);
    setPairUrlInput(saved.bridgeUrl);
    await refreshLocalBridge();
    const check = await fetchAgentControls(saved.bridgeSecret, saved.bridgeUrl);
    if (check.ok) {
      onNotify?.('Workstation agent bridge paired and controls synced.');
      setActiveDrawer(null);
    } else if (check.unauthorized) {
      onNotify?.('Bridge rejected secret (HTTP 401). Check agent.config.json.');
    } else if (!saved.bridgeSecret) {
      onNotify?.('Cleared saved bridge secret.');
    } else {
      onNotify?.('Saved pairing settings. Local Desktop Agent appears offline.');
    }
  };

  const primaryDevice =
    workstationDevices.find((d) => d.status === 'live') || workstationDevices[0] || null;

  const isLocalBridgeOnline = bridgeHealth.online;
  const isControlPaired = isLocalBridgeOnline && bridgeAuthState === 'paired';
  const isBlocked = Boolean(controls && !controls.allowedNow);
  const isServerLive = primaryDevice?.status === 'live';
  const isServerDelayed = primaryDevice?.status === 'delayed';

  const statusTone = useMemo(() => {
    if (controls?.offTheRecord) {
      return {
        label: 'Off the Record · Capture Stopped',
        cls: 'text-rose-700 dark:text-rose-400',
        Icon: EyeOff,
      };
    }
    if (controls?.blockedReason === 'paused') {
      const until = formatShortTime(controls.resumesAtMs);
      return {
        label: until ? `Capture Paused · Until ${until}` : 'Capture Paused',
        cls: 'text-amber-700 dark:text-amber-400',
        Icon: Pause,
      };
    }
    if (controls?.blockedReason === 'outside_schedule') {
      const until = formatShortTime(controls.resumesAtMs);
      return {
        label: until ? `Outside Work Schedule · Resumes ${until}` : 'Outside Work Schedule',
        cls: 'text-amber-700 dark:text-amber-400',
        Icon: CalendarClock,
      };
    }
    if (isLocalBridgeOnline || isServerLive) {
      return {
        label: 'Background Capture Active · Recording',
        cls: 'text-emerald-700 dark:text-emerald-400',
        Icon: Radio,
      };
    }
    if (isServerDelayed) {
      return {
        label: 'Workstation Agent Delayed',
        cls: 'text-amber-700 dark:text-amber-400',
        Icon: ShieldAlert,
      };
    }
    return {
      label: 'Waiting for Workstation Agent',
      cls: 'text-slate-600 dark:text-slate-400',
      Icon: Monitor,
    };
  }, [controls, isLocalBridgeOnline, isServerLive, isServerDelayed]);

  const localStore = captureHealth?.localStore || bridgeHealth.localStore;
  const filteredRecentEvents = useMemo(() => {
    const q = recentSearch.trim().toLowerCase();
    if (!q) return recentEvents;
    return recentEvents.filter((ev) => {
      const app = String(ev.payload?.app || '').toLowerCase();
      const title = String(ev.payload?.window_title || '').toLowerCase();
      const domain = String(ev.payload?.domain || ev.payload?.url || '').toLowerCase();
      const type = ev.type.toLowerCase();
      return app.includes(q) || title.includes(q) || domain.includes(q) || type.includes(q);
    });
  }, [recentEvents, recentSearch]);

  const StatusIcon = statusTone.Icon;

  return (
    <>
      <div
        data-testid="workstation-capture-strip"
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs"
      >
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <div className={`flex items-center gap-1.5 font-semibold shrink-0 ${statusTone.cls}`}>
            <StatusIcon className="w-3.5 h-3.5" />
            <span>{statusTone.label}</span>
          </div>

          <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300 truncate tabular-nums">
            {bridgeHealth.deviceId || primaryDevice?.deviceId || 'Web Session'}
            {' · '}
            {bridgeHealth.latestSample?.osPlatform || primaryDevice?.osPlatform || 'browser'}
            {' · '}
            {bridgeHealth.extensionConnected || primaryDevice?.extensionConnected
              ? 'Extension Connected'
              : isLocalBridgeOnline
                ? 'Desktop Collector Active'
                : 'No Local Agent Detected'}
            {localStore && (
              <>
                {' · '}
                {localStore.pendingCount === 0
                  ? `SQLite Synced (${formatBytesKb(localStore.dbBytes)})`
                  : `${localStore.pendingCount} Queued in SQLite (${formatBytesKb(localStore.dbBytes)})`}
              </>
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Always-On Capture Controls */}
          {isControlPaired ? (
            isBlocked ? (
              <button
                type="button"
                disabled={applyingControl}
                onClick={() => void handleControlAction({ action: 'resume' }, 'Workstation capture resumed.')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-md whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Resume Recording</span>
              </button>
            ) : (
              <>
                <div className="relative">
                  <button
                    type="button"
                    disabled={applyingControl}
                    onClick={() => setPauseMenuOpen((prev) => !prev)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    <span>Pause</span>
                  </button>
                  {pauseMenuOpen && (
                    <div className="absolute right-0 mt-1.5 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg p-2 z-30 space-y-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          void handleControlAction(
                            { action: 'pause', minutes: 15 },
                            'Capture paused for 15 minutes.'
                          )
                        }
                        className="w-full text-left px-2.5 py-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 font-medium cursor-pointer"
                      >
                        Pause for 15 minutes
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void handleControlAction(
                            { action: 'pause', minutes: 60 },
                            'Capture paused for 1 hour.'
                          )
                        }
                        className="w-full text-left px-2.5 py-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 font-medium cursor-pointer"
                      >
                        Pause for 1 hour
                      </button>
                      <div className="pt-1.5 border-t border-slate-200 dark:border-slate-800 flex items-center gap-1.5">
                        <input
                          type="number"
                          min={1}
                          max={1440}
                          value={customPauseMinutes}
                          onChange={(e) => setCustomPauseMinutes(e.target.value)}
                          aria-label="Custom pause minutes"
                          className="w-16 px-2 py-1 text-xs font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-900 dark:text-white"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const mins = Number(customPauseMinutes);
                            if (!Number.isFinite(mins) || mins < 1) return;
                            void handleControlAction(
                              { action: 'pause', minutes: mins },
                              `Capture paused for ${mins} minutes.`
                            );
                          }}
                          className="flex-1 px-2 py-1 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded cursor-pointer whitespace-nowrap"
                        >
                          Pause (m)
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  disabled={applyingControl}
                  onClick={() =>
                    void handleControlAction(
                      { action: 'offTheRecord', enabled: true },
                      'Switched to Off the Record — active capture paused.'
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/70 hover:bg-rose-100 dark:hover:bg-rose-950/60 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <EyeOff className="w-3.5 h-3.5" />
                  <span>Off the Record</span>
                </button>
              </>
            )
          ) : (
            <button
              type="button"
              onClick={() => setActiveDrawer('pair')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>
                {bridgeAuthState === 'unauthorized'
                  ? 'Fix Bridge Secret'
                  : isLocalBridgeOnline
                    ? 'Pair Local Controls'
                    : 'Pair Desktop Agent'}
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setActiveDrawer((prev) => (prev === 'schedule' ? null : 'schedule'))}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            <CalendarClock className="w-3.5 h-3.5" />
            <span>
              Schedule
              {controls?.schedule && controls.schedule.length > 0
                ? ` · ${controls.schedule[0].start}–${controls.schedule[0].end}`
                : ' · Always'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveDrawer((prev) => (prev === 'health' ? null : 'health'))}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            {captureHealth?.level === 'degraded' || captureHealth?.level === 'poor' ? (
              <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
            ) : (
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
            )}
            <span className="font-mono tabular-nums">
              {captureHealth ? `Health ${captureHealth.score}%` : 'Capture Health'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveDrawer((prev) => (prev === 'recorded' ? null : 'recorded'))}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 rounded-md whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileSearch className="w-3.5 h-3.5" />
            <span>Recorded Activity</span>
          </button>

          {isControlPaired && (
            <button
              type="button"
              onClick={() => setActiveDrawer((prev) => (prev === 'pair' ? null : 'pair'))}
              title="Configure local Desktop Agent bridge URL and secret"
              className="px-2 py-1.5 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
            >
              Bridge
            </button>
          )}

          <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums pl-1 whitespace-nowrap shrink-0">
            {syncStatus === 'syncing'
              ? 'Syncing...'
              : `${workstationDevices.length} paired`}
          </span>
        </div>
      </div>

      {/* Slide-Over Workstation Capture Drawer */}
      {activeDrawer !== null && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 backdrop-blur-xs"
          onClick={() => setActiveDrawer(null)}
        >
          <div
            data-testid={`capture-drawer-${activeDrawer}`}
            className="w-full max-w-xl bg-white dark:bg-slate-900 h-full border-l border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
                  {activeDrawer === 'health'
                    ? 'Workstation Capture Health & SQLite Buffer'
                    : activeDrawer === 'recorded'
                      ? 'What Was Recorded on This Workstation'
                      : activeDrawer === 'schedule'
                        ? 'Automatic Capture Work Schedule'
                        : 'Pair Local Workstation Bridge'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {activeDrawer === 'recorded'
                    ? 'Exact redacted metadata queued on your device (never screenshots, keystrokes, or clipboard).'
                    : activeDrawer === 'schedule'
                      ? 'Limit automatic capture to your working hours; outside those windows capture stays paused.'
                      : activeDrawer === 'health'
                        ? 'Live collector diagnostics, OS permission checks, and embedded local SQLite cleanup telemetry.'
                        : 'Connect your browser timeline directly to your local OnTrack Desktop Agent.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveDrawer(null)}
                aria-label="Close drawer"
                className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5 text-xs">
              {(activeDrawer === 'pair' || bridgeAuthState !== 'paired') &&
                activeDrawer !== 'schedule' && (
                  <form
                    onSubmit={handleSavePairing}
                    className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        Local Loopback Bridge Connection
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                        {isLocalBridgeOnline ? 'Bridge Reachable' : 'Bridge Offline'}
                      </span>
                    </div>
                    {bridgeAuthState === 'unauthorized' && (
                      <p className="text-rose-600 dark:text-rose-400 font-medium">
                        The saved bridge secret was rejected (HTTP 401). Copy `bridgeSecret` from your workstation `agent.config.json` or Auto-Track pairing output.
                      </p>
                    )}
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Desktop Agent Bridge Origin
                      </label>
                      <input
                        type="url"
                        value={pairUrlInput}
                        onChange={(e) => setPairUrlInput(e.target.value)}
                        placeholder="http://127.0.0.1:47621"
                        className="w-full px-3 py-2 font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Bridge Secret (X-OnTrack-Bridge-Secret)
                      </label>
                      <input
                        type="password"
                        value={pairSecretInput}
                        onChange={(e) => setPairSecretInput(e.target.value)}
                        placeholder="Paste bridgeSecret from agent.config.json"
                        className="w-full px-3 py-2 font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-white"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      {onOpenInstallers ? (
                        <button
                          type="button"
                          onClick={() => {
                            setActiveDrawer(null);
                            onOpenInstallers();
                          }}
                          className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium cursor-pointer"
                        >
                          Download Desktop Agent &amp; Extension →
                        </button>
                      ) : (
                        <span />
                      )}
                      <button
                        type="submit"
                        className="px-3.5 py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-md cursor-pointer"
                      >
                        Save &amp; Connect Bridge
                      </button>
                    </div>
                  </form>
                )}

              {activeDrawer === 'health' && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500 dark:text-slate-400">Collector Mode</div>
                      <div className="mt-1 font-mono text-sm font-bold text-slate-900 dark:text-white">
                        {captureHealth?.collectorMode || (isLocalBridgeOnline ? 'active' : 'offline')}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500 dark:text-slate-400">Coverage Score</div>
                      <div className="mt-1 font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                        {captureHealth ? `${captureHealth.score}% (${captureHealth.level})` : 'Unavailable'}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500 dark:text-slate-400">Local SQLite Queue</div>
                      <div className="mt-1 font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                        {localStore
                          ? `${localStore.pendingCount} pending · ${formatBytesKb(localStore.dbBytes)}`
                          : 'Not connected'}
                      </div>
                    </div>
                    <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                      <div className="text-slate-500 dark:text-slate-400">Last SQLite Cleanup</div>
                      <div className="mt-1 font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                        {localStore?.lastCleanupAtMs
                          ? new Date(localStore.lastCleanupAtMs).toLocaleTimeString()
                          : 'Scheduled (5m)'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-slate-900 dark:text-white">
                        Diagnostics &amp; OS Permission Checks
                      </h3>
                      <button
                        type="button"
                        onClick={() => void refreshLocalBridge()}
                        className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>Refresh</span>
                      </button>
                    </div>
                    {!captureHealth ? (
                      <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500">
                        Pair your workstation bridge secret above to read detailed collector diagnostics.
                      </div>
                    ) : captureHealth.issues.length === 0 ? (
                      <div className="p-3.5 rounded-lg border border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/60 dark:bg-emerald-950/20 flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>All workstation collectors and browser bridges are operating cleanly.</span>
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                        {captureHealth.issues.map((issue) => (
                          <div key={issue.code} className="p-3 flex items-start gap-2.5">
                            <Activity
                              className={`w-4 h-4 shrink-0 mt-0.5 ${
                                issue.severity === 'error'
                                  ? 'text-rose-600'
                                  : issue.severity === 'warning'
                                    ? 'text-amber-600'
                                    : 'text-sky-600'
                              }`}
                            />
                            <div>
                              <div className="font-mono text-[11px] font-semibold text-slate-900 dark:text-white">
                                {issue.code} · {issue.severity}
                              </div>
                              <p className="text-slate-600 dark:text-slate-300 mt-0.5">
                                {issue.message}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {activeDrawer === 'recorded' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <input
                      type="text"
                      value={recentSearch}
                      onChange={(e) => setRecentSearch(e.target.value)}
                      placeholder="Filter recorded apps, titles, or domains..."
                      className="flex-1 px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-white"
                    />
                    <button
                      type="button"
                      onClick={() => void loadRecentEvents()}
                      disabled={loadingRecent || !savedConfig.bridgeSecret}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${loadingRecent ? 'animate-spin' : ''}`} />
                      <span>Refresh</span>
                    </button>
                  </div>

                  {filteredRecentEvents.length === 0 ? (
                    <div className="p-6 text-center rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-slate-500">
                      {loadingRecent
                        ? 'Loading local agent event log...'
                        : 'No recent redacted capture records found on this bridge session.'}
                    </div>
                  ) : (
                    <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-200 dark:divide-slate-800">
                      {filteredRecentEvents.map((ev, idx) => {
                        const app = String(ev.payload?.app || 'Workstation');
                        const title = String(ev.payload?.window_title || ev.payload?.domain || ev.type);
                        const durMs = Number(ev.payload?.duration_ms || 0);
                        const idleFlag = Boolean(ev.payload?.idle);
                        return (
                          <div key={`${ev.timeUtc}-${idx}`} className="p-3 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-900 dark:text-white truncate">
                                {app}
                              </span>
                              <span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                                {new Date(ev.timeUtc).toLocaleTimeString()}
                                {durMs > 0 ? ` · ${Math.round(durMs / 1000)}s` : ''}
                              </span>
                            </div>
                            <div className="text-slate-700 dark:text-slate-300 truncate">
                              {title}
                            </div>
                            <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                              {ev.type}
                              {idleFlag ? ' · idle' : ' · active'}
                              {ev.payload?.domain ? ` · ${String(ev.payload.domain)}` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {activeDrawer === 'schedule' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setScheduleDays([1, 2, 3, 4, 5]);
                        setScheduleStart('08:00');
                        setScheduleEnd('18:00');
                      }}
                      className="px-2.5 py-1.5 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      Mon–Fri 08:00–18:00
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScheduleDays([1, 2, 3, 4, 5]);
                        setScheduleStart('09:00');
                        setScheduleEnd('17:00');
                      }}
                      className="px-2.5 py-1.5 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      Mon–Fri 09:00–17:00
                    </button>
                    <button
                      type="button"
                      disabled={applyingControl}
                      onClick={() =>
                        void handleControlAction(
                          { action: 'setSchedule', schedule: [] },
                          'Cleared capture schedule — recording always allowed.'
                        )
                      }
                      className="px-2.5 py-1.5 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      Always Capture (Clear Schedule)
                    </button>
                  </div>

                  <div>
                    <div className="font-medium text-slate-700 dark:text-slate-300 mb-2">
                      Active Work Days
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {DAY_LABELS.map((label, dayIdx) => {
                        const active = scheduleDays.includes(dayIdx);
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() =>
                              setScheduleDays((prev) =>
                                prev.includes(dayIdx)
                                  ? prev.filter((d) => d !== dayIdx)
                                  : [...prev, dayIdx].sort((a, b) => a - b)
                              )
                            }
                            className={`px-2.5 py-1.5 rounded-md font-medium border cursor-pointer ${
                              active
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        Start Time
                      </label>
                      <input
                        type="time"
                        value={scheduleStart}
                        onChange={(e) => setScheduleStart(e.target.value)}
                        className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                        End Time
                      </label>
                      <input
                        type="time"
                        value={scheduleEnd}
                        onChange={(e) => setScheduleEnd(e.target.value)}
                        className="w-full px-3 py-2 font-mono tabular-nums bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-white"
                      />
                    </div>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="button"
                      disabled={applyingControl || scheduleDays.length === 0}
                      onClick={() =>
                        void handleControlAction(
                          {
                            action: 'setSchedule',
                            schedule: [
                              { days: scheduleDays, start: scheduleStart, end: scheduleEnd },
                            ],
                          },
                          `Capture schedule saved (${scheduleStart}–${scheduleEnd}).`
                        )
                      }
                      className="px-4 py-2 font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-md cursor-pointer disabled:opacity-50"
                    >
                      Save Work Schedule
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
