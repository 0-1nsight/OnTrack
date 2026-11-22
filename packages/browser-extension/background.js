const DEFAULT_BRIDGE_ORIGIN = 'http://127.0.0.1:47621';

async function getConfig() {
  const stored = await chrome.storage.local.get([
    'bridgeUrl',
    'excludedDomains',
  ]);
  return {
    bridgeUrl: stored.bridgeUrl || `${DEFAULT_BRIDGE_ORIGIN}/browser-event`,
    excludedDomains: stored.excludedDomains || ['personalbank', 'mychart', 'chase.com'],
  };
}

async function syncExclusionsFromAgentBridge() {
  try {
    const res = await fetch(`${DEFAULT_BRIDGE_ORIGIN}/config`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.excludedDomains)) {
      await chrome.storage.local.set({ excludedDomains: data.excludedDomains });
    }
  } catch {
    // Local bridge offline; continue with cached exclusions
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
  const domainLower = urlMeta.domain.toLowerCase();
  if (cfg.excludedDomains.some((d) => domainLower.includes(d.toLowerCase()))) {
    return;
  }

  try {
    await fetch(cfg.bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  } catch {
    // Desktop agent handles window-title fallback when local bridge is unreachable
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('ontrack-sync-config', { periodInMinutes: 1 });
  void syncExclusionsFromAgentBridge();
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
