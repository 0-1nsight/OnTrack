/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AuthUser,
  DemoAccountSummary,
  bootstrapFirmAdmin,
  fetchAuthSession,
  fetchBootstrapStatus,
  fetchDemoAccounts,
  loginWithDemoAccount,
  loginWithPassword,
  logoutSession,
} from './services/authClient';
import {
  ActiveTimerState,
  ActivitySegment,
  ApplicationUsageSegment,
  DocumentUsageSegment,
  IdleAlertState,
  NavigationTab,
  Task,
  TimeBlock,
  UserProfile,
  WeeklyReport,
  WorkCategory,
  WorkspaceHierarchy,
  WorkspacePreferences,
} from './types';
import { AttributionRecord, EngineTask, PrivacyRule, SyncConflict, UserRole, WorkSession } from './engine/types';
import {
  buildLocalTrackingEvent,
  createEngineTaskApi,
  deleteEngineTaskApi,
  fetchEngineSnapshot,
  filterAndEnqueueEvent,
  flushQueuedEventsOverHttp,
  getOrCreateLocalDeviceId,
  updateEngineTaskApi,
} from './services/engineClient';
import {
  DEFAULT_PREFERENCES,
  createEmptyWorkspaceDataset,
  getRecentWeekDates,
  inferAppCategory,
} from './utils/workspaceConstants';
import { createDemoWorkspaceDataset } from './utils/demoWorkspaceSeed';
import {
  adaptEngineSnapshotToWorkspace,
  buildTimeBlockStartTimestampUtc,
  mapEngineTaskToWorkspaceTask,
} from './utils/engineWorkspaceAdapter';
import { getRolePolicy } from './utils/roleConfig';
import { createDefaultWorkspaceHierarchy } from './utils/taskHierarchy';
import { TopBar } from './components/TopBar';
import { ActiveTimerBar } from './components/ActiveTimerBar';
import { TimelineView } from './components/TimelineView';
import { TaskWorkspaceView } from './components/TaskWorkspaceView';
import { WeeklyReportView } from './components/WeeklyReportView';
import { AnalyticsView } from './components/AnalyticsView';
import { AutoTrackSubTab, AutoTrackView } from './components/AutoTrackView';
import { RoleDashboardView } from './components/RoleDashboardView';
import { ClientPortalView } from './components/ClientPortalView';
import { IdleReconcileModal } from './components/IdleReconcileModal';
import { QuickLogModal } from './components/QuickLogModal';
import { DataPreferencesModal } from './components/DataPreferencesModal';
import { AccountModal } from './components/AccountModal';
import { LandingPage } from './components/LandingPage';

const STORAGE_KEYS = {
  TASKS: 'ontrack_tasks_v1',
  BLOCKS: 'ontrack_blocks_v1',
  SEGMENTS: 'ontrack_segments_v1',
  APP_SEGMENTS: 'ontrack_app_segments_v1',
  DOC_SEGMENTS: 'ontrack_doc_segments_v1',
  REPORTS: 'ontrack_reports_v1',
  PREFS: 'ontrack_prefs_v1',
  HIERARCHY: 'ontrack_workspace_hierarchy_v1',
};

function readStorageJson<T>(primaryKey: string): T | null {
  try {
    const raw = localStorage.getItem(primaryKey);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getCurrentMinuteOfDay(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export default function App() {
  const weekDates = getRecentWeekDates();
  const todayDate = weekDates[weekDates.length - 1];

  const [activeTab, setActiveTab] = useState<NavigationTab>('timeline');
  const [selectedDate, setSelectedDate] = useState<string>(todayDate);

  // Workspace Persistent State
  const [tasks, setTasks] = useState<Task[]>(() => {
    return readStorageJson<Task[]>(STORAGE_KEYS.TASKS) || createEmptyWorkspaceDataset().tasks;
  });

  const [timeBlocks, setTimeBlocks] = useState<TimeBlock[]>(() => {
    return readStorageJson<TimeBlock[]>(STORAGE_KEYS.BLOCKS) || createEmptyWorkspaceDataset().timeBlocks;
  });

  const [activitySegments, setActivitySegments] = useState<ActivitySegment[]>(() => {
    return readStorageJson<ActivitySegment[]>(STORAGE_KEYS.SEGMENTS) || createEmptyWorkspaceDataset().activitySegments;
  });

  const [appSegments, setAppSegments] = useState<ApplicationUsageSegment[]>(() => {
    return readStorageJson<ApplicationUsageSegment[]>(STORAGE_KEYS.APP_SEGMENTS) || createEmptyWorkspaceDataset().appSegments;
  });

  const [documentSegments, setDocumentSegments] = useState<DocumentUsageSegment[]>(() => {
    return readStorageJson<DocumentUsageSegment[]>(STORAGE_KEYS.DOC_SEGMENTS) || createEmptyWorkspaceDataset().documentSegments;
  });

  const [reports, setReports] = useState<WeeklyReport[]>(() => {
    return readStorageJson<WeeklyReport[]>(STORAGE_KEYS.REPORTS) || createEmptyWorkspaceDataset().reports;
  });

  const [preferences, setPreferences] = useState<WorkspacePreferences>(() => {
    const saved = readStorageJson<Partial<WorkspacePreferences>>(STORAGE_KEYS.PREFS);
    return saved ? { ...DEFAULT_PREFERENCES, ...saved } : DEFAULT_PREFERENCES;
  });

  const [workspaceHierarchy, setWorkspaceHierarchy] = useState<WorkspaceHierarchy>(() => {
    const saved = readStorageJson<WorkspaceHierarchy>(STORAGE_KEYS.HIERARCHY);
    if (
      saved &&
      Array.isArray(saved.spaces) &&
      Array.isArray(saved.folders) &&
      Array.isArray(saved.boards) &&
      saved.boards.length > 0
    ) {
      return saved;
    }
    return createDefaultWorkspaceHierarchy();
  });

  // Persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(tasks));
    } catch {
      // ignore
    }
  }, [tasks]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.BLOCKS, JSON.stringify(timeBlocks));
    } catch {
      // ignore
    }
  }, [timeBlocks]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.SEGMENTS,
        JSON.stringify(activitySegments)
      );
    } catch {
      // ignore
    }
  }, [activitySegments]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.APP_SEGMENTS,
        JSON.stringify(appSegments)
      );
    } catch {
      // ignore
    }
  }, [appSegments]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.DOC_SEGMENTS,
        JSON.stringify(documentSegments)
      );
    } catch {
      // ignore
    }
  }, [documentSegments]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.REPORTS, JSON.stringify(reports));
    } catch {
      // ignore
    }
  }, [reports]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.PREFS, JSON.stringify(preferences));
    } catch {
      // ignore
    }
    document.documentElement.classList.toggle('dark', preferences.darkMode);
  }, [preferences]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEYS.HIERARCHY,
        JSON.stringify(workspaceHierarchy)
      );
    } catch {
      // ignore
    }
  }, [workspaceHierarchy]);

  // Live Active Task Stopwatch State
  const [timer, setTimer] = useState<ActiveTimerState>({
    isRunning: false,
    isPaused: false,
    taskId: null,
    customTitle: '',
    project: 'Core Platform',
    category: 'deep_work',
    tags: [],
    isBillable: false,
    startedAtMs: null,
    accumulatedSeconds: 0,
    startMinuteOfDay: getCurrentMinuteOfDay(),
    activeAppName: 'OnTrack Web',
    activeDocumentTitle: 'Workspace — OnTrack',
  });

  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Automatic Browser Activity & Idle Presence Tracking
  const lastActivityMsRef = useRef<number>(0);
  const [idleSeconds, setIdleSeconds] = useState<number>(0);
  const [idleAlert, setIdleAlert] = useState<IdleAlertState>({
    isOpen: false,
    idleStartedAtMs: 0,
    idleDurationSeconds: 0,
    activeTaskTitle: '',
    startMinuteOfDay: 600,
    endMinuteOfDay: 620,
  });

  // Quick Log & Preferences Modal States
  const [quickLogOpen, setQuickLogOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState<TimeBlock | null>(null);
  const [quickLogRange, setQuickLogRange] = useState<{
    startTime: number;
    endTime: number;
  } | null>(null);
  const [quickLogTask, setQuickLogTask] = useState<Task | null>(null);
  const [initialAppDoc, setInitialAppDoc] = useState<{
    appName: string;
    documentTitle: string;
    startTime: number;
    endTime: number;
    linkedTaskId?: string | null;
  } | null>(null);
  const [prefsModalOpen, setPrefsModalOpen] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [toastBanner, setToastBanner] = useState<string | null>(null);

  // Self-Hosted Auth & User Account State
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);
  const [demoModeEnabled, setDemoModeEnabled] = useState(false);
  const [demoAccounts, setDemoAccounts] = useState<DemoAccountSummary[]>([]);
  const [showLanding, setShowLanding] = useState(true);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [previewRoleOverride, setPreviewRoleOverride] = useState<UserRole | null>(null);
  const [autoTrackNav, setAutoTrackNav] = useState<{
    key: number;
    subTab?: AutoTrackSubTab;
    targetUserId?: string;
    drilldown?: boolean;
  }>({ key: 0 });

  // Live Engine Sync State (Tasks, Sessions, Conflicts, Privacy Rules)
  const [enginePrivacyRules, setEnginePrivacyRules] = useState<PrivacyRule[]>([]);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [engineTaskVersions, setEngineTaskVersions] = useState<Record<string, number>>({});
  const [engineSyncStatus, setEngineSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle');
  const demoSeedAppliedRef = useRef(false);
  const hierarchyBoardsRef = useRef(workspaceHierarchy.boards);
  useEffect(() => {
    hierarchyBoardsRef.current = workspaceHierarchy.boards;
  }, [workspaceHierarchy.boards]);

  const canSwitchPreviewRole =
    demoModeEnabled && (!user || (user.isDemoSandbox && user.role === 'admin_it'));
  const activeRole: UserRole = user
    ? user.isDemoSandbox && demoModeEnabled && user.role === 'admin_it' && previewRoleOverride
      ? previewRoleOverride
      : user.role
    : demoModeEnabled
    ? previewRoleOverride ?? 'accountant'
    : 'accountant';
  const rolePolicy = getRolePolicy(activeRole);
  const effectiveTab: NavigationTab = rolePolicy.allowedTabs.some((t) => t.id === activeTab)
    ? activeTab
    : rolePolicy.defaultTab;

  const resetWorkspaceState = useCallback(() => {
    const empty = createEmptyWorkspaceDataset();
    setTasks(empty.tasks);
    setTimeBlocks(empty.timeBlocks);
    setActivitySegments(empty.activitySegments);
    setAppSegments(empty.appSegments);
    setDocumentSegments(empty.documentSegments);
    setReports(empty.reports);
    setWorkspaceHierarchy(createDefaultWorkspaceHierarchy());
    setEnginePrivacyRules([]);
    setSyncConflicts([]);
    setEngineTaskVersions({});
    setEngineSyncStatus('idle');
    demoSeedAppliedRef.current = false;
    setElapsedSeconds(0);
    setTimer((prev) => ({
      ...prev,
      isRunning: false,
      isPaused: false,
      taskId: null,
      customTitle: '',
      startedAtMs: null,
      accumulatedSeconds: 0,
    }));
    try {
      localStorage.removeItem(STORAGE_KEYS.TASKS);
      localStorage.removeItem(STORAGE_KEYS.BLOCKS);
      localStorage.removeItem(STORAGE_KEYS.SEGMENTS);
      localStorage.removeItem(STORAGE_KEYS.APP_SEGMENTS);
      localStorage.removeItem(STORAGE_KEYS.DOC_SEGMENTS);
      localStorage.removeItem(STORAGE_KEYS.REPORTS);
    } catch {
      // ignore storage cleanup errors
    }
  }, []);

  const showToast = useCallback((msg: string) => {
    setToastBanner(msg);
    setTimeout(() => {
      setToastBanner((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  const [autoSyncToTimeline, setAutoSyncToTimeline] = useState<boolean>(true);
  const handleSyncEngineSessionsToTimeline = useCallback(
    (sessions: WorkSession[], attributions: AttributionRecord[]) => {
      if (!autoSyncToTimeline || sessions.length === 0) return;
      const attrMap = new Map(attributions.map((a) => [a.sessionId, a]));
      const syncCandidates = sessions.filter((s) => {
        const attr = attrMap.get(s.id);
        return attr && (attr.status === 'confirmed' || attr.status === 'detected');
      });
      if (syncCandidates.length === 0) return;

      const newBlocks: TimeBlock[] = [];
      const newApps: ApplicationUsageSegment[] = [];
      const newDocs: DocumentUsageSegment[] = [];

      for (const s of syncCandidates) {
        const attr = attrMap.get(s.id)!;
        const startDateObj = new Date(s.startTimeUtc);
        const endDateObj = new Date(s.endTimeUtc);
        const startMin = Math.max(
          0,
          Math.min(1425, startDateObj.getHours() * 60 + startDateObj.getMinutes())
        );
        const rawDur = Math.max(
          15,
          Math.round((endDateObj.getTime() - startDateObj.getTime()) / 60000)
        );
        const endMin = Math.min(1440, startMin + rawDur);

        newBlocks.push({
          id: `blk-eng-sync-${s.id}`,
          taskId: null,
          title: attr.taskTitle || s.primaryTitle,
          project: attr.clientName || s.entities.clientName || 'Accounting',
          category: 'billable',
          tags: ['auto-tracked', attr.status, s.osPlatform],
          date: selectedDate,
          startTime: startMin,
          endTime: endMin,
          durationMinutes: endMin - startMin,
          source: 'reconciled',
          isBillable: true,
          notes: `${attr.reason} · ${s.primaryApp}`,
          appName: s.primaryApp,
          documentTitle: s.primaryTitle,
        });
        newApps.push({
          id: `app-eng-sync-${s.id}`,
          date: selectedDate,
          startTime: startMin,
          endTime: endMin,
          appName: s.primaryApp,
          appCategory: inferAppCategory(s.primaryApp),
        });
        newDocs.push({
          id: `doc-eng-sync-${s.id}`,
          date: selectedDate,
          startTime: startMin,
          endTime: endMin,
          appName: s.primaryApp,
          documentTitle: s.primaryTitle,
          domainOrPath: s.primaryUrl || s.primaryPath || s.primaryApp,
          linkedTaskId: null,
        });
      }

      setTimeBlocks((prev) => {
        const existing = new Set(prev.map((b) => b.id));
        const toAdd = newBlocks.filter((b) => !existing.has(b.id));
        if (toAdd.length === 0) return prev;
        return [...prev, ...toAdd];
      });
      setAppSegments((prev) => {
        const existing = new Set(prev.map((a) => a.id));
        const toAdd = newApps.filter((a) => !existing.has(a.id));
        if (toAdd.length === 0) return prev;
        return [...prev, ...toAdd];
      });
      setDocumentSegments((prev) => {
        const existing = new Set(prev.map((d) => d.id));
        const toAdd = newDocs.filter((d) => !existing.has(d.id));
        if (toAdd.length === 0) return prev;
        return [...prev, ...toAdd];
      });
    },
    [autoSyncToTimeline, selectedDate]
  );

  // Keep latest local dataset ref for initial account onboarding migration
  const latestWorkspaceRef = useRef({
    tasks,
    timeBlocks,
    activitySegments,
    appSegments,
    documentSegments,
    reports,
    preferences,
  });
  useEffect(() => {
    latestWorkspaceRef.current = {
      tasks,
      timeBlocks,
      activitySegments,
      appSegments,
      documentSegments,
      reports,
      preferences,
    };
  }, [
    tasks,
    timeBlocks,
    activitySegments,
    appSegments,
    documentSegments,
    reports,
    preferences,
  ]);

  const hydrateFromEngine = useCallback(
    async (targetUser?: AuthUser | null, roleOverride?: UserRole) => {
      const currentUser = targetUser ?? user;
      const role = roleOverride ?? activeRole;
      if (!currentUser || !currentUser.mfaVerified || role === 'client') {
        setEngineSyncStatus('idle');
        return;
      }

      await Promise.resolve();
      setEngineSyncStatus('syncing');
      try {
        const snapshot = await fetchEngineSnapshot({
          tenantId: currentUser.tenantId,
          viewerUserId: currentUser.userId,
          viewerRole: role,
          targetUserId: currentUser.userId,
          drilldownGranted: false,
        });

        setEnginePrivacyRules(snapshot.privacyRules || []);
        setSyncConflicts(snapshot.conflicts || []);
        const versionMap: Record<string, number> = {};
        for (const t of snapshot.tasks) {
          versionMap[t.id] = t.version;
        }
        setEngineTaskVersions(versionMap);

        const latest = latestWorkspaceRef.current;
        const adapted = adaptEngineSnapshotToWorkspace({
          snapshot,
          existingTasks: latest.tasks,
          existingBlocks: latest.timeBlocks,
          existingActivity: latest.activitySegments,
          existingApps: latest.appSegments,
          existingDocs: latest.documentSegments,
          boards: hierarchyBoardsRef.current,
          includeAllSessionBlocks: false,
          isDemoSandbox: Boolean(currentUser.isDemoSandbox),
        });

        setTasks(adapted.tasks);
        setTimeBlocks(adapted.timeBlocks);
        setActivitySegments(adapted.activitySegments);
        setAppSegments(adapted.appSegments);
        setDocumentSegments(adapted.documentSegments);
        setEngineSyncStatus('idle');
      } catch {
        setEngineSyncStatus('error');
      }
    },
    [user, activeRole]
  );

  const persistTrackingEvent = useCallback(
    async (params: {
      type:
        | 'activity.window'
        | 'activity.browser'
        | 'activity.idle'
        | 'state.task_status';
      priority: 'state' | 'activity';
      payload: Record<string, unknown>;
      eventTimeUtc?: string;
    }) => {
      if (!user || !user.mfaVerified || activeRole === 'client') return;
      const deviceId = getOrCreateLocalDeviceId();
      const ev = buildLocalTrackingEvent({
        tenantId: user.tenantId,
        userId: user.userId,
        deviceId,
        type: params.type,
        priority: params.priority,
        payload: {
          os_platform: 'web',
          extension_connected: true,
          ...params.payload,
        },
        eventTimeUtc: params.eventTimeUtc,
      });
      const queued = filterAndEnqueueEvent(ev, enginePrivacyRules);
      if (!queued.allowed) {
        if (queued.dropReason) showToast(queued.dropReason);
        return;
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return;
      }
      try {
        const res = await flushQueuedEventsOverHttp({
          tenantId: user.tenantId,
          userId: user.userId,
          deviceId,
        });
        if (res.conflictsCreated && res.conflictsCreated.length > 0) {
          setSyncConflicts((prev) => [...res.conflictsCreated, ...prev]);
          showToast(
            `${res.conflictsCreated.length} sync conflict detected — resolve in Auto-Track.`
          );
        }
      } catch {
        // Keep in ontrack_engine_queue_v1 until connectivity returns
      }
    },
    [user, activeRole, enginePrivacyRules, showToast]
  );

  const refreshAuthSession = useCallback(async () => {
    try {
      const [status, session] = await Promise.all([
        fetchBootstrapStatus().catch(() => ({
          needsInitialSetup: false,
          demoModeEnabled: false,
          hasOidcTenants: false,
        })),
        fetchAuthSession().catch(() => ({ authenticated: false, user: null })),
      ]);
      setNeedsInitialSetup(Boolean(status.needsInitialSetup));
      setDemoModeEnabled(Boolean(status.demoModeEnabled));
      if (status.demoModeEnabled) {
        const demoList = await fetchDemoAccounts().catch(() => ({
          demoModeEnabled: false,
          accounts: [],
        }));
        setDemoAccounts(demoList.accounts || []);
      } else {
        setDemoAccounts([]);
      }
      if (session.authenticated && session.user) {
        if (!session.user.isDemoSandbox) {
          setReports((prev) => prev.filter((r) => !r.id.startsWith('demo-rep-')));
        }
        setUser(session.user);
        setUserProfile({
          ownerId: session.user.userId,
          email: session.user.email,
          displayName: session.user.name,
          jobTitle: session.user.role,
          hourlyRate: 150,
          currency: 'USD',
          preferences: latestWorkspaceRef.current.preferences,
        });
        setShowLanding(false);
      } else {
        setUser(null);
        setUserProfile(null);
      }
    } finally {
      setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    void refreshAuthSession();
  }, [refreshAuthSession]);

  // Hydrate workspace from live Engine DB or Demo Sandbox seed when appropriate
  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;

    const runHydration = async () => {
      await Promise.resolve();
      if (cancelled) return;

      if (user && !user.mfaVerified) {
        setEngineSyncStatus('idle');
        return;
      }

      if (user && activeRole !== 'client') {
        if (user.isDemoSandbox && demoModeEnabled && !demoSeedAppliedRef.current) {
          const latest = latestWorkspaceRef.current;
          if (latest.timeBlocks.length === 0 && latest.reports.length === 0) {
            const demo = createDemoWorkspaceDataset(weekDates);
            setTimeBlocks(demo.timeBlocks);
            setActivitySegments(demo.activitySegments);
            setAppSegments(demo.appSegments);
            setDocumentSegments(demo.documentSegments);
            setReports(demo.reports);
          }
          demoSeedAppliedRef.current = true;
        }
        await hydrateFromEngine(user, activeRole);
        return;
      }

      if (!user && demoModeEnabled && !demoSeedAppliedRef.current) {
        const latest = latestWorkspaceRef.current;
        if (
          latest.tasks.length === 0 &&
          latest.timeBlocks.length === 0 &&
          latest.appSegments.length === 0
        ) {
          const demo = createDemoWorkspaceDataset(weekDates);
          setTasks(demo.tasks);
          setTimeBlocks(demo.timeBlocks);
          setActivitySegments(demo.activitySegments);
          setAppSegments(demo.appSegments);
          setDocumentSegments(demo.documentSegments);
          setReports(demo.reports);
        }
        demoSeedAppliedRef.current = true;
      }
    };

    void runHydration();
    return () => {
      cancelled = true;
    };
  }, [authReady, user, activeRole, demoModeEnabled, hydrateFromEngine, weekDates]);

  // Global /ws/engine live updates + online queue flush (SYNC-5)
  useEffect(() => {
    if (!authReady || !user || !user.mfaVerified || activeRole === 'client') return;

    const deviceId = getOrCreateLocalDeviceId();
    const handleOnline = () => {
      void flushQueuedEventsOverHttp({
        tenantId: user.tenantId,
        userId: user.userId,
        deviceId,
      })
        .then(() => hydrateFromEngine(user, activeRole))
        .catch(() => undefined);
    };
    window.addEventListener('online', handleOnline);

    let ws: WebSocket | null = null;
    let refreshTimer: number | null = null;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({
        tenantId: user.tenantId,
        userId: user.userId,
        role: activeRole,
      });
      ws = new WebSocket(`${proto}//${window.location.host}/ws/engine?${qs.toString()}`);
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg.type === 'state:updated' || msg.type === 'activity:updated') {
            if (refreshTimer) window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
              void hydrateFromEngine(user, activeRole);
            }, 350);
          }
        } catch {
          // ignore malformed WS frames
        }
      };
    } catch {
      // Fall back cleanly if WebSocket unavailable
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      if (refreshTimer) window.clearTimeout(refreshTimer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [authReady, user, activeRole, hydrateFromEngine]);

  // Auth & Account Management Handlers
  const handleLogin = async (payload: {
    email: string;
    password: string;
    totpCode?: string;
    isClientPortal?: boolean;
  }) => {
    setAuthError(null);
    try {
      const res = await loginWithPassword(payload);
      if (res.user.userId !== user?.userId || res.user.tenantId !== user?.tenantId) {
        resetWorkspaceState();
      }
      setUser(res.user);
      setPreviewRoleOverride(null);
      setActiveTab(getRolePolicy(res.user.role).defaultTab);
      setUserProfile({
        ownerId: res.user.userId,
        email: res.user.email,
        displayName: res.user.name,
        jobTitle: res.user.role,
        hourlyRate: 150,
        currency: 'USD',
        preferences,
      });
      setShowLanding(false);
      if (!res.user.mfaVerified) {
        setAccountModalOpen(true);
        showToast('Two-factor authentication setup is required before accessing workspace data.');
      } else {
        showToast(`Signed in as ${res.user.email}.`);
      }
    } catch (err: any) {
      const msg = err?.message || 'Authentication failed.';
      setAuthError(msg);
      throw err;
    }
  };

  const handleDemoLogin = async (userId: string) => {
    setAuthError(null);
    try {
      const res = await loginWithDemoAccount(userId);
      if (res.user.userId !== user?.userId || res.user.tenantId !== user?.tenantId) {
        resetWorkspaceState();
      }
      setUser(res.user);
      setPreviewRoleOverride(null);
      setActiveTab(getRolePolicy(res.user.role).defaultTab);
      setUserProfile({
        ownerId: res.user.userId,
        email: res.user.email,
        displayName: res.user.name,
        jobTitle: res.user.role,
        hourlyRate: 150,
        currency: 'USD',
        preferences,
      });
      setShowLanding(false);
      showToast(`Signed in as ${res.user.name} (${getRolePolicy(res.user.role).shortLabel}).`);
    } catch (err: any) {
      const msg = err?.message || 'Demo sign-in failed.';
      setAuthError(msg);
      throw err;
    }
  };

  const handleBootstrapFirm = async (payload: {
    firmName: string;
    name: string;
    email: string;
    password: string;
  }) => {
    setAuthError(null);
    try {
      const res = await bootstrapFirmAdmin(payload);
      resetWorkspaceState();
      setNeedsInitialSetup(false);
      setUser(res.user);
      setPreviewRoleOverride(null);
      setActiveTab(getRolePolicy(res.user.role).defaultTab);
      setUserProfile({
        ownerId: res.user.userId,
        email: res.user.email,
        displayName: res.user.name,
        jobTitle: res.user.role,
        hourlyRate: 150,
        currency: 'USD',
        preferences,
      });
      setShowLanding(false);
      if (!res.user.mfaVerified) {
        setAccountModalOpen(true);
        showToast('Firm workspace initialized. Complete 2FA setup to unlock Admin Console.');
      } else {
        showToast('Firm workspace initialized and signed in.');
      }
    } catch (err: any) {
      const msg = err?.message || 'Firm initialization failed.';
      setAuthError(msg);
      throw err;
    }
  };

  const handleSignOut = async () => {
    await logoutSession();
    resetWorkspaceState();
    setUser(null);
    setUserProfile(null);
    setPreviewRoleOverride(null);
    setActiveTab('timeline');
    setAccountModalOpen(false);
    setPrefsModalOpen(false);
    setQuickLogOpen(false);
    setShowLanding(true);
    showToast('Signed out.');
  };

  const handleSaveProfile = async (updates: {
    displayName: string;
    jobTitle: string;
    hourlyRate: number;
    currency: string;
  }) => {
    setUserProfile((prev) =>
      prev
        ? { ...prev, ...updates }
        : user
          ? {
              ownerId: user.userId,
              email: user.email,
              ...updates,
              preferences,
            }
          : null
    );
    showToast('Workspace profile updated.');
  };

  // Reset idle counter on user mouse/keyboard/focus activity (unless Idle Modal is open)
  useEffect(() => {
    const handleUserActivity = () => {
      if (!idleAlert.isOpen) {
        lastActivityMsRef.current = Date.now();
        setIdleSeconds(0);
      }
    };

    window.addEventListener('mousemove', handleUserActivity, { passive: true });
    window.addEventListener('keydown', handleUserActivity, { passive: true });
    window.addEventListener('mousedown', handleUserActivity, { passive: true });
    window.addEventListener('scroll', handleUserActivity, { passive: true });

    return () => {
      window.removeEventListener('mousemove', handleUserActivity);
      window.removeEventListener('keydown', handleUserActivity);
      window.removeEventListener('mousedown', handleUserActivity);
      window.removeEventListener('scroll', handleUserActivity);
    };
  }, [idleAlert.isOpen]);

  // 1-second master ticker for Stopwatch & Idle Sensor
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      // Update live stopwatch elapsed seconds
      if (timer.isRunning && !timer.isPaused && timer.startedAtMs) {
        const deltaSec = Math.floor((now - timer.startedAtMs) / 1000);
        setElapsedSeconds(timer.accumulatedSeconds + deltaSec);
      } else {
        setElapsedSeconds(timer.accumulatedSeconds);
      }

      // Check idle sensor (only when inside staff workspace)
      if (!idleAlert.isOpen && !(showLanding && !user) && activeRole !== 'client') {
        if (lastActivityMsRef.current === 0) {
          lastActivityMsRef.current = now;
        }
        const inactiveSec = Math.floor((now - lastActivityMsRef.current) / 1000);
        setIdleSeconds(inactiveSec);

        if (inactiveSec >= preferences.idleThresholdSeconds) {
          const endMin = getCurrentMinuteOfDay();
          const durationMin = Math.max(15, Math.round(inactiveSec / 60));
          const startMin = Math.max(0, endMin - durationMin);
          setIdleAlert({
            isOpen: true,
            idleStartedAtMs: lastActivityMsRef.current,
            idleDurationSeconds: Math.max(inactiveSec, 15 * 60),
            activeTaskTitle:
              timer.customTitle || 'Active Workstation Session',
            startMinuteOfDay: startMin,
            endMinuteOfDay: endMin,
          });
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [timer, idleAlert.isOpen, preferences.idleThresholdSeconds, showLanding, user, activeRole]);

  // Sync browser document.title with active work context
  useEffect(() => {
    if (showLanding && !user) {
      document.title = 'OnTrack — Accounting Resource Management & Auto-Tracking';
      return;
    }
    if (activeRole === 'client') {
      document.title = 'OnTrack — Client Portal';
      return;
    }
    const docLabel = timer.activeDocumentTitle || timer.customTitle || 'Workspace';
    document.title = `${timer.isRunning && !timer.isPaused ? '● ' : ''}${timer.activeAppName} · ${docLabel} — OnTrack`;
  }, [timer.activeAppName, timer.activeDocumentTitle, timer.customTitle, timer.isRunning, timer.isPaused, showLanding, user, activeRole]);

  // Record in-app OnTrack tab focus switches inside explicit navigation handler (never for external client)
  const navigateTab = useCallback(
    (nextTab: NavigationTab) => {
      setActiveTab(nextTab);
      if (activeRole === 'client') return;
      const tabLabels: Record<NavigationTab, string> = {
        overview: `${rolePolicy.label} Overview — OnTrack`,
        timeline: `Day Timeline (${selectedDate}) — OnTrack`,
        tasks: 'Task Board & Backlog — OnTrack',
        autotrack: 'Automated Tracking & Attribution Engine — OnTrack',
        portal: 'Client Portal — OnTrack',
        admin: 'Admin & Fleet Governance — OnTrack',
        report: 'Weekly Executive Progress Report — OnTrack',
        analytics: 'Productivity & App Usage Analytics — OnTrack',
      };
      const nowMin = Math.min(1440, Math.max(20, getCurrentMinuteOfDay()));
      const startMin = Math.max(0, nowMin - 10);
      const ts = Date.now();
      const docTitle = tabLabels[nextTab];

      const newAppSeg: ApplicationUsageSegment = {
        id: `app-${ts}`,
        date: todayDate,
        startTime: startMin,
        endTime: nowMin,
        appName: 'OnTrack Web',
        appCategory: 'browser',
      };
      const newDocSeg: DocumentUsageSegment = {
        id: `doc-${ts}`,
        date: todayDate,
        startTime: startMin,
        endTime: nowMin,
        appName: 'OnTrack Web',
        documentTitle: docTitle,
        domainOrPath: `ontrack.local/${nextTab}`,
        linkedTaskId: timer.taskId,
      };

      setAppSegments((prev) => {
        const recentSame = prev.find(
          (s) =>
            s.date === todayDate &&
            s.appName === 'OnTrack Web' &&
            Math.abs(s.endTime - nowMin) <= 2
        );
        if (recentSame) return prev;
        return [...prev, newAppSeg];
      });
      setDocumentSegments((prev) => {
        const recentSame = prev.find(
          (s) =>
            s.date === todayDate &&
            s.documentTitle === docTitle &&
            Math.abs(s.endTime - nowMin) <= 2
        );
        if (recentSame) return prev;
        return [...prev, newDocSeg];
      });
    },
    [activeRole, rolePolicy.label, selectedDate, todayDate, timer.taskId]
  );

  // Timer Handlers
  const handleStartTimer = (taskId?: string | null) => {
    const targetId = taskId !== undefined ? taskId : timer.taskId;
    const foundTask = tasks.find((t) => t.id === targetId);

    setTimer((prev) => ({
      isRunning: true,
      isPaused: false,
      taskId: foundTask ? foundTask.id : null,
      customTitle: foundTask
        ? foundTask.title
        : prev.customTitle || 'Focused Work Session',
      project: foundTask ? foundTask.project : prev.project,
      category: foundTask ? foundTask.category : prev.category,
      tags: foundTask ? foundTask.tags : prev.tags,
      isBillable: foundTask ? foundTask.category === 'billable' : prev.isBillable,
      startedAtMs: Date.now(),
      accumulatedSeconds: 0,
      startMinuteOfDay: getCurrentMinuteOfDay(),
      activeAppName: prev.activeAppName || 'VS Code',
      activeDocumentTitle:
        prev.activeDocumentTitle ||
        (foundTask ? `${foundTask.title} — Workspace` : 'Active Document'),
    }));
    setElapsedSeconds(0);
    if (foundTask && foundTask.status === 'todo') {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === foundTask.id ? { ...t, status: 'in_progress' } : t
        )
      );
      if (user && activeRole !== 'client') {
        const ver = engineTaskVersions[foundTask.id];
        if (ver !== undefined || foundTask.id.startsWith('tsk-eng-') || foundTask.id.startsWith('demo_tsk_')) {
          void updateEngineTaskApi(foundTask.id, { status: 'in_progress' }).catch(() => undefined);
          void persistTrackingEvent({
            type: 'state.task_status',
            priority: 'state',
            payload: {
              task_id: foundTask.id,
              from_value: 'todo',
              to_value: 'in_progress',
              expected_version: ver,
              actor_role: activeRole,
            },
          });
        }
      }
    }
    showToast(
      `Stopwatch started: ${
        foundTask ? foundTask.title : timer.customTitle || 'Focused Session'
      }`
    );
  };

  const handlePauseTimer = () => {
    if (!timer.isRunning || timer.isPaused) return;
    const delta = timer.startedAtMs
      ? Math.floor((Date.now() - timer.startedAtMs) / 1000)
      : 0;
    setTimer((prev) => ({
      ...prev,
      isPaused: true,
      startedAtMs: null,
      accumulatedSeconds: prev.accumulatedSeconds + delta,
    }));
  };

  const handleResumeTimer = () => {
    if (!timer.isRunning || !timer.isPaused) return;
    setTimer((prev) => ({
      ...prev,
      isPaused: false,
      startedAtMs: Date.now(),
    }));
  };

  const handleStopAndSaveTimer = () => {
    if (!timer.isRunning) return;
    const totalSec =
      timer.accumulatedSeconds +
      (timer.startedAtMs && !timer.isPaused
        ? Math.floor((Date.now() - timer.startedAtMs) / 1000)
        : 0);

    // Ensure at least 15m visible block on the day timeline (or exact minutes if > 15m)
    const durationMinutes = Math.max(15, Math.round(totalSec / 60));
    const endMin = Math.min(1440, Math.max(60, getCurrentMinuteOfDay()));
    const startMin = Math.max(0, endMin - durationMinutes);
    const ts = Date.now();

    const newBlock: TimeBlock = {
      id: `blk-${ts}`,
      taskId: timer.taskId,
      title: timer.customTitle || 'Focused Task Session',
      project: timer.project,
      category: timer.category,
      tags: timer.tags.length > 0 ? timer.tags : ['focus'],
      date: selectedDate,
      startTime: startMin,
      endTime: endMin,
      durationMinutes,
      source: 'timer',
      isBillable: timer.isBillable,
      notes: 'Logged directly via OnTrack active stopwatch.',
      appName: timer.activeAppName || 'VS Code',
      documentTitle: timer.activeDocumentTitle || undefined,
    };

    const activeApp = timer.activeAppName || 'VS Code';
    const activeDoc =
      timer.activeDocumentTitle?.trim() || `${newBlock.title} — Workspace`;

    const newAppSeg: ApplicationUsageSegment = {
      id: `app-${ts}`,
      date: selectedDate,
      startTime: startMin,
      endTime: endMin,
      appName: activeApp,
      appCategory: inferAppCategory(activeApp),
    };

    const newDocSeg: DocumentUsageSegment = {
      id: `doc-${ts}`,
      date: selectedDate,
      startTime: startMin,
      endTime: endMin,
      appName: activeApp,
      documentTitle: activeDoc,
      domainOrPath: activeApp === 'Google Chrome' ? 'app.browser/session' : `~/workspace/${activeApp.toLowerCase().replace(/\s+/g, '-')}`,
      linkedTaskId: timer.taskId,
    };

    setTimeBlocks((prev) => [...prev, newBlock]);
    setAppSegments((prev) => [...prev, newAppSeg]);
    setDocumentSegments((prev) => [...prev, newDocSeg]);
    setTimer((prev) => ({
      ...prev,
      isRunning: false,
      isPaused: false,
      startedAtMs: null,
      accumulatedSeconds: 0,
    }));
    setElapsedSeconds(0);
    void persistTrackingEvent({
      type: 'activity.window',
      priority: 'activity',
      eventTimeUtc: buildTimeBlockStartTimestampUtc(selectedDate, startMin),
      payload: {
        app: activeApp,
        window_title: activeDoc,
        duration_ms: durationMinutes * 60 * 1000,
        active_task_id: timer.taskId,
        entry_source: 'timer',
        entry_project: newBlock.project,
        entry_category: newBlock.category,
        entry_title: newBlock.title,
      },
    });
    showToast(
      `Saved ${durationMinutes}m block + ${activeApp} document trace for "${newBlock.title}".`
    );
  };

  // Manual or Live App + Document Window Switch Logger (Track 2 & 3)
  const handleLogAppDocSwitch = (appName: string, documentTitle: string) => {
    const cleanApp = appName.trim() || 'VS Code';
    const cleanDoc = documentTitle.trim() || `${cleanApp} Active Window`;
    const nowMin = Math.min(
      preferences.workdayEndHour * 60,
      Math.max(preferences.workdayStartHour * 60 + 15, getCurrentMinuteOfDay())
    );
    const startMin = Math.max(0, nowMin - 15);
    const ts = Date.now();

    const newAppSeg: ApplicationUsageSegment = {
      id: `app-${ts}`,
      date: selectedDate,
      startTime: startMin,
      endTime: nowMin,
      appName: cleanApp,
      appCategory: inferAppCategory(cleanApp),
    };

    const domainOrPath =
      cleanApp === 'Google Chrome' || cleanApp === 'OnTrack Web'
        ? 'browser.active/tab'
        : `~/workspace/${cleanDoc.split(' ')[0].replace(/[^a-zA-Z0-9._/-]/g, '')}`;

    const newDocSeg: DocumentUsageSegment = {
      id: `doc-${ts}`,
      date: selectedDate,
      startTime: startMin,
      endTime: nowMin,
      appName: cleanApp,
      documentTitle: cleanDoc,
      domainOrPath,
      linkedTaskId: timer.taskId,
    };

    setAppSegments((prev) => [...prev, newAppSeg]);
    setDocumentSegments((prev) => [...prev, newDocSeg]);
    void persistTrackingEvent({
      type: cleanApp === 'Google Chrome' ? 'activity.browser' : 'activity.window',
      priority: 'activity',
      eventTimeUtc: buildTimeBlockStartTimestampUtc(selectedDate, startMin),
      payload: {
        app: cleanApp,
        window_title: cleanDoc,
        file_path: domainOrPath,
        duration_ms: 15 * 60 * 1000,
        active_task_id: timer.taskId,
      },
    });
    showToast(`Recorded ${cleanApp} session: "${cleanDoc}"`);
  };

  // Simulate Idle Prompt (for immediate testing)
  const handleSimulateIdle = () => {
    const startMin = 15 * 60 + 45; // 15:45
    const endMin = 16 * 60 + 10; // 16:10 (25m idle gap)
    setIdleAlert({
      isOpen: true,
      idleStartedAtMs: Date.now() - 25 * 60 * 1000,
      idleDurationSeconds: 25 * 60,
      activeTaskTitle:
        timer.customTitle || 'Architect multi-track timeline query indexer',
      startMinuteOfDay: startMin,
      endMinuteOfDay: endMin,
    });
  };

  // Idle Reconciliation Actions
  const handleDiscardIdle = () => {
    const deductSec = idleAlert.idleDurationSeconds;
    if (timer.isRunning) {
      setTimer((prev) => ({
        ...prev,
        accumulatedSeconds: Math.max(0, prev.accumulatedSeconds - deductSec),
        startedAtMs: prev.isPaused ? null : Date.now(),
      }));
    }
    const newSeg: ActivitySegment = {
      id: `seg-${Date.now()}`,
      date: selectedDate,
      startTime: idleAlert.startMinuteOfDay,
      endTime: idleAlert.endMinuteOfDay,
      state: 'away',
      label: 'Trimmed Idle Time (Marked Away)',
      reconciled: true,
    };
    setActivitySegments((prev) => [
      ...prev.map((s) =>
        s.date === selectedDate && !s.reconciled ? { ...s, reconciled: true } : s
      ),
      newSeg,
    ]);
    lastActivityMsRef.current = Date.now();
    setIdleSeconds(0);
    setIdleAlert((prev) => ({ ...prev, isOpen: false }));
    void persistTrackingEvent({
      type: 'activity.idle',
      priority: 'activity',
      eventTimeUtc: buildTimeBlockStartTimestampUtc(selectedDate, idleAlert.startMinuteOfDay),
      payload: {
        app: 'Workstation',
        window_title: 'Trimmed Idle Time (Marked Away)',
        idle: true,
        duration_ms: Math.max(15, idleAlert.endMinuteOfDay - idleAlert.startMinuteOfDay) * 60 * 1000,
      },
    });
    showToast('Idle interval trimmed and marked as Away on Track 1.');
  };

  const handleKeepIdleAsActive = () => {
    const newSeg: ActivitySegment = {
      id: `seg-${Date.now()}`,
      date: selectedDate,
      startTime: idleAlert.startMinuteOfDay,
      endTime: idleAlert.endMinuteOfDay,
      state: 'active',
      label: 'Confirmed Active Desk Session',
      reconciled: true,
    };
    setActivitySegments((prev) => [
      ...prev.map((s) =>
        s.date === selectedDate && !s.reconciled ? { ...s, reconciled: true } : s
      ),
      newSeg,
    ]);
    lastActivityMsRef.current = Date.now();
    setIdleSeconds(0);
    setIdleAlert((prev) => ({ ...prev, isOpen: false }));
    void persistTrackingEvent({
      type: 'activity.window',
      priority: 'activity',
      eventTimeUtc: buildTimeBlockStartTimestampUtc(selectedDate, idleAlert.startMinuteOfDay),
      payload: {
        app: timer.activeAppName || 'OnTrack Web',
        window_title: idleAlert.activeTaskTitle || 'Confirmed Active Desk Session',
        idle: false,
        duration_ms: Math.max(15, idleAlert.endMinuteOfDay - idleAlert.startMinuteOfDay) * 60 * 1000,
        active_task_id: timer.taskId,
      },
    });
    showToast('Idle interval confirmed as active work time.');
  };

  const handleReassignIdle = (payload: {
    title: string;
    project: string;
    category: WorkCategory;
    notes: string;
  }) => {
    const durationMinutes = Math.max(
      15,
      idleAlert.endMinuteOfDay - idleAlert.startMinuteOfDay
    );
    const reconciledBlock: TimeBlock = {
      id: `blk-${Date.now()}`,
      taskId: null,
      title: payload.title,
      project: payload.project,
      category: payload.category,
      tags: ['reconciled', 'offline-sync'],
      date: selectedDate,
      startTime: idleAlert.startMinuteOfDay,
      endTime: idleAlert.startMinuteOfDay + durationMinutes,
      durationMinutes,
      source: 'reconciled',
      isBillable: payload.category === 'billable',
      notes: payload.notes,
    };

    setTimeBlocks((prev) => [...prev, reconciledBlock]);
    setActivitySegments((prev) =>
      prev.map((s) =>
        s.date === selectedDate && !s.reconciled
          ? { ...s, state: 'active', reconciled: true, label: payload.title }
          : s
      )
    );
    lastActivityMsRef.current = Date.now();
    setIdleSeconds(0);
    setIdleAlert((prev) => ({ ...prev, isOpen: false }));
    void persistTrackingEvent({
      type: 'activity.window',
      priority: 'activity',
      eventTimeUtc: buildTimeBlockStartTimestampUtc(selectedDate, idleAlert.startMinuteOfDay),
      payload: {
        app: 'OnTrack Reconciled',
        window_title: `${payload.project} · ${payload.title}`,
        idle: false,
        duration_ms: durationMinutes * 60 * 1000,
        entry_source: 'reconciled',
        entry_project: payload.project,
        entry_category: payload.category,
        entry_title: payload.title,
      },
    });
    showToast(`Reconciled away interval into "${payload.title}".`);
  };

  // Save or Update Timeline Block from QuickLogModal
  const handleSaveTimeBlock = (
    blockData: Omit<TimeBlock, 'id'>,
    existingId?: string
  ) => {
    if (existingId) {
      const updatedBlock: TimeBlock = { ...blockData, id: existingId };
      setTimeBlocks((prev) =>
        prev.map((b) => (b.id === existingId ? updatedBlock : b))
      );
      void persistTrackingEvent({
        type: 'activity.window',
        priority: 'activity',
        eventTimeUtc: buildTimeBlockStartTimestampUtc(blockData.date, blockData.startTime),
        payload: {
          app: blockData.appName || 'OnTrack Manual',
          window_title: blockData.documentTitle || blockData.title,
          duration_ms: blockData.durationMinutes * 60 * 1000,
          active_task_id: blockData.taskId,
          entry_source: blockData.source === 'timer' ? 'timer' : 'manual',
          entry_project: blockData.project,
          entry_category: blockData.category,
          entry_title: blockData.title,
        },
      });
      showToast(`Updated timeline block "${blockData.title}".`);
    } else {
      const created: TimeBlock = {
        ...blockData,
        id: `blk-${Date.now()}`,
      };
      setTimeBlocks((prev) => [...prev, created]);
      setSelectedDate(blockData.date);
      void persistTrackingEvent({
        type: 'activity.window',
        priority: 'activity',
        eventTimeUtc: buildTimeBlockStartTimestampUtc(blockData.date, blockData.startTime),
        payload: {
          app: blockData.appName || 'OnTrack Manual',
          window_title: blockData.documentTitle || blockData.title,
          duration_ms: blockData.durationMinutes * 60 * 1000,
          active_task_id: blockData.taskId,
          entry_source: blockData.source === 'timer' ? 'timer' : 'manual',
          entry_project: blockData.project,
          entry_category: blockData.category,
          entry_title: blockData.title,
        },
      });
      showToast(`Logged ${blockData.durationMinutes}m to ${blockData.date}.`);
    }
  };

  const handleDeleteTimeBlock = (blockId: string) => {
    setTimeBlocks((prev) => prev.filter((b) => b.id !== blockId));
    showToast('Timeline block removed.');
  };

  // Task CRUD Handlers (Optimistic UI + Engine DB Sync)
  const handleCreateTask = (newTaskData: Omit<Task, 'id' | 'createdAt'>) => {
    const tempId = `tsk-${Date.now()}`;
    const created: Task = {
      ...newTaskData,
      id: tempId,
      createdAt: todayDate,
    };
    setTasks((prev) => [created, ...prev]);

    if (user && activeRole !== 'client') {
      void createEngineTaskApi({
        tenantId: user.tenantId,
        project: newTaskData.project,
        clientName: newTaskData.project,
        title: newTaskData.title,
        status: newTaskData.status,
        estimatedMinutes: newTaskData.estimatedMinutes,
        dueDateUtc: newTaskData.dueDate
          ? `${newTaskData.dueDate}T17:00:00.000Z`
          : new Date().toISOString(),
        assignedUserId: user.userId,
        period: new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      })
        .then(({ task: serverTask }: { task: EngineTask }) => {
          const mapped = mapEngineTaskToWorkspaceTask(
            serverTask,
            created,
            hierarchyBoardsRef.current
          );
          setEngineTaskVersions((prev) => ({ ...prev, [serverTask.id]: serverTask.version }));
          setTasks((prev) =>
            prev.map((t) => (t.id === tempId ? mapped : t))
          );
        })
        .catch(() => {
          showToast('Saved locally; server sync will retry when online.');
        });
    }
    showToast(`Task "${created.title}" added to ${created.project}.`);
  };

  const handleUpdateTask = (taskId: string, updates: Partial<Task>) => {
    const previousTask = tasks.find((t) => t.id === taskId);
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, ...updates } : t))
    );

    if (user && activeRole !== 'client') {
      const isServerTask =
        engineTaskVersions[taskId] !== undefined ||
        taskId.startsWith('tsk-eng-') ||
        taskId.startsWith('demo_tsk_');
      if (isServerTask) {
        const expectedVersion = engineTaskVersions[taskId];
        void updateEngineTaskApi(taskId, {
          title: updates.title,
          status: updates.status,
          estimatedMinutes: updates.estimatedMinutes,
          dueDateUtc: updates.dueDate ? `${updates.dueDate}T17:00:00.000Z` : undefined,
        })
          .then(({ task: updatedServer }) => {
            setEngineTaskVersions((prev) => ({
              ...prev,
              [updatedServer.id]: updatedServer.version,
            }));
          })
          .catch(() => undefined);

        if (updates.status && previousTask && updates.status !== previousTask.status) {
          void persistTrackingEvent({
            type: 'state.task_status',
            priority: 'state',
            payload: {
              task_id: taskId,
              from_value: previousTask.status,
              to_value: updates.status,
              expected_version: expectedVersion,
              actor_role: activeRole,
            },
          });
        }
      }
    }
  };

  const handleDeleteTask = (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    if (user && activeRole !== 'client') {
      const isServerTask =
        engineTaskVersions[taskId] !== undefined ||
        taskId.startsWith('tsk-eng-') ||
        taskId.startsWith('demo_tsk_');
      if (isServerTask) {
        void deleteEngineTaskApi(taskId).catch(() => undefined);
      }
    }
    showToast('Task deleted.');
  };

  // JSON Export & Import Handlers
  const handleExportJson = () => {
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      tasks,
      timeBlocks,
      activitySegments,
      appSegments,
      documentSegments,
      reports,
      preferences,
      workspaceHierarchy,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ontrack-workspace-backup-${todayDate}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported JSON workspace backup.');
  };

  const handleImportJson = (jsonText: string): boolean => {
    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed.tasks) && Array.isArray(parsed.timeBlocks)) {
        const nextActivity = Array.isArray(parsed.activitySegments)
          ? parsed.activitySegments
          : activitySegments;
        const nextApp = Array.isArray(parsed.appSegments)
          ? parsed.appSegments
          : appSegments;
        const nextDoc = Array.isArray(parsed.documentSegments)
          ? parsed.documentSegments
          : documentSegments;
        const nextReports = Array.isArray(parsed.reports)
          ? parsed.reports
          : reports;

        setTasks(parsed.tasks);
        setTimeBlocks(parsed.timeBlocks);
        setActivitySegments(nextActivity);
        setAppSegments(nextApp);
        setDocumentSegments(nextDoc);
        setReports(nextReports);
        if (
          parsed.workspaceHierarchy &&
          Array.isArray(parsed.workspaceHierarchy.spaces) &&
          Array.isArray(parsed.workspaceHierarchy.folders) &&
          Array.isArray(parsed.workspaceHierarchy.boards)
        ) {
          setWorkspaceHierarchy(parsed.workspaceHierarchy);
        }

        showToast('Workspace state restored from JSON backup.');
        return true;
      }
      return false;
    } catch {
      return false;
    }
  };

  const handleResetToSeed = () => {
    const canLoadDemo = demoModeEnabled && (!user || user.isDemoSandbox);
    if (canLoadDemo) {
      const demo = createDemoWorkspaceDataset(weekDates);
      setTasks(demo.tasks);
      setTimeBlocks(demo.timeBlocks);
      setActivitySegments(demo.activitySegments);
      setAppSegments(demo.appSegments);
      setDocumentSegments(demo.documentSegments);
      setReports(demo.reports);
      setWorkspaceHierarchy(createDefaultWorkspaceHierarchy());
      if (user) {
        void hydrateFromEngine(user, activeRole);
      }
      showToast('Loaded 7-day sample accounting dataset.');
      return;
    }

    const empty = createEmptyWorkspaceDataset();
    setTasks(empty.tasks);
    setTimeBlocks(empty.timeBlocks);
    setActivitySegments(empty.activitySegments);
    setAppSegments(empty.appSegments);
    setDocumentSegments(empty.documentSegments);
    setReports(empty.reports);
    setWorkspaceHierarchy(createDefaultWorkspaceHierarchy());
    if (user && activeRole !== 'client') {
      void hydrateFromEngine(user, activeRole);
    }
    showToast('Cleared local browser draft cache and synced from server.');
  };

  if (!authReady) {
    return (
      <div className={preferences.darkMode ? 'dark' : ''}>
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex items-center justify-center px-6">
          <div className="text-center space-y-2">
            <div className="font-display text-lg font-bold tracking-tight">OnTrack</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Initializing workspace session...
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (showLanding && !user) {
    return (
      <LandingPage
        authReady={authReady}
        authError={authError}
        needsInitialSetup={needsInitialSetup}
        demoModeEnabled={demoModeEnabled}
        demoAccounts={demoAccounts}
        darkMode={preferences.darkMode}
        onToggleTheme={() =>
          setPreferences((prev) => ({ ...prev, darkMode: !prev.darkMode }))
        }
        onLogin={handleLogin}
        onDemoLogin={handleDemoLogin}
        onBootstrapFirm={handleBootstrapFirm}
        onContinueLocal={() => {
          lastActivityMsRef.current = Date.now();
          setIdleSeconds(0);
          setShowLanding(false);
        }}
      />
    );
  }

  return (
    <div className={preferences.darkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
        {/* Strict 3-Zone Top Bar Contract */}
        <TopBar
          activeTab={effectiveTab}
          onSelectTab={(nextTab) => {
            if (nextTab === 'autotrack') {
              setAutoTrackNav((prev) => ({
                key: prev.key + 1,
                subTab: activeRole === 'admin_it' ? 'capture' : 'review',
                targetUserId: undefined,
                drilldown: false,
              }));
            }
            navigateTab(nextTab);
          }}
          onOpenQuickLog={() => {
            setEditingBlock(null);
            setQuickLogRange(null);
            setQuickLogTask(null);
            setInitialAppDoc(null);
            setQuickLogOpen(true);
          }}
          user={user}
          userProfile={userProfile}
          activeRole={activeRole}
          canSwitchPreviewRole={canSwitchPreviewRole}
          onChangePreviewRole={(nextRole) => {
            setPreviewRoleOverride(nextRole);
            setActiveTab(getRolePolicy(nextRole).defaultTab);
            setAutoTrackNav((prev) => ({
              key: prev.key + 1,
              subTab: nextRole === 'admin_it' ? 'capture' : 'review',
              targetUserId: undefined,
              drilldown: false,
            }));
          }}
          onOpenAccount={() => setAccountModalOpen(true)}
          onSignOut={handleSignOut}
        />

        {/* Global Active Task Timer & Workstation Presence Sensor Strip (Accountant & Team Lead only) */}
        {rolePolicy.showTimerBar && (
          <ActiveTimerBar
            timer={timer}
            elapsedSeconds={elapsedSeconds}
            tasks={tasks}
            selectedDate={selectedDate}
            weekDates={weekDates}
            idleSeconds={idleSeconds}
            preferences={preferences}
            onSelectDate={setSelectedDate}
            onStartTimer={handleStartTimer}
            onPauseTimer={handlePauseTimer}
            onResumeTimer={handleResumeTimer}
            onStopAndSaveTimer={handleStopAndSaveTimer}
            onUpdateTimerMeta={(updates) =>
              setTimer((prev) => ({ ...prev, ...updates }))
            }
            onLogAppDocSwitch={handleLogAppDocSwitch}
            onSimulateIdle={handleSimulateIdle}
            onOpenPreferences={() => setPrefsModalOpen(true)}
            onToggleTheme={() => {
              setPreferences((prev) => ({ ...prev, darkMode: !prev.darkMode }));
            }}
          />
        )}

        {/* Toast Notification Banner */}
        {toastBanner && (
          <div className="no-print fixed bottom-5 right-5 z-40 bg-slate-900 dark:bg-indigo-600 text-white text-xs font-medium px-4 py-2.5 rounded-lg shadow-lg border border-slate-700">
            {toastBanner}
          </div>
        )}

        {/* Unresolved Sync Conflict Banner (SYNC-6) */}
        {syncConflicts.length > 0 && activeRole !== 'client' && (
          <div className="no-print bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 px-6 py-2">
            <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-amber-900 dark:text-amber-200 font-medium">
                {syncConflicts.length} unresolved task sync conflict
                {syncConflicts.length === 1 ? '' : 's'} detected across offline edits.
              </span>
              <button
                type="button"
                onClick={() => {
                  setAutoTrackNav((prev) => ({
                    key: prev.key + 1,
                    subTab: 'review',
                  }));
                  navigateTab('autotrack');
                }}
                className="px-2.5 py-1 font-semibold bg-amber-600 text-white rounded hover:bg-amber-500 cursor-pointer"
              >
                Review &amp; Resolve in Auto-Track
              </button>
            </div>
          </div>
        )}

        {/* Engine Sync Status Error Banner */}
        {engineSyncStatus === 'error' && user && activeRole !== 'client' && (
          <div className="no-print bg-slate-100 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 py-2">
            <div className="max-w-[1440px] mx-auto flex items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-300">
              <span>Offline or reconnecting to OnTrack engine database; local edits remain queued.</span>
              <button
                type="button"
                onClick={() => void hydrateFromEngine(user, activeRole)}
                className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
              >
                Retry Sync
              </button>
            </div>
          </div>
        )}

        {/* Main 1440px Workspace Viewport */}
        <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 py-6">
          {user && !user.mfaVerified ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 max-w-xl mx-auto space-y-4">
              <div className="space-y-1.5">
                <h1 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                  Two-Factor Authenticator Setup Required
                </h1>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Signed in as <span className="font-mono font-semibold">{user.email}</span> ({rolePolicy.label}). Complete TOTP authenticator setup before accessing firm workspace data.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setAccountModalOpen(true)}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
                >
                  Set Up 2FA Authenticator
                </button>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
                >
                  Sign Out
                </button>
              </div>
            </div>
          ) : (
            <>
          {(effectiveTab === 'overview' || effectiveTab === 'admin') && (
            <RoleDashboardView
              activeRole={activeRole}
              currentUser={user}
              onInspectStaffTimeline={(targetUserId) => {
                setAutoTrackNav((prev) => ({
                  key: prev.key + 1,
                  subTab: 'review',
                  targetUserId,
                  drilldown: true,
                }));
                setActiveTab('autotrack');
              }}
              onOpenAutoTrackConfig={() => {
                setAutoTrackNav((prev) => ({
                  key: prev.key + 1,
                  subTab: 'packages',
                  targetUserId: undefined,
                  drilldown: false,
                }));
                setActiveTab('autotrack');
              }}
              onOpenAccount={() => setAccountModalOpen(true)}
              onNotify={showToast}
            />
          )}

          {effectiveTab === 'portal' && (
            <ClientPortalView
              key={`${user?.userId || 'anon'}-${activeRole}`}
              currentUser={user}
              activeRole={activeRole}
              demoModeEnabled={demoModeEnabled}
              demoAccounts={demoAccounts}
              onDemoLogin={handleDemoLogin}
              onReturnAdmin={() => {
                setPreviewRoleOverride('admin_it');
                setActiveTab('admin');
              }}
              onOpenAccount={() => setAccountModalOpen(true)}
              onNotify={showToast}
            />
          )}

          {effectiveTab === 'timeline' && (
            <TimelineView
              selectedDate={selectedDate}
              weekDates={weekDates}
              timeBlocks={timeBlocks}
              activitySegments={activitySegments}
              appSegments={appSegments}
              documentSegments={documentSegments}
              tasks={tasks}
              onSelectDate={setSelectedDate}
              onOpenQuickLogWithRange={(startTime, endTime) => {
                setEditingBlock(null);
                setQuickLogTask(null);
                setInitialAppDoc(null);
                setQuickLogRange({ startTime, endTime });
                setQuickLogOpen(true);
              }}
              onConvertAppDocToBlock={(doc) => {
                setEditingBlock(null);
                setQuickLogTask(null);
                setQuickLogRange(null);
                setInitialAppDoc(doc);
                setQuickLogOpen(true);
              }}
              onEditTimeBlock={(block) => {
                setEditingBlock(block);
                setQuickLogRange(null);
                setQuickLogTask(null);
                setInitialAppDoc(null);
                setQuickLogOpen(true);
              }}
              onDeleteTimeBlock={handleDeleteTimeBlock}
              onStartTimerForTask={(taskId) => handleStartTimer(taskId)}
              onReconcileSegment={(segment) => {
                setIdleAlert({
                  isOpen: true,
                  idleStartedAtMs: Date.now() - 15 * 60 * 1000,
                  idleDurationSeconds:
                    (segment.endTime - segment.startTime) * 60,
                  activeTaskTitle: segment.label,
                  startMinuteOfDay: segment.startTime,
                  endMinuteOfDay: segment.endTime,
                });
              }}
            />
          )}

          {effectiveTab === 'tasks' && (
            <TaskWorkspaceView
              tasks={tasks}
              timeBlocks={timeBlocks}
              hierarchy={workspaceHierarchy}
              selectedDate={selectedDate}
              activeTimerTaskId={timer.taskId}
              isTimerRunning={timer.isRunning && !timer.isPaused}
              onUpdateHierarchy={setWorkspaceHierarchy}
              onNotify={showToast}
              onStartTimerForTask={(taskId) => handleStartTimer(taskId)}
              onPauseTimer={handlePauseTimer}
              onCreateTask={handleCreateTask}
              onUpdateTask={handleUpdateTask}
              onDeleteTask={handleDeleteTask}
              onOpenQuickLogForTask={(task) => {
                setEditingBlock(null);
                setQuickLogRange(null);
                setInitialAppDoc(null);
                setQuickLogTask(task);
                setQuickLogOpen(true);
              }}
              onOpenQuickLogForDate={(date) => {
                setSelectedDate(date);
                setEditingBlock(null);
                setQuickLogTask(null);
                setInitialAppDoc(null);
                setQuickLogRange({ startTime: 9 * 60, endTime: 10 * 60 });
                setQuickLogOpen(true);
              }}
              onJumpToTimelineDate={(date) => {
                setSelectedDate(date);
                setActiveTab(
                  rolePolicy.allowedTabs.some((t) => t.id === 'timeline')
                    ? 'timeline'
                    : rolePolicy.defaultTab
                );
              }}
            />
          )}

          {effectiveTab === 'autotrack' && (
            <AutoTrackView
              key={`${activeRole}-${autoTrackNav.key}`}
              selectedDate={selectedDate}
              currentUser={user}
              forcedRole={activeRole}
              initialSubTab={
                autoTrackNav.subTab || (activeRole === 'admin_it' ? 'capture' : 'review')
              }
              initialTargetUserId={autoTrackNav.targetUserId}
              initialDrilldown={autoTrackNav.drilldown}
              autoSyncToTimeline={autoSyncToTimeline}
              onToggleAutoSyncToTimeline={setAutoSyncToTimeline}
              onSyncEngineSessionsToTimeline={handleSyncEngineSessionsToTimeline}
              onNotify={showToast}
              onOpenAccount={() => setAccountModalOpen(true)}
              onPushConfirmedToTimeline={({ session, title, project, category, notes }) => {
                const startDateObj = new Date(session.startTimeUtc);
                const endDateObj = new Date(session.endTimeUtc);
                const startMin = Math.max(
                  0,
                  Math.min(1425, startDateObj.getHours() * 60 + startDateObj.getMinutes())
                );
                const rawDur = Math.max(
                  15,
                  Math.round((endDateObj.getTime() - startDateObj.getTime()) / 60000)
                );
                const endMin = Math.min(1440, startMin + rawDur);
                const ts = Date.now();
                const dateStr = selectedDate;

                const newBlock: TimeBlock = {
                  id: `blk-eng-${ts}`,
                  taskId: null,
                  title,
                  project,
                  category,
                  tags: ['auto-tracked', session.osPlatform],
                  date: dateStr,
                  startTime: startMin,
                  endTime: endMin,
                  durationMinutes: endMin - startMin,
                  source: 'reconciled',
                  isBillable: category === 'billable',
                  notes,
                  appName: session.primaryApp,
                  documentTitle: session.primaryTitle,
                };
                const newAppSeg: ApplicationUsageSegment = {
                  id: `app-eng-${ts}`,
                  date: dateStr,
                  startTime: startMin,
                  endTime: endMin,
                  appName: session.primaryApp,
                  appCategory: inferAppCategory(session.primaryApp),
                };
                const newDocSeg: DocumentUsageSegment = {
                  id: `doc-eng-${ts}`,
                  date: dateStr,
                  startTime: startMin,
                  endTime: endMin,
                  appName: session.primaryApp,
                  documentTitle: session.primaryTitle,
                  domainOrPath:
                    session.primaryUrl || session.primaryPath || session.primaryApp,
                  linkedTaskId: null,
                };

                setTimeBlocks((prev) => [...prev, newBlock]);
                setAppSegments((prev) => [...prev, newAppSeg]);
                setDocumentSegments((prev) => [...prev, newDocSeg]);
                showToast(`Pushed "${title}" (${endMin - startMin}m) to Day Timeline.`);
              }}
            />
          )}

          {effectiveTab === 'report' && (
            <WeeklyReportView
              weekDates={weekDates}
              tasks={tasks}
              timeBlocks={timeBlocks}
              appSegments={appSegments}
              documentSegments={documentSegments}
              reports={reports}
              activeRole={activeRole}
              currentUser={user}
              onSaveReport={(newReport) => {
                setReports((prev) => [newReport, ...prev]);
              }}
            />
          )}

          {effectiveTab === 'analytics' && (
            <AnalyticsView
              weekDates={weekDates}
              tasks={tasks}
              timeBlocks={timeBlocks}
              activitySegments={activitySegments}
              appSegments={appSegments}
              documentSegments={documentSegments}
              activeRole={activeRole}
              currentUser={user}
              onSelectDateAndGoToTimeline={(date) => {
                setSelectedDate(date);
                setActiveTab(
                  rolePolicy.allowedTabs.some((t) => t.id === 'timeline')
                    ? 'timeline'
                    : rolePolicy.defaultTab
                );
              }}
            />
          )}
            </>
          )}
        </main>

        {/* Quiet Utilitarian Footer */}
        <footer className="no-print border-t border-slate-200 dark:border-slate-800 px-6 py-4 text-xs text-slate-500 dark:text-slate-400">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-4">
            <span>
              OnTrack Workspace · {rolePolicy.label} ·{' '}
              {user
                ? `Synced as ${user.email}`
                : 'Local browser mode (Sign in to sync across devices)'}
            </span>
            <div className="flex items-center gap-4">
              {!user && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowLanding(true)}
                    className="hover:text-slate-900 dark:hover:text-white underline cursor-pointer"
                  >
                    Landing Page
                  </button>
                  <span>·</span>
                </>
              )}
              <button
                type="button"
                onClick={() => setAccountModalOpen(true)}
                className="hover:text-slate-900 dark:hover:text-white underline cursor-pointer"
              >
                {user ? 'Account Settings' : 'Sign In & Sync'}
              </button>
              {activeRole !== 'client' && (
                <>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={handleExportJson}
                    className="hover:text-slate-900 dark:hover:text-white underline cursor-pointer"
                  >
                    Export JSON Backup
                  </button>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={() => setPrefsModalOpen(true)}
                    className="hover:text-slate-900 dark:hover:text-white underline cursor-pointer"
                  >
                    Idle Sensor Settings
                  </button>
                </>
              )}
            </div>
          </div>
        </footer>

        {/* Modals */}
        <IdleReconcileModal
          idleAlert={idleAlert}
          onDiscardIdle={handleDiscardIdle}
          onKeepAsActive={handleKeepIdleAsActive}
          onReassignIdle={handleReassignIdle}
          onClose={() => setIdleAlert((prev) => ({ ...prev, isOpen: false }))}
        />

        {quickLogOpen && (
          <QuickLogModal
            key={`${editingBlock?.id || quickLogTask?.id || initialAppDoc?.documentTitle || quickLogRange?.startTime || 'new'}-${selectedDate}`}
            isOpen={quickLogOpen}
            selectedDate={selectedDate}
            weekDates={weekDates}
            tasks={tasks}
            initialBlock={editingBlock}
            initialRange={quickLogRange}
            initialTask={quickLogTask}
            initialAppDoc={initialAppDoc}
            onSaveBlock={handleSaveTimeBlock}
            onClose={() => setQuickLogOpen(false)}
          />
        )}

        <DataPreferencesModal
          isOpen={prefsModalOpen}
          preferences={preferences}
          demoModeEnabled={demoModeEnabled && (!user || Boolean(user.isDemoSandbox))}
          onUpdatePreferences={(updates) => {
            setPreferences((prev) => ({ ...prev, ...updates }));
          }}
          onExportJson={handleExportJson}
          onImportJson={handleImportJson}
          onResetToSeed={handleResetToSeed}
          onClose={() => setPrefsModalOpen(false)}
        />

        {accountModalOpen && (
          <AccountModal
            key={user?.userId || 'anon'}
            isOpen={accountModalOpen}
            user={user}
            userProfile={userProfile}
            authReady={authReady}
            needsInitialSetup={needsInitialSetup}
            demoModeEnabled={demoModeEnabled}
            demoAccounts={demoAccounts}
            authError={authError}
            onLogin={handleLogin}
            onDemoLogin={handleDemoLogin}
            onBootstrapFirm={handleBootstrapFirm}
            onSignOut={handleSignOut}
            onSaveProfile={handleSaveProfile}
            onRefreshSession={refreshAuthSession}
            onExportJson={handleExportJson}
            onOpenPreferences={() => setPrefsModalOpen(true)}
            onClose={() => setAccountModalOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
