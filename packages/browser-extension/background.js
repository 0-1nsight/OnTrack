const DEFAULT_BRIDGE_ORIGIN = 'http://127.0.0.1:47621';
const DEFAULT_BRIDGE_URL = `${DEFAULT_BRIDGE_ORIGIN}/browser-event`;
const DEFAULT_EXCLUDED_DOMAINS = ['personalbank', 'mychart', 'chase.com'];

let defaultsSeedPromise = null;

async function ensureDefaultsSeeded() {
  if (!defaultsSeedPromise) {
    defaultsSeedPromise = (async () => {
      const stored = await chrome.storage.local.get([
        'bridgeUrl',
        'bridgeSecret',
        'excludedDomains',
      ]);
      if (stored.bridgeUrl && typeof stored.bridgeSecret === 'string' && stored.bridgeSecret.length > 0) {
        return;
      }

      try {
        const res = await fetch(chrome.runtime.getURL('config.defaults.json'));
        if (!res.ok) return;
        const defaults = await res.json();
        const updates = {};
        if (!stored.bridgeUrl && typeof defaults.bridgeUrl === 'string') {
          updates.bridgeUrl = defaults.bridgeUrl;
        }
        if (!stored.bridgeSecret && typeof defaults.bridgeSecret === 'string' && defaults.bridgeSecret.trim()) {
          updates.bridgeSecret = defaults.bridgeSecret.trim();
        }
        if (!Array.isArray(stored.excludedDomains) && Array.isArray(defaults.excludedDomains)) {
          updates.excludedDomains = defaults.excludedDomains;
        }
        if (Object.keys(updates).length > 0) {
          await chrome.storage.local.set(updates);
        }
      } catch {
        // Fallback defaults still apply
      }
    })();
  }
  return defaultsSeedPromise;
}

async function getConfig() {
  await ensureDefaultsSeeded();
  const stored = await chrome.storage.local.get([
    'bridgeUrl',
    'bridgeSecret',
    'excludedDomains',
    'agentControls',
    'captureHealth',
  ]);
  return {
    bridgeUrl: stored.bridgeUrl || DEFAULT_BRIDGE_URL,
    bridgeSecret: typeof stored.bridgeSecret === 'string' ? stored.bridgeSecret.trim() : '',
    excludedDomains: Array.isArray(stored.excludedDomains)
      ? stored.excludedDomains
      : DEFAULT_EXCLUDED_DOMAINS,
    agentControls: stored.agentControls || null,
    captureHealth: stored.captureHealth || null,
  };
}

function deriveBridgeOrigin(bridgeUrl) {
  try {
    return new URL(bridgeUrl).origin;
  } catch {
    return DEFAULT_BRIDGE_ORIGIN;
  }
}

async function syncExclusionsFromAgentBridge() {
  const cfg = await getConfig();
  if (!cfg.bridgeSecret) {
    await chrome.storage.local.set({
      lastSyncStatus: 'unconfigured',
      lastSyncUtc: new Date().toISOString(),
    });
    return { status: 'unconfigured', agentControls: null, captureHealth: null };
  }

  const origin = deriveBridgeOrigin(cfg.bridgeUrl);
  const headers = {
    'X-OnTrack-Bridge-Secret': cfg.bridgeSecret,
  };
  try {
    const [cfgRes, controlsRes, healthRes] = await Promise.all([
      fetch(`${origin}/config`, { headers }),
      fetch(`${origin}/controls`, { headers }).catch(() => null),
      fetch(`${origin}/capture-health`, { headers }).catch(() => null),
    ]);

    if (cfgRes.status === 401 || cfgRes.status === 403) {
      await chrome.storage.local.set({
        lastSyncStatus: 'unauthorized',
        lastSyncUtc: new Date().toISOString(),
      });
      return { status: 'unauthorized', agentControls: null, captureHealth: null };
    }
    if (!cfgRes.ok) {
      await chrome.storage.local.set({
        lastSyncStatus: 'offline',
        lastSyncUtc: new Date().toISOString(),
      });
      return { status: 'offline', agentControls: null, captureHealth: null };
    }

    const data = await cfgRes.json();
    const agentControls = controlsRes && controlsRes.ok ? await controlsRes.json().catch(() => null) : null;
    const captureHealth = healthRes && healthRes.ok ? await healthRes.json().catch(() => null) : null;

    const nextState = {
      lastSyncStatus: 'connected',
      lastSyncUtc: new Date().toISOString(),
    };
    if (Array.isArray(data.excludedDomains)) {
      nextState.excludedDomains = data.excludedDomains;
    }
    if (agentControls) {
      nextState.agentControls = agentControls;
    }
    if (captureHealth) {
      nextState.captureHealth = captureHealth;
    }
    await chrome.storage.local.set(nextState);
    return { status: 'connected', agentControls, captureHealth };
  } catch {
    await chrome.storage.local.set({
      lastSyncStatus: 'offline',
      lastSyncUtc: new Date().toISOString(),
    });
    return { status: 'offline', agentControls: null, captureHealth: null };
  }
}

async function applyAgentControlAction(actionPayload) {
  const cfg = await getConfig();
  if (!cfg.bridgeSecret) {
    return { ok: false, status: 'unconfigured', error: 'Bridge secret is required.' };
  }

  const origin = deriveBridgeOrigin(cfg.bridgeUrl);
  const headers = {
    'Content-Type': 'application/json',
    'X-OnTrack-Bridge-Secret': cfg.bridgeSecret,
  };
  try {
    const res = await fetch(`${origin}/controls`, {
      method: 'POST',
      headers,
      body: JSON.stringify(actionPayload || {}),
    });
    if (res.status === 401 || res.status === 403) {
      await chrome.storage.local.set({
        lastSyncStatus: 'unauthorized',
        lastSyncUtc: new Date().toISOString(),
      });
      return { ok: false, status: 'unauthorized', error: 'Invalid bridge secret.' };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      return { ok: false, status: 'connected', error: body.error || 'Control request failed.' };
    }
    const healthRes = await fetch(`${origin}/capture-health`, {
      headers: { 'X-OnTrack-Bridge-Secret': cfg.bridgeSecret },
    }).catch(() => null);
    const captureHealth = healthRes && healthRes.ok ? await healthRes.json().catch(() => null) : null;

    const nextUpdates = {
      lastSyncStatus: 'connected',
      lastSyncUtc: new Date().toISOString(),
    };
    if (body.controls) nextUpdates.agentControls = body.controls;
    if (captureHealth) nextUpdates.captureHealth = captureHealth;
    await chrome.storage.local.set(nextUpdates);
    return { ok: true, status: 'connected', controls: body.controls, captureHealth };
  } catch {
    await chrome.storage.local.set({ lastSyncStatus: 'offline' });
    return { ok: false, status: 'offline', error: 'Desktop agent offline.' };
  }
}

function sanitizeUrlMetadata(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return {
      domain: parsed.hostname,
      url: `${parsed.origin}${parsed.pathname}`,
    };
  } catch {
    return null;
  }
}

function isTrackingLocallyBlocked(agentControls) {
  if (!agentControls) return false;
  if (agentControls.offTheRecord) return true;
  if (typeof agentControls.pausedUntilMs === 'number' && Date.now() < agentControls.pausedUntilMs) {
    return true;
  }
  return false;
}

async function emitTabMetadata(tab, extra = {}) {
  // PRIV-1: Ignore private / incognito windows completely before storage or bridge call
  if (!tab || tab.incognito) {
    return;
  }

  const urlMeta = sanitizeUrlMetadata(tab.url || '');
  if (!urlMeta) return;

  const cfg = await getConfig();
  if (!cfg.bridgeSecret) {
    await chrome.storage.local.set({
      lastSyncStatus: 'unconfigured',
    });
    return;
  }

  if (isTrackingLocallyBlocked(cfg.agentControls)) {
    return;
  }

  const domainLower = urlMeta.domain.toLowerCase();
  if (cfg.excludedDomains.some((d) => domainLower.includes(d.toLowerCase()))) {
    return;
  }

  try {
    const res = await fetch(cfg.bridgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OnTrack-Bridge-Secret': cfg.bridgeSecret,
      },
      body: JSON.stringify({
        browser: navigator.userAgent.includes('Edg')
          ? 'Microsoft Edge'
          : navigator.userAgent.includes('Firefox')
          ? 'Mozilla Firefox'
          : 'Google Chrome',
        domain: urlMeta.domain,
        url: urlMeta.url,
        pageTitle: tab.title || urlMeta.domain,
        incognito: false,
        downloadFilename: extra.downloadFilename || null,
        durationMs: 10000,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      await chrome.storage.local.set({
        lastSyncStatus: 'unauthorized',
        lastSyncUtc: new Date().toISOString(),
      });
      return;
    }

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const updates = {
        lastSyncStatus: 'connected',
        lastSyncUtc: new Date().toISOString(),
      };
      if (data.accepted !== false) {
        updates.lastEventSummary = `${urlMeta.domain}${extra.downloadFilename ? ` · ${extra.downloadFilename}` : ''}`;
      }
      await chrome.storage.local.set(updates);
    }
  } catch {
    await chrome.storage.local.set({
      lastSyncStatus: 'offline',
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  defaultsSeedPromise = null;
  chrome.alarms.create('ontrack-sync-config', { periodInMinutes: 1 });
  void syncExclusionsFromAgentBridge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ontrack:sync-config' || message?.type === 'ontrack:get-status') {
    defaultsSeedPromise = null;
    void syncExclusionsFromAgentBridge().then((result) => {
      sendResponse({
        ok: result.status === 'connected',
        status: result.status,
        agentControls: result.agentControls,
        captureHealth: result.captureHealth,
      });
    });
    return true;
  }
  if (message?.type === 'ontrack:apply-control') {
    void applyAgentControlAction(message.payload).then((result) => {
      sendResponse(result);
    });
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ontrack-sync-config') {
    void syncExclusionsFromAgentBridge();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await emitTabMetadata(tab);
  } catch {
    // ignore closed tabs
  }
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.title) {
    await emitTabMetadata(tab);
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  try {
    const tab = await chrome.tabs.get(details.tabId);
    await emitTabMetadata(tab);
  } catch {
    // ignore
  }
});

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (downloadItem.incognito) return;
  const filename = (downloadItem.filename || downloadItem.url || '').split(/[\\/]/).pop();
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab) {
    await emitTabMetadata(activeTab, { downloadFilename: filename || null });
  }
});
