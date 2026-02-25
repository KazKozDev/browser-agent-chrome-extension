/**
 * Background Service Worker
 *
 * Orchestrates:
 * - Side panel ↔ Agent communication
 * - Provider initialization
 * - Tab management
 * - Keep-alive via chrome.alarms + setInterval
 */

import { ProviderManager } from '../providers/index.js';
import { Agent } from '../agent/agent.js';
import { dispatchConnection } from '../integrations/index.js';

let providerManager = null;
let activeAgent = null;
let sidePanelPort = null;
let initPromise = null;
const NOTIFICATION_ICON_URL = chrome.runtime.getURL('icons/icon48.png');

// Buffered outbound events while sidepanel is disconnected.
const replayBuffer = [];
const MAX_REPLAY_MESSAGES = 300;
const CONNECTIONS_STORAGE_KEY = 'connectionsState';
const ACTIVE_SESSION_STORAGE_KEY = 'activeAgentSession';
const ACTIVE_SESSION_VERSION = 1;
const SESSION_HISTORY_LIMIT = 200;
const BLOCKLIST_RULE_ID_BASE = 32000;
const BLOCKLIST_RULE_CAP = 1000;
const BLOCKED_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
];
const BLOCKLIST_MATCH_MODE = {
  REQUEST_DOMAINS: 'requestDomains',
  URL_FILTER: 'urlFilter',
};

// Keep in sync with agent-side defaults for deterministic policy behavior.
const DEFAULT_BLOCKED_DOMAINS = [
  'paypal.com',
  'venmo.com',
  'cashapp.com',
  'zelle.com',
  'wise.com',
  'binance.com',
  'coinbase.com',
  'bybit.com',
  'kraken.com',
  'bitfinex.com',
  'blockchain.com',
  'metamask.io',
];

const WARN_THROTTLE_MS = 10000;
const MAX_TELEMETRY_ITEMS = 30;
const warnTimestamps = new Map();

function normalizeBlockedDomain(raw) {
  let input = String(raw || '').trim().toLowerCase();
  if (!input) return '';
  input = input.replace(/^[a-z]+:\/\//, '');
  input = input.split('/')[0] || '';
  input = input.split('@').pop() || '';
  input = input.replace(/:\d+$/, '');
  input = input.replace(/^www\./, '').replace(/\.+$/, '').trim();
  if (!input) return '';
  if (!/^[a-z0-9.-]+$/.test(input)) return '';
  if (input.includes('..')) return '';
  return input;
}

function normalizeCustomBlockedDomains(rawDomains) {
  if (!Array.isArray(rawDomains)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawDomains) {
    const domain = normalizeBlockedDomain(raw);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

function buildEffectiveBlockedDomains(customDomains) {
  const out = [];
  const seen = new Set();
  const pushDomain = (raw) => {
    const domain = normalizeBlockedDomain(raw);
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    out.push(domain);
  };
  for (const domain of DEFAULT_BLOCKED_DOMAINS) pushDomain(domain);
  for (const domain of normalizeCustomBlockedDomains(customDomains)) pushDomain(domain);
  return out;
}

function buildBlocklistRules(domains, mode = BLOCKLIST_MATCH_MODE.REQUEST_DOMAINS) {
  return domains.slice(0, BLOCKLIST_RULE_CAP).map((domain, idx) => ({
    id: BLOCKLIST_RULE_ID_BASE + idx,
    priority: 1,
    action: { type: 'block' },
    condition: mode === BLOCKLIST_MATCH_MODE.REQUEST_DOMAINS
      ? {
        requestDomains: [domain],
        resourceTypes: BLOCKED_RESOURCE_TYPES,
      }
      : {
        urlFilter: `||${domain}^`,
        resourceTypes: BLOCKED_RESOURCE_TYPES,
      },
  }));
}

async function syncNetworkBlockRules(customDomains = null) {
  if (!chrome?.declarativeNetRequest?.updateDynamicRules || !chrome?.declarativeNetRequest?.getDynamicRules) {
    return { synced: false, reason: 'declarativeNetRequest unavailable' };
  }

  let custom = customDomains;
  if (!Array.isArray(custom)) {
    const stored = await chrome.storage.local.get('customBlockedDomains');
    custom = stored?.customBlockedDomains;
  }

  const effectiveDomains = buildEffectiveBlockedDomains(custom);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((rule) => rule?.id >= BLOCKLIST_RULE_ID_BASE && rule.id < BLOCKLIST_RULE_ID_BASE + BLOCKLIST_RULE_CAP)
    .map((rule) => rule.id);

  const trySync = async (mode) => {
    const addRules = buildBlocklistRules(effectiveDomains, mode);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    return { synced: true, rules: addRules.length, domains: effectiveDomains.length, mode };
  };

  try {
    return await trySync(BLOCKLIST_MATCH_MODE.REQUEST_DOMAINS);
  } catch (err) {
    const message = String(err?.message || err || '').toLowerCase();
    const maySupportFallback =
      message.includes('requestdomains')
      || message.includes('unexpected property')
      || message.includes('invalid condition')
      || message.includes('rule with id');
    if (!maySupportFallback) throw err;
    debugWarn('syncNetworkBlockRules.requestDomainsFallback', err);
    return await trySync(BLOCKLIST_MATCH_MODE.URL_FILTER);
  }
}

let blocklistSyncQueue = Promise.resolve();
function enqueueNetworkBlockSync(customDomains = null) {
  blocklistSyncQueue = blocklistSyncQueue
    .catch(() => {})
    .then(() => syncNetworkBlockRules(customDomains));
  return blocklistSyncQueue;
}

async function ensureNetworkBlockFilteringReady() {
  const sync = await enqueueNetworkBlockSync();
  if (sync?.synced) return sync;
  throw new Error(sync?.reason || 'Network blocklist sync failed');
}

// ===== TRACKER / AD BLOCKER (static ruleset) =====

async function isTrackerBlockerPreferenceOn() {
  const { trackerBlockerEnabled } = await chrome.storage.local.get('trackerBlockerEnabled');
  return trackerBlockerEnabled !== false; // enabled by default
}

async function enableTrackerBlocker() {
  if (!chrome?.declarativeNetRequest?.updateEnabledRulesets) return;
  const pref = await isTrackerBlockerPreferenceOn();
  if (!pref) return;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['tracker_blocker'] });
    console.log('[BG] Tracker blocker enabled');
  } catch (err) {
    debugWarn('trackerBlocker.enable', err);
  }
}

async function disableTrackerBlocker() {
  if (!chrome?.declarativeNetRequest?.updateEnabledRulesets) return;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['tracker_blocker'] });
    console.log('[BG] Tracker blocker disabled');
  } catch (err) {
    debugWarn('trackerBlocker.disable', err);
  }
}

function appendTelemetry(source, context, message) {
  if (!chrome?.storage?.local) return;
  chrome.storage.local.get('diagnosticTelemetry')
    .then(({ diagnosticTelemetry = [] }) => {
      diagnosticTelemetry.unshift({
        source,
        context,
        message,
        timestamp: Date.now(),
      });
      if (diagnosticTelemetry.length > MAX_TELEMETRY_ITEMS) {
        diagnosticTelemetry.length = MAX_TELEMETRY_ITEMS;
      }
      return chrome.storage.local.set({ diagnosticTelemetry });
    })
    .catch((err) => {
      console.warn('[BG] telemetry.append failed:', err?.message || err);
    });
}

function buildActiveTabContext(tab) {
  if (!tab || typeof tab !== 'object') return null;
  const rawUrl = String(tab.url || '');
  const title = String(tab.title || '').trim();
  const tabId = Number.isFinite(Number(tab.id)) ? Number(tab.id) : null;

  if (!rawUrl) {
    return {
      tabId,
      url: '',
      title,
      hostname: '',
      pathname: '',
      protocol: '',
      searchQuery: '',
    };
  }

  try {
    const parsed = new URL(rawUrl);
    const searchQuery = String(
      parsed.searchParams.get('q')
      || parsed.searchParams.get('query')
      || parsed.searchParams.get('k')
      || ''
    ).trim();
    return {
      tabId,
      url: parsed.toString(),
      title,
      hostname: String(parsed.hostname || '').toLowerCase(),
      pathname: String(parsed.pathname || ''),
      protocol: String(parsed.protocol || ''),
      searchQuery,
    };
  } catch {
    return {
      tabId,
      url: rawUrl,
      title,
      hostname: '',
      pathname: '',
      protocol: '',
      searchQuery: '',
    };
  }
}

async function getActiveTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return buildActiveTabContext(tab);
}

function debugWarn(context, err) {
  const key = String(context || 'unknown');
  const now = Date.now();
  const last = warnTimestamps.get(key) || 0;
  if (now - last < WARN_THROTTLE_MS) return;
  warnTimestamps.set(key, now);
  const message = err?.message || String(err || 'unknown error');
  console.warn(`[BG] ${key}: ${message}`);
  appendTelemetry('BG', key, message);
}

// ===== INIT =====

async function init() {
  providerManager = new ProviderManager();
  await providerManager.init();
  console.log('[BG] Provider manager initialized');

  try {
    await enqueueNetworkBlockSync();
  } catch (err) {
    debugWarn('init.syncNetworkBlockRules', err);
  }

  // Re-register scheduled task alarms (cleared when SW terminated)
  try {
    const { scheduledTasks = [] } = await chrome.storage.local.get('scheduledTasks');
    for (const task of scheduledTasks) {
      if (task.enabled === false) continue;
      const existing = await chrome.alarms.get(task.id);
      if (!existing) {
        chrome.alarms.create(task.id, { periodInMinutes: task.periodMinutes });
      }
    }
  } catch (err) {
    debugWarn('init.scheduledTasks.restore', err);
  }
}

initPromise = init().catch((err) => {
  console.error('[BG] Initialization failed:', err);
  throw err;
});

async function ensureInitialized() {
  if (initPromise) {
    await initPromise;
  }
}

// ===== SAFE PORT MESSAGING =====

function safeSend(port, msg) {
  try {
    if (port) port.postMessage(msg);
  } catch (err) {
    console.warn('[BG] safeSend failed (port likely disconnected):', err.message);
  }
}

function clearReplayBuffer() {
  replayBuffer.length = 0;
}

function bufferReplayMessage(msg) {
  replayBuffer.push(msg);
  if (replayBuffer.length > MAX_REPLAY_MESSAGES) {
    replayBuffer.shift();
  }
}

function sendToSidePanel(msg, options = {}) {
  const { bufferIfDisconnected = true } = options;
  if (sidePanelPort) {
    safeSend(sidePanelPort, msg);
    return;
  }
  if (bufferIfDisconnected) {
    bufferReplayMessage(msg);
  }
}

async function getConnectionsState() {
  try {
    const stored = await chrome.storage.local.get(CONNECTIONS_STORAGE_KEY);
    return stored?.[CONNECTIONS_STORAGE_KEY] || null;
  } catch (err) {
    debugWarn('connections.getState', err);
    return null;
  }
}

function isRouteEnabled(state, routeId) {
  if (!state?.routing) return routeId === 'desktop';
  return state.routing[routeId] === true;
}

function isConnectorRouteEnabled(state, connectorId) {
  if (!connectorId) return false;
  const explicit = state?.routing?.[connectorId];
  if (typeof explicit === 'boolean') return explicit;
  return true;
}

function findConnectedIntegration(state, id) {
  const item = state?.integrations?.find((i) => i.id === id);
  if (!item || !item.connected) return null;
  return item;
}

function normalizeConnectorIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawIds) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function formatResultText(result, meta = {}) {
  const header = meta?.taskName ? `Task: ${meta.taskName}` : (meta?.goal ? `Goal: ${meta.goal}` : 'Task result');
  const status = result?.success ? 'Completed' : 'Failed';
  const summary = result?.summary || result?.reason || (result?.success ? 'Done.' : 'Failed.');
  const answer = result?.answer ? `\n\n${String(result.answer).slice(0, 1400)}` : '';
  return `${header}\nStatus: ${status}\nSteps: ${Number(result?.steps || 0)}\nSummary: ${summary}${answer}`;
}

function buildResultPayload(result, meta = {}) {
  const nowIso = new Date().toISOString();
  return {
    goal: meta?.goal || '',
    taskName: meta?.taskName || '',
    source: meta?.source || 'task',
    success: !!result?.success,
    steps: Number(result?.steps || 0),
    summary: result?.summary || result?.reason || '',
    answer: result?.answer || '',
    timestamp: nowIso,
    text: formatResultText(result, meta),
  };
}

async function notifyConnector(connectorId, message, meta = {}) {
  const id = String(connectorId || '').trim();
  const text = String(message || '').trim();
  if (!id) throw new Error('notifyConnector: connectorId is required');
  if (!text) throw new Error('notifyConnector: message is required');

  const state = await getConnectionsState();
  if (!state) throw new Error('notifyConnector: connections state is not available');

  const conn = findConnectedIntegration(state, id);
  if (!conn) throw new Error(`notifyConnector: connector "${id}" is not connected`);

  const payload = buildResultPayload(
    {
      success: true,
      steps: Number(meta?.step || 0),
      summary: String(meta?.summary || `Agent notification to ${id}`).slice(0, 180),
      answer: text,
    },
    {
      source: meta?.source || 'agent_tool',
      goal: meta?.goal || '',
      taskName: meta?.taskName || '',
    },
  );
  payload.text = text;
  await dispatchConnection(conn, payload, false);
  return { connectorId: id, delivery: { id, ok: true } };
}

async function routeTaskResult(result, meta = {}) {
  const state = await getConnectionsState();
  if (!state) return { state: null, delivery: [] };
  const payload = buildResultPayload(result, meta);
  const requestedConnectorIds = normalizeConnectorIds(meta?.connectorIds);
  const targets = requestedConnectorIds.length > 0
    ? requestedConnectorIds.map((id) => findConnectedIntegration(state, id)).filter(Boolean)
    : (Array.isArray(state.integrations) ? state.integrations : []).filter((item) => {
      if (!item?.connected) return false;
      return isConnectorRouteEnabled(state, item.id);
    });

  const seen = new Set();
  const unique = targets.filter((t) => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const delivery = [];
  for (const conn of unique) {
    try {
      await dispatchConnection(conn, payload, false);
      delivery.push({ id: conn.id, ok: true });
    } catch (err) {
      delivery.push({ id: conn.id, ok: false, error: err?.message || String(err) });
      debugWarn(`connections.route.${conn.id}`, err);
    }
  }
  return { state, delivery };
}

async function readActiveSession() {
  try {
    const stored = await chrome.storage.local.get(ACTIVE_SESSION_STORAGE_KEY);
    return stored?.[ACTIVE_SESSION_STORAGE_KEY] || null;
  } catch (err) {
    debugWarn('session.read', err);
    return null;
  }
}

async function clearActiveSession() {
  try {
    await chrome.storage.local.remove(ACTIVE_SESSION_STORAGE_KEY);
  } catch (err) {
    debugWarn('session.clear', err);
  }
}

function buildSessionSnapshot(agent, meta = {}, overrides = {}) {
  if (!agent || typeof agent.getCheckpointState !== 'function') return null;
  const state = agent.getCheckpointState(SESSION_HISTORY_LIMIT);
  if (!state || typeof state !== 'object') return null;
  const now = Date.now();
  return {
    version: ACTIVE_SESSION_VERSION,
    sessionId: String(meta.sessionId || `sess_${now}`),
    source: String(meta.source || 'task'),
    goal: String(meta.goal || state.goal || ''),
    taskName: String(meta.taskName || ''),
    planMode: !!meta.planMode,
    createdAt: Number(meta.createdAt || now),
    updatedAt: now,
    resumeCount: Number(meta.resumeCount || 0),
    status: String(overrides.status || state.status || 'running'),
    state,
  };
}

async function persistActiveSession(agent, meta = {}, overrides = {}) {
  try {
    const snapshot = buildSessionSnapshot(agent, meta, overrides);
    if (!snapshot) return null;
    await chrome.storage.local.set({ [ACTIVE_SESSION_STORAGE_KEY]: snapshot });
    return snapshot;
  } catch (err) {
    debugWarn('session.persist', err);
    return null;
  }
}

function normalizeRecoverableSession(session) {
  if (!session || typeof session !== 'object') return null;
  const status = String(session.status || '');
  if (!['running', 'paused_waiting_user', 'recoverable'].includes(status)) return null;
  const state = session.state || {};
  return {
    sessionId: String(session.sessionId || ''),
    source: String(session.source || 'task'),
    goal: String(session.goal || state.goal || ''),
    taskName: String(session.taskName || ''),
    status: status === 'recoverable' ? 'recoverable' : 'interrupted',
    updatedAt: Number(session.updatedAt || 0),
    createdAt: Number(session.createdAt || 0),
    nextStep: Number(state.nextStep || 0),
    lastKnownUrl: String(state.lastKnownUrl || ''),
  };
}

async function sendRecoverableSession(port) {
  const session = await readActiveSession();
  const recoverable = normalizeRecoverableSession(session);
  if (recoverable && !activeAgent) {
    safeSend(port, { type: 'recoverableSession', session: recoverable });
  } else {
    safeSend(port, { type: 'recoverableSessionCleared' });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'notifyConnector') return undefined;
  notifyConnector(msg.connectorId, msg.message, msg.meta || {})
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

// ===== SIDE PANEL CONNECTION =====

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;
    console.log('[BG] Side panel connected');

    if (replayBuffer.length > 0) {
      for (const msg of replayBuffer) safeSend(port, msg);
      clearReplayBuffer();
    }
    if (activeAgent?.status) {
      safeSend(port, { type: 'status', status: activeAgent.status });
    }
    sendRecoverableSession(port).catch((err) => debugWarn('session.sendRecoverable.onConnect', err));

    port.onMessage.addListener(async (msg) => {
      try {
        await handleSidePanelMessage(msg, port);
      } catch (err) {
        safeSend(port, { type: 'error', error: err.message });
      }
    });

    port.onDisconnect.addListener(() => {
      if (sidePanelPort === port) {
        sidePanelPort = null;
      }
      // Do NOT abort the agent — let it continue running in the background.
      // Events are buffered and replayed when the panel reconnects.
      console.log('[BG] Side panel disconnected — agent continues in background');
    });
  }
});

async function handleSidePanelMessage(msg, port) {
  await ensureInitialized();
  switch (msg.type) {
    case 'startTask': {
      const { goal } = msg;
      if (activeAgent?.status === 'running' || activeAgent?.status === 'paused_waiting_user') {
        safeSend(port, { type: 'error', error: 'Agent is already running. Stop it first.' });
        return;
      }

      // Get active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        safeSend(port, { type: 'error', error: 'No active tab found' });
        return;
      }

      // Preflight: ensure selected provider is actually usable.
      try {
        await providerManager.getProvider();
      } catch (err) {
        const reason = err?.message || 'Provider is not available';
        safeSend(port, {
          type: 'error',
          error: `${reason} Open Settings and configure API key for the selected provider.`,
        });
        safeSend(port, { type: 'status', status: 'idle' });
        return;
      }

      // Security preflight: enforce network-level blocklist rules before task run.
      try {
        const sync = await ensureNetworkBlockFilteringReady();
        safeSend(port, {
          type: 'networkBlockSync',
          synced: true,
          domains: Number(sync?.domains || 0),
          rules: Number(sync?.rules || 0),
          mode: String(sync?.mode || ''),
        });
      } catch (err) {
        const reason = err?.message || 'Network blocklist sync failed';
        safeSend(port, {
          type: 'error',
          error: `${reason}. Aborting task start to preserve safety policy.`,
        });
        safeSend(port, { type: 'status', status: 'idle' });
        return;
      }

      // Enable tracker/ad blocker for cleaner pages during agent run.
      await enableTrackerBlocker();

      // Create agent
      activeAgent = new Agent(providerManager, tab.id);
      clearReplayBuffer();
      const sessionMeta = {
        sessionId: `task_${Date.now()}`,
        source: 'task',
        goal,
        taskName: '',
        planMode: !!msg.planMode,
        createdAt: Date.now(),
        resumeCount: 0,
      };

      // Wire up callbacks
      activeAgent.onStep = (step) => {
        sendToSidePanel({ type: 'step', step });
        persistActiveSession(activeAgent, sessionMeta).catch((err) => debugWarn('session.persist.step', err));
      };
      activeAgent.onPlan = (plan) => {
        sendToSidePanel({ type: 'plan', plan });
      };
      activeAgent.onStatus = (status) => {
        // Manage keep-alive based on agent status
        if (status === 'running' || status === 'paused_waiting_user') {
          startKeepAlive();
        } else {
          stopKeepAlive();
        }
        sendToSidePanel({ type: 'status', status });
        persistActiveSession(activeAgent, sessionMeta, { status }).catch((err) => debugWarn('session.persist.status', err));
      };
      activeAgent.onIntervention = (details) => {
        sendToSidePanel({ type: 'manualIntervention', details });
        persistActiveSession(activeAgent, sessionMeta).catch((err) => debugWarn('session.persist.intervention', err));
      };
      activeAgent.onNotifyConnector = async ({ connectorId, message, meta }) => {
        const res = await notifyConnector(connectorId, message, meta || {});
        return { success: true, connectorId: res.connectorId, delivery: res.delivery };
      };

      sendToSidePanel({ type: 'status', status: 'running' }, { bufferIfDisconnected: false });
      await persistActiveSession(activeAgent, sessionMeta, { status: 'running' });

      try {
        // Run agent (async, non-blocking)
        const result = await activeAgent.run(goal, { planMode: msg.planMode || false });
        sendToSidePanel({ type: 'result', result });
        const routed = await routeTaskResult(result, { source: 'task', goal });

        // Desktop notification
        try {
          if (isRouteEnabled(routed?.state, 'desktop')) {
            chrome.notifications.create(`task-${Date.now()}`, {
              type: 'basic',
              iconUrl: NOTIFICATION_ICON_URL,
              title: result.success ? 'Task completed ✔' : 'Task failed',
              message: (result.summary || result.reason || (result.success ? 'Done.' : 'Could not complete.')).slice(0, 200),
            });
          }
        } catch (err) {
          debugWarn('notification.taskResult', err);
        }
      } finally {
        await disableTrackerBlocker();
        await clearActiveSession();
        activeAgent = null;
      }
      break;
    }

    case 'stopTask': {
      if (activeAgent) {
        activeAgent.abort();
        activeAgent = null;
        stopKeepAlive();
        clearReplayBuffer();
        await disableTrackerBlocker();
        await clearActiveSession();
        safeSend(port, { type: 'recoverableSessionCleared' });
        safeSend(port, { type: 'status', status: 'idle' });
      }
      break;
    }

    case 'resumeTask': {
      if (!activeAgent) {
        safeSend(port, { type: 'error', error: 'No active task to resume.' });
        return;
      }
      if (activeAgent.status !== 'paused_waiting_user') {
        safeSend(port, { type: 'error', error: 'Task is not waiting for manual input.' });
        return;
      }
      const guidance = String(msg.guidance || '').trim().slice(0, 500);
      const resumed = activeAgent.resume(guidance);
      if (!resumed) {
        safeSend(port, { type: 'error', error: 'Could not resume task. Try again.' });
      }
      break;
    }

    case 'finishPartialTask': {
      if (!activeAgent) {
        safeSend(port, { type: 'error', error: 'No active task to complete partially.' });
        return;
      }
      if (activeAgent.status !== 'paused_waiting_user') {
        safeSend(port, { type: 'error', error: 'Task is not waiting for manual input.' });
        return;
      }
      const accepted = activeAgent.requestPartialCompletion?.();
      if (!accepted) {
        safeSend(port, { type: 'error', error: 'Could not trigger partial completion. Try again.' });
      }
      break;
    }

    case 'resumeRecoveredTask': {
      if (activeAgent?.status === 'running' || activeAgent?.status === 'paused_waiting_user') {
        safeSend(port, { type: 'error', error: 'Agent is already running. Stop it first.' });
        return;
      }

      const session = await readActiveSession();
      const recoverable = normalizeRecoverableSession(session);
      if (!session || !recoverable || !session.state) {
        safeSend(port, { type: 'error', error: 'No recoverable task session found.' });
        safeSend(port, { type: 'recoverableSessionCleared' });
        return;
      }

      // Preflight: ensure selected provider is usable.
      try {
        await providerManager.getProvider();
      } catch (err) {
        const reason = err?.message || 'Provider is not available';
        safeSend(port, {
          type: 'error',
          error: `${reason} Open Settings and configure API key for the selected provider.`,
        });
        safeSend(port, { type: 'status', status: 'idle' });
        return;
      }

      // Security preflight: enforce network-level blocklist rules before recovered run.
      try {
        const sync = await ensureNetworkBlockFilteringReady();
        safeSend(port, {
          type: 'networkBlockSync',
          synced: true,
          domains: Number(sync?.domains || 0),
          rules: Number(sync?.rules || 0),
          mode: String(sync?.mode || ''),
        });
      } catch (err) {
        const reason = err?.message || 'Network blocklist sync failed';
        safeSend(port, {
          type: 'error',
          error: `${reason}. Aborting recovered task start to preserve safety policy.`,
        });
        safeSend(port, { type: 'status', status: 'idle' });
        return;
      }

      // Enable tracker/ad blocker for cleaner pages during recovered run.
      await enableTrackerBlocker();

      let targetTab = null;
      const checkpointTabId = Number(session?.state?.tabId);
      if (Number.isInteger(checkpointTabId)) {
        try {
          targetTab = await chrome.tabs.get(checkpointTabId);
        } catch {
          targetTab = null;
        }
      }
      if (!targetTab) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        targetTab = activeTab || null;
      }
      if (!targetTab?.id) {
        safeSend(port, { type: 'error', error: 'No active tab found for session recovery.' });
        return;
      }

      activeAgent = new Agent(providerManager, targetTab.id);
      clearReplayBuffer();
      const resumedGoal = String(session.goal || session.state.goal || '');
      const sessionMeta = {
        sessionId: String(session.sessionId || `task_${Date.now()}`),
        source: String(session.source || 'task'),
        goal: resumedGoal,
        taskName: String(session.taskName || ''),
        planMode: false,
        createdAt: Number(session.createdAt || Date.now()),
        resumeCount: Number(session.resumeCount || 0) + 1,
      };

      activeAgent.onStep = (step) => {
        sendToSidePanel({ type: 'step', step });
        persistActiveSession(activeAgent, sessionMeta).catch((err) => debugWarn('session.persist.recover.step', err));
      };
      activeAgent.onPlan = (plan) => {
        sendToSidePanel({ type: 'plan', plan });
      };
      activeAgent.onStatus = (status) => {
        if (status === 'running' || status === 'paused_waiting_user') {
          startKeepAlive();
        } else {
          stopKeepAlive();
        }
        sendToSidePanel({ type: 'status', status });
        persistActiveSession(activeAgent, sessionMeta, { status }).catch((err) => debugWarn('session.persist.recover.status', err));
      };
      activeAgent.onIntervention = (details) => {
        sendToSidePanel({ type: 'manualIntervention', details });
        persistActiveSession(activeAgent, sessionMeta).catch((err) => debugWarn('session.persist.recover.intervention', err));
      };
      activeAgent.onNotifyConnector = async ({ connectorId, message, meta }) => {
        const res = await notifyConnector(connectorId, message, meta || {});
        return { success: true, connectorId: res.connectorId, delivery: res.delivery };
      };

      sendToSidePanel({ type: 'status', status: 'running' }, { bufferIfDisconnected: false });
      await persistActiveSession(activeAgent, sessionMeta, { status: 'running' });

      try {
        const result = await activeAgent.run(resumedGoal, {
          planMode: false,
          resumeState: session.state,
        });
        sendToSidePanel({ type: 'result', result });
        const routed = await routeTaskResult(result, {
          source: sessionMeta.source,
          goal: resumedGoal,
          taskName: sessionMeta.taskName,
        });
        try {
          if (isRouteEnabled(routed?.state, 'desktop')) {
            chrome.notifications.create(`task-recover-${Date.now()}`, {
              type: 'basic',
              iconUrl: NOTIFICATION_ICON_URL,
              title: result.success ? 'Recovered task completed ✔' : 'Recovered task failed',
              message: (result.summary || result.reason || (result.success ? 'Done.' : 'Could not complete.')).slice(0, 200),
            });
          }
        } catch (err) {
          debugWarn('notification.recoveredTaskResult', err);
        }
      } finally {
        await disableTrackerBlocker();
        await clearActiveSession();
        activeAgent = null;
        safeSend(port, { type: 'recoverableSessionCleared' });
      }
      break;
    }

    case 'discardRecoveredTask': {
      await clearActiveSession();
      safeSend(port, { type: 'recoverableSessionCleared' });
      break;
    }

    case 'approvePlan': {
      if (activeAgent) activeAgent.approvePlan();
      break;
    }

    case 'jsDomainAllow': {
      if (activeAgent) activeAgent.allowJsDomain(msg.domain);
      break;
    }

    case 'jsDomainDeny': {
      if (activeAgent) activeAgent.denyJsDomain();
      break;
    }

    case 'getBlocklist': {
      const { customBlockedDomains = [] } = await chrome.storage.local.get('customBlockedDomains');
      const normalized = normalizeCustomBlockedDomains(customBlockedDomains);
      if (JSON.stringify(normalized) !== JSON.stringify(customBlockedDomains)) {
        await chrome.storage.local.set({ customBlockedDomains: normalized });
      }
      safeSend(port, { type: 'blocklist', domains: normalized });
      break;
    }

    case 'updateBlocklist': {
      const normalized = normalizeCustomBlockedDomains(msg.domains);
      await chrome.storage.local.set({ customBlockedDomains: normalized });
      try {
        await enqueueNetworkBlockSync(normalized);
      } catch (err) {
        debugWarn('blocklist.syncNetworkBlockRules', err);
      }
      safeSend(port, { type: 'blocklistUpdated', domains: normalized });
      break;
    }

    case 'getTrackerBlockerState': {
      const on = await isTrackerBlockerPreferenceOn();
      safeSend(port, { type: 'trackerBlockerState', enabled: on });
      break;
    }

    case 'setTrackerBlockerState': {
      const enabled = !!msg.enabled;
      await chrome.storage.local.set({ trackerBlockerEnabled: enabled });
      safeSend(port, { type: 'trackerBlockerState', enabled });
      break;
    }

    case 'getScheduledTasks': {
      const { scheduledTasks = [] } = await chrome.storage.local.get('scheduledTasks');
      safeSend(port, { type: 'scheduledTasks', tasks: scheduledTasks });
      break;
    }

    case 'addScheduledTask': {
      const { scheduledTasks: existing = [] } = await chrome.storage.local.get('scheduledTasks');
      const state = await getConnectionsState();
      const connectedIds = new Set(
        (Array.isArray(state?.integrations) ? state.integrations : [])
          .filter((item) => item?.connected && item?.id)
          .map((item) => String(item.id).trim()),
      );
      const connectorIds = normalizeConnectorIds(msg.connectorIds).filter((id) => connectedIds.has(id));
      const task = {
        id: `sched_${Date.now()}`,
        name: msg.name || 'Scheduled Task',
        goal: msg.goal,
        periodMinutes: Math.max(1, Number(msg.periodMinutes) || 60),
        enabled: true,
        connectorIds,
      };
      existing.push(task);
      await chrome.storage.local.set({ scheduledTasks: existing });
      chrome.alarms.create(task.id, { periodInMinutes: task.periodMinutes });
      safeSend(port, { type: 'scheduledTasks', tasks: existing });
      break;
    }

    case 'toggleScheduledTask': {
      const { scheduledTasks: tasks = [] } = await chrome.storage.local.get('scheduledTasks');
      const updated = tasks.map((t) => (
        t.id === msg.id ? { ...t, enabled: !!msg.enabled } : t
      ));
      await chrome.storage.local.set({ scheduledTasks: updated });
      try {
        if (msg.enabled) {
          const task = updated.find((t) => t.id === msg.id);
          if (task) chrome.alarms.create(task.id, { periodInMinutes: task.periodMinutes });
        } else {
          chrome.alarms.clear(msg.id);
        }
      } catch (err) {
        debugWarn('schedule.toggle.alarm', err);
      }
      safeSend(port, { type: 'scheduledTasks', tasks: updated });
      break;
    }

    case 'removeScheduledTask': {
      const { scheduledTasks: tasks = [] } = await chrome.storage.local.get('scheduledTasks');
      const updated = tasks.filter(t => t.id !== msg.id);
      await chrome.storage.local.set({ scheduledTasks: updated });
      try {
        chrome.alarms.clear(msg.id);
      } catch (err) {
        debugWarn('schedule.remove.clearAlarm', err);
      }
      safeSend(port, { type: 'scheduledTasks', tasks: updated });
      break;
    }

    case 'testConnection': {
      const conn = msg.connection;
      if (!conn || !conn.id) {
        safeSend(port, { type: 'connectionTestResult', ok: false, error: 'Invalid connection payload' });
        break;
      }
      try {
        await dispatchConnection(conn, buildResultPayload({ success: true, steps: 0, summary: 'Test' }, { source: 'test' }), true);
        safeSend(port, { type: 'connectionTestResult', connectionId: conn.id, ok: true });
      } catch (err) {
        safeSend(port, {
          type: 'connectionTestResult',
          connectionId: conn.id,
          ok: false,
          error: err?.message || String(err),
        });
      }
      break;
    }

    case 'connectionAction': {
      const conn = msg.connection;
      const action = String(msg.action || '').toLowerCase();
      if (!conn || !conn.id) {
        safeSend(port, { type: 'connectionActionResult', ok: false, error: 'Invalid connection payload' });
        break;
      }
      try {
        if (conn.id === 'telegram' && action === 'alert_on_change') {
          const state = await getConnectionsState();
          if (!state) throw new Error('Connections state not found');
          state.routing = state.routing || {};
          state.routing.telegram = !state.routing.telegram;
          await chrome.storage.local.set({ [CONNECTIONS_STORAGE_KEY]: state });
          safeSend(port, {
            type: 'connectionActionResult',
            connectionId: conn.id,
            ok: true,
            routing: { telegram: state.routing.telegram },
          });
          break;
        }

        const payload = buildResultPayload(
          {
            success: true,
            steps: 1,
            summary: action === 'send_report'
              ? 'Manual report from Connections'
              : 'Manual message from Connections',
            answer: action === 'send_report'
              ? 'This is a sample report generated from the Connections panel.'
              : 'This is a test message sent from the Connections panel.',
          },
          { source: 'manual_action', taskName: conn.label || conn.id },
        );
        await dispatchConnection(conn, payload, false);
        safeSend(port, { type: 'connectionActionResult', connectionId: conn.id, ok: true });
      } catch (err) {
        safeSend(port, {
          type: 'connectionActionResult',
          connectionId: conn.id,
          ok: false,
          error: err?.message || String(err),
        });
      }
      break;
    }

    case 'getConfig': {
      const status = await providerManager.getStatus();
      const info = ProviderManager.getProviderInfo();
      safeSend(port, {
        type: 'config',
        config: providerManager.config,
        status,
        providerInfo: info,
      });
      break;
    }

    case 'getActiveTabContext': {
      try {
        const context = await getActiveTabContext();
        safeSend(port, { type: 'activeTabContext', context });
      } catch (err) {
        safeSend(port, {
          type: 'activeTabContext',
          context: null,
          error: err?.message || String(err),
        });
      }
      break;
    }

    case 'updateConfig': {
      await providerManager.updateConfig(msg.config);
      safeSend(port, { type: 'configUpdated', config: providerManager.config });
      break;
    }

    case 'testProvider': {
      if (msg.providerConfig && typeof msg.providerConfig === 'object') {
        await providerManager.updateConfig({
          providers: { [msg.providerName]: msg.providerConfig },
        });
      }
      const provider = providerManager.providers[msg.providerName];
      if (!provider) {
        safeSend(port, { type: 'testResult', provider: msg.providerName, available: false, error: 'Unknown provider' });
        return;
      }
      try {
        const available = await provider.isAvailable();
        safeSend(port, {
          type: 'testResult',
          provider: msg.providerName,
          available,
          error: available ? '' : (provider.lastError || 'Unavailable'),
        });
      } catch (err) {
        safeSend(port, { type: 'testResult', provider: msg.providerName, available: false, error: err.message });
      }
      break;
    }

    case 'getHistory': {
      safeSend(port, {
        type: 'history',
        history: activeAgent?.history || [],
      });
      break;
    }

    default:
      safeSend(port, { type: 'error', error: `Unknown message type: ${msg.type}` });
  }
}

// ===== EXTENSION ICON → OPEN SIDE PANEL =====

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// ===== KEEP ALIVE (setInterval + chrome.alarms backup) =====

const KEEP_ALIVE_ALARM = 'agent-keep-alive';
let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  // Primary: setInterval every 25s
  keepAliveInterval = setInterval(() => {
    if (activeAgent?.status === 'running' || activeAgent?.status === 'paused_waiting_user') {
      chrome.runtime.getPlatformInfo(() => { });
    } else {
      stopKeepAlive();
    }
  }, 25000);
  // Backup: chrome.alarms (survives if setInterval is lost)
  try {
    chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch (err) {
    debugWarn('keepAlive.createAlarm', err);
  }
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  try {
    chrome.alarms.clear(KEEP_ALIVE_ALARM);
  } catch (err) {
    debugWarn('keepAlive.clearAlarm', err);
  }
}

// Alarm handler: backup keep-alive + scheduled tasks
try {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) {
      if (activeAgent?.status === 'running' || activeAgent?.status === 'paused_waiting_user') {
        chrome.runtime.getPlatformInfo(() => { });
      } else {
        stopKeepAlive();
      }
      return;
    }

    // Check if this is a scheduled task alarm
    const { scheduledTasks = [] } = await chrome.storage.local.get('scheduledTasks');
    const task = scheduledTasks.find(t => t.id === alarm.name);
    if (!task) return;
    if (task.enabled === false) return;

    // Skip if another task is already running
    if (activeAgent?.status === 'running' || activeAgent?.status === 'paused_waiting_user') {
      console.log(`[BG] Skipping scheduled task "${task.name}" — agent already running`);
      return;
    }

    console.log(`[BG] Running scheduled task: "${task.name}" → "${task.goal}"`);
    try {
      await ensureInitialized();
      try {
        await ensureNetworkBlockFilteringReady();
      } catch (syncErr) {
        debugWarn('scheduled.syncNetworkBlockRules', syncErr);
        return;
      }
      await enableTrackerBlocker();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        console.warn('[BG] Scheduled task: no active tab');
        return;
      }
      const provider = await providerManager.getProvider().catch(() => null);
      if (!provider) {
        console.warn('[BG] Scheduled task: provider not available');
        return;
      }
      clearReplayBuffer();
      activeAgent = new Agent(providerManager, tab.id);
      const sessionMeta = {
        sessionId: `sched_${task.id}_${Date.now()}`,
        source: 'scheduled',
        goal: String(task.goal || ''),
        taskName: String(task.name || ''),
        planMode: false,
        createdAt: Date.now(),
        resumeCount: 0,
      };
      activeAgent.onStep = (step) => {
        sendToSidePanel({ type: 'step', step });
        persistActiveSession(activeAgent, sessionMeta).catch((err) => debugWarn('session.persist.scheduled.step', err));
      };
      activeAgent.onStatus = (status) => {
        if (status === 'running' || status === 'paused_waiting_user') startKeepAlive();
        else stopKeepAlive();
        sendToSidePanel({ type: 'status', status });
        persistActiveSession(activeAgent, sessionMeta, { status }).catch((err) => debugWarn('session.persist.scheduled.status', err));
      };
      activeAgent.onIntervention = (details) => {
        sendToSidePanel({ type: 'manualIntervention', details });
        persistActiveSession(activeAgent, sessionMeta).catch((err) => debugWarn('session.persist.scheduled.intervention', err));
      };
      activeAgent.onNotifyConnector = async ({ connectorId, message, meta }) => {
        const res = await notifyConnector(connectorId, message, meta || {});
        return { success: true, connectorId: res.connectorId, delivery: res.delivery };
      };
      await persistActiveSession(activeAgent, sessionMeta, { status: 'running' });
      try {
        const result = await activeAgent.run(task.goal);
        sendToSidePanel({ type: 'result', result });
        const routed = await routeTaskResult(result, {
          source: 'scheduled',
          goal: task.goal,
          taskName: task.name,
          connectorIds: task.connectorIds || [],
        });
        try {
          if (isRouteEnabled(routed?.state, 'desktop')) {
            chrome.notifications.create(`sched-${Date.now()}`, {
              type: 'basic',
              iconUrl: NOTIFICATION_ICON_URL,
              title: `Scheduled: "${task.name}" ${result.success ? '✔' : '✖'}`,
              message: (result.summary || result.reason || (result.success ? 'Done.' : 'Failed.')).slice(0, 200),
            });
          }
        } catch (err) {
          debugWarn('notification.scheduledTaskResult', err);
        }
      } finally {
        await disableTrackerBlocker();
        await clearActiveSession();
        activeAgent = null;
      }
    } catch (err) {
      console.error('[BG] Scheduled task error:', err);
      await disableTrackerBlocker();
      await clearActiveSession();
      activeAgent = null;
    }
  });
} catch (err) {
  debugWarn('alarms.onAlarm.register', err);
}

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes?.customBlockedDomains) return;
    const next = changes.customBlockedDomains.newValue;
    enqueueNetworkBlockSync(next).catch((err) => debugWarn('storage.onChanged.syncNetworkBlockRules', err));
  });
} catch (err) {
  debugWarn('storage.onChanged.register', err);
}

try {
  chrome.runtime.onInstalled.addListener(() => {
    enqueueNetworkBlockSync().catch((err) => debugWarn('runtime.onInstalled.syncNetworkBlockRules', err));
  });
} catch (err) {
  debugWarn('runtime.onInstalled.register', err);
}

try {
  chrome.runtime.onStartup.addListener(() => {
    enqueueNetworkBlockSync().catch((err) => debugWarn('runtime.onStartup.syncNetworkBlockRules', err));
  });
} catch (err) {
  debugWarn('runtime.onStartup.register', err);
}

console.log('[BG] Service worker ready');
