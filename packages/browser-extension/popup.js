const statusBadgeEl = document.getElementById('statusBadge');
const bridgeUrlInput = document.getElementById('bridgeUrl');
const bridgeSecretInput = document.getElementById('bridgeSecret');
const toggleSecretBtn = document.getElementById('toggleSecretBtn');
const bridgeForm = document.getElementById('bridgeForm');
const feedbackEl = document.getElementById('feedback');
const lastSyncUtcEl = document.getElementById('lastSyncUtc');
const exclusionCountEl = document.getElementById('exclusionCount');
const lastEventSummaryEl = document.getElementById('lastEventSummary');

const STATUS_LABELS = {
  connected: 'Connected',
  unauthorized: '401 Invalid Secret',
  offline: 'Agent Offline',
  unconfigured: 'Secret Required',
};

function renderState(state) {
  const status = state.lastSyncStatus || (state.bridgeSecret ? 'offline' : 'unconfigured');
  statusBadgeEl.textContent = STATUS_LABELS[status] || status;
  statusBadgeEl.className = `badge ${status}`;
  lastSyncUtcEl.textContent = state.lastSyncUtc || 'Never';
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
  ]);
  bridgeUrlInput.value = stored.bridgeUrl || 'http://127.0.0.1:47621/browser-event';
  bridgeSecretInput.value = stored.bridgeSecret || '';
  renderState(stored);
}

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
      feedbackEl.textContent = 'Bridge authenticated and exclusion list synced.';
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

void loadState();
