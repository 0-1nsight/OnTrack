const statusBadgeEl = document.getElementById('statusBadge');
const controlNoteEl = document.getElementById('controlNote');
const recordingControlsEl = document.getElementById('recordingControls');
const resumeControlsEl = document.getElementById('resumeControls');
const pause15Btn = document.getElementById('pause15Btn');
const pause60Btn = document.getElementById('pause60Btn');
const offRecordBtn = document.getElementById('offRecordBtn');
const resumeBtn = document.getElementById('resumeBtn');
const captureHealthSummaryEl = document.getElementById('captureHealthSummary');
const sqliteSummaryEl = document.getElementById('sqliteSummary');
const healthIssueNoteEl = document.getElementById('healthIssueNote');
const pairingDetailsEl = document.getElementById('pairingDetails');
const bridgeUrlInput = document.getElementById('bridgeUrl');
const bridgeSecretInput = document.getElementById('bridgeSecret');
const toggleSecretBtn = document.getElementById('toggleSecretBtn');
const bridgeForm = document.getElementById('bridgeForm');
const feedbackEl = document.getElementById('feedback');
const lastSyncUtcEl = document.getElementById('lastSyncUtc');
const exclusionCountEl = document.getElementById('exclusionCount');
const lastEventSummaryEl = document.getElementById('lastEventSummary');

const STATUS_LABELS = {
  connected: 'Recording',
  paused: 'Paused',
  off_the_record: 'Off the Record',
  outside_schedule: 'Outside Schedule',
  unauthorized: '401 Invalid Secret',
  offline: 'Agent Offline',
  unconfigured: 'Secret Required',
};

function formatClockTime(ms) {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderState(state) {
  const syncStatus = state.lastSyncStatus || (state.bridgeSecret ? 'offline' : 'unconfigured');
  const controls = state.agentControls || null;
  const health = state.captureHealth || null;

  let displayKey = syncStatus;
  if (syncStatus === 'connected' && controls) {
    if (controls.offTheRecord) displayKey = 'off_the_record';
    else if (controls.blockedReason === 'paused') displayKey = 'paused';
    else if (controls.blockedReason === 'outside_schedule') displayKey = 'paused';
  }

  const label =
    displayKey === 'paused' && controls?.blockedReason === 'outside_schedule'
      ? STATUS_LABELS.outside_schedule
      : STATUS_LABELS[displayKey] || syncStatus;
  statusBadgeEl.textContent = label;
  statusBadgeEl.className = `status-text ${displayKey}`;

  const connected = syncStatus === 'connected';
  const blocked = Boolean(controls && controls.allowedNow === false);

  pause15Btn.disabled = !connected;
  pause60Btn.disabled = !connected;
  offRecordBtn.disabled = !connected;
  resumeBtn.disabled = !connected;

  if (!connected) {
    recordingControlsEl.style.display = 'grid';
    resumeControlsEl.style.display = 'none';
    controlNoteEl.textContent =
      syncStatus === 'unconfigured'
        ? 'Pair with your Desktop Agent secret below to control background capture.'
        : syncStatus === 'unauthorized'
          ? 'Bridge secret rejected (401). Update pairing settings below.'
          : 'Desktop Agent not detected on localhost. Start OnTrack Agent to manage capture.';
    if (syncStatus === 'unconfigured' || syncStatus === 'unauthorized') {
      pairingDetailsEl.open = true;
    }
  } else if (blocked) {
    recordingControlsEl.style.display = 'none';
    resumeControlsEl.style.display = 'block';
    if (controls.offTheRecord) {
      controlNoteEl.textContent =
        'Off the Record is active. No window titles or browser tabs are being recorded.';
    } else if (controls.blockedReason === 'paused') {
      const until = formatClockTime(controls.resumesAtMs);
      controlNoteEl.textContent = until
        ? `Capture is paused until ${until}. Resume anytime below.`
        : 'Capture is currently paused.';
    } else {
      const until = formatClockTime(controls.resumesAtMs);
      controlNoteEl.textContent = until
        ? `Outside configured work schedule. Resumes automatically at ${until}.`
        : 'Outside configured work schedule.';
    }
  } else {
    recordingControlsEl.style.display = 'grid';
    resumeControlsEl.style.display = 'none';
    controlNoteEl.textContent =
      'Background metadata capture is active (no screenshots or keystrokes).';
  }

  if (health) {
    const levelLabel = String(health.level || 'good').toUpperCase();
    const modeLabel = health.collectorMode ? ` · ${health.collectorMode}` : '';
    captureHealthSummaryEl.textContent = `${levelLabel} (${Number(health.score ?? 100)}%)${modeLabel}`;
    const firstIssue = Array.isArray(health.issues) && health.issues.length > 0 ? health.issues[0] : null;
    if (firstIssue && firstIssue.severity !== 'info') {
      healthIssueNoteEl.style.display = 'block';
      healthIssueNoteEl.textContent = firstIssue.message;
    } else {
      healthIssueNoteEl.style.display = 'none';
      healthIssueNoteEl.textContent = '';
    }
    if (health.localStore) {
      const kb = Math.max(1, Math.round(Number(health.localStore.dbBytes || 0) / 1024));
      const pending = Number(health.localStore.pendingCount || 0);
      sqliteSummaryEl.textContent = pending === 0 ? `Synced · ${kb} KB` : `${pending} queued · ${kb} KB`;
    } else {
      sqliteSummaryEl.textContent = '--';
    }
  } else {
    captureHealthSummaryEl.textContent = connected ? 'Active' : 'Unavailable';
    sqliteSummaryEl.textContent = '--';
    healthIssueNoteEl.style.display = 'none';
  }

  lastSyncUtcEl.textContent = state.lastSyncUtc
    ? new Date(state.lastSyncUtc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'Never';
  exclusionCountEl.textContent = Array.isArray(state.excludedDomains)
    ? String(state.excludedDomains.length)
    : '0';
  lastEventSummaryEl.textContent = state.lastEventSummary || 'None';
}

async function loadState() {
  const stored = await chrome.storage.local.get([
    'bridgeUrl',
    'bridgeSecret',
    'excludedDomains',
    'lastSyncStatus',
    'lastSyncUtc',
    'lastEventSummary',
    'agentControls',
    'captureHealth',
  ]);
  bridgeUrlInput.value = stored.bridgeUrl || 'http://127.0.0.1:47621/browser-event';
  bridgeSecretInput.value = stored.bridgeSecret || '';
  renderState(stored);
}

async function refreshFromWorker() {
  try {
    await chrome.runtime.sendMessage({ type: 'ontrack:get-status' });
  } catch {
    // ignore if background worker asleep or offline
  }
  await loadState();
}

async function sendControl(payload, successText) {
  feedbackEl.textContent = 'Applying capture control...';
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'ontrack:apply-control',
      payload,
    });
    await loadState();
    feedbackEl.textContent = res?.ok ? successText : res?.error || 'Unable to update controls.';
  } catch {
    feedbackEl.textContent = 'Desktop Agent unreachable.';
  }
}

pause15Btn.addEventListener('click', () => {
  void sendControl({ action: 'pause', minutes: 15 }, 'Capture paused for 15 minutes.');
});

pause60Btn.addEventListener('click', () => {
  void sendControl({ action: 'pause', minutes: 60 }, 'Capture paused for 1 hour.');
});

offRecordBtn.addEventListener('click', () => {
  void sendControl({ action: 'offTheRecord', enabled: true }, 'Switched to Off the Record.');
});

resumeBtn.addEventListener('click', () => {
  void sendControl({ action: 'resume' }, 'Capture resumed.');
});

toggleSecretBtn.addEventListener('click', () => {
  const nextType = bridgeSecretInput.type === 'password' ? 'text' : 'password';
  bridgeSecretInput.type = nextType;
  toggleSecretBtn.textContent = nextType === 'password' ? 'Show' : 'Hide';
});

bridgeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const bridgeUrl = bridgeUrlInput.value.trim() || 'http://127.0.0.1:47621/browser-event';
  const bridgeSecret = bridgeSecretInput.value.trim();

  feedbackEl.textContent = 'Testing local agent bridge...';
  await chrome.storage.local.set({ bridgeUrl, bridgeSecret });

  try {
    const response = await chrome.runtime.sendMessage({ type: 'ontrack:sync-config' });
    await loadState();
    if (response?.status === 'connected') {
      feedbackEl.textContent = 'Bridge authenticated and exclusions synced.';
    } else if (response?.status === 'unauthorized') {
      feedbackEl.textContent = 'Bridge rejected secret (HTTP 401). Verify agent.config.json.';
    } else if (response?.status === 'unconfigured') {
      feedbackEl.textContent = 'Enter a non-empty bridge secret to pair with Desktop Agent.';
    } else {
      feedbackEl.textContent = 'Saved settings. Start OnTrack Desktop Agent to connect.';
    }
  } catch {
    await loadState();
    feedbackEl.textContent = 'Saved settings. Open background worker or start Desktop Agent.';
  }
});

void loadState().then(() => refreshFromWorker());
