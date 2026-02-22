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

let providerManager = null;
let activeAgent = null;
let sidePanelPort = null;
let initPromise = null;

// Buffered outbound events while sidepanel is disconnected.
const replayBuffer = [];
const MAX_REPLAY_MESSAGES = 300;
const NOTIFICATION_ICON_URL = chrome.runtime.getURL('icons/icon48.png');

const WARN_THROTTLE_MS = 10000;
const MAX_TELEMETRY_ITEMS = 30;
const warnTimestamps = new Map();

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

  // Re-register scheduled task alarms (cleared when SW terminated)
  try {
    const { scheduledTasks = [] } = await chrome.storage.local.get('scheduledTasks');
    for (const task of scheduledTasks) {
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

      // Create agent
      activeAgent = new Agent(providerManager, tab.id);
      clearReplayBuffer();

      // Wire up callbacks
      activeAgent.onStep = (step) => {
        sendToSidePanel({ type: 'step', step });
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
      };
      activeAgent.onIntervention = (details) => {
        sendToSidePanel({ type: 'manualIntervention', details });
      };

      sendToSidePanel({ type: 'status', status: 'running' }, { bufferIfDisconnected: false });

      // Run agent (async, non-blocking)
      const result = await activeAgent.run(goal, {
        planMode: msg.planMode || false,
        policy: providerManager?.config?.agentPolicy || {},
      });
      sendToSidePanel({ type: 'result', result });

      // Desktop notification
      try {
        chrome.notifications.create(`task-${Date.now()}`, {
          type: 'basic',
          iconUrl: NOTIFICATION_ICON_URL,
          title: result.success ? 'Task completed ✔' : 'Task failed',
          message: (result.summary || result.reason || (result.success ? 'Done.' : 'Could not complete.')).slice(0, 200),
        });
      } catch (err) {
        debugWarn('notification.taskResult', err);
      }

      activeAgent = null;
      break;
    }

    case 'stopTask': {
      if (activeAgent) {
        activeAgent.abort();
        activeAgent = null;
        stopKeepAlive();
        clearReplayBuffer();
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
      const resumed = activeAgent.resume();
      if (!resumed) {
        safeSend(port, { type: 'error', error: 'Could not resume task. Try again.' });
      }
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
      safeSend(port, { type: 'blocklist', domains: customBlockedDomains });
      break;
    }

    case 'updateBlocklist': {
      await chrome.storage.local.set({ customBlockedDomains: msg.domains || [] });
      safeSend(port, { type: 'blocklistUpdated', domains: msg.domains || [] });
      break;
    }

    case 'getScheduledTasks': {
      const { scheduledTasks = [] } = await chrome.storage.local.get('scheduledTasks');
      safeSend(port, { type: 'scheduledTasks', tasks: scheduledTasks });
      break;
    }

    case 'addScheduledTask': {
      const { scheduledTasks: existing = [] } = await chrome.storage.local.get('scheduledTasks');
      const task = {
        id: `sched_${Date.now()}`,
        name: msg.name || 'Scheduled Task',
        goal: msg.goal,
        periodMinutes: Math.max(1, Number(msg.periodMinutes) || 60),
      };
      existing.push(task);
      await chrome.storage.local.set({ scheduledTasks: existing });
      chrome.alarms.create(task.id, { periodInMinutes: task.periodMinutes });
      safeSend(port, { type: 'scheduledTasks', tasks: existing });
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

    // Skip if another task is already running
    if (activeAgent?.status === 'running' || activeAgent?.status === 'paused_waiting_user') {
      console.log(`[BG] Skipping scheduled task "${task.name}" — agent already running`);
      return;
    }

    console.log(`[BG] Running scheduled task: "${task.name}" → "${task.goal}"`);
    try {
      await ensureInitialized();
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
      activeAgent.onStep = (step) => {
        sendToSidePanel({ type: 'step', step });
      };
      activeAgent.onStatus = (status) => {
        if (status === 'running' || status === 'paused_waiting_user') startKeepAlive();
        else stopKeepAlive();
        sendToSidePanel({ type: 'status', status });
      };
      activeAgent.onIntervention = (details) => {
        sendToSidePanel({ type: 'manualIntervention', details });
      };
      const result = await activeAgent.run(task.goal);
      sendToSidePanel({ type: 'result', result });
      try {
        chrome.notifications.create(`sched-${Date.now()}`, {
          type: 'basic',
          iconUrl: NOTIFICATION_ICON_URL,
          title: `Scheduled: "${task.name}" ${result.success ? '✔' : '✖'}`,
          message: (result.summary || result.reason || (result.success ? 'Done.' : 'Failed.')).slice(0, 200),
        });
      } catch (err) {
        debugWarn('notification.scheduledTaskResult', err);
      }
      activeAgent = null;
    } catch (err) {
      console.error('[BG] Scheduled task error:', err);
      activeAgent = null;
    }
  });
} catch (err) {
  debugWarn('alarms.onAlarm.register', err);
}

console.log('[BG] Service worker ready');
