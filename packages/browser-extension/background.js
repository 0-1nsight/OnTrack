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
  ]);
  return {
    bridgeUrl: stored.bridgeUrl || DEFAULT_BRIDGE_URL,
    bridgeSecret: typeof stored.bridgeSecret === 'string' ? stored.bridgeSecret.trim() : '',
    excludedDomains: Array.isArray(stored.excludedDomains)
      ? stored.excludedDomains
      : DEFAULT_EXCLUDED_DOMAINS,
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
    return 'unconfigured';
  }

  const origin = deriveBridgeOrigin(cfg.bridgeUrl);
  try {
    const res = await fetch(`${origin}/config`, {
      headers: {
        'X-OnTrack-Bridge-Secret': cfg.bridgeSecret,
      },
    });
    if (res.status === 401 || res.status === 403) {
      await chrome.storage.local.set({
        lastSyncStatus: 'unauthorized',
        lastSyncUtc: new Date().toISOString(),
      });
      return 'unauthorized';
    }
    if (!res.ok) {
      await chrome.storage.local.set({
        lastSyncStatus: 'offline',
        lastSyncUtc: new Date().toISOString(),
      });
      return 'offline';
    }
    const data = await res.json();
    const nextState = {
      lastSyncStatus: 'connected',
      lastSyncUtc: new Date().toISOString(),
    };
    if (Array.isArray(data.excludedDomains)) {
      nextState.excludedDomains = data.excludedDomains;
    }
    await chrome.storage.local.set(nextState);
    return 'connected';
  } catch {
    await chrome.storage.local.set({
      lastSyncStatus: 'offline',
      lastSyncUtc: new Date().toISOString(),
    });
    return 'offline';
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
      await chrome.storage.local.set({
        lastSyncStatus: 'connected',
        lastSyncUtc: new Date().toISOString(),
        lastEventSummary: `${urlMeta.domain}${extra.downloadFilename ? ` · ${extra.downloadFilename}` : ''}`,
      });
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
  if (message?.type === 'ontrack:sync-config') {
    defaultsSeedPromise = null;
    void syncExclusionsFromAgentBridge().then((status) => {
      sendResponse({ ok: status === 'connected', status });
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
