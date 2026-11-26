/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AuthUser,
  DemoAccountSummary,
  bootstrapFirmAdmin,
  fetchAuthSession,
  fetchBootstrapStatus,
  fetchDemoAccounts,
  loginWithAccessKeyApi,
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
import {
  AttributionRecord,
  ClientDictionaryEntry,
  DeviceFreshnessRecord,
  EngineTask,
  LiveActivitySnapshot,
  PrivacyRule,
  ShiftUser,
  SyncConflict,
  TaskCollaborationInvite,
  UserRole,
  WorkSession,
} from './engine/types';
import {
  buildLocalTrackingEvent,
  createEngineTaskApi,
  deleteEngineTaskApi,
  fetchEngineSnapshot,
  filterAndEnqueueEvent,
  flushQueuedEventsOverHttp,
  getOrCreateLocalDeviceId,
  inviteTaskCollaboratorApi,
  removeTaskCollaboratorApi,
  resolveAttributionApi,
  respondTaskInviteApi,
  updateAppColorsApi,
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
  const weekDates = useMemo(() => getRecentWeekDates(), []);
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

  // Automatic Browser Activity & Idle Presence Tracking
  const lastActivityMsRef = useRef<number>(0);
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

  // Live Engine Sync State (Tasks, Sessions, Conflicts, Privacy Rules, Collaboration)
  const [enginePrivacyRules, setEnginePrivacyRules] = useState<PrivacyRule[]>([]);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [staffUsers, setStaffUsers] = useState<ShiftUser[]>([]);
  const [taskInvites, setTaskInvites] = useState<TaskCollaborationInvite[]>([]);
  const [engineDevices, setEngineDevices] = useState<DeviceFreshnessRecord[]>([]);
  const [engineSessions, setEngineSessions] = useState<WorkSession[]>([]);
  const [engineAttributions, setEngineAttributions] = useState<AttributionRecord[]>([]);
  const [engineClients, setEngineClients] = useState<ClientDictionaryEntry[]>([]);
  const [engineTaskVersions, setEngineTaskVersions] = useState<Record<string, number>>({});
  const [appColors, setAppColors] = useState<Record<string, string>>({});
  const [liveActivity, setLiveActivity] = useState<LiveActivitySnapshot | null>(null);
  const liveActivityRef = useRef<LiveActivitySnapshot | null>(null);
  const [engineSyncStatus, setEngineSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle');
  const demoSeedAppliedRef = useRef(false);
  const hierarchyBoardsRef = useRef(workspaceHierarchy.boards);
  const pendingTaskMetaRef = useRef<Map<string, Task>>(new Map());
  const pendingTaskTempBySigRef = useRef<Map<string, string>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const lastHydrateTriggerMsRef = useRef<number>(0);
  useEffect(() => {
    liveActivityRef.current = liveActivity;
  }, [liveActivity]);
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
    setStaffUsers([]);
    setTaskInvites([]);
    setEngineDevices([]);
    setEngineSessions([]);
    setEngineAttributions([]);
    setEngineClients([]);
    setEngineTaskVersions({});
    setAppColors({});
    setLiveActivity(null);
    setEngineSyncStatus('idle');
    demoSeedAppliedRef.current = false;
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
      if (
        !currentUser ||
        currentUser.mustSetPassword ||
        !currentUser.mfaVerified ||
        role === 'client'
      ) {
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
        setStaffUsers(snapshot.staffUsers || []);
        setTaskInvites(snapshot.taskInvites || []);
        setEngineDevices(snapshot.devices || []);
        setEngineSessions(snapshot.sessions || []);
        setEngineAttributions(snapshot.attributions || []);
        setEngineClients(snapshot.clients || []);
        setAppColors(snapshot.config?.appColors || {});
        const versionMap: Record<string, number> = {};
        for (const t of snapshot.tasks) {
          versionMap[t.id] = t.version;
        }
        setEngineTaskVersions(versionMap);

        const latest = latestWorkspaceRef.current;
        const matchedTempIds = new Set<string>();
        const enrichedExisting = latest.tasks.map((t) => {
          const override = pendingTaskMetaRef.current.get(t.id);
          return override ? { ...t, ...override, id: t.id } : t;
        });

        for (const st of snapshot.tasks) {
          const exactSig = `${st.title.trim().toLowerCase()}::${st.clientName.trim().toLowerCase()}`;
          const titleStatusSig = `${st.title.trim().toLowerCase()}::status:${st.status}`;
          const matchingTempId =
            pendingTaskTempBySigRef.current.get(exactSig) ||
            pendingTaskTempBySigRef.current.get(titleStatusSig);
          if (matchingTempId && !enrichedExisting.some((t) => t.id === st.id)) {
            const pendingMeta = pendingTaskMetaRef.current.get(matchingTempId);
            if (pendingMeta) {
              matchedTempIds.add(matchingTempId);
              enrichedExisting.push({ ...pendingMeta, id: st.id });
            }
          }
        }

        const filteredExisting =
          matchedTempIds.size > 0
            ? enrichedExisting.filter((t) => !matchedTempIds.has(t.id))
            : enrichedExisting;

        const adapted = adaptEngineSnapshotToWorkspace({
          snapshot,
          existingTasks: filteredExisting,
          existingBlocks: latest.timeBlocks,
          existingActivity: latest.activitySegments,
          existingApps: latest.appSegments,
          existingDocs: latest.documentSegments,
          boards: hierarchyBoardsRef.current,
          includeAllSessionBlocks: false,
          isDemoSandbox: Boolean(currentUser.isDemoSandbox),
        });

        const seenTaskIds = new Set<string>();
        const dedupedTasks = adapted.tasks.filter((t) => {
          if (seenTaskIds.has(t.id)) return false;
          seenTaskIds.add(t.id);
          return true;
        });

        setTasks(dedupedTasks);
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

  const refreshAuthSession = useCallback(async (): Promise<AuthUser | null> => {
    let refreshedUser: AuthUser | null = null;
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
        refreshedUser = session.user;
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
    return refreshedUser;
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

      if (user && (user.mustSetPassword || !user.mfaVerified)) {
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
    if (
      !authReady ||
      !user ||
      user.mustSetPassword ||
      !user.mfaVerified ||
      activeRole === 'client'
    ) {
      return;
    }

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
      wsRef.current = ws;
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg.liveActivity && typeof msg.liveActivity === 'object') {
            setLiveActivity(msg.liveActivity as LiveActivitySnapshot);
          }
          if (msg.type === 'state:updated' || msg.type === 'activity:updated') {
            if (msg.livePulseOnly === true) {
              return;
            }
            const nowMs = Date.now();
            const minGap = msg.type === 'state:updated' ? 200 : 1200;
            const elapsed = nowMs - lastHydrateTriggerMsRef.current;
            const delay = elapsed >= minGap ? 150 : minGap - elapsed;
            if (refreshTimer) window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
              lastHydrateTriggerMsRef.current = Date.now();
              void hydrateFromEngine(user, activeRole);
            }, delay);
          }
        } catch {
          // ignore malformed WS frames
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
      };
    } catch {
      // Fall back cleanly if WebSocket unavailable
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      if (refreshTimer) window.clearTimeout(refreshTimer);
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [authReady, user, activeRole, hydrateFromEngine]);

  const emitBrowserLivePulse = useCallback(
    (
      appName: string,
      documentTitle: string,
      state: LiveActivitySnapshot['state'] = 'active',
      domainOrPath: string | null = null,
      source: LiveActivitySnapshot['source'] = 'browser'
    ) => {
      if (activeRole === 'client') return;
      const nowIso = new Date().toISOString();
      const deviceId = getOrCreateLocalDeviceId();
      const prev = liveActivityRef.current;
      const sameOngoing =
        Boolean(prev) &&
        prev!.appName === (appName.trim() || 'OnTrack Web') &&
        prev!.documentTitle === (documentTitle.trim() || appName) &&
        prev!.state === state &&
        Date.now() - Date.parse(prev!.lastSeenUtc) < 90_000;
      const nextSnapshot: LiveActivitySnapshot = {
        tenantId: user?.tenantId || 'local',
        userId: user?.userId || 'local',
        deviceId,
        appName: appName.trim() || 'OnTrack Web',
        documentTitle: documentTitle.trim() || appName,
        domainOrPath,
        state,
        startedAtUtc: sameOngoing ? prev!.startedAtUtc : nowIso,
        lastSeenUtc: nowIso,
        source,
      };
      liveActivityRef.current = nextSnapshot;
      setLiveActivity(nextSnapshot);
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && user) {
        try {
          wsRef.current.send(
            JSON.stringify({
              type: 'live:pulse',
              tenantId: user.tenantId,
              userId: user.userId,
              deviceId,
              liveActivity: nextSnapshot,
            })
          );
        } catch {
          // ignore transient WS send error
        }
      }
    },
    [activeRole, user]
  );

  const handleUpdateAppColors = useCallback(
    async (params: {
      appName?: string;
      color?: string | null;
      appColors?: Record<string, string>;
    }) => {
      if (!user || activeRole === 'client') {
        showToast('Sign in to save firm application colors.');
        return;
      }
      const prev = appColors;
      if (params.appColors) {
        setAppColors(params.appColors);
      } else if (params.appName) {
        setAppColors((curr) => {
          const next = { ...curr };
          if (!params.color) delete next[params.appName!];
          else next[params.appName!] = params.color;
          return next;
        });
      }
      try {
        const res = await updateAppColorsApi({
          tenantId: user.tenantId,
          ...params,
          previewRole: activeRole,
        });
        setAppColors(res.config.appColors || {});
        showToast(
          params.appName
            ? params.color
              ? `Updated firm color for ${params.appName}.`
              : `Reset ${params.appName} to auto-assigned color.`
            : 'Updated firm application palette.'
        );
      } catch (err: any) {
        setAppColors(prev);
        showToast(err?.message || 'Unable to update application color.');
      }
    },
    [user, activeRole, appColors, showToast]
  );

  // Auth & Account Management Handlers
  const handleLogin = async (payload: {
    email: string;
    password: string;
    totpCode?: string;
    backupCode?: string;
    isClientPortal?: boolean;
  }) => {
    setAuthError(null);
    try {
      const trimmedTotp = payload.totpCode?.trim() || '';
      const compactTotp = trimmedTotp.replace(/\s+/g, '');
      const hasSixDigitTotp = /^\d{6}$/.test(compactTotp);
      const res = await loginWithPassword({
        ...payload,
        totpCode: hasSixDigitTotp ? compactTotp : undefined,
        backupCode:
          payload.backupCode?.trim() ||
          (trimmedTotp && !hasSixDigitTotp ? trimmedTotp : undefined),
      });
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
      if (res.user.mustSetPassword || !res.user.mfaVerified) {
        setAccountModalOpen(true);
        showToast('Complete account onboarding (password & 2FA setup) to continue.');
      } else {
        showToast(`Signed in as ${res.user.email}.`);
      }
    } catch (err: any) {
      const msg = err?.message || 'Authentication failed.';
      setAuthError(msg);
      throw err;
    }
  };

  const handleKeyLogin = async (payload: {
    email: string;
    accessKey: string;
  }) => {
    setAuthError(null);
    try {
      const res = await loginWithAccessKeyApi(payload);
      if (res.user.userId !== user?.userId || res.user.tenantId !== user?.tenantId) {
        resetWorkspaceState();
      }
      setUser(res.user);
      setPreviewRoleOverride(null);
      setActiveTab('timeline');
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
      if (res.user.mustSetPassword || !res.user.mfaVerified) {
        setAccountModalOpen(true);
        showToast('Access key verified. Create your password and set up 2FA to open your Timeline.');
      } else {
        showToast(`Signed in as ${res.user.email}.`);
      }
    } catch (err: any) {
      const msg = err?.message || 'Access key verification failed.';
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
    setAuthError(null);
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

  // Background Idle Threshold Sensor (checks every 2s via ref without re-rendering App)
  const idleCheckConfigRef = useRef({
    customTitle: timer.customTitle,
    thresholdSeconds: preferences.idleThresholdSeconds,
    enabled: !idleAlert.isOpen && !(showLanding && !user) && activeRole !== 'client',
  });
  useEffect(() => {
    idleCheckConfigRef.current = {
      customTitle: timer.customTitle,
      thresholdSeconds: preferences.idleThresholdSeconds,
      enabled: !idleAlert.isOpen && !(showLanding && !user) && activeRole !== 'client',
    };
  }, [timer.customTitle, preferences.idleThresholdSeconds, idleAlert.isOpen, showLanding, user, activeRole]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const cfg = idleCheckConfigRef.current;
      if (!cfg.enabled) return;
      const now = Date.now();
      if (lastActivityMsRef.current === 0) {
        lastActivityMsRef.current = now;
        return;
      }
      const inactiveSec = Math.floor((now - lastActivityMsRef.current) / 1000);
      if (inactiveSec >= cfg.thresholdSeconds) {
        const endMin = getCurrentMinuteOfDay();
        const durationMin = Math.max(15, Math.round(inactiveSec / 60));
        const startMin = Math.max(0, endMin - durationMin);
        setIdleAlert({
          isOpen: true,
          idleStartedAtMs: lastActivityMsRef.current,
          idleDurationSeconds: Math.max(inactiveSec, 15 * 60),
          activeTaskTitle: cfg.customTitle || 'Active Workstation Session',
          startMinuteOfDay: startMin,
          endMinuteOfDay: endMin,
        });
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, []);

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
      emitBrowserLivePulse('OnTrack Web', docTitle, 'active', `ontrack.local/${nextTab}`, 'browser');
    },
    [activeRole, rolePolicy.label, selectedDate, todayDate, timer.taskId, emitBrowserLivePulse]
  );

  // Sync active browser focus / visibility changes immediately as live capture signals
  useEffect(() => {
    if (!authReady || !user || user.mustSetPassword || !user.mfaVerified || activeRole === 'client') {
      return;
    }
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        const appName =
          timer.isRunning && !timer.isPaused
            ? timer.activeAppName || 'OnTrack Web'
            : 'OnTrack Web';
        const docTitle =
          timer.isRunning && !timer.isPaused
            ? timer.activeDocumentTitle || timer.customTitle || 'Focused Session'
            : `OnTrack Workspace (${effectiveTab})`;
        emitBrowserLivePulse(appName, docTitle, 'active', `ontrack.local/${effectiveTab}`, 'browser');
      }
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    return () => {
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
    };
  }, [
    authReady,
    user,
    activeRole,
    effectiveTab,
    timer.isRunning,
    timer.isPaused,
    timer.activeAppName,
    timer.activeDocumentTitle,
    timer.customTitle,
    emitBrowserLivePulse,
  ]);

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
    const nextLiveApp = timer.activeAppName || 'VS Code';
    const nextLiveDoc =
      timer.activeDocumentTitle ||
      (foundTask ? `${foundTask.title} — Workspace` : 'Active Document');
    emitBrowserLivePulse(nextLiveApp, nextLiveDoc, 'active', null, 'timer');
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
    emitBrowserLivePulse(
      timer.activeAppName || 'VS Code',
      timer.activeDocumentTitle || timer.customTitle || 'Active Document',
      'active',
      null,
      'timer'
    );
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
    emitBrowserLivePulse(cleanApp, cleanDoc, 'active', domainOrPath, 'browser');
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
  const resolveIdleSegmentOverride = (
    segmentId: string | undefined,
    status: 'confirmed' | 'dismissed',
    reason: string
  ) => {
    if (!user || activeRole === 'client' || !segmentId?.startsWith('seg-eng-sync-')) {
      return;
    }
    const sessionId = segmentId.slice('seg-eng-sync-'.length);
    void resolveAttributionApi({
      tenantId: user.tenantId,
      userId: user.userId,
      sessionId,
      taskId: null,
      status,
      customReason: reason,
    }).catch(() => undefined);
  };

  const handleDiscardIdle = () => {
    const deductSec = idleAlert.idleDurationSeconds;
    const segmentId = idleAlert.segmentId;
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
        (segmentId && s.id === segmentId) || (s.date === selectedDate && !s.reconciled)
          ? { ...s, state: 'away' as const, reconciled: true }
          : s
      ),
      newSeg,
    ]);
    lastActivityMsRef.current = Date.now();
    setIdleAlert((prev) => ({ ...prev, isOpen: false, segmentId: undefined }));
    resolveIdleSegmentOverride(segmentId, 'dismissed', 'Trimmed Idle Time (Marked Away)');
    if (!segmentId?.startsWith('seg-eng-sync-')) {
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
    }
    showToast('Idle interval trimmed and marked as Away on Track 1.');
  };

  const handleKeepIdleAsActive = () => {
    const segmentId = idleAlert.segmentId;
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
        (segmentId && s.id === segmentId) || (s.date === selectedDate && !s.reconciled)
          ? { ...s, state: 'active' as const, reconciled: true }
          : s
      ),
      newSeg,
    ]);
    lastActivityMsRef.current = Date.now();
    setIdleAlert((prev) => ({ ...prev, isOpen: false, segmentId: undefined }));
    resolveIdleSegmentOverride(segmentId, 'confirmed', 'Confirmed Active Desk Session');
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
        entry_source: 'reconciled',
        entry_project: timer.project || 'Accounting',
        entry_category: timer.category || 'billable',
        entry_title: idleAlert.activeTaskTitle || 'Confirmed Active Desk Session',
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
    const segmentId = idleAlert.segmentId;
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
        (segmentId && s.id === segmentId) || (s.date === selectedDate && !s.reconciled)
          ? { ...s, state: 'active', reconciled: true, label: payload.title }
          : s
      )
    );
    lastActivityMsRef.current = Date.now();
    setIdleAlert((prev) => ({ ...prev, isOpen: false, segmentId: undefined }));
    resolveIdleSegmentOverride(segmentId, 'confirmed', `Reconciled as "${payload.title}"`);
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

  const persistEditedEngineBlock = async (
    oldBlockId: string,
    blockData: Omit<TimeBlock, 'id'>
  ) => {
    if (user && activeRole !== 'client' && oldBlockId.startsWith('blk-eng-sync-')) {
      const oldSessionId = oldBlockId.slice('blk-eng-sync-'.length);
      await resolveAttributionApi({
        tenantId: user.tenantId,
        userId: user.userId,
        sessionId: oldSessionId,
        taskId: blockData.taskId,
        status: 'dismissed',
        customReason: `Replaced by edited timeline block "${blockData.title}"`,
      }).catch(() => undefined);
    }
    await persistTrackingEvent({
      type: 'activity.window',
      priority: 'activity',
      eventTimeUtc: buildTimeBlockStartTimestampUtc(blockData.date, blockData.startTime),
      payload: {
        app: blockData.appName || 'OnTrack Manual',
        window_title: blockData.documentTitle || blockData.title,
        duration_ms: blockData.durationMinutes * 60 * 1000,
        active_task_id: blockData.taskId,
        entry_source:
          blockData.source === 'timer'
            ? 'timer'
            : blockData.source === 'reconciled'
            ? 'reconciled'
            : 'manual',
        entry_project: blockData.project,
        entry_category: blockData.category,
        entry_title: blockData.title,
      },
    });
    if (user && activeRole !== 'client') {
      await hydrateFromEngine(user, activeRole);
    }
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
      void persistEditedEngineBlock(existingId, blockData);
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

  const handleQuickUpdateTimeBlock = (updatedBlock: TimeBlock) => {
    setTimeBlocks((prev) =>
      prev.map((b) => (b.id === updatedBlock.id ? updatedBlock : b))
    );
    const { id, ...rest } = updatedBlock;
    void persistEditedEngineBlock(id, rest);
    showToast(`Adjusted "${updatedBlock.title}" (${updatedBlock.durationMinutes}m).`);
  };

  const handleDeleteTimeBlock = (blockId: string) => {
    setTimeBlocks((prev) => prev.filter((b) => b.id !== blockId));
    if (user && activeRole !== 'client' && blockId.startsWith('blk-eng-sync-')) {
      const sessionId = blockId.slice('blk-eng-sync-'.length);
      void resolveAttributionApi({
        tenantId: user.tenantId,
        userId: user.userId,
        sessionId,
        taskId: null,
        status: 'dismissed',
        customReason: 'Deleted from Day Timeline',
      })
        .then(() => hydrateFromEngine(user, activeRole))
        .catch(() => undefined);
    }
    showToast('Timeline block removed.');
  };

  const handleResolveTimelineAttribution = async (params: {
    sessionId: string;
    taskId: string | null;
    status: 'confirmed' | 'dismissed';
  }) => {
    if (!user || activeRole === 'client') return;
    try {
      await resolveAttributionApi({
        tenantId: user.tenantId,
        userId: user.userId,
        sessionId: params.sessionId,
        taskId: params.taskId,
        status: params.status,
      });
      await hydrateFromEngine(user, activeRole);
      showToast(
        params.status === 'confirmed'
          ? 'Session confirmed and added to Track 4 Timeline.'
          : 'Auto-tracked suggestion dismissed.'
      );
    } catch (err: any) {
      showToast(err?.message || 'Unable to update session attribution.');
    }
  };

  // Task CRUD Handlers (Optimistic UI + Engine DB Sync)
  const handleCreateTask = (newTaskData: Omit<Task, 'id' | 'createdAt'>) => {
    const tempId = `tsk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const safeProject = (newTaskData.project || '').trim() || 'Internal Firm';
    const created: Task = {
      ...newTaskData,
      project: safeProject,
      completedAt:
        newTaskData.completedAt ??
        (newTaskData.status === 'completed' ? todayDate : undefined),
      id: tempId,
      createdAt: todayDate,
    };
    const sig = `${created.title.trim().toLowerCase()}::${safeProject.toLowerCase()}`;
    const titleStatusSig = `${created.title.trim().toLowerCase()}::status:${created.status}`;
    pendingTaskMetaRef.current.set(tempId, created);
    pendingTaskTempBySigRef.current.set(sig, tempId);
    pendingTaskTempBySigRef.current.set(titleStatusSig, tempId);
    setTasks((prev) => [created, ...prev]);

    if (user && activeRole !== 'client') {
      void createEngineTaskApi({
        tenantId: user.tenantId,
        project: safeProject,
        clientName: safeProject,
        title: created.title,
        status: created.status,
        estimatedMinutes: created.estimatedMinutes,
        dueDateUtc: created.dueDate
          ? `${created.dueDate}T17:00:00.000Z`
          : new Date().toISOString(),
        assignedUserId: created.assignedUserId || user.userId,
        period: new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
        previewRole: activeRole,
      })
        .then(({ task: serverTask }: { task: EngineTask }) => {
          const mapped = mapEngineTaskToWorkspaceTask(
            serverTask,
            created,
            hierarchyBoardsRef.current
          );
          pendingTaskMetaRef.current.delete(tempId);
          pendingTaskTempBySigRef.current.delete(sig);
          pendingTaskTempBySigRef.current.delete(titleStatusSig);
          pendingTaskMetaRef.current.set(serverTask.id, mapped);
          setEngineTaskVersions((prev) => ({ ...prev, [serverTask.id]: serverTask.version }));
          setTasks((prev) => {
            const withoutDuplicateServer = prev.filter(
              (t) => t.id !== serverTask.id || t.id === tempId
            );
            const hasTemp = withoutDuplicateServer.some((t) => t.id === tempId);
            if (!hasTemp) {
              return [mapped, ...withoutDuplicateServer];
            }
            return withoutDuplicateServer.map((t) => (t.id === tempId ? mapped : t));
          });
        })
        .catch((err: any) => {
          pendingTaskMetaRef.current.delete(tempId);
          pendingTaskTempBySigRef.current.delete(sig);
          pendingTaskTempBySigRef.current.delete(titleStatusSig);
          setTasks((prev) => prev.filter((t) => t.id !== tempId));
          showToast(err?.message || 'Unable to save task on server.');
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
          assignedUserId: updates.assignedUserId,
          previewRole: activeRole,
        })
          .then(({ task: updatedServer }) => {
            setEngineTaskVersions((prev) => ({
              ...prev,
              [updatedServer.id]: updatedServer.version,
            }));
            pendingTaskMetaRef.current.delete(updatedServer.id);
            setTasks((prev) =>
              prev.map((t) =>
                t.id === updatedServer.id
                  ? mapEngineTaskToWorkspaceTask(
                      updatedServer,
                      t,
                      hierarchyBoardsRef.current
                    )
                  : t
              )
            );
            if (updates.assignedUserId && updatedServer.assignedUserName) {
              showToast(`Assigned "${updatedServer.title}" to ${updatedServer.assignedUserName}.`);
            }
          })
          .catch((err: any) => {
            if (previousTask) {
              setTasks((prev) =>
                prev.map((t) => (t.id === taskId ? previousTask : t))
              );
            }
            showToast(err?.message || 'Unable to update task.');
          });

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
    const previousTask = tasks.find((t) => t.id === taskId);
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    if (user && activeRole !== 'client') {
      const isServerTask =
        engineTaskVersions[taskId] !== undefined ||
        taskId.startsWith('tsk-eng-') ||
        taskId.startsWith('demo_tsk_');
      if (isServerTask) {
        void deleteEngineTaskApi(taskId, activeRole)
          .then(() => {
            showToast('Task deleted.');
          })
          .catch((err: any) => {
            if (previousTask) {
              setTasks((prev) => [previousTask, ...prev]);
            }
            showToast(err?.message || 'Unable to delete task.');
          });
        return;
      }
    }
    showToast('Task deleted.');
  };

  const handleInviteCollaborator = async (
    taskId: string,
    inviteeUserId: string,
    note?: string
  ) => {
    if (!user || activeRole === 'client') return;
    try {
      const res = await inviteTaskCollaboratorApi({
        taskId,
        inviteeUserId,
        note,
        tenantId: user.tenantId,
        previewRole: activeRole,
      });
      setTaskInvites((prev) => [
        res.invite,
        ...prev.filter((inv) => inv.id !== res.invite.id),
      ]);
      setTasks((prev) =>
        prev.map((t) =>
          t.id === res.task.id
            ? mapEngineTaskToWorkspaceTask(res.task, t, hierarchyBoardsRef.current)
            : t
        )
      );
      showToast(
        `Invited ${res.invite.inviteeName} to collaborate on "${res.task.title}".`
      );
    } catch (err: any) {
      showToast(err?.message || 'Unable to send collaboration invite.');
    }
  };

  const handleRespondTaskInvite = async (
    inviteId: string,
    action: 'accept' | 'decline'
  ) => {
    if (!user || activeRole === 'client') return;
    try {
      const res = await respondTaskInviteApi({
        inviteId,
        action,
        tenantId: user.tenantId,
        previewRole: activeRole,
      });
      setTaskInvites((prev) =>
        prev.map((inv) => (inv.id === res.invite.id ? res.invite : inv))
      );
      setTasks((prev) => {
        const exists = prev.some((t) => t.id === res.task.id);
        if (exists) {
          return prev.map((t) =>
            t.id === res.task.id
              ? mapEngineTaskToWorkspaceTask(
                  res.task,
                  t,
                  hierarchyBoardsRef.current
                )
              : t
          );
        }
        return [
          mapEngineTaskToWorkspaceTask(
            res.task,
            undefined,
            hierarchyBoardsRef.current
          ),
          ...prev,
        ];
      });
      showToast(
        action === 'accept'
          ? `Joined "${res.task.title}" as a collaborator.`
          : `Declined collaboration invite for "${res.task.title}".`
      );
      if (action === 'accept') {
        void hydrateFromEngine(user, activeRole);
      }
    } catch (err: any) {
      showToast(err?.message || 'Unable to respond to invite.');
    }
  };

  const handleRemoveCollaborator = async (
    taskId: string,
    targetUserId: string
  ) => {
    if (!user || activeRole === 'client') return;
    try {
      const res = await removeTaskCollaboratorApi({
        taskId,
        targetUserId,
        tenantId: user.tenantId,
        previewRole: activeRole,
      });
      setTasks((prev) =>
        prev.map((t) =>
          t.id === res.task.id
            ? mapEngineTaskToWorkspaceTask(res.task, t, hierarchyBoardsRef.current)
            : t
        )
      );
      setTaskInvites((prev) =>
        prev.filter(
          (inv) =>
            !(
              inv.taskId === taskId &&
              inv.inviteeUserId === targetUserId &&
              inv.status === 'pending'
            )
        )
      );
      showToast('Updated task collaborators.');
    } catch (err: any) {
      showToast(err?.message || 'Unable to update collaborators.');
    }
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
        onKeyLogin={handleKeyLogin}
        onDemoLogin={handleDemoLogin}
        onBootstrapFirm={handleBootstrapFirm}
        onClearAuthError={() => setAuthError(null)}
        onContinueLocal={() => {
          lastActivityMsRef.current = Date.now();
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
            lastActivityMsRef={lastActivityMsRef}
            isIdleModalOpen={idleAlert.isOpen}
            tasks={tasks}
            clients={engineClients}
            selectedDate={selectedDate}
            weekDates={weekDates}
            preferences={preferences}
            currentUserId={user?.userId || null}
            onSelectDate={setSelectedDate}
            onStartTimer={handleStartTimer}
            onPauseTimer={handlePauseTimer}
            onResumeTimer={handleResumeTimer}
            onStopAndSaveTimer={handleStopAndSaveTimer}
            onUpdateTimerMeta={(updates) => {
              setTimer((prev) => {
                const next = { ...prev, ...updates };
                if (updates.activeAppName || updates.activeDocumentTitle) {
                  emitBrowserLivePulse(
                    next.activeAppName || 'OnTrack Web',
                    next.activeDocumentTitle || next.customTitle || 'Workspace',
                    'active',
                    null,
                    'timer'
                  );
                }
                return next;
              });
            }}
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
          {user && (user.mustSetPassword || !user.mfaVerified) ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 max-w-xl mx-auto space-y-4">
              <div className="space-y-1.5">
                <h1 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                  {user.mustSetPassword
                    ? 'Complete Password & 2FA Onboarding'
                    : 'Two-Factor Authenticator Setup Required'}
                </h1>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Signed in as <span className="font-mono font-semibold">{user.email}</span> ({rolePolicy.label}).{' '}
                  {user.mustSetPassword
                    ? 'Create your personal password and finish 2FA setup to land on your live Timeline.'
                    : 'Complete TOTP authenticator setup before accessing firm workspace data.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setAccountModalOpen(true)}
                  className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
                >
                  {user.mustSetPassword ? 'Create Password & Set Up 2FA' : 'Set Up 2FA Authenticator'}
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
              onTasksMutated={() => void hydrateFromEngine(user, activeRole)}
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
              clients={engineClients}
              engineSessions={engineSessions}
              engineAttributions={engineAttributions}
              workstationDevices={
                user
                  ? engineDevices.filter((d) => d.userId === user.userId)
                  : engineDevices
              }
              syncStatus={engineSyncStatus}
              appColors={appColors}
              canCustomizeAppColors={activeRole === 'admin_it' || activeRole === 'team_lead'}
              liveActivity={liveActivity}
              isTimerRunning={timer.isRunning && !timer.isPaused}
              activeTimerAppName={timer.activeAppName}
              activeTimerDocTitle={timer.activeDocumentTitle || timer.customTitle}
              activeTimerStartedAtMs={timer.startedAtMs}
              onUpdateAppColors={handleUpdateAppColors}
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
              onQuickUpdateTimeBlock={handleQuickUpdateTimeBlock}
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
                  segmentId: segment.id,
                });
              }}
              onResolveTimelineAttribution={handleResolveTimelineAttribution}
              onNotify={showToast}
              onOpenInstallers={() => {
                setAutoTrackNav((prev) => ({
                  key: prev.key + 1,
                  subTab: 'packages',
                  targetUserId: undefined,
                  drilldown: false,
                }));
                navigateTab('autotrack');
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
              staffUsers={staffUsers}
              taskInvites={taskInvites}
              currentUserId={user?.userId || null}
              activeRole={activeRole}
              onUpdateHierarchy={setWorkspaceHierarchy}
              onNotify={showToast}
              onStartTimerForTask={(taskId) => handleStartTimer(taskId)}
              onPauseTimer={handlePauseTimer}
              onCreateTask={handleCreateTask}
              onUpdateTask={handleUpdateTask}
              onDeleteTask={handleDeleteTask}
              onInviteCollaborator={handleInviteCollaborator}
              onRespondTaskInvite={handleRespondTaskInvite}
              onRemoveCollaborator={handleRemoveCollaborator}
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
              appColors={appColors}
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
              clients={engineClients}
              appColors={appColors}
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
          clients={engineClients}
          tasks={tasks}
          onDiscardIdle={handleDiscardIdle}
          onKeepAsActive={handleKeepIdleAsActive}
          onReassignIdle={handleReassignIdle}
          onClose={() =>
            setIdleAlert((prev) => ({ ...prev, isOpen: false, segmentId: undefined }))
          }
        />

        {quickLogOpen && (
          <QuickLogModal
            key={`${editingBlock?.id || quickLogTask?.id || initialAppDoc?.documentTitle || quickLogRange?.startTime || 'new'}-${selectedDate}`}
            isOpen={quickLogOpen}
            selectedDate={selectedDate}
            weekDates={weekDates}
            tasks={tasks}
            clients={engineClients}
            initialBlock={editingBlock}
            initialRange={quickLogRange}
            initialTask={quickLogTask}
            currentUserId={user?.userId || null}
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
            onKeyLogin={handleKeyLogin}
            onDemoLogin={handleDemoLogin}
            onBootstrapFirm={handleBootstrapFirm}
            onSignOut={handleSignOut}
            onSaveProfile={handleSaveProfile}
            onRefreshSession={refreshAuthSession}
            onOnboardingComplete={(freshUser) => {
              const resolvedUser = freshUser ?? user;
              const resolvedRole = resolvedUser?.role ?? activeRole;
              const policy = getRolePolicy(resolvedRole);
              const landingTab = policy.allowedTabs.some((t) => t.id === 'timeline')
                ? 'timeline'
                : policy.defaultTab;
              setAccountModalOpen(false);
              setActiveTab(landingTab);
              if (resolvedUser) {
                void hydrateFromEngine(resolvedUser, resolvedRole);
              }
              showToast(
                landingTab === 'timeline'
                  ? 'Account activated! Workstation capture status is running on your Timeline.'
                  : 'Account activated and MFA verified.'
              );
            }}
            onExportJson={handleExportJson}
            onOpenPreferences={() => setPrefsModalOpen(true)}
            onClose={() => setAccountModalOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
