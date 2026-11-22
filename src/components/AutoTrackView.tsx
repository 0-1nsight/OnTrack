import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthUser } from '../services/authClient';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Download,
  FileSpreadsheet,
  FolderUp,
  KeyRound,
  Laptop,
  Lock,
  Merge,
  Play,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import {
  AttributionRecord,
  AttributionStatus,
  AutoChecklistItem,
  OSPlatform,
  ReplayMetricsResult,
  UserRole,
  WorkSession,
} from '../engine/types';
import {
  AcceptanceReport,
  addActivityRuleApi,
  addPrivacyRuleApi,
  buildLocalTrackingEvent,
  createEngineTaskApi,
  deleteActivityRuleApi,
  deleteChecklistItemApi,
  deleteClientApi,
  deletePrivacyRuleApi,
  downloadPackageZip,
  downloadPortableFileWithAuth,
  EngineSnapshot,
  fetchEngineSnapshot,
  filterAndEnqueueEvent,
  flushQueuedEventsOverHttp,
  getOrCreateLocalDeviceId,
  importClientsRawApi,
  importStaffCsvApi,
  loadLocalQueue,
  LocalAgentHealth,
  mergeChecklistItemsApi,
  pairDeviceTokenApi,
  pollEngineSnapshot,
  probeLocalDesktopAgentBridge,
  purgeRetentionApi,
  reorderChecklistItemsApi,
  resolveAttributionApi,
  resolveConflictApi,
  revokeDeviceTokenApi,
  runAcceptanceApi,
  runReplayApi,
  saveChecklistItemApi,
  saveManualClientApi,
  togglePrivacyRuleApi,
  updateEngineConfigApi,
  updateStaffRoleApi,
  uploadPortableFileApi,
} from '../services/engineClient';

export type AutoTrackSubTab = 'review' | 'capture' | 'dictionaries' | 'packages';

interface AutoTrackViewProps {
  selectedDate: string;
  currentUser: AuthUser | null;
  forcedRole?: UserRole;
  initialSubTab?: AutoTrackSubTab;
  initialTargetUserId?: string;
  initialDrilldown?: boolean;
  autoSyncToTimeline: boolean;
  onToggleAutoSyncToTimeline: (enabled: boolean) => void;
  onSyncEngineSessionsToTimeline?: (
    sessions: WorkSession[],
    attributions: AttributionRecord[]
  ) => void;
  onPushConfirmedToTimeline: (payload: {
    session: WorkSession;
    title: string;
    project: string;
    category: 'deep_work' | 'collaborative' | 'billable' | 'admin';
    notes: string;
  }) => void;
  onNotify: (message: string) => void;
  onOpenAccount?: () => void;
}

type SubTab = AutoTrackSubTab;
type ConfidenceFilter = 'all' | 'review_tray' | 'suggested' | 'detected' | 'confirmed';

const DEMO_STAFF_OPTIONS = [
  { id: 'demo_u_acc_01', label: 'Maya Patel · 8-5 Audit' },
  { id: 'demo_u_acc_02', label: 'Devon Brooks · 5-9 Shift' },
  { id: 'demo_u_acc_03', label: 'Elena Gomez · Remote Tax' },
  { id: 'demo_u_acc_04', label: 'Samira Al-Mansoor · Weekend Audit' },
  { id: 'demo_u_lead_01', label: 'Marcus Chen · Audit Team Lead' },
  { id: 'demo_u_lead_02', label: 'Hannah Kim · Tax Team Lead' },
];

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: 'accountant', label: 'Accountant' },
  { value: 'team_lead', label: 'Team Lead' },
  { value: 'line_manager', label: 'Line Manager' },
  { value: 'executive', label: 'Executive / Partner' },
  { value: 'client', label: 'Client Portal' },
  { value: 'admin_it', label: 'Admin / IT' },
];

const SAMPLE_CLIENT_CSV = `legal_name,aliases,codes,folder_patterns,known_domains
Cedar Ridge Construction,Cedar Ridge|CRC,CRC-404,Clients/Cedar_Ridge,cedarridge.example.com
Bluewater Retail Group,Bluewater|BRG,BRG-210,Clients\\Bluewater,bluewater-pos.example.org`;

const SAMPLE_STAFF_CSV = `name,email,role,shift_pattern,team_id
Priya Nair,priya.nair@apex-cpa.example,accountant,8-5,team_audit
Jordan Lee,jordan.lee@apex-cpa.example,team_lead,remote,team_tax
Liam Scott,liam.scott@apex-cpa.example,accountant,weekend,team_audit`;

function formatUtcRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const fmt = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
      d.getSeconds()
    ).padStart(2, '0')}`;
  return `${fmt(s)}–${fmt(e)}`;
}

function formatDurationSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function generatePairingBridgeSecret(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export const AutoTrackView: React.FC<AutoTrackViewProps> = ({
  currentUser,
  forcedRole,
  initialSubTab,
  initialTargetUserId,
  initialDrilldown,
  autoSyncToTimeline,
  onToggleAutoSyncToTimeline,
  onSyncEngineSessionsToTimeline,
  onPushConfirmedToTimeline,
  onNotify,
  onOpenAccount,
}) => {
  const isAuthenticated = Boolean(currentUser);
  const [tenantModeOverride, setTenantModeOverride] = useState<'firm_demo' | 'live' | null>(null);
  const tenantMode: 'firm_demo' | 'live' = tenantModeOverride ?? (isAuthenticated ? 'live' : 'firm_demo');
  const setTenantMode = (mode: 'firm_demo' | 'live') => setTenantModeOverride(mode);

  const tenantId =
    tenantMode === 'live' && currentUser ? currentUser.tenantId : 'firm_demo';

  const [subTab, setSubTab] = useState<SubTab>(initialSubTab || 'review');
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [wsSyncState, setWsSyncState] = useState<'ws' | 'poll' | 'syncing'>('ws');
  const [offlineMode, setOfflineMode] = useState<boolean>(false);
  const [forcePollingFallback, setForcePollingFallback] = useState<boolean>(false);
  const syncState: 'ws' | 'poll' | 'syncing' | 'offline' = offlineMode
    ? 'offline'
    : forcePollingFallback
    ? 'poll'
    : wsSyncState;
  const [queuedCount, setQueuedCount] = useState<number>(() => loadLocalQueue().length);
  const [droppedPrivacyCount, setDroppedPrivacyCount] = useState<number>(0);

  // Live Local Agent Bridge & Built-in Browser Collector
  const [agentHealth, setAgentHealth] = useState<LocalAgentHealth>({ online: false });
  const [liveBrowserCollector, setLiveBrowserCollector] = useState<boolean>(false);

  // Role & Visibility Controls (VIS-1 & VIS-2)
  const [viewerRoleDraft, setViewerRoleDraft] = useState<UserRole>(forcedRole || 'accountant');
  const viewerRole: UserRole =
    isAuthenticated && currentUser && currentUser.role !== 'admin_it'
      ? currentUser.role
      : forcedRole && tenantId === 'firm_demo'
      ? forcedRole
      : viewerRoleDraft;
  const setViewerRole = (r: UserRole) => setViewerRoleDraft(r);

  const [targetUserIdDraft, setTargetUserIdDraft] = useState<string | null>(
    initialTargetUserId || null
  );
  const targetUserId = useMemo(() => {
    if (tenantId === 'firm_demo') {
      if (targetUserIdDraft && targetUserIdDraft.startsWith('demo_')) return targetUserIdDraft;
      return 'demo_u_acc_01';
    }
    if (targetUserIdDraft) return targetUserIdDraft;
    return snapshot?.visibility.viewerUserId || currentUser?.userId || 'demo_u_acc_01';
  }, [tenantId, targetUserIdDraft, snapshot?.visibility.viewerUserId, currentUser?.userId]);
  const setTargetUserId = (next: string) => setTargetUserIdDraft(next);

  const [drilldownGranted, setDrilldownGranted] = useState<boolean>(Boolean(initialDrilldown));

  const viewerUserId =
    tenantMode === 'live' && snapshot?.authMode === 'session'
      ? snapshot.visibility.viewerUserId
      : viewerRole === 'team_lead'
      ? 'demo_u_lead_01'
      : viewerRole === 'line_manager'
      ? 'demo_u_mgr_01'
      : viewerRole === 'executive'
      ? 'demo_u_exec_01'
      : viewerRole === 'admin_it'
      ? 'demo_u_admin_01'
      : viewerRole === 'client'
      ? 'demo_u_client_01'
      : 'demo_u_acc_01';

  const deviceId = useMemo(() => getOrCreateLocalDeviceId(), []);
  const wsRef = useRef<WebSocket | null>(null);

  // Review & Checklists Tab States
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>('all');
  const [selectedTaskIdForChecklist, setSelectedTaskIdForChecklist] = useState<string>('');
  const [newFreeFormTitle, setNewFreeFormTitle] = useState<string>('');
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistTitle, setEditingChecklistTitle] = useState<string>('');
  const [selectedForMerge, setSelectedForMerge] = useState<Record<string, boolean>>({});
  const [reassignDraft, setReassignDraft] = useState<Record<string, string>>({});
  const [learnRuleDraft, setLearnRuleDraft] = useState<Record<string, 'none' | 'learn' | 'reject'>>({});

  // Capture & Device Pairing States
  const [simOs, setSimOs] = useState<OSPlatform>('windows');
  const [simExtConnected, setSimExtConnected] = useState<boolean>(true);
  const [customApp, setCustomApp] = useState<string>('QuickBooks Online');
  const [customTitle, setCustomTitle] = useState<string>('Acme Ltd - Oct 2026 Bank Reconciliation');
  const [customUrl, setCustomUrl] = useState<string>('https://qbo.intuit.com/app/reconcile');
  const [customFilePath, setCustomFilePath] = useState<string>('Clients/Acme_Ltd/Oct2026_Bank.xlsx');
  const [newDeviceLabel, setNewDeviceLabel] = useState<string>('Workstation Laptop');
  const [newPairedRawToken, setNewPairedRawToken] = useState<string | null>(null);
  const [pairingBridgeSecret, setPairingBridgeSecret] = useState<string>(() =>
    generatePairingBridgeSecret()
  );
  const [downloadingPkg, setDownloadingPkg] = useState<
    'desktop-agent' | 'browser-extension' | 'paired' | null
  >(null);

  // Dictionaries, Privacy & Portable Vault Forms
  const [manualLegalName, setManualLegalName] = useState<string>('');
  const [manualAliases, setManualAliases] = useState<string>('');
  const [manualCodes, setManualCodes] = useState<string>('');
  const [manualFolders, setManualFolders] = useState<string>('');
  const [manualDomains, setManualDomains] = useState<string>('');
  const [manualRestricted, setManualRestricted] = useState<boolean>(false);
  const [clientSearch, setClientSearch] = useState<string>('');
  const [newActKeyword, setNewActKeyword] = useState<string>('');
  const [newActType, setNewActType] = useState<string>('');
  const [newActCategory, setNewActCategory] = useState<'billable' | 'deep_work' | 'collaborative' | 'admin'>('billable');
  const [newPrivKind, setNewPrivKind] = useState<'app' | 'domain' | 'path'>('domain');
  const [newPrivPattern, setNewPrivPattern] = useState<string>('');
  const [newPrivReason, setNewPrivReason] = useState<string>('');
  const [newTaskTitle, setNewTaskTitle] = useState<string>('');
  const [newTaskClientId, setNewTaskClientId] = useState<string>('');
  const [newTaskPeriod, setNewTaskPeriod] = useState<string>('Oct 2026');
  const [vaultPurpose, setVaultPurpose] = useState<
    'portal_document' | 'dictionary_import' | 'branding_asset' | 'policy_doc'
  >('portal_document');

  // Replay & Acceptance States
  const [replayResult, setReplayResult] = useState<ReplayMetricsResult | null>(null);
  const [acceptanceReport, setAcceptanceReport] = useState<AcceptanceReport | null>(null);
  const [runningChecks, setRunningChecks] = useState<boolean>(false);

  const loadSnapshot = useCallback(
    async (viaPoll = false) => {
      try {
        setLoadError(null);
        const data = viaPoll
          ? await pollEngineSnapshot({
              tenantId,
              viewerUserId,
              viewerRole,
              targetUserId,
              drilldownGranted,
            })
          : await fetchEngineSnapshot({
              tenantId,
              viewerUserId,
              viewerRole,
              targetUserId,
              drilldownGranted,
            });
        setSnapshot(data);
        if (data.tasks.length > 0 && !data.tasks.some((t) => t.id === selectedTaskIdForChecklist)) {
          setSelectedTaskIdForChecklist(data.tasks[0].id);
        }
        if (data.clients.length > 0 && !data.clients.some((c) => c.id === newTaskClientId)) {
          setNewTaskClientId(data.clients[0].id);
        }
      } catch (err: any) {
        setLoadError(err?.message || 'Unable to load tracking snapshot');
      } finally {
        setLoading(false);
      }
    },
    [
      tenantId,
      viewerUserId,
      viewerRole,
      targetUserId,
      drilldownGranted,
      selectedTaskIdForChecklist,
      newTaskClientId,
    ]
  );

  useEffect(() => {
    let active = true;
    fetchEngineSnapshot({
      tenantId,
      viewerUserId,
      viewerRole,
      targetUserId,
      drilldownGranted,
    })
      .then((data) => {
        if (!active) return;
        setLoadError(null);
        setSnapshot(data);
        if (data.tasks.length > 0) {
          setSelectedTaskIdForChecklist((prev) =>
            data.tasks.some((t) => t.id === prev) ? prev : data.tasks[0].id
          );
        }
        if (data.clients.length > 0) {
          setNewTaskClientId((prev) =>
            data.clients.some((c) => c.id === prev) ? prev : data.clients[0].id
          );
        }
      })
      .catch((err: any) => {
        if (active) setLoadError(err?.message || 'Unable to load tracking snapshot');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tenantId, viewerUserId, viewerRole, targetUserId, drilldownGranted]);

  // Trigger optional automatic Engine-to-Timeline synchronization
  useEffect(() => {
    if (
      autoSyncToTimeline &&
      snapshot &&
      snapshot.visibility.timelinePermitted &&
      onSyncEngineSessionsToTimeline
    ) {
      onSyncEngineSessionsToTimeline(snapshot.sessions, snapshot.attributions);
    }
  }, [autoSyncToTimeline, snapshot, onSyncEngineSessionsToTimeline]);

  // Probe local OS Desktop Agent HTTP bridge (:47621/health) every 15s
  useEffect(() => {
    let active = true;
    const probe = async () => {
      const h = await probeLocalDesktopAgentBridge();
      if (active) setAgentHealth(h);
    };
    void probe();
    const timer = window.setInterval(probe, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  // Flush queued events silently when coming back online
  const flushQueue = useCallback(async () => {
    const q = loadLocalQueue();
    if (q.length === 0) {
      setQueuedCount(0);
      return;
    }
    setWsSyncState('syncing');
    try {
      const res = await flushQueuedEventsOverHttp({
        tenantId,
        userId: targetUserId,
        deviceId,
      });
      setQueuedCount(0);
      setWsSyncState(forcePollingFallback ? 'poll' : 'ws');
      await loadSnapshot(false);
      if (res.conflictsCreated.length > 0) {
        onNotify(`Synced queue · ${res.conflictsCreated.length} conflict requires review.`);
      } else if (res.acceptedCount > 0) {
        onNotify(`Synced ${res.acceptedCount} buffered event(s) cleanly.`);
      }
    } catch {
      setWsSyncState('poll');
    }
  }, [tenantId, targetUserId, deviceId, forcePollingFallback, loadSnapshot, onNotify]);

  // WebSocket + HTTPS Polling Fallback Manager (authenticates via session cookie)
  useEffect(() => {
    if (offlineMode) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    if (forcePollingFallback) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      const interval = setInterval(() => {
        void loadSnapshot(true);
      }, 5000);
      return () => clearInterval(interval);
    }

    let cancelled = false;
    let pollTimer: number | null = null;
    let hbInterval: number | null = null;
    let ws: WebSocket | null = null;

    const connect = async () => {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({
        tenantId,
        userId: viewerUserId,
        role: viewerRole,
      });

      ws = new WebSocket(`${proto}//${window.location.host}/ws/engine?${qs.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsSyncState('ws');
        void flushQueue();
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (
            msg.type === 'state:updated' ||
            msg.type === 'activity:updated' ||
            msg.type === 'freshness:updated'
          ) {
            void loadSnapshot(false);
          }
        } catch {
          // ignore
        }
      };

      ws.onerror = () => {
        setWsSyncState('poll');
      };

      ws.onclose = () => {
        if (!offlineMode && !cancelled) {
          setWsSyncState('poll');
          pollTimer = window.setInterval(() => {
            void loadSnapshot(true);
          }, 5000);
        }
      };

      hbInterval = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          const hb = buildLocalTrackingEvent({
            tenantId,
            userId: targetUserId,
            deviceId,
            type: 'activity.heartbeat',
            priority: 'activity',
            payload: {
              os_platform: simOs,
              extension_connected: simExtConnected,
            },
          });
          ws.send(
            JSON.stringify({
              type: 'sync:batch',
              tenantId,
              userId: targetUserId,
              deviceId,
              events: [hb],
            })
          );
        }
      }, 12000);
    };

    void connect();

    return () => {
      cancelled = true;
      if (hbInterval !== null) window.clearInterval(hbInterval);
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (ws) ws.close();
      wsRef.current = null;
    };
  }, [
    offlineMode,
    forcePollingFallback,
    tenantId,
    viewerUserId,
    targetUserId,
    viewerRole,
    deviceId,
    simOs,
    simExtConnected,
    loadSnapshot,
    flushQueue,
  ]);

  // Emit single event through local privacy filter -> offline buffer -> WS/HTTP
  const emitEngineEvent = useCallback(
    async (params: {
      type:
        | 'activity.window'
        | 'activity.browser'
        | 'activity.file'
        | 'activity.idle'
        | 'state.task_status';
      priority: 'state' | 'activity';
      payload: Record<string, any>;
      toastOnDrop?: string;
      toastOnSuccess?: string;
    }) => {
      const privacyRules = snapshot?.privacyRules || [];
      const ev = buildLocalTrackingEvent({
        tenantId,
        userId: targetUserId,
        deviceId: `dev-${simOs}-${targetUserId}`,
        type: params.type,
        priority: params.priority,
        payload: {
          os_platform: simOs,
          extension_connected: simExtConnected,
          ...params.payload,
        },
      });

      const filtered = filterAndEnqueueEvent(ev, privacyRules);
      setQueuedCount(filtered.queueLength);

      if (!filtered.allowed) {
        setDroppedPrivacyCount((c) => c + 1);
        onNotify(params.toastOnDrop || `Blocked on-device (${filtered.dropReason})`);
        return;
      }

      if (offlineMode) {
        onNotify(`Offline mode active · Buffered (${filtered.queueLength} in queue)`);
        return;
      }

      await flushQueue();
      if (params.toastOnSuccess) onNotify(params.toastOnSuccess);
    },
    [
      snapshot?.privacyRules,
      tenantId,
      targetUserId,
      simOs,
      simExtConnected,
      offlineMode,
      flushQueue,
      onNotify,
    ]
  );

  // Built-in Live Browser Focus Collector (real browser visibility/focus/idle capture)
  useEffect(() => {
    if (!liveBrowserCollector) return;
    let lastFocusStart = Date.now();
    const recordFocusSlice = (reason: string) => {
      const elapsedMs = Math.max(5000, Date.now() - lastFocusStart);
      lastFocusStart = Date.now();
      const hidden = document.visibilityState === 'hidden';
      void emitEngineEvent({
        type: hidden ? 'activity.idle' : 'activity.browser',
        priority: 'activity',
        payload: {
          app: 'Web Browser',
          window_title: document.title || `OnTrack Workspace (${reason})`,
          domain: window.location.hostname || 'ontrack.local',
          url: `${window.location.origin}${window.location.pathname}`,
          duration_ms: elapsedMs,
          idle: hidden,
          os_platform: 'web',
          extension_connected: true,
        },
      });
    };

    const onVisChange = () => recordFocusSlice('visibilitychange');
    const timer = window.setInterval(() => recordFocusSlice('periodic'), 30000);
    document.addEventListener('visibilitychange', onVisChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisChange);
    };
  }, [liveBrowserCollector, emitEngineEvent]);

  const handleToggleOfflineMode = async () => {
    const nextOffline = !offlineMode;
    setOfflineMode(nextOffline);
    if (!nextOffline) {
      onNotify('Reconnected · Flushing buffered events...');
      await flushQueue();
    } else {
      onNotify('Offline simulation enabled · Events will buffer locally.');
    }
  };

  // Review Attribution Resolution
  const handleConfirmAttribution = async (
    session: WorkSession,
    taskId: string | null,
    status: AttributionStatus,
    sessionTitleSnippet: string
  ) => {
    const ruleChoice = learnRuleDraft[session.id] || 'none';
    await resolveAttributionApi({
      tenantId,
      userId: targetUserId,
      sessionId: session.id,
      taskId,
      status,
      createRulePattern: ruleChoice === 'learn' ? sessionTitleSnippet.slice(0, 32) : undefined,
      rejectRulePattern: ruleChoice === 'reject' ? sessionTitleSnippet.slice(0, 32) : undefined,
    });
    await loadSnapshot(false);
    onNotify(
      ruleChoice === 'learn'
        ? 'Attribution confirmed & learned rule saved.'
        : ruleChoice === 'reject'
        ? 'Attribution confirmed (one-time only, rule rejected).'
        : 'Session attribution confirmed.'
    );
  };

  // Checklist actions
  const handleToggleConfirmChecklist = async (item: AutoChecklistItem) => {
    await saveChecklistItemApi(tenantId, {
      ...item,
      status: item.status === 'confirmed' ? 'detected' : 'confirmed',
      updatedAtUtc: new Date().toISOString(),
    });
    await loadSnapshot(false);
  };

  const handleSaveEditedChecklistTitle = async (item: AutoChecklistItem) => {
    if (!editingChecklistTitle.trim()) return;
    await saveChecklistItemApi(tenantId, {
      ...item,
      title: editingChecklistTitle.trim(),
      status: 'confirmed',
      updatedAtUtc: new Date().toISOString(),
    });
    setEditingChecklistId(null);
    setEditingChecklistTitle('');
    await loadSnapshot(false);
  };

  const handleAddFreeFormChecklist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFreeFormTitle.trim() || !selectedTaskIdForChecklist) return;
    const item: AutoChecklistItem = {
      id: `chk-free-${Date.now()}`,
      tenantId,
      taskId: selectedTaskIdForChecklist,
      userId: targetUserId,
      stepId: null,
      orderIndex:
        (snapshot?.checklistItems.filter((c) => c.taskId === selectedTaskIdForChecklist).length ||
          0) + 1,
      title: newFreeFormTitle.trim(),
      status: 'confirmed',
      minutesAccumulated: 0,
      sourceSessionIds: [],
      reason: 'Added manually by accountant',
      isFreeForm: true,
      updatedAtUtc: new Date().toISOString(),
    };
    await saveChecklistItemApi(tenantId, item);
    setNewFreeFormTitle('');
    await loadSnapshot(false);
    onNotify('Added checklist item.');
  };

  const taskChecklistItems = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.checklistItems.filter((c) => c.taskId === selectedTaskIdForChecklist);
  }, [snapshot, selectedTaskIdForChecklist]);

  const handleMergeSelectedChecklist = async () => {
    const picked = taskChecklistItems.filter((it) => selectedForMerge[it.id]);
    if (picked.length < 2 || !selectedTaskIdForChecklist) return;
    await mergeChecklistItemsApi({
      tenantId,
      taskId: selectedTaskIdForChecklist,
      itemsToMerge: picked,
    });
    setSelectedForMerge({});
    await loadSnapshot(false);
    onNotify(`Merged ${picked.length} checklist steps cleanly.`);
  };

  const handleMoveChecklistItem = async (index: number, direction: -1 | 1) => {
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= taskChecklistItems.length) return;
    const next = [...taskChecklistItems];
    const [moved] = next.splice(index, 1);
    next.splice(targetIdx, 0, moved);
    await reorderChecklistItemsApi(tenantId, next);
    await loadSnapshot(false);
  };

  // CSV / File Upload Import
  const handleClientFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const rawText = await file.text();
    const res = await importClientsRawApi({
      tenantId,
      rawText,
      source: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'file_upload',
    });
    await loadSnapshot(false);
    onNotify(`Imported ${res.importedCount} client(s) from ${file.name}.`);
    e.target.value = '';
  };

  const handleImportSampleCsv = async () => {
    const res = await importClientsRawApi({
      tenantId,
      rawText: SAMPLE_CLIENT_CSV,
      source: 'csv',
    });
    await loadSnapshot(false);
    onNotify(`Imported ${res.importedCount} sample accounting clients via CSV.`);
  };

  const handleSaveManualClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualLegalName.trim()) return;
    const splitList = (s: string) =>
      s
        .split(/[,;|]/)
        .map((x) => x.trim())
        .filter(Boolean);
    await saveManualClientApi({
      tenantId,
      legalName: manualLegalName.trim(),
      aliases: splitList(manualAliases),
      codes: splitList(manualCodes),
      folderPatterns: splitList(manualFolders),
      knownDomains: splitList(manualDomains),
      restrictedUserIds: manualRestricted ? [targetUserId] : [],
    });
    setManualLegalName('');
    setManualAliases('');
    setManualCodes('');
    setManualFolders('');
    setManualDomains('');
    setManualRestricted(false);
    await loadSnapshot(false);
    onNotify('Client saved to dictionary.');
  };

  const handleVaultFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await uploadPortableFileApi({
        tenantId,
        file,
        purpose: vaultPurpose,
      });
      await loadSnapshot(false);
      onNotify(`Stored ${res.file.originalName} (${Math.round(res.file.byteSize / 1024)} KB).`);
    } catch (err: any) {
      onNotify(err?.message || 'File upload failed');
    } finally {
      e.target.value = '';
    }
  };

  const handleRunReplayAndAcceptance = async () => {
    setRunningChecks(true);
    try {
      const [rep, acc] = await Promise.all([
        runReplayApi(tenantId, targetUserId),
        runAcceptanceApi(tenantId),
      ]);
      setReplayResult(rep);
      setAcceptanceReport(acc);
      onNotify(`Acceptance suite: ${acc.passedCount}/${acc.totalCount} checks passed.`);
    } finally {
      setRunningChecks(false);
    }
  };

  const sessionsWithAttribution = useMemo(() => {
    if (!snapshot) return [];
    const attrMap = new Map(snapshot.attributions.map((a) => [a.sessionId, a]));
    return snapshot.sessions
      .map((session) => ({
        session,
        attr: attrMap.get(session.id) || null,
      }))
      .filter(({ attr }) => {
        if (confidenceFilter === 'all') return true;
        return attr?.status === confidenceFilter;
      });
  }, [snapshot, confidenceFilter]);

  const countsByStatus = useMemo(() => {
    const counts = {
      all: 0,
      review_tray: 0,
      suggested: 0,
      detected: 0,
      confirmed: 0,
    };
    if (!snapshot) return counts;
    counts.all = snapshot.attributions.length;
    for (const a of snapshot.attributions) {
      if (a.status in counts) {
        counts[a.status as keyof typeof counts] += 1;
      }
    }
    return counts;
  }, [snapshot]);

  const filteredClients = useMemo(() => {
    if (!snapshot) return [];
    const q = clientSearch.trim().toLowerCase();
    if (!q) return snapshot.clients;
    return snapshot.clients.filter(
      (c) =>
        c.legalName.toLowerCase().includes(q) ||
        c.codes.some((code) => code.toLowerCase().includes(q)) ||
        c.aliases.some((al) => al.toLowerCase().includes(q))
    );
  }, [snapshot, clientSearch]);

  const staffOptions = useMemo(() => {
    if (tenantMode === 'live' && snapshot?.staffUsers?.length) {
      return snapshot.staffUsers.map((u) => ({
        id: u.userId,
        label: `${u.name} · ${u.role}`,
      }));
    }
    return DEMO_STAFF_OPTIONS;
  }, [tenantMode, snapshot]);

  const selectedMergeCount = useMemo(
    () => taskChecklistItems.filter((it) => selectedForMerge[it.id]).length,
    [taskChecklistItems, selectedForMerge]
  );

  if (loading && !snapshot) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-8 text-sm text-slate-500 dark:text-slate-400">
        Initializing Automated Tracking &amp; Attribution Engine...
      </div>
    );
  }

  if (loadError && !snapshot) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-8 space-y-4">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              Authentication Required for Engine Access
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {loadError}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {onOpenAccount && (
            <button
              type="button"
              onClick={onOpenAccount}
              className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              Sign In or Setup Firm
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadSnapshot(false)}
            className="px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const unresolvedConflicts = (snapshot?.conflicts || []).filter((c) => !c.resolved);

  return (
    <div className="space-y-5">
      {/* Mode & Auth Provenance Strip */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                Automated Tracking &amp; Attribution Engine
              </h1>
              <span className="font-mono text-xs px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 tabular-nums">
                {snapshot?.config.name || (tenantMode === 'live' ? currentUser?.tenantName || 'Live Firm' : 'Demo Sandbox')}
              </span>
              <span className="inline-flex items-center gap-1 font-mono text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300">
                <Database className="w-3 h-3" />
                <span>{(snapshot?.dialect || 'sqlite').toUpperCase()}</span>
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {tenantMode === 'live'
                ? `Live Authenticated Firm (${currentUser?.email || 'Verified'}) · Server-enforced RBAC`
                : 'Isolated Demo Sandbox (firm_demo) · Role switcher enabled for preview'}
              {' · '}
              <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                {snapshot?.freshnessSummary.reportingLiveCount ?? 0} of{' '}
                {snapshot?.freshnessSummary.totalActiveShiftStaff ?? 0} active-shift staff live
              </span>
              {snapshot?.freshnessSummary.provisional && (
                <span className="text-amber-600 dark:text-amber-400 font-medium">
                  {' '}
                  · Provisional ({snapshot.freshnessSummary.delayedCount} delayed)
                </span>
              )}
              {snapshot?.latencyStats && snapshot.latencyStats.sampleCount > 0 && (
                <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {' '}
                  · WS p95: {snapshot.latencyStats.p95BroadcastMs}ms
                </span>
              )}
            </p>
            {snapshot?.freshnessSummary.recentlyUpdatedNotice && (
              <div className="mt-1.5 text-[11px] font-mono text-indigo-600 dark:text-indigo-400">
                FRESH-3 · {snapshot.freshnessSummary.recentlyUpdatedNotice}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Tenant Mode Switcher (Live Firm vs Demo Sandbox) */}
            {isAuthenticated && (
              <div className="inline-flex rounded border border-slate-200 dark:border-slate-700 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setTenantMode('live')}
                  className={`px-2.5 py-1.5 font-medium cursor-pointer ${
                    tenantMode === 'live'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Live Firm
                </button>
                <button
                  type="button"
                  onClick={() => setTenantMode('firm_demo')}
                  className={`px-2.5 py-1.5 font-medium cursor-pointer ${
                    tenantMode === 'firm_demo'
                      ? 'bg-slate-900 dark:bg-slate-700 text-white'
                      : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  Demo Sandbox
                </button>
              </div>
            )}

            {/* Local Desktop Agent Bridge Badge */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-xs font-mono tabular-nums">
              <Radio
                className={`w-3.5 h-3.5 ${
                  agentHealth.online ? 'text-emerald-500' : 'text-slate-400'
                }`}
              />
              <span className="text-slate-700 dark:text-slate-300">
                {agentHealth.online ? `Agent Online (${agentHealth.deviceId})` : 'Agent Bridge Offline'}
              </span>
            </div>

            {/* Real-time Sync Status Indicator */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-xs font-mono tabular-nums">
              {syncState === 'offline' ? (
                <>
                  <WifiOff className="w-3.5 h-3.5 text-rose-500" />
                  <span className="text-rose-600 dark:text-rose-400">
                    Offline ({queuedCount} queued)
                  </span>
                </>
              ) : syncState === 'poll' ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 text-amber-500" />
                  <span className="text-amber-600 dark:text-amber-400">HTTPS Poll Fallback</span>
                </>
              ) : syncState === 'syncing' ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 text-indigo-500 animate-spin" />
                  <span className="text-indigo-600 dark:text-indigo-400">Syncing...</span>
                </>
              ) : (
                <>
                  <Wifi className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-emerald-600 dark:text-emerald-400">Synced (WS Live)</span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setLiveBrowserCollector((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border cursor-pointer ${
                liveBrowserCollector
                  ? 'bg-emerald-600 border-emerald-600 text-white'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
              }`}
              title="Automatically capture live browser focus/visibility sessions"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>{liveBrowserCollector ? 'Browser Capture ON' : 'Start Browser Capture'}</span>
            </button>

            <button
              type="button"
              onClick={handleToggleOfflineMode}
              className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors cursor-pointer ${
                offlineMode
                  ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700'
              }`}
            >
              {offlineMode ? 'Go Online & Auto-Flush' : 'Simulate Offline'}
            </button>

            {/* Role Selector (active in Demo Sandbox or Admin/IT) */}
            {(tenantId === 'firm_demo' || snapshot?.visibility.viewerRole === 'admin_it') && (
              <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <span>Role:</span>
                <select
                  value={viewerRole}
                  onChange={(e) => {
                    const r = e.target.value as UserRole;
                    setViewerRole(r);
                    if (r === 'accountant' && tenantId === 'firm_demo') {
                      setTargetUserId('demo_u_acc_01');
                      setDrilldownGranted(false);
                    }
                  }}
                  className="px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {(viewerRole === 'team_lead' || viewerRole === 'line_manager') && (
              <div className="flex items-center gap-2">
                <select
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                  className="px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
                >
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setDrilldownGranted((v) => !v)}
                  className={`px-2.5 py-1 text-xs font-medium rounded border cursor-pointer ${
                    drilldownGranted
                      ? 'bg-indigo-600 border-indigo-600 text-white'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {drilldownGranted ? 'Audit Drill-Down Active' : 'Request Audit Drill-Down'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Sub-navigation bar */}
        <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                { id: 'review', label: `Review & Checklists (${countsByStatus.all})` },
                { id: 'capture', label: 'Live Capture, Pairing & Staff' },
                { id: 'dictionaries', label: 'Dictionaries, Privacy & Vault' },
                { id: 'packages', label: 'Agent, Extension & Replay' },
              ] as { id: SubTab; label: string }[]
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSubTab(t.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                  subTab === t.id
                    ? 'bg-slate-900 dark:bg-indigo-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            <label className="flex items-center gap-1.5 font-sans cursor-pointer text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                checked={autoSyncToTimeline}
                onChange={(e) => onToggleAutoSyncToTimeline(e.target.checked)}
              />
              <span>Auto-Sync to Timeline</span>
            </label>
            <span>·</span>
            <span>Blocked: {droppedPrivacyCount}</span>
            <span>·</span>
            <span>
              Threshold: ≥{Math.round((snapshot?.config.confidenceThresholds.detected || 0.85) * 100)}%
            </span>
            <span>·</span>
            <span>Retention: {snapshot?.config.retentionDays || 60}d</span>
          </div>
        </div>
      </section>

      {loadError && (
        <section className="bg-rose-50 dark:bg-rose-950/30 border border-rose-300 dark:border-rose-800 rounded-lg p-4 text-xs text-rose-800 dark:text-rose-200">
          {loadError}
        </section>
      )}

      {/* SYNC-6 Conflict Resolution Banner */}
      {unresolvedConflicts.length > 0 && (
        <section className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-lg p-4 space-y-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-900 dark:text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <span>
              Offline State Conflict Detected ({unresolvedConflicts.length}) — Never Silently Overwritten
            </span>
          </div>
          {unresolvedConflicts.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900 rounded p-3 text-xs"
            >
              <div>
                <div className="font-medium text-slate-900 dark:text-white">{c.taskTitle}</div>
                <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                  Local: {c.localStatus} (v{c.localVersion}) vs Server: {c.serverStatus} (v
                  {c.serverVersion})
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await resolveConflictApi(tenantId, c.id, 'keep_local');
                    await loadSnapshot(false);
                    onNotify('Resolved conflict keeping local edit.');
                  }}
                  className="px-2.5 py-1 text-xs font-medium bg-indigo-600 text-white rounded hover:bg-indigo-500 cursor-pointer"
                >
                  Keep Local ({c.localStatus})
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await resolveConflictApi(tenantId, c.id, 'keep_server');
                    await loadSnapshot(false);
                    onNotify('Resolved conflict keeping server state.');
                  }}
                  className="px-2.5 py-1 text-xs font-medium border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Keep Server ({c.serverStatus})
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Visibility Guard Banner when role lacks minute-by-minute timeline permissions */}
      {snapshot && !snapshot.visibility.timelinePermitted && subTab === 'review' && (
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 flex items-start gap-3">
          <Lock className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <div className="font-semibold text-slate-900 dark:text-white">
              Individual Minute-by-Minute Timeline Restricted (
              {snapshot.visibility.viewerRole.replace('_', ' ').toUpperCase()})
            </div>
            <p className="text-slate-600 dark:text-slate-400">
              Server-side row-level visibility (VIS-1) hides raw application/document sessions for
              this role. Executives and Clients see aggregated Shift Handoffs &amp; Fleet Freshness
              only; Admin/IT manages fleet pairing &amp; health with zero client content; Team Leads
              require an audited Drill-Down grant.
            </p>
          </div>
        </section>
      )}

      {/* ===================================================================== */}
      {/* TAB 1: REVIEW & CHECKLISTS                                            */}
      {/* ===================================================================== */}
      {subTab === 'review' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left 7 cols: Attribution Queue & Review Tray */}
          <div className="lg:col-span-7 space-y-4">
            {snapshot && snapshot.revisionsPublished.length > 0 && (
              <div className="bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 rounded-lg p-3.5 text-xs">
                <div className="font-semibold text-indigo-900 dark:text-indigo-200">
                  Retroactive Attribution Published ({snapshot.revisionsPublished.length} revised
                  block)
                </div>
                {snapshot.revisionsPublished.map((rev) => (
                  <div key={rev.sessionId} className="mt-1 text-indigo-800 dark:text-indigo-300">
                    Session {rev.sessionId} revised → <strong>{rev.newTaskTitle}</strong> (
                    <span className="font-mono tabular-nums">
                      {Math.round(rev.newConfidence * 100)}%
                    </span>
                    ) · {rev.newReason}
                  </div>
                ))}
              </div>
            )}

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900 dark:text-white">
                  Session Attribution Queue
                </span>
                <div className="flex flex-wrap items-center gap-1">
                  {(
                    [
                      { id: 'all', label: `All (${countsByStatus.all})` },
                      {
                        id: 'review_tray',
                        label: `Review Tray <50% (${countsByStatus.review_tray})`,
                      },
                      { id: 'suggested', label: `Suggested (${countsByStatus.suggested})` },
                      { id: 'detected', label: `Detected (${countsByStatus.detected})` },
                      { id: 'confirmed', label: `Confirmed (${countsByStatus.confirmed})` },
                    ] as { id: ConfidenceFilter; label: string }[]
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setConfidenceFilter(f.id)}
                      className={`px-2 py-1 text-xs rounded border cursor-pointer ${
                        confidenceFilter === f.id
                          ? 'bg-slate-900 dark:bg-indigo-600 text-white border-slate-900 dark:border-indigo-600'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {sessionsWithAttribution.length === 0 ? (
                  <div className="p-6 text-xs text-slate-500 dark:text-slate-400">
                    No sessions captured yet for this filter or firm workspace. Enable Browser
                    Capture, connect a Desktop Agent, or emit a capture event in Live Capture.
                  </div>
                ) : (
                  sessionsWithAttribution.map(({ session, attr }) => {
                    const selectedTaskId =
                      reassignDraft[session.id] !== undefined
                        ? reassignDraft[session.id]
                        : attr?.taskId || '';
                    const confidencePct = Math.round((attr?.confidence || 0) * 100);
                    const statusColor =
                      attr?.status === 'confirmed'
                        ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30'
                        : attr?.status === 'detected'
                        ? 'text-indigo-700 dark:text-indigo-400 border-indigo-300 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30'
                        : attr?.status === 'suggested'
                        ? 'text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30'
                        : 'text-rose-700 dark:text-rose-400 border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30';

                    return (
                      <div key={session.id} className="p-4 space-y-2.5 text-xs">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-slate-900 dark:text-white truncate">
                              {session.primaryTitle}
                            </div>
                            <div className="mt-0.5 text-slate-500 dark:text-slate-400 font-mono tabular-nums flex flex-wrap items-center gap-x-2">
                              <span>{formatUtcRange(session.startTimeUtc, session.endTimeUtc)}</span>
                              <span>·</span>
                              <span>{formatDurationSeconds(session.durationSeconds)}</span>
                              <span>·</span>
                              <span>{session.primaryApp}</span>
                              <span>·</span>
                              <span className="uppercase">{session.osPlatform}</span>
                              {!session.extensionConnected && (
                                <>
                                  <span>·</span>
                                  <span className="text-amber-600 dark:text-amber-400">
                                    Window-title fallback
                                  </span>
                                </>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`font-mono tabular-nums px-2 py-0.5 rounded border text-[11px] font-semibold ${statusColor}`}
                            >
                              {attr?.status.replace('_', ' ').toUpperCase()} · {confidencePct}%
                            </span>
                            {attr?.retroactiveRevision && (
                              <span className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300">
                                REVISED v{attr.version}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/70 rounded px-3 py-2 space-y-1">
                          <div className="text-slate-700 dark:text-slate-200">
                            <span className="font-semibold">Why assigned:</span>{' '}
                            {attr?.reason || 'No attribution signal'}
                          </div>
                          <div className="text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-3">
                            <span>Client: {session.entities.clientName || 'Unknown'}</span>
                            <span>·</span>
                            <span>Period: {session.entities.period || 'Unspecified'}</span>
                            <span>·</span>
                            <span>Doc: {session.entities.docType || 'General'}</span>
                            <span>·</span>
                            <span>Activity: {session.entities.activityType || 'Work'}</span>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={selectedTaskId}
                              onChange={(e) =>
                                setReassignDraft((prev) => ({
                                  ...prev,
                                  [session.id]: e.target.value,
                                }))
                              }
                              className="px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 max-w-[240px]"
                            >
                              <option value="">-- Unassigned / Review --</option>
                              {(snapshot?.tasks || []).map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.title}
                                </option>
                              ))}
                            </select>

                            <select
                              value={learnRuleDraft[session.id] || 'none'}
                              onChange={(e) =>
                                setLearnRuleDraft((prev) => ({
                                  ...prev,
                                  [session.id]: e.target.value as 'none' | 'learn' | 'reject',
                                }))
                              }
                              className="px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                              title="Feedback learning prompt"
                            >
                              <option value="none">Confirm this session only</option>
                              <option value="learn">Learn rule from title</option>
                              <option value="reject">Don't generalize pattern</option>
                            </select>

                            <button
                              type="button"
                              onClick={() =>
                                handleConfirmAttribution(
                                  session,
                                  selectedTaskId || null,
                                  'confirmed',
                                  session.primaryTitle
                                )
                              }
                              className="px-2.5 py-1 text-xs font-medium bg-emerald-600 text-white rounded hover:bg-emerald-500 cursor-pointer"
                            >
                              Confirm
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              const matchedTask = snapshot?.tasks.find(
                                (t) => t.id === selectedTaskId
                              );
                              onPushConfirmedToTimeline({
                                session,
                                title: matchedTask?.title || session.primaryTitle,
                                project:
                                  session.entities.clientName ||
                                  matchedTask?.clientName ||
                                  'Accounting',
                                category: 'billable',
                                notes: `${attr?.reason || ''} · ${session.primaryApp} (${
                                  session.osPlatform
                                })`,
                              });
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          >
                            <span>Push to Timeline</span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {/* Right 5 cols: Auto-Checklists & "Where I Left Off" Shift Handoffs */}
          <div className="lg:col-span-5 space-y-5">
            {/* Auto-Checklist Card with Merge & Reorder */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900 dark:text-white">
                    Task Auto-Checklists
                  </span>
                  {selectedMergeCount >= 2 && (
                    <button
                      type="button"
                      onClick={handleMergeSelectedChecklist}
                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-indigo-600 text-white rounded hover:bg-indigo-500 cursor-pointer"
                    >
                      <Merge className="w-3 h-3" />
                      <span>Merge ({selectedMergeCount})</span>
                    </button>
                  )}
                </div>
                <select
                  value={selectedTaskIdForChecklist}
                  onChange={(e) => {
                    setSelectedTaskIdForChecklist(e.target.value);
                    setSelectedForMerge({});
                  }}
                  className="px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 max-w-[220px]"
                >
                  {(snapshot?.tasks || []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {taskChecklistItems.length === 0 ? (
                  <div className="p-4 text-xs text-slate-500 dark:text-slate-400">
                    No template steps matched yet for this task. Add a free-form item or run
                    activity capture.
                  </div>
                ) : (
                  taskChecklistItems.map((item, idx) => (
                    <div key={item.id} className="p-3.5 text-xs space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 flex-1 min-w-0">
                          <input
                            type="checkbox"
                            checked={Boolean(selectedForMerge[item.id])}
                            onChange={(e) =>
                              setSelectedForMerge((prev) => ({
                                ...prev,
                                [item.id]: e.target.checked,
                              }))
                            }
                            className="mt-1 shrink-0 cursor-pointer"
                            title="Select to merge multiple steps"
                          />
                          <button
                            type="button"
                            onClick={() => handleToggleConfirmChecklist(item)}
                            className="mt-0.5 shrink-0 cursor-pointer"
                            title="Confirm or unconfirm step"
                          >
                            {item.status === 'confirmed' ? (
                              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                            ) : (
                              <Clock className="w-4 h-4 text-indigo-500" />
                            )}
                          </button>

                          {editingChecklistId === item.id ? (
                            <div className="flex items-center gap-1.5 flex-1">
                              <input
                                type="text"
                                value={editingChecklistTitle}
                                onChange={(e) => setEditingChecklistTitle(e.target.value)}
                                className="flex-1 px-2 py-1 text-xs rounded border border-indigo-400 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                              />
                              <button
                                type="button"
                                onClick={() => handleSaveEditedChecklistTitle(item)}
                                className="px-2 py-1 text-xs bg-indigo-600 text-white rounded cursor-pointer"
                              >
                                Save
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingChecklistId(item.id);
                                setEditingChecklistTitle(item.title);
                              }}
                              className="text-left font-medium text-slate-900 dark:text-white hover:underline cursor-pointer"
                              title="Click to edit title"
                            >
                              {item.title}
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            {item.minutesAccumulated}m
                          </span>
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => handleMoveChecklistItem(idx, -1)}
                            className="text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-30 cursor-pointer"
                            title="Move up"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === taskChecklistItems.length - 1}
                            onClick={() => handleMoveChecklistItem(idx, 1)}
                            className="text-slate-400 hover:text-slate-700 dark:hover:text-white disabled:opacity-30 cursor-pointer"
                            title="Move down"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              await deleteChecklistItemApi(tenantId, item.id);
                              await loadSnapshot(false);
                            }}
                            className="text-slate-400 hover:text-rose-500 cursor-pointer"
                            title="Delete item"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="pl-10 text-[11px] text-slate-500 dark:text-slate-400">
                        {item.reason}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <form
                onSubmit={handleAddFreeFormChecklist}
                className="p-3 border-t border-slate-200 dark:border-slate-800 flex items-center gap-2"
              >
                <input
                  type="text"
                  value={newFreeFormTitle}
                  onChange={(e) => setNewFreeFormTitle(e.target.value)}
                  placeholder="Add free-form checklist step..."
                  className="flex-1 px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-slate-900 dark:bg-indigo-600 text-white rounded hover:opacity-90 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add</span>
                </button>
              </form>
            </div>

            {/* Shift Handoff ("Where I Left Off") */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-900 dark:text-white">
                  Where I Left Off (Shift Handoff)
                </span>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  Cross-Shift
                </span>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {(snapshot?.handoffs || []).length === 0 ? (
                  <div className="p-4 text-xs text-slate-500 dark:text-slate-400">
                    No active shift handoffs yet.
                  </div>
                ) : (
                  snapshot!.handoffs.map((h) => (
                    <div key={h.taskId} className="p-3.5 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {h.clientName} · {h.period}
                        </span>
                        <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                          {h.totalMinutes}m · {h.confirmedSteps.length}/
                          {h.confirmedSteps.length + h.pendingSteps.length} steps
                        </span>
                      </div>
                      <p className="text-slate-600 dark:text-slate-400">{h.handoffNote}</p>
                      {h.lastDocuments.length > 0 && (
                        <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                          Last docs: {h.lastDocuments.join(', ')}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 2: LIVE CAPTURE, PAIRING & STAFF                                  */}
      {/* ===================================================================== */}
      {subTab === 'capture' && (
        <div className="space-y-5">
          {/* Device Pairing Key Enrollment (AUTH-1) */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-indigo-500" />
                  <span>Enrolled Workstation Pairing Keys (AUTH-1 · SHA-256)</span>
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Issue cryptographic pairing keys (`ontrack_dev_*`) for Windows, macOS, Linux, or VDI
                  Desktop Agents so telemetry authenticates securely to your tenant.
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <input
                  type="text"
                  value={newDeviceLabel}
                  onChange={(e) => setNewDeviceLabel(e.target.value)}
                  placeholder="Workstation label (e.g., Audit MacBook)"
                  className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const out = await pairDeviceTokenApi({
                      tenantId,
                      userId: targetUserId,
                      label: newDeviceLabel.trim() || 'Workstation Agent',
                    });
                    setNewPairedRawToken(out.rawToken);
                    await loadSnapshot(false);
                    onNotify(`Paired device ${out.record.deviceId}. Copy token now!`);
                  }}
                  className="px-3 py-1.5 font-medium bg-indigo-600 text-white rounded hover:bg-indigo-500 cursor-pointer"
                >
                  Generate Pairing Key
                </button>
              </div>
            </div>

            {newPairedRawToken && (
              <div className="p-3.5 rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-800 text-xs space-y-2">
                <div className="font-semibold text-emerald-900 dark:text-emerald-200">
                  New Device Token Issued (Shown Once — Stored as SHA-256 Hash Only)
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 font-mono text-emerald-800 dark:text-emerald-300">
                    {newPairedRawToken}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(newPairedRawToken);
                      onNotify('Device pairing token copied.');
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                    <span>Copy Key</span>
                  </button>
                  <button
                    type="button"
                    disabled={downloadingPkg !== null}
                    onClick={async () => {
                      setDownloadingPkg('desktop-agent');
                      try {
                        await downloadPackageZip({
                          kind: 'desktop-agent',
                          userId: targetUserId,
                          bridgeSecret: pairingBridgeSecret,
                        });
                        onNotify('Downloaded ontrack-desktop-agent.zip');
                      } catch (err) {
                        onNotify(
                          err instanceof Error ? err.message : 'Desktop agent download failed'
                        );
                      } finally {
                        setDownloadingPkg(null);
                      }
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-700 text-white font-medium disabled:opacity-60 cursor-pointer"
                  >
                    <Download className="w-3 h-3" />
                    <span>
                      {downloadingPkg === 'desktop-agent'
                        ? 'Packaging...'
                        : 'Download Pre-Paired Agent .zip'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {(snapshot?.deviceTokens || []).length > 0 && (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded text-xs">
                {snapshot!.deviceTokens.map((tk) => (
                  <div key={tk.tokenId} className="px-3.5 py-2.5 flex items-center justify-between gap-3">
                    <div>
                      <span className="font-medium text-slate-900 dark:text-white">{tk.label}</span>
                      <span className="ml-2 font-mono text-slate-500 dark:text-slate-400">
                        {tk.prefix}... · {tk.deviceId} · {tk.userName}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 font-mono">
                      <span
                        className={
                          tk.revokedAtUtc
                            ? 'text-rose-500'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }
                      >
                        {tk.revokedAtUtc ? 'REVOKED' : tk.lastUsedUtc ? 'ACTIVE' : 'ISSUED'}
                      </span>
                      {!tk.revokedAtUtc && (
                        <button
                          type="button"
                          onClick={async () => {
                            await revokeDeviceTokenApi(tenantId, tk.tokenId);
                            await loadSnapshot(false);
                            onNotify('Device token revoked.');
                          }}
                          className="text-rose-500 hover:underline cursor-pointer"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Interactive Cross-OS Event Collector Console */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Cross-OS Telemetry &amp; Privacy Collector Console
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Capture live browser focus or emit cross-OS events, verify pre-sync privacy drops
                  (PRIV-1 / PRIV-2), and test HTTPS polling fallback.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-1.5">
                  <span className="text-slate-500 dark:text-slate-400">OS:</span>
                  <select
                    value={simOs}
                    onChange={(e) => setSimOs(e.target.value as OSPlatform)}
                    className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                  >
                    <option value="windows">Windows 11</option>
                    <option value="macos">macOS Sonoma</option>
                    <option value="linux">Linux (X11/Wayland)</option>
                    <option value="vdi">Citrix / RDP VDI</option>
                    <option value="web">Web Browser</option>
                  </select>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={simExtConnected}
                    onChange={(e) => setSimExtConnected(e.target.checked)}
                  />
                  <span className="text-slate-700 dark:text-slate-300">
                    Extension Connected {simExtConnected ? '' : '(Fallback Active)'}
                  </span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forcePollingFallback}
                    onChange={(e) => setForcePollingFallback(e.target.checked)}
                  />
                  <span className="text-slate-700 dark:text-slate-300">
                    Simulate WS Proxy Block (HTTPS Poll)
                  </span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-xs">
              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: 'activity.browser',
                    priority: 'activity',
                    payload: {
                      app: 'Google Chrome',
                      window_title: 'QuickBooks Online - Acme Ltd - Bank Reconciliation Oct 2026',
                      domain: simExtConnected ? 'qbo.intuit.com' : null,
                      url: simExtConnected ? 'https://qbo.intuit.com/app/reconcile' : null,
                      duration_ms: 420000,
                    },
                    toastOnSuccess: 'Captured QuickBooks Online session (Acme Ltd).',
                  })
                }
                className="p-3 text-left rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <div className="font-semibold text-slate-900 dark:text-white">QuickBooks Online</div>
                <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                  Acme Ltd · Oct 2026 Bank Reconciliation
                </div>
              </button>

              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: 'activity.browser',
                    priority: 'activity',
                    payload: {
                      app: 'Google Chrome',
                      window_title: 'Xero - Northstar Logistics - Q3 2026 Payroll Register',
                      domain: simExtConnected ? 'go.xero.com' : null,
                      url: simExtConnected ? 'https://go.xero.com/Payroll' : null,
                      duration_ms: 360000,
                    },
                    toastOnSuccess: 'Captured Xero Payroll session (Northstar Logistics).',
                  })
                }
                className="p-3 text-left rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <div className="font-semibold text-slate-900 dark:text-white">Xero Payroll</div>
                <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                  Northstar Logistics · Q3 2026 Payroll
                </div>
              </button>

              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: 'activity.file',
                    priority: 'activity',
                    payload: {
                      app: 'Microsoft Excel',
                      window_title: 'Harbor_Health_FY25_Tax_Workpaper.xlsx',
                      file_path: 'Clients/Harbor_Health/FY25/Tax_Return_Workpaper.xlsx',
                      duration_ms: 480000,
                    },
                    toastOnSuccess: 'Captured Desktop Excel workpaper (Harbor Health).',
                  })
                }
                className="p-3 text-left rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <div className="font-semibold text-slate-900 dark:text-white">
                  Desktop Excel + Path
                </div>
                <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                  Harbor Health · FY25 Corporate Tax
                </div>
              </button>

              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: 'activity.file',
                    priority: 'activity',
                    payload: {
                      app: 'Adobe Acrobat',
                      window_title: 'Acme Ltd - Oct 2026 Bank Statement.pdf',
                      file_path: 'Clients/Acme_Ltd/Bank_Statement_Oct2026.pdf',
                      duration_ms: 240000,
                    },
                    toastOnSuccess: 'Captured Bank Statement PDF (Acme Ltd).',
                  })
                }
                className="p-3 text-left rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
              >
                <div className="font-semibold text-slate-900 dark:text-white">
                  Bank Statement PDF
                </div>
                <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                  Acme Ltd · Statement Tie-Out
                </div>
              </button>
            </div>

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold text-slate-600 dark:text-slate-300 mr-1">
                Privacy &amp; Sync Tests:
              </span>
              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: 'activity.browser',
                    priority: 'activity',
                    payload: {
                      app: 'Google Chrome',
                      window_title: 'Personal Banking Login',
                      domain: 'personalbank.com',
                      url: 'https://personalbank.com/checking',
                      duration_ms: 60000,
                    },
                    toastOnDrop: 'PRIV-1 verified: Personal Banking dropped on-device before sync!',
                  })
                }
                className="px-2.5 py-1.5 rounded border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer"
              >
                Test Excluded Domain (PRIV-1)
              </button>

              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: 'activity.browser',
                    priority: 'activity',
                    payload: {
                      app: 'Google Chrome',
                      window_title: 'Private Tab',
                      incognito: true,
                      domain: 'private.example',
                      duration_ms: 60000,
                    },
                    toastOnDrop: 'PRIV-1 verified: Incognito tab dropped on-device!',
                  })
                }
                className="px-2.5 py-1.5 rounded border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer"
              >
                Test Incognito Drop (PRIV-1)
              </button>

              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: 'activity.window',
                    priority: 'activity',
                    payload: {
                      app: 'Excel',
                      window_title: 'Test Forbidden Key',
                      screenshot: 'base64-forbidden-content',
                    },
                    toastOnDrop:
                      'PRIV-2 verified: Forbidden screenshot payload rejected on-device!',
                  })
                }
                className="px-2.5 py-1.5 rounded border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 cursor-pointer"
              >
                Test Forbidden Payload (PRIV-2)
              </button>

              <button
                type="button"
                onClick={() => {
                  const firstTask = snapshot?.tasks?.[0];
                  if (!firstTask) return;
                  void emitEngineEvent({
                    type: 'state.task_status',
                    priority: 'state',
                    payload: {
                      task_id: firstTask.id,
                      from_value: 'in_progress',
                      to_value: 'completed',
                      expected_version: 99,
                    },
                    toastOnSuccess: 'State version conflict emitted to review banner (SYNC-6).',
                  });
                }}
                className="px-2.5 py-1.5 rounded border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer"
              >
                Trigger Offline Conflict (SYNC-6)
              </button>
            </div>

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-5 gap-2 text-xs">
              <input
                type="text"
                value={customApp}
                onChange={(e) => setCustomApp(e.target.value)}
                placeholder="Application"
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="Window Title"
                className="md:col-span-2 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={customFilePath || customUrl}
                onChange={(e) => {
                  setCustomFilePath(e.target.value);
                  setCustomUrl('');
                }}
                placeholder="File Path or URL"
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
              <button
                type="button"
                onClick={() =>
                  emitEngineEvent({
                    type: customUrl ? 'activity.browser' : 'activity.file',
                    priority: 'activity',
                    payload: {
                      app: customApp,
                      window_title: customTitle,
                      url: simExtConnected ? customUrl || null : null,
                      file_path: customFilePath || null,
                      duration_ms: 300000,
                    },
                    toastOnSuccess: 'Custom capture event emitted.',
                  })
                }
                className="px-3 py-1.5 font-medium bg-indigo-600 text-white rounded hover:bg-indigo-500 cursor-pointer"
              >
                Emit Custom Event
              </button>
            </div>
          </section>

          {/* Device Freshness Table (FRESH-1) */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                <Laptop className="w-4 h-4 text-slate-500" />
                <span>Device Fleet Freshness &amp; Shift Awareness (FRESH-1)</span>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                Delayed threshold: &gt;{snapshot?.config.delayedThresholdSeconds || 120}s
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">Staff</th>
                    <th className="py-2.5 px-4 font-medium">Device</th>
                    <th className="py-2.5 px-4 font-medium">Shift</th>
                    <th className="py-2.5 px-4 font-medium">OS / Ext</th>
                    <th className="py-2.5 px-4 font-medium">Last Seq</th>
                    <th className="py-2.5 px-4 font-medium">Clock Offset</th>
                    <th className="py-2.5 px-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {(snapshot?.devices || []).length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-4 px-4 text-slate-500 dark:text-slate-400">
                        No devices have reported heartbeats in this tenant yet.
                      </td>
                    </tr>
                  ) : (
                    snapshot!.devices.map((d) => (
                      <tr key={d.deviceId}>
                        <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-white">
                          {d.userName}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-300">
                          {d.deviceId}
                        </td>
                        <td className="py-2.5 px-4 font-mono">{d.shiftPattern}</td>
                        <td className="py-2.5 px-4 font-mono">
                          {d.osPlatform} · {d.extensionConnected ? 'Ext On' : 'Fallback'}
                        </td>
                        <td className="py-2.5 px-4 font-mono tabular-nums">#{d.lastAckSeq}</td>
                        <td className="py-2.5 px-4 font-mono tabular-nums">{d.clockOffsetMs}ms</td>
                        <td className="py-2.5 px-4 font-mono">
                          <span
                            className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                              d.status === 'live'
                                ? 'border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400'
                                : d.status === 'delayed'
                                ? 'border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-400'
                                : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            {d.status.toUpperCase()} ({d.delayedSeconds}s)
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Staff Roster & RBAC Directory */}
          {(snapshot?.staffUsers || []).length > 0 && (
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Users className="w-4 h-4 text-slate-500" />
                  <span>Firm Staff Roster &amp; RBAC Roles</span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const out = await importStaffCsvApi(tenantId, SAMPLE_STAFF_CSV);
                    await loadSnapshot(false);
                    onNotify(`Imported ${out.importedCount} staff roster entries.`);
                  }}
                  className="px-2.5 py-1 text-xs font-medium rounded border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 cursor-pointer"
                >
                  Import Sample Staff CSV
                </button>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {snapshot!.staffUsers.map((st) => (
                  <div
                    key={st.userId}
                    className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div>
                      <span className="font-medium text-slate-900 dark:text-white">{st.name}</span>
                      <span className="ml-2 font-mono text-slate-500 dark:text-slate-400">
                        {st.email} · Shift {st.shiftPattern}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={st.role}
                        onChange={async (e) => {
                          await updateStaffRoleApi(
                            tenantId,
                            st.userId,
                            e.target.value as UserRole
                          );
                          await loadSnapshot(false);
                          onNotify(`Updated role for ${st.name}.`);
                        }}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                      >
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Audit Logs (VIS-2) */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900 dark:text-white">
                Governance, File Vault &amp; Drill-Down Audit Log (VIS-2)
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Visible to Team Lead / Executive / Admin IT
              </span>
            </div>
            {(snapshot?.auditLogs || []).length === 0 ? (
              <div className="p-4 text-xs text-slate-500 dark:text-slate-400">
                No audit entries visible for current role ({snapshot?.visibility.viewerRole}) yet.
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {snapshot!.auditLogs.slice(0, 12).map((log) => (
                  <div key={log.id} className="px-4 py-2.5 flex items-center justify-between gap-4">
                    <div>
                      <span className="font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                        {log.action}
                      </span>{' '}
                      <span className="text-slate-700 dark:text-slate-300">· {log.details}</span>
                    </div>
                    <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0">
                      {log.actorRole} · {log.createdAtUtc.slice(11, 19)}Z
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 3: DICTIONARIES, PRIVACY & FILE VAULT                             */}
      {/* ===================================================================== */}
      {subTab === 'dictionaries' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Client Dictionary (CSV + File Upload + Manual CRUD) */}
          <section className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Client Dictionary (CSV · File Upload · Manual Entry)
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Matches legal names, aliases, client codes, folder paths, and accounting domains.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                  <FolderUp className="w-3.5 h-3.5" />
                  <span>Upload CSV / File</span>
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,.json"
                    onChange={handleClientFileUpload}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={handleImportSampleCsv}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border border-indigo-300 dark:border-indigo-700 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 cursor-pointer"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Import Sample CSV</span>
                </button>
              </div>
            </div>

            <form
              onSubmit={handleSaveManualClient}
              className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded text-xs"
            >
              <input
                type="text"
                required
                value={manualLegalName}
                onChange={(e) => setManualLegalName(e.target.value)}
                placeholder="Legal Name (e.g., Summit Manufacturing)"
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={manualAliases}
                onChange={(e) => setManualAliases(e.target.value)}
                placeholder="Aliases (comma-separated)"
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={manualCodes}
                onChange={(e) => setManualCodes(e.target.value)}
                placeholder="Client Codes (e.g., SUM-101)"
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={manualFolders}
                onChange={(e) => setManualFolders(e.target.value)}
                placeholder="Folder Patterns (e.g., Clients/Summit)"
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
              <input
                type="text"
                value={manualDomains}
                onChange={(e) => setManualDomains(e.target.value)}
                placeholder="Known Domains (e.g., summit.example)"
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
              />
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={manualRestricted}
                    onChange={(e) => setManualRestricted(e.target.checked)}
                  />
                  <span>Restricted</span>
                </label>
                <button
                  type="submit"
                  className="px-3 py-1.5 font-medium bg-indigo-600 text-white rounded hover:bg-indigo-500 cursor-pointer"
                >
                  Save Client
                </button>
              </div>
            </form>

            <div className="space-y-2">
              <input
                type="text"
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                placeholder="Filter client dictionary..."
                className="w-full px-3 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
              <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded">
                {filteredClients.map((c) => (
                  <div key={c.id} className="p-3 flex items-start justify-between gap-3 text-xs">
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {c.legalName}
                        {c.restrictedUserIds.length > 0 && (
                          <span className="ml-2 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                            [RESTRICTED]
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-slate-500 dark:text-slate-400 font-mono">
                        Codes: {c.codes.join(', ') || '—'} · Aliases: {c.aliases.join(', ') || '—'}
                      </div>
                      <div className="text-slate-500 dark:text-slate-400 font-mono">
                        Folders: {c.folderPatterns.join(', ') || '—'} · Domains:{' '}
                        {c.knownDomains.join(', ') || '—'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteClientApi(tenantId, c.id);
                        await loadSnapshot(false);
                      }}
                      className="text-slate-400 hover:text-rose-500 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Quick Add Engine Task */}
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newTaskTitle.trim() || !snapshot?.clients.length) return;
                const cli =
                  snapshot.clients.find((c) => c.id === newTaskClientId) || snapshot.clients[0];
                await createEngineTaskApi({
                  tenantId,
                  clientId: cli.id,
                  clientName: cli.legalName,
                  title: newTaskTitle.trim(),
                  period: newTaskPeriod.trim() || 'Oct 2026',
                  assignedUserId: targetUserId,
                  estimatedMinutes: 120,
                });
                setNewTaskTitle('');
                await loadSnapshot(false);
                onNotify('Added attribution target task.');
              }}
              className="pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs"
            >
              <input
                type="text"
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="New Target Task Title..."
                className="sm:col-span-2 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              />
              <select
                value={newTaskClientId}
                onChange={(e) => setNewTaskClientId(e.target.value)}
                className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
              >
                {(snapshot?.clients || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.legalName}
                  </option>
                ))}
              </select>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={newTaskPeriod}
                  onChange={(e) => setNewTaskPeriod(e.target.value)}
                  placeholder="Period"
                  className="w-20 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                />
                <button
                  type="submit"
                  className="flex-1 px-2.5 py-1.5 bg-slate-900 dark:bg-indigo-600 text-white rounded font-medium cursor-pointer"
                >
                  + Task
                </button>
              </div>
            </form>
          </section>

          {/* Right 5 cols: Privacy Exclusions, Activity Rules, Retention & Portable File Vault */}
          <div className="lg:col-span-5 space-y-5">
            {/* Portable Local Server File Vault */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Portable Document &amp; Branding Vault
                </h3>
                <div className="flex items-center gap-1.5 text-xs">
                  <select
                    value={vaultPurpose}
                    onChange={(e) =>
                      setVaultPurpose(
                        e.target.value as
                          | 'portal_document'
                          | 'dictionary_import'
                          | 'branding_asset'
                          | 'policy_doc'
                      )
                    }
                    className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                  >
                    <option value="portal_document">Client Doc</option>
                    <option value="dictionary_import">CSV Import</option>
                    <option value="branding_asset">Firm Branding</option>
                    <option value="policy_doc">Policy Doc</option>
                  </select>
                  <label className="inline-flex items-center gap-1 px-2.5 py-1 font-medium bg-indigo-600 text-white rounded hover:bg-indigo-500 cursor-pointer">
                    <FolderUp className="w-3.5 h-3.5" />
                    <span>Upload</span>
                    <input
                      type="file"
                      accept=".pdf,.csv,.tsv,.txt,.json,.png,.jpg,.jpeg,.svg,.xlsx"
                      onChange={handleVaultFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs max-h-40 overflow-y-auto">
                {(snapshot?.storedFiles || []).length === 0 ? (
                  <div className="py-2 text-slate-500 dark:text-slate-400">
                    No files stored yet. Uploads are saved to disk with SHA-256 verification &amp;
                    audit logs.
                  </div>
                ) : (
                  snapshot!.storedFiles.map((f) => (
                    <div key={f.fileId} className="py-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-white truncate">
                          {f.originalName}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                          {f.purpose} · {Math.max(1, Math.round(f.byteSize / 1024))} KB ·{' '}
                          {f.sha256.slice(0, 10)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          downloadPortableFileWithAuth(tenantId, f.fileId, f.originalName)
                        }
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer shrink-0"
                      >
                        <Download className="w-3 h-3" />
                        <span>Get</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Pre-Sync Privacy Exclusions */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span>Pre-Sync Privacy Exclusions (PRIV-1)</span>
              </div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {(snapshot?.privacyRules || []).map((rule) => (
                  <div key={rule.id} className="py-2 flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={async (e) => {
                          await togglePrivacyRuleApi(tenantId, rule.id, e.target.checked);
                          await loadSnapshot(false);
                        }}
                      />
                      <span className="font-mono text-slate-900 dark:text-white">
                        {rule.pattern}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400">
                        ({rule.kind} · {rule.reason})
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={async () => {
                        await deletePrivacyRuleApi(tenantId, rule.id);
                        await loadSnapshot(false);
                      }}
                      className="text-slate-400 hover:text-rose-500 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newPrivPattern.trim()) return;
                  await addPrivacyRuleApi({
                    tenantId,
                    kind: newPrivKind,
                    pattern: newPrivPattern.trim(),
                    reason: newPrivReason.trim() || 'Custom Exclusion',
                  });
                  setNewPrivPattern('');
                  setNewPrivReason('');
                  await loadSnapshot(false);
                }}
                className="flex items-center gap-1.5 text-xs pt-2"
              >
                <select
                  value={newPrivKind}
                  onChange={(e) => setNewPrivKind(e.target.value as 'app' | 'domain' | 'path')}
                  className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                >
                  <option value="domain">Domain</option>
                  <option value="app">App</option>
                  <option value="path">Path</option>
                </select>
                <input
                  type="text"
                  value={newPrivPattern}
                  onChange={(e) => setNewPrivPattern(e.target.value)}
                  placeholder="Pattern (e.g., spotify)"
                  className="flex-1 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                />
                <input
                  type="text"
                  value={newPrivReason}
                  onChange={(e) => setNewPrivReason(e.target.value)}
                  placeholder="Reason"
                  className="w-24 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                />
                <button
                  type="submit"
                  className="px-2.5 py-1.5 bg-slate-900 dark:bg-indigo-600 text-white rounded cursor-pointer"
                >
                  Add
                </button>
              </form>
            </section>

            {/* Activity Dictionary */}
            <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                Activity Dictionary Rules
              </h3>
              <div className="divide-y divide-slate-200 dark:divide-slate-800 text-xs max-h-44 overflow-y-auto">
                {(snapshot?.activityRules || []).map((a) => (
                  <div key={a.id} className="py-1.5 flex items-center justify-between gap-2">
                    <div>
                      <span className="font-mono text-slate-900 dark:text-white">{a.keyword}</span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {' '}
                        → {a.activityType} ({a.workCategory})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteActivityRuleApi(tenantId, a.id);
                        await loadSnapshot(false);
                      }}
                      className="text-slate-400 hover:text-rose-500 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newActKeyword.trim() || !newActType.trim()) return;
                  await addActivityRuleApi({
                    tenantId,
                    keyword: newActKeyword.trim(),
                    activityType: newActType.trim(),
                    workCategory: newActCategory,
                    weight: 8,
                  });
                  setNewActKeyword('');
                  setNewActType('');
                  await loadSnapshot(false);
                }}
                className="grid grid-cols-4 gap-1.5 text-xs pt-1"
              >
                <input
                  type="text"
                  value={newActKeyword}
                  onChange={(e) => setNewActKeyword(e.target.value)}
                  placeholder="Keyword"
                  className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                />
                <input
                  type="text"
                  value={newActType}
                  onChange={(e) => setNewActType(e.target.value)}
                  placeholder="Activity Type"
                  className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                />
                <select
                  value={newActCategory}
                  onChange={(e) =>
                    setNewActCategory(
                      e.target.value as 'billable' | 'deep_work' | 'collaborative' | 'admin'
                    )
                  }
                  className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                >
                  <option value="billable">Billable</option>
                  <option value="deep_work">Deep Work</option>
                  <option value="collaborative">Collaborative</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="submit"
                  className="px-2.5 py-1.5 bg-slate-900 dark:bg-indigo-600 text-white rounded cursor-pointer"
                >
                  Add Rule
                </button>
              </form>
            </section>

            {/* Tenant Thresholds & Retention Purge */}
            {snapshot && (
              <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Firm Policy, Thresholds &amp; Retention
                  </h3>
                  <button
                    type="button"
                    onClick={async () => {
                      const out = await purgeRetentionApi(tenantId);
                      await loadSnapshot(false);
                      onNotify(`Retention sweep purged ${out.purgedCount} expired raw event(s).`);
                    }}
                    className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium cursor-pointer"
                  >
                    Run Retention Purge Now
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1">
                    <span className="text-slate-500 dark:text-slate-400">Detected Threshold</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0.6"
                      max="0.95"
                      value={snapshot.config.confidenceThresholds.detected}
                      onChange={async (e) => {
                        await updateEngineConfigApi(tenantId, {
                          confidenceThresholds: {
                            ...snapshot.config.confidenceThresholds,
                            detected: Number(e.target.value) || 0.85,
                          },
                        });
                        await loadSnapshot(false);
                      }}
                      className="w-full px-2.5 py-1.5 font-mono rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-slate-500 dark:text-slate-400">
                      Retention Window (30–90d)
                    </span>
                    <input
                      type="number"
                      min="30"
                      max="90"
                      value={snapshot.config.retentionDays}
                      onChange={async (e) => {
                        await updateEngineConfigApi(tenantId, {
                          retentionDays: Math.min(90, Math.max(30, Number(e.target.value) || 60)),
                        });
                        await loadSnapshot(false);
                      }}
                      className="w-full px-2.5 py-1.5 font-mono rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800"
                    />
                  </label>
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 4: DESKTOP AGENT, BROWSER EXTENSION & REPLAY HARNESS              */}
      {/* ===================================================================== */}
      {subTab === 'packages' && (
        <div className="space-y-5">
          {/* Paired Collector Bridge Secret & One-Click Bundle Bar */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <span>Authenticated Loopback Bridge &amp; Paired Collector Bundle</span>
                </h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Both packages share a per-install cryptographic secret (<code className="font-mono">X-OnTrack-Bridge-Secret</code>)
                  embedded into <code className="font-mono">agent.config.json</code> and <code className="font-mono">config.defaults.json</code> so untrusted browser tabs cannot spoof local telemetry.
                </p>
              </div>
              <button
                type="button"
                disabled={downloadingPkg !== null}
                onClick={async () => {
                  setDownloadingPkg('paired');
                  try {
                    await downloadPackageZip({
                      kind: 'desktop-agent',
                      userId: targetUserId,
                      bridgeSecret: pairingBridgeSecret,
                    });
                    await downloadPackageZip({
                      kind: 'browser-extension',
                      userId: targetUserId,
                      bridgeSecret: pairingBridgeSecret,
                    });
                    onNotify('Downloaded paired Desktop Agent & Browser Extension bundles');
                  } catch (err) {
                    onNotify(
                      err instanceof Error ? err.message : 'Failed to download paired packages'
                    );
                  } finally {
                    setDownloadingPkg(null);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-60 cursor-pointer shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>
                  {downloadingPkg === 'paired'
                    ? 'Packaging...'
                    : 'Download Paired Bundle (.zip x2)'}
                </span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 p-3 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Pairing Secret:
              </span>
              <code className="text-[11px] font-mono text-slate-900 dark:text-slate-100 select-all break-all flex-1">
                {pairingBridgeSecret}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(pairingBridgeSecret);
                  onNotify('Copied bridge secret to clipboard');
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
              >
                <Copy className="w-3 h-3" />
                <span>Copy</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPairingBridgeSecret(generatePairingBridgeSecret());
                  onNotify('Generated fresh pairing secret for next download');
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Regenerate</span>
              </button>
            </div>
          </section>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Cross-OS Desktop Agent Package
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Windows, macOS (<code className="font-mono">ioreg</code>), Linux (<code className="font-mono">xprintidle</code>) &amp; Citrix/RDP VDI support ·
                    Bearer device key auth, authenticated loopback bridge (<code className="font-mono">:47621</code>), WebSocket stream + HTTP fallback, and OS launchers.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={downloadingPkg !== null}
                  onClick={async () => {
                    setDownloadingPkg('desktop-agent');
                    try {
                      await downloadPackageZip({
                        kind: 'desktop-agent',
                        userId: targetUserId,
                        bridgeSecret: pairingBridgeSecret,
                      });
                      onNotify('Downloaded ontrack-desktop-agent.zip');
                    } catch (err) {
                      onNotify(
                        err instanceof Error ? err.message : 'Desktop agent download failed'
                      );
                    } finally {
                      setDownloadingPkg(null);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-60 cursor-pointer shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>
                    {downloadingPkg === 'desktop-agent' ? 'Packaging...' : 'Download .zip'}
                  </span>
                </button>
              </div>
              <pre className="p-3 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-700 dark:text-slate-300 overflow-x-auto">
{`unzip ontrack-desktop-agent.zip -d ontrack-agent
cd ontrack-agent
# macOS / Linux: chmod +x start-agent.sh && ./start-agent.sh
# Windows:       start-agent.bat`}
              </pre>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Chrome / Edge MV3 Browser Extension
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Captures active tab domains/paths, SPA URL updates (QuickBooks, Xero),
                    download filenames, syncs exclusions via authenticated <code className="font-mono">:47621/config</code>,
                    includes a status/pairing popup, and drops incognito windows.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={downloadingPkg !== null}
                  onClick={async () => {
                    setDownloadingPkg('browser-extension');
                    try {
                      await downloadPackageZip({
                        kind: 'browser-extension',
                        userId: targetUserId,
                        bridgeSecret: pairingBridgeSecret,
                      });
                      onNotify('Downloaded ontrack-browser-extension.zip');
                    } catch (err) {
                      onNotify(
                        err instanceof Error ? err.message : 'Extension download failed'
                      );
                    } finally {
                      setDownloadingPkg(null);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-900 dark:bg-indigo-600 text-white rounded hover:opacity-90 disabled:opacity-60 cursor-pointer shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>
                    {downloadingPkg === 'browser-extension' ? 'Packaging...' : 'Download .zip'}
                  </span>
                </button>
              </div>
              <pre className="p-3 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-700 dark:text-slate-300 overflow-x-auto">
{`1. Unzip ontrack-browser-extension.zip (pre-paired config.defaults.json)
2. Open chrome://extensions -> Enable Developer Mode -> Load unpacked
3. Click the extension toolbar icon to verify Connected status`}
              </pre>
            </div>
          </div>

          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Shadow-Mode Replay Harness &amp; 12-Gate Acceptance Suite
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Verifies PRIV-1, PRIV-2, SYNC-5, SYNC-6, FRESH-3, ATTR-1..4, VIS-1, FRESH-1,
                  AUTH-1, and RET-1 against the live portable SQL store.
                </p>
              </div>
              <button
                type="button"
                onClick={handleRunReplayAndAcceptance}
                disabled={runningChecks}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-60 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{runningChecks ? 'Running Suite...' : 'Run Acceptance & Replay'}</span>
              </button>
            </div>

            {acceptanceReport && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="p-3 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                    <div className="text-slate-500 dark:text-slate-400">Acceptance Gate</div>
                    <div className="mt-1 text-lg font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {acceptanceReport.passedCount}/{acceptanceReport.totalCount} PASS
                    </div>
                  </div>
                  <div className="p-3 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                    <div className="text-slate-500 dark:text-slate-400">
                      Auto-Assignment Accuracy
                    </div>
                    <div className="mt-1 text-lg font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                      {acceptanceReport.replay.autoAssignmentAccuracyPercent}%
                    </div>
                  </div>
                  <div className="p-3 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                    <div className="text-slate-500 dark:text-slate-400">Est. Daily Review</div>
                    <div className="mt-1 text-lg font-mono font-bold tabular-nums text-slate-900 dark:text-white">
                      {acceptanceReport.replay.estimatedDailyReviewMinutes}m
                    </div>
                  </div>
                  <div className="p-3 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
                    <div className="text-slate-500 dark:text-slate-400">Privacy Leaks</div>
                    <div className="mt-1 text-lg font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {acceptanceReport.replay.excludedLeaksCount} leaks (
                      {acceptanceReport.replay.filteredOutCount} dropped)
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded text-xs">
                  {acceptanceReport.checks.map((chk) => (
                    <div key={chk.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        {chk.passed ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-rose-500 shrink-0" />
                        )}
                        <span className="font-mono font-semibold text-slate-700 dark:text-slate-300 w-16">
                          {chk.id}
                        </span>
                        <span className="text-slate-900 dark:text-white">{chk.name}</span>
                      </div>
                      <span className="font-mono text-slate-500 dark:text-slate-400">{chk.detail}</span>
                    </div>
                  ))}
                </div>

                {replayResult && (
                  <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                        <tr>
                          <th className="py-2 px-3 font-medium">Window / Document</th>
                          <th className="py-2 px-3 font-medium">App</th>
                          <th className="py-2 px-3 font-medium">Status</th>
                          <th className="py-2 px-3 font-medium">Conf.</th>
                          <th className="py-2 px-3 font-medium">Reason</th>
                          <th className="py-2 px-3 font-medium">Match</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {replayResult.items.map((item) => (
                          <tr key={item.sessionId}>
                            <td className="py-2 px-3 font-medium text-slate-900 dark:text-white">
                              {item.primaryTitle}
                            </td>
                            <td className="py-2 px-3 text-slate-600 dark:text-slate-300">
                              {item.primaryApp}
                            </td>
                            <td className="py-2 px-3 font-mono">{item.status}</td>
                            <td className="py-2 px-3 font-mono tabular-nums">
                              {Math.round(item.confidence * 100)}%
                            </td>
                            <td className="py-2 px-3 text-slate-500 dark:text-slate-400">
                              {item.reason}
                            </td>
                            <td className="py-2 px-3 font-mono">
                              {item.correct ? (
                                <span className="text-emerald-600 dark:text-emerald-400">PASS</span>
                              ) : (
                                <span className="text-rose-600 dark:text-rose-400">MISS</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
