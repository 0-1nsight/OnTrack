import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock,
  Download,
  FileCheck2,
  FileText,
  Globe,
  Lock,
  MessageSquare,
  PenTool,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  Wifi,
} from 'lucide-react';
import { PortalAccentTheme, UserRole } from '../engine/types';
import { AuthUser, DemoAccountSummary } from '../services/authClient';
import {
  approvePortalRequestApi,
  confirmPortalMilestoneApi,
  createPortalDocRequestApi,
  createPortalRequestApi,
  fetchPortalOverviewApi,
  getPortalFileDownloadUrl,
  PortalApiError,
  PortalOverviewData,
  PortalRequestStage,
  postPortalMessageApi,
  sendPortalDocReminderApi,
  updatePortalRequestStageApi,
  uploadPortalDocumentApi,
  verifyPortalDocUploadApi,
  withdrawPortalMilestoneApi,
} from '../services/portalClient';

interface ClientPortalViewProps {
  currentUser: AuthUser | null;
  activeRole: UserRole;
  demoModeEnabled?: boolean;
  demoAccounts?: DemoAccountSummary[];
  onDemoLogin?: (userId: string) => Promise<void>;
  onReturnAdmin?: () => void;
  onOpenAccount?: () => void;
  onNotify: (msg: string) => void;
}

interface ThemeClasses {
  logoBox: string;
  badge: string;
  primaryBtn: string;
  progressBar: string;
  selectedCard: string;
  accentText: string;
}

const THEME_CLASS_MAP: Record<PortalAccentTheme, ThemeClasses> = {
  indigo: {
    logoBox: 'bg-indigo-600 text-white',
    badge: 'border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300',
    primaryBtn: 'bg-indigo-600 hover:bg-indigo-500 text-white',
    progressBar: 'bg-indigo-600',
    selectedCard: 'border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/20',
    accentText: 'text-indigo-600 dark:text-indigo-400',
  },
  emerald: {
    logoBox: 'bg-emerald-600 text-white',
    badge: 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300',
    primaryBtn: 'bg-emerald-600 hover:bg-emerald-500 text-white',
    progressBar: 'bg-emerald-600',
    selectedCard: 'border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20',
    accentText: 'text-emerald-600 dark:text-emerald-400',
  },
  blue: {
    logoBox: 'bg-blue-600 text-white',
    badge: 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300',
    primaryBtn: 'bg-blue-600 hover:bg-blue-500 text-white',
    progressBar: 'bg-blue-600',
    selectedCard: 'border-blue-500 bg-blue-50/40 dark:bg-blue-950/20',
    accentText: 'text-blue-600 dark:text-blue-400',
  },
  slate: {
    logoBox: 'bg-slate-800 text-white',
    badge: 'border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200',
    primaryBtn: 'bg-slate-800 hover:bg-slate-700 text-white',
    progressBar: 'bg-slate-700',
    selectedCard: 'border-slate-600 bg-slate-100/60 dark:bg-slate-800/40',
    accentText: 'text-slate-700 dark:text-slate-300',
  },
  amber: {
    logoBox: 'bg-amber-600 text-white',
    badge: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
    primaryBtn: 'bg-amber-600 hover:bg-amber-500 text-white',
    progressBar: 'bg-amber-600',
    selectedCard: 'border-amber-500 bg-amber-50/40 dark:bg-amber-950/20',
    accentText: 'text-amber-600 dark:text-amber-400',
  },
  rose: {
    logoBox: 'bg-rose-600 text-white',
    badge: 'border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300',
    primaryBtn: 'bg-rose-600 hover:bg-rose-500 text-white',
    progressBar: 'bg-rose-600',
    selectedCard: 'border-rose-500 bg-rose-50/40 dark:bg-rose-950/20',
    accentText: 'text-rose-600 dark:text-rose-400',
  },
};

const PORTAL_STAGES: PortalRequestStage[] = [
  'Documents received',
  'In review',
  'Awaiting your approval',
  'Complete',
];

interface PortalLiveNotification {
  id: string;
  title: string;
  detail: string;
  timeUtc: string;
  tone: 'confirmed' | 'withdrawn' | 'info';
}

export const ClientPortalView: React.FC<ClientPortalViewProps> = ({
  currentUser,
  activeRole,
  demoModeEnabled = false,
  demoAccounts = [],
  onDemoLogin,
  onReturnAdmin,
  onOpenAccount,
  onNotify,
}) => {
  const tenantId = currentUser ? currentUser.tenantId : 'firm_demo';
  const isStaffManager = activeRole !== 'client' && activeRole !== 'admin_it';

  const [data, setData] = useState<PortalOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorInfo, setErrorInfo] = useState<{ message: string; code: string } | null>(null);

  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [selectedRequestId, setSelectedRequestId] = useState<string>('');
  const [stageFilter, setStageFilter] = useState<'all' | PortalRequestStage>('all');
  const [docScope, setDocScope] = useState<'selected' | 'all'>('selected');

  // Intake form state
  const [newReqTitle, setNewReqTitle] = useState('');
  const [newReqPeriod, setNewReqPeriod] = useState('Nov 2026');
  const [newReqTemplateId, setNewReqTemplateId] = useState('');
  const [newReqDueDate, setNewReqDueDate] = useState('');
  const [newReqNotes, setNewReqNotes] = useState('');

  // Messaging
  const [messageDraft, setMessageDraft] = useState('');

  // Electronic signature approval modal state
  const [signingRequestId, setSigningRequestId] = useState<string | null>(null);
  const [signatureName, setSignatureName] = useState(
    currentUser?.name || ''
  );
  const [signatureAttested, setSignatureAttested] = useState(false);
  const [approvalNotes, setApprovalNotes] = useState('');

  // Staff portal publishing & document controls
  const [newMilestoneTitle, setNewMilestoneTitle] = useState('');
  const [withdrawingMilestoneId, setWithdrawingMilestoneId] = useState<string | null>(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [newDocTitle, setNewDocTitle] = useState('');
  const [newDocDueDate, setNewDocDueDate] = useState('');

  // Real-time transport + milestone notifications
  const [wsConnected, setWsConnected] = useState(false);
  const [liveNotifications, setLiveNotifications] = useState<PortalLiveNotification[]>([]);
  const seenMilestoneIdsRef = useRef<Set<string>>(new Set());
  const prevClientIdRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);

  const applyOverview = useCallback((overview: PortalOverviewData) => {
    if (prevClientIdRef.current !== overview.clientId) {
      prevClientIdRef.current = overview.clientId;
      seenMilestoneIdsRef.current.clear();
      for (const m of overview.milestones) {
        seenMilestoneIdsRef.current.add(m.id);
      }
      setLiveNotifications([]);
    } else {
      const newNotes: PortalLiveNotification[] = [];
      for (const m of overview.milestones) {
        if (!seenMilestoneIdsRef.current.has(m.id) && m.status === 'confirmed') {
          newNotes.push({
            id: `notif-${m.id}`,
            title: `Milestone Confirmed: ${m.title}`,
            detail: `Confirmed by ${m.confirmedBy}`,
            timeUtc: m.confirmedAtUtc,
            tone: 'confirmed',
          });
        }
      }
      if (newNotes.length > 0) {
        setLiveNotifications((existing) => [...newNotes, ...existing].slice(0, 6));
      }
      for (const m of overview.milestones) {
        seenMilestoneIdsRef.current.add(m.id);
      }
    }

    setData(overview);
    setErrorInfo(null);

    if (overview.requests.length > 0) {
      setSelectedRequestId((prev) =>
        prev && overview.requests.some((r) => r.id === prev)
          ? prev
          : overview.requests[0].id
      );
    } else {
      setSelectedRequestId('');
    }

    if (overview.templates.length > 0) {
      setNewReqTemplateId((prev) =>
        prev && overview.templates.some((t) => t.id === prev)
          ? prev
          : overview.templates[0].id
      );
    }
  }, []);

  const loadPortal = useCallback(
    async (opts?: { silent?: boolean; clientIdOverride?: string }) => {
      if (!opts?.silent) setLoading(true);
      try {
        const overview = await fetchPortalOverviewApi({
          tenantId,
          viewerRole: activeRole,
          previewUserId: !currentUser ? 'demo_u_client_01' : undefined,
          clientId:
            opts?.clientIdOverride !== undefined
              ? opts.clientIdOverride || undefined
              : isStaffManager
              ? selectedClientId || undefined
              : undefined,
        });
        applyOverview(overview);
      } catch (err: any) {
        const code =
          err instanceof PortalApiError ? err.code : 'PORTAL_LOAD_FAILED';
        setErrorInfo({
          code,
          message: err?.message || 'Unable to load Client Portal.',
        });
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [tenantId, activeRole, currentUser, isStaffManager, selectedClientId, applyOverview]
  );

  // Initial + dependency-triggered load (purely async state updates after await)
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const overview = await fetchPortalOverviewApi({
          tenantId,
          viewerRole: activeRole,
          previewUserId: !currentUser ? 'demo_u_client_01' : undefined,
          clientId: isStaffManager ? selectedClientId || undefined : undefined,
        });
        if (!active) return;
        applyOverview(overview);
      } catch (err: any) {
        if (!active) return;
        const code =
          err instanceof PortalApiError ? err.code : 'PORTAL_LOAD_FAILED';
        setErrorInfo({
          code,
          message: err?.message || 'Unable to load Client Portal.',
        });
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [
    tenantId,
    activeRole,
    currentUser,
    isStaffManager,
    selectedClientId,
    applyOverview,
  ]);

  // Real-time WebSocket subscription + HTTPS polling fallback (SYNC-1 / PORT-1)
  useEffect(() => {
    if (errorInfo?.code === 'ADMIN_NO_CLIENT_CONTENT') return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams({
      tenantId,
      previewRole: activeRole,
      previewUserId: currentUser?.userId || 'demo_u_client_01',
    });
    const wsUrl = `${proto}//${window.location.host}/ws/engine?${qs.toString()}`;

    let ws: WebSocket | null = null;
    let disposed = false;

    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        if (!disposed) setWsConnected(true);
      };
      ws.onclose = () => {
        if (!disposed) setWsConnected(false);
      };
      ws.onerror = () => {
        if (!disposed) setWsConnected(false);
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (
            msg.type === 'portal:updated' ||
            (msg.type === 'state:updated' && msg.portalVisible === true)
          ) {
            if (msg.kind === 'milestone_confirmed' && msg.title) {
              const confirmedItem: PortalLiveNotification = {
                id: `ws-${Date.now()}`,
                title: `Confirmed Milestone Published: ${String(msg.title)}`,
                detail: 'Live update received via real-time gateway',
                timeUtc: msg.sentAtUtc || new Date().toISOString(),
                tone: 'confirmed',
              };
              setLiveNotifications((prev) =>
                [
                  confirmedItem,
                  ...prev.filter((p) => p.title !== confirmedItem.title),
                ].slice(0, 6)
              );
            } else if (msg.kind === 'milestone_withdrawn') {
              const withdrawnItem: PortalLiveNotification = {
                id: `ws-${Date.now()}`,
                title: 'Milestone Correction Notice Published',
                detail: String(msg.reason || 'Confirmed milestone withdrawn by firm.'),
                timeUtc: msg.sentAtUtc || new Date().toISOString(),
                tone: 'withdrawn',
              };
              setLiveNotifications((prev) => [withdrawnItem, ...prev].slice(0, 6));
            }
            void loadPortal({ silent: true });
          }
        } catch {
          // ignore malformed WS frames
        }
      };
    } catch {
      // WebSocket unsupported or blocked; HTTPS polling fallback handles sync
    }

    return () => {
      disposed = true;
      if (ws && ws.readyState < WebSocket.CLOSING) {
        ws.close();
      }
    };
  }, [tenantId, activeRole, currentUser?.userId, errorInfo?.code, loadPortal]);

  // HTTPS polling fallback (5s when WS is offline, 30s safety refresh otherwise)
  useEffect(() => {
    if (errorInfo?.code === 'ADMIN_NO_CLIENT_CONTENT') return;
    const pollTimer = window.setInterval(() => {
      void loadPortal({ silent: true });
    }, wsConnected ? 30000 : 5000);
    return () => window.clearInterval(pollTimer);
  }, [errorInfo?.code, loadPortal, wsConnected]);

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newReqTitle.trim()) return;
    setBusy(true);
    try {
      const res = await createPortalRequestApi({
        tenantId,
        viewerRole: activeRole,
        clientId: data?.clientId,
        title: newReqTitle.trim(),
        period: newReqPeriod.trim() || 'Nov 2026',
        templateId: newReqTemplateId || null,
        expectedDueUtc: newReqDueDate ? new Date(`${newReqDueDate}T17:00:00Z`).toISOString() : undefined,
        notes: newReqNotes.trim() || undefined,
      });
      setNewReqTitle('');
      setNewReqNotes('');
      setNewReqDueDate('');
      if (res.request?.id) setSelectedRequestId(res.request.id);
      onNotify('Engagement request submitted and queued from firm template.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Failed to submit request.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmSignatureApproval = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!signingRequestId || !signatureName.trim() || !signatureAttested) return;
    setBusy(true);
    try {
      await approvePortalRequestApi({
        tenantId,
        viewerRole: activeRole,
        requestId: signingRequestId,
        signatureName: signatureName.trim(),
        approvalNotes: approvalNotes.trim() || undefined,
      });
      setSigningRequestId(null);
      setSignatureAttested(false);
      setApprovalNotes('');
      onNotify('Approval & electronic signature recorded.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Approval failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateStage = async (requestId: string, stage: PortalRequestStage) => {
    setBusy(true);
    try {
      await updatePortalRequestStageApi({
        tenantId,
        viewerRole: activeRole,
        requestId,
        stage,
      });
      onNotify(`Engagement stage updated to "${stage}".`);
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Stage update failed.');
    } finally {
      setBusy(false);
    }
  };

  const handlePublishMilestone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReq || !newMilestoneTitle.trim()) return;
    setBusy(true);
    try {
      await confirmPortalMilestoneApi({
        tenantId,
        viewerRole: activeRole,
        requestId: activeReq.id,
        title: newMilestoneTitle.trim(),
      });
      setNewMilestoneTitle('');
      onNotify('Confirmed milestone published to Client Portal.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Failed to confirm milestone.');
    } finally {
      setBusy(false);
    }
  };

  const handleWithdrawMilestone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!withdrawingMilestoneId || !withdrawReason.trim()) return;
    setBusy(true);
    try {
      await withdrawPortalMilestoneApi({
        tenantId,
        viewerRole: activeRole,
        milestoneId: withdrawingMilestoneId,
        reason: withdrawReason.trim(),
      });
      setWithdrawingMilestoneId(null);
      setWithdrawReason('');
      onNotify('Milestone withdrawal correction recorded.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Withdrawal failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReq || !messageDraft.trim()) return;
    setBusy(true);
    try {
      await postPortalMessageApi({
        tenantId,
        viewerRole: activeRole,
        requestId: activeReq.id,
        body: messageDraft.trim(),
      });
      setMessageDraft('');
      onNotify('Message sent.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Failed to post message.');
    } finally {
      setBusy(false);
    }
  };

  const handleFileUpload = async (docReqId: string, file: File) => {
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const contentBase64 = btoa(binary);
      await uploadPortalDocumentApi({
        tenantId,
        viewerRole: activeRole,
        docReqId,
        originalName: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64,
      });
      onNotify(`Uploaded "${file.name}" securely.`);
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateDocRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReq || !newDocTitle.trim()) return;
    setBusy(true);
    try {
      await createPortalDocRequestApi({
        tenantId,
        viewerRole: activeRole,
        requestId: activeReq.id,
        title: newDocTitle.trim(),
        dueDateUtc: newDocDueDate ? new Date(`${newDocDueDate}T17:00:00Z`).toISOString() : undefined,
      });
      setNewDocTitle('');
      setNewDocDueDate('');
      onNotify('Document request added and sent to client portal.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Failed to add document request.');
    } finally {
      setBusy(false);
    }
  };

  const handleSendDocReminder = async (docReqId: string) => {
    setBusy(true);
    try {
      await sendPortalDocReminderApi({
        tenantId,
        viewerRole: activeRole,
        docReqId,
      });
      onNotify('Reminder sent to client portal.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Reminder failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyDoc = async (docReqId: string) => {
    setBusy(true);
    try {
      await verifyPortalDocUploadApi({
        tenantId,
        viewerRole: activeRole,
        docReqId,
      });
      onNotify('Uploaded document verified & confirmed milestone published.');
      await loadPortal({ silent: true });
    } catch (err: any) {
      onNotify(err?.message || 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const filteredRequests = useMemo(() => {
    if (!data) return [];
    if (stageFilter === 'all') return data.requests;
    return data.requests.filter((r) => r.stage === stageFilter);
  }, [data, stageFilter]);

  const activeReq = data
    ? data.requests.find((r) => r.id === selectedRequestId) ||
      filteredRequests[0] ||
      data.requests[0] ||
      null
    : null;

  if (loading && !data) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-8 text-sm text-slate-500 dark:text-slate-400">
        Loading Client Portal...
      </div>
    );
  }

  if (errorInfo && !data) {
    const clientDemos = demoAccounts.filter((a) => a.role === 'client');
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-7 space-y-5 max-w-3xl mx-auto">
        <div className="flex items-start gap-3">
          <Lock className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">
              {errorInfo.code === 'ADMIN_NO_CLIENT_CONTENT'
                ? 'Role Privacy Guard: Admin / IT Cannot Access Client Portal Work Content'
                : 'Unable to Load Client Portal'}
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {errorInfo.message}
              {errorInfo.code === 'ADMIN_NO_CLIENT_CONTENT'
                ? ' Per firm privacy rules (VIS-1), Admin/IT manages branding, templates, and device sync health in the Admin Console rather than viewing client files or engagement requests.'
                : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {errorInfo.code === 'ADMIN_NO_CLIENT_CONTENT' && onReturnAdmin && (
            <button
              type="button"
              onClick={onReturnAdmin}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Return to Admin &amp; Fleet Console</span>
            </button>
          )}
          {onOpenAccount && (
            <button
              type="button"
              onClick={onOpenAccount}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg cursor-pointer"
            >
              Account / Switch Sign-In
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadPortal()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>

        {demoModeEnabled && clientDemos.length > 0 && onDemoLogin && (
          <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
            <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Open Portal as a Demo Client Account
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {clientDemos.map((acc) => (
                <button
                  key={acc.userId}
                  type="button"
                  onClick={() => void onDemoLogin(acc.userId)}
                  className="text-left p-3 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-indigo-400 bg-slate-50 dark:bg-slate-800/60 cursor-pointer transition-colors"
                >
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    {acc.name.split(' (')[0]}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                    {acc.email}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!data) return null;

  const theme =
    THEME_CLASS_MAP[(data.branding?.accentTheme as PortalAccentTheme) || 'indigo'] ||
    THEME_CLASS_MAP.indigo;

  const activeMessages = activeReq
    ? data.messages.filter((m) => m.requestId === activeReq.id)
    : [];
  const activeMilestones = activeReq
    ? data.milestones.filter((m) => m.requestId === activeReq.id)
    : data.milestones;
  const visibleDocs =
    docScope === 'selected' && activeReq
      ? data.documentRequests.filter((d) => d.requestId === activeReq.id)
      : data.documentRequests;

  const selectedTemplateForIntake =
    data.templates.find((t) => t.id === newReqTemplateId) || data.templates[0] || null;
  const activeReqTemplate = activeReq?.templateId
    ? data.templates.find((t) => t.id === activeReq.templateId) || null
    : null;

  const awaitingApprovalCount = data.requests.filter(
    (r) => r.stage === 'Awaiting your approval' && r.approvalStatus === 'pending'
  ).length;
  const pendingDocsWithReminders = data.documentRequests.filter(
    (d) => d.status === 'pending' && (d.isOverdue || d.reminderSentAtUtc)
  );

  const signingTargetReq = signingRequestId
    ? data.requests.find((r) => r.id === signingRequestId) || null
    : null;

  return (
    <div className="space-y-5">
      {/* Firm-Branded Portal Header (PORT-1 & PORT-2) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            {data.branding.logoFileId ? (
              <img
                src={`/api/portal/branding/logo/${encodeURIComponent(data.branding.logoFileId)}?tenantId=${encodeURIComponent(tenantId)}`}
                alt={`${data.firmName} logo`}
                className="w-11 h-11 rounded-lg object-cover border border-slate-200 dark:border-slate-700 shrink-0"
              />
            ) : (
              <div
                className={`w-11 h-11 rounded-lg flex items-center justify-center font-display font-bold text-sm shrink-0 ${theme.logoBox}`}
              >
                {data.branding.logoText || 'OT'}
              </div>
            )}

            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white">
                  {data.branding.portalTitle || `${data.firmName} — Client Portal`}
                </h1>
                <span className={`font-mono text-xs px-2 py-0.5 rounded border ${theme.badge}`}>
                  {data.clientName}
                </span>
                {data.branding.customDomain && (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    <Globe className="w-3 h-3" />
                    <span>{data.branding.customDomain}</span>
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                {data.branding.welcomeMessage}
              </p>
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>
                  {data.branding.supportNotice ||
                    'Confirmed deliverables only · Internal staff telemetry and preliminary guesses are strictly excluded.'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {isStaffManager && data.availableClients.length > 0 && (
              <select
                aria-label="Select Client Account"
                value={data.clientId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setSelectedClientId(nextId);
                  setSelectedRequestId('');
                  void loadPortal({ clientIdOverride: nextId });
                }}
                className="px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-medium cursor-pointer"
              >
                {data.availableClients.map((c) => (
                  <option key={c.id} value={c.id}>
                    Client: {c.legalName}
                  </option>
                ))}
              </select>
            )}

            <span
              className={`inline-flex items-center gap-1.5 font-mono text-[11px] px-2.5 py-1.5 rounded border ${
                wsConnected
                  ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
            >
              <Wifi className="w-3 h-3" />
              <span>{wsConnected ? 'Live Sync' : 'HTTPS Polling'}</span>
            </span>

            <span className="font-mono tabular-nums px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300">
              Last Updated:{' '}
              {new Date(data.lastUpdatedUtc).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}{' '}
              (
              {new Date(data.lastUpdatedUtc).toISOString().slice(11, 19)} UTC)
            </span>

            <button
              type="button"
              onClick={() => void loadPortal()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </section>

      {/* Real-Time Milestone Confirmation Notifications & Automatic Reminders */}
      {(liveNotifications.length > 0 ||
        awaitingApprovalCount > 0 ||
        pendingDocsWithReminders.length > 0) && (
        <section className="space-y-2">
          {liveNotifications.map((notif) => (
            <div
              key={notif.id}
              className={`px-4 py-2.5 rounded-lg border flex items-center justify-between gap-3 text-xs ${
                notif.tone === 'withdrawn'
                  ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200'
                  : 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200'
              }`}
            >
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 shrink-0" />
                <div>
                  <span className="font-semibold">{notif.title}</span>
                  <span className="ml-2 opacity-80">
                    {notif.detail} · {new Date(notif.timeUtc).toLocaleTimeString()}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setLiveNotifications((prev) => prev.filter((p) => p.id !== notif.id))
                }
                className="text-[11px] underline cursor-pointer shrink-0"
              >
                Dismiss
              </button>
            </div>
          ))}

          {(awaitingApprovalCount > 0 || pendingDocsWithReminders.length > 0) && (
            <div className="px-4 py-2.5 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/25 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900 dark:text-amber-200">
              <div className="flex flex-wrap items-center gap-4">
                {awaitingApprovalCount > 0 && (
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <PenTool className="w-3.5 h-3.5" />
                    <span>
                      {awaitingApprovalCount} deliverable{awaitingApprovalCount > 1 ? 's' : ''}{' '}
                      awaiting your approval &amp; signature
                    </span>
                  </span>
                )}
                {pendingDocsWithReminders.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <Clock className="w-3.5 h-3.5" />
                    <span>
                      {pendingDocsWithReminders.length} document request
                      {pendingDocsWithReminders.length > 1 ? 's' : ''} with active automatic
                      reminder{pendingDocsWithReminders.some((d) => d.isOverdue) ? ' (overdue)' : ''}
                    </span>
                  </span>
                )}
              </div>
              <span className="font-mono text-[11px] opacity-80">
                {data.requests.length} total engagement{data.requests.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
        </section>
      )}

      {/* Main 12-Column Portal Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left 7 Columns: Engagement Tracker, Staff Stage/Milestone Controls & Milestone Audit Log */}
        <div className="lg:col-span-7 space-y-6">
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Clock className={`w-4 h-4 ${theme.accentText}`} />
                <span>Engagement Requests &amp; Approvals</span>
              </h2>
              <select
                aria-label="Filter by stage"
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value as 'all' | PortalRequestStage)}
                className="px-2.5 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 cursor-pointer"
              >
                <option value="all">All Stages ({data.requests.length})</option>
                {PORTAL_STAGES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            </div>

            {filteredRequests.length === 0 ? (
              <div className="p-6 text-center rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                No engagement requests match this filter yet. Use the Request Intake form to create one from a firm template.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredRequests.map((req) => {
                  const isSelected = activeReq?.id === req.id;
                  const stageIdx = PORTAL_STAGES.indexOf(req.stage);
                  return (
                    <div
                      key={req.id}
                      onClick={() => setSelectedRequestId(req.id)}
                      className={`p-4 rounded-lg border transition-colors cursor-pointer ${
                        isSelected
                          ? theme.selectedCard
                          : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-white">
                            {req.title}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            Period: {req.period} · Expected Due:{' '}
                            {new Date(req.expectedDueUtc).toLocaleDateString()} (
                            {req.expectedDueUtc.slice(0, 10)})
                          </div>
                          {req.notes && (
                            <p className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">
                              {req.notes}
                            </p>
                          )}
                        </div>

                        {req.approvalStatus === 'approved' ? (
                          <div className="text-right">
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-[11px] font-semibold">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Signed Off</span>
                            </span>
                            {req.signatureName && (
                              <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 mt-1">
                                Signed by {req.signatureName} ·{' '}
                                {req.approvedAtUtc
                                  ? new Date(req.approvedAtUtc).toLocaleDateString()
                                  : ''}
                              </div>
                            )}
                          </div>
                        ) : req.stage === 'Awaiting your approval' ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSigningRequestId(req.id);
                              setSignatureName(
                                currentUser?.name || `${data.clientName} Authorized Signer`
                              );
                              setSignatureAttested(false);
                              setApprovalNotes('');
                            }}
                            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${theme.primaryBtn}`}
                          >
                            <PenTool className="w-3.5 h-3.5" />
                            <span>Approve &amp; Sign Off</span>
                          </button>
                        ) : (
                          <span className="font-mono text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300">
                            {req.stage}
                          </span>
                        )}
                      </div>

                      {/* 4-Stage Progress Bar */}
                      <div className="mt-3 grid grid-cols-4 gap-1.5">
                        {PORTAL_STAGES.map((st, idx) => (
                          <div key={st} className="space-y-1">
                            <div
                              className={`h-1.5 rounded ${
                                idx <= stageIdx
                                  ? theme.progressBar
                                  : 'bg-slate-200 dark:bg-slate-800'
                              }`}
                            />
                            <div className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
                              {st}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Staff Deliverable Stage Switcher (visible to Firm Staff only) */}
                      {isStaffManager && isSelected && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                            Staff Stage Control:
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {PORTAL_STAGES.map((st) => (
                              <button
                                key={st}
                                type="button"
                                disabled={busy || req.stage === st}
                                onClick={() => void handleUpdateStage(req.id, st)}
                                className={`px-2 py-1 text-[10px] font-medium rounded border cursor-pointer disabled:opacity-50 ${
                                  req.stage === st
                                    ? theme.badge
                                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                                }`}
                              >
                                {st}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Template Milestone Blueprint for Selected Request (PORT-2) */}
            {activeReq && activeReqTemplate && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
                <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-2 flex items-center gap-1.5">
                  <Sparkles className={`w-3.5 h-3.5 ${theme.accentText}`} />
                  <span>Template Milestone Roadmap · {activeReqTemplate.name}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeReqTemplate.milestoneNames.map((stepName, idx) => {
                    const isConfirmed = activeMilestones.some(
                      (m) =>
                        m.status === 'confirmed' &&
                        m.title.toLowerCase().includes(stepName.toLowerCase().slice(0, 12))
                    );
                    return (
                      <div
                        key={`${activeReqTemplate.id}-m-${idx}`}
                        className={`text-[11px] px-2.5 py-1 rounded border flex items-center gap-1.5 ${
                          isConfirmed
                            ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                            : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        <span className="font-mono font-bold">{idx + 1}.</span>
                        <span>{stepName}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* Confirmed Milestones & Withdrawn Correction Audit (PORT-1 & PORT-2) */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <FileCheck2 className="w-4 h-4 text-emerald-600" />
                <span>Confirmed Milestones &amp; Correction Log</span>
              </h2>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                {activeMilestones.filter((m) => m.status === 'confirmed').length} confirmed ·{' '}
                {activeMilestones.filter((m) => m.status === 'withdrawn').length} corrections
              </span>
            </div>

            {isStaffManager && activeReq && (
              <form
                onSubmit={handlePublishMilestone}
                className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/40 flex flex-wrap gap-2 text-xs"
              >
                <input
                  type="text"
                  value={newMilestoneTitle}
                  onChange={(e) => setNewMilestoneTitle(e.target.value)}
                  placeholder={`Publish confirmed milestone for ${activeReq.period}...`}
                  className="flex-1 min-w-[200px] px-3 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                />
                <button
                  type="submit"
                  disabled={busy || !newMilestoneTitle.trim()}
                  className={`px-3 py-1.5 text-xs font-semibold rounded cursor-pointer disabled:opacity-50 ${theme.primaryBtn}`}
                >
                  Confirm &amp; Publish Live
                </button>
              </form>
            )}

            <div className="space-y-2.5">
              {activeMilestones.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  No confirmed milestones published on this request yet. Unconfirmed activity never appears here.
                </p>
              ) : (
                activeMilestones.map((m) => (
                  <div
                    key={m.id}
                    className={`p-3 rounded-lg border text-xs ${
                      m.status === 'withdrawn'
                        ? 'border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/30'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {m.title}
                      </div>
                      {m.status === 'withdrawn' ? (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300 font-semibold shrink-0">
                          <AlertTriangle className="w-3.5 h-3.5" /> Withdrawn Correction
                        </span>
                      ) : (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-semibold">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Confirmed
                          </span>
                          {isStaffManager && (
                            <button
                              type="button"
                              onClick={() => {
                                setWithdrawingMilestoneId(m.id);
                                setWithdrawReason('');
                              }}
                              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 cursor-pointer"
                            >
                              <RotateCcw className="w-2.5 h-2.5" />
                              <span>Withdraw</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                      Confirmed by {m.confirmedBy} on{' '}
                      {new Date(m.confirmedAtUtc).toLocaleString()}
                    </div>
                    {m.status === 'withdrawn' && m.withdrawalReason && (
                      <div className="mt-1.5 text-[11px] text-amber-800 dark:text-amber-200 font-medium">
                        Correction (
                        {m.withdrawnAtUtc
                          ? new Date(m.withdrawnAtUtc).toLocaleString()
                          : ''}
                        ): {m.withdrawalReason}
                      </div>
                    )}
                    {withdrawingMilestoneId === m.id && (
                      <form onSubmit={handleWithdrawMilestone} className="mt-2.5 flex gap-2">
                        <input
                          type="text"
                          required
                          value={withdrawReason}
                          onChange={(e) => setWithdrawReason(e.target.value)}
                          placeholder="Reason for correction (shown to client with timestamp)..."
                          className="flex-1 px-2.5 py-1 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-[11px]"
                        />
                        <button
                          type="submit"
                          disabled={busy || !withdrawReason.trim()}
                          className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white text-[11px] font-semibold cursor-pointer"
                        >
                          Record Withdrawal
                        </button>
                        <button
                          type="button"
                          onClick={() => setWithdrawingMilestoneId(null)}
                          className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 text-[11px] cursor-pointer"
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* Right 5 Columns: Document Vault, Request Messages & Template Intake */}
        <div className="lg:col-span-5 space-y-6">
          {/* Document Requests & Upload */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Upload className={`w-4 h-4 ${theme.accentText}`} />
                <span>Document Requests &amp; Vault</span>
              </h2>
              <div className="flex items-center gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => setDocScope('selected')}
                  className={`px-2 py-0.5 rounded border cursor-pointer ${
                    docScope === 'selected'
                      ? theme.badge
                      : 'border-slate-200 dark:border-slate-700 text-slate-500'
                  }`}
                >
                  This Request
                </button>
                <button
                  type="button"
                  onClick={() => setDocScope('all')}
                  className={`px-2 py-0.5 rounded border cursor-pointer ${
                    docScope === 'all'
                      ? theme.badge
                      : 'border-slate-200 dark:border-slate-700 text-slate-500'
                  }`}
                >
                  All ({data.documentRequests.length})
                </button>
              </div>
            </div>

            {isStaffManager && activeReq && (
              <form
                onSubmit={handleCreateDocRequest}
                className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/30 space-y-2 text-xs"
              >
                <input
                  type="text"
                  value={newDocTitle}
                  onChange={(e) => setNewDocTitle(e.target.value)}
                  placeholder="Request new client document (e.g., Signed T2 Schedule)..."
                  className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                />
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={newDocDueDate}
                    onChange={(e) => setNewDocDueDate(e.target.value)}
                    className="w-1/2 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
                  />
                  <button
                    type="submit"
                    disabled={busy || !newDocTitle.trim()}
                    className={`w-1/2 px-2.5 py-1 text-[11px] font-semibold rounded cursor-pointer disabled:opacity-50 ${theme.primaryBtn}`}
                  >
                    + Add Doc Request
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-2.5">
              {visibleDocs.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  No document requests on this item.
                </p>
              ) : (
                visibleDocs.map((doc) => (
                  <div
                    key={doc.id}
                    className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-2 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-slate-900 dark:text-white flex items-start gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                        <span>{doc.title}</span>
                      </div>
                      <span
                        className={`font-mono text-[11px] px-2 py-0.5 rounded border shrink-0 ${
                          doc.status === 'pending'
                            ? doc.isOverdue
                              ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
                              : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                            : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                        }`}
                      >
                        {doc.status === 'pending' && doc.isOverdue ? 'overdue' : doc.status}
                      </span>
                    </div>

                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      Due {new Date(doc.dueDateUtc).toLocaleDateString()}
                      {doc.reminderSentAtUtc &&
                        ` · Reminder sent ${new Date(doc.reminderSentAtUtc).toLocaleDateString()}`}
                      {doc.uploadedFileName && ` · File: ${doc.uploadedFileName}`}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {doc.status !== 'verified' && (
                        <label className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-medium cursor-pointer text-[11px] ${theme.badge}`}>
                          <Upload className="w-3 h-3" />
                          <span>
                            {doc.status === 'uploaded' ? 'Replace Upload' : 'Upload Document'}
                          </span>
                          <input
                            type="file"
                            className="hidden"
                            disabled={busy}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void handleFileUpload(doc.id, file);
                            }}
                          />
                        </label>
                      )}

                      {doc.uploadedFileId && (
                        <a
                          href={getPortalFileDownloadUrl({
                            fileId: doc.uploadedFileId,
                            tenantId,
                            viewerRole: activeRole,
                          })}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 text-[11px] text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          <Download className="w-3 h-3" />
                          <span>Download</span>
                        </a>
                      )}

                      {isStaffManager && doc.status === 'pending' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleSendDocReminder(doc.id)}
                          className="px-2 py-1 rounded border border-amber-300 dark:border-amber-800 text-[11px] text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 cursor-pointer"
                        >
                          Send Reminder
                        </button>
                      )}

                      {isStaffManager && doc.status === 'uploaded' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleVerifyDoc(doc.id)}
                          className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold cursor-pointer"
                        >
                          Verify &amp; Confirm
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Request Message Thread */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <MessageSquare className={`w-4 h-4 ${theme.accentText}`} />
              <span>Request Messages {activeReq ? `· ${activeReq.period}` : ''}</span>
            </h2>
            <div className="space-y-2 max-h-56 overflow-y-auto text-xs">
              {activeMessages.length === 0 ? (
                <p className="text-slate-500 dark:text-slate-400">
                  No messages on this request yet.
                </p>
              ) : (
                activeMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`p-2.5 rounded border ${
                      msg.senderRole === 'client'
                        ? 'border-indigo-200 dark:border-indigo-900 bg-indigo-50/40 dark:bg-indigo-950/20'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {msg.senderName}
                        <span className="ml-1.5 font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                          {msg.senderRole === 'client' ? 'Client' : 'Firm Team'}
                        </span>
                      </span>
                      <span>{new Date(msg.createdAtUtc).toLocaleTimeString()}</span>
                    </div>
                    <p className="mt-1 text-slate-700 dark:text-slate-300">{msg.body}</p>
                  </div>
                ))
              )}
            </div>
            {activeReq && (
              <form onSubmit={handleSendMessage} className="flex gap-2">
                <input
                  type="text"
                  value={messageDraft}
                  onChange={(e) => setMessageDraft(e.target.value)}
                  placeholder="Write a message on this engagement..."
                  className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                />
                <button
                  type="submit"
                  disabled={busy || !messageDraft.trim()}
                  className={`inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg disabled:opacity-50 cursor-pointer ${theme.primaryBtn}`}
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>
            )}
          </section>

          {/* New Request Intake (from Firm Templates) */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-3">
            <h2 className="font-display text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Plus className={`w-4 h-4 ${theme.accentText}`} />
              <span>Request Intake (From Firm Template)</span>
            </h2>
            <form onSubmit={handleCreateRequest} className="space-y-2.5 text-xs">
              <select
                value={newReqTemplateId}
                onChange={(e) => setNewReqTemplateId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
              >
                {data.templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    Template: {tpl.name}
                  </option>
                ))}
              </select>

              {selectedTemplateForIntake && (
                <div className="p-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 text-[11px] text-slate-600 dark:text-slate-300 space-y-1">
                  <div className="font-semibold text-slate-700 dark:text-slate-200">
                    Included Milestones ({selectedTemplateForIntake.milestoneNames.length}):
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selectedTemplateForIntake.milestoneNames.map((m, i) => (
                      <span
                        key={i}
                        className="px-1.5 py-0.5 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                      >
                        {i + 1}. {m}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <input
                type="text"
                required
                value={newReqTitle}
                onChange={(e) => setNewReqTitle(e.target.value)}
                placeholder="Request title (e.g., Nov 2026 Bank Reconciliation)"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
              />

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  value={newReqPeriod}
                  onChange={(e) => setNewReqPeriod(e.target.value)}
                  placeholder="Period (e.g., Nov 2026)"
                  className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                />
                <input
                  type="date"
                  value={newReqDueDate}
                  onChange={(e) => setNewReqDueDate(e.target.value)}
                  aria-label="Target due date"
                  className="px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                />
              </div>

              <textarea
                rows={2}
                value={newReqNotes}
                onChange={(e) => setNewReqNotes(e.target.value)}
                placeholder="Optional scope or instructions for your accounting team..."
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
              />

              <button
                type="submit"
                disabled={busy || !newReqTitle.trim()}
                className={`w-full px-3 py-2 text-xs font-semibold rounded-lg disabled:opacity-50 cursor-pointer ${theme.primaryBtn}`}
              >
                Submit Engagement Request &amp; Create Firm Task
              </button>
            </form>
          </section>
        </div>
      </div>

      {/* Electronic Approval & Signature Modal */}
      {signingTargetReq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 shadow-xl space-y-4">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="font-display text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <PenTool className={`w-4 h-4 ${theme.accentText}`} />
                  <span>Client Deliverable Approval &amp; Electronic Signature</span>
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {signingTargetReq.title} · {signingTargetReq.period}
                </p>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                Confirmed Milestones Included:
              </div>
              {data.milestones
                .filter((m) => m.requestId === signingTargetReq.id && m.status === 'confirmed')
                .map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span>{m.title}</span>
                  </div>
                ))}
            </div>

            <form onSubmit={handleConfirmSignatureApproval} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Typed Full Name (Electronic Signature)
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  value={signatureName}
                  onChange={(e) => setSignatureName(e.target.value)}
                  placeholder="Enter your full legal name"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white font-semibold"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Optional Sign-Off Notes
                </label>
                <textarea
                  rows={2}
                  value={approvalNotes}
                  onChange={(e) => setApprovalNotes(e.target.value)}
                  placeholder="Any authorization notes or filing instructions..."
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-white"
                />
              </div>

              <label className="flex items-start gap-2 text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={signatureAttested}
                  onChange={(e) => setSignatureAttested(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I confirm I am authorized to approve this deliverable and execute this electronic signature on behalf of{' '}
                  <strong>{data.clientName}</strong>.
                </span>
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setSigningRequestId(null)}
                  className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !signatureName.trim() || !signatureAttested}
                  className={`px-4 py-2 font-semibold rounded-lg disabled:opacity-50 cursor-pointer ${theme.primaryBtn}`}
                >
                  Execute Sign-Off
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
