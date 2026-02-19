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

// ===== INIT =====

async function init() {
  providerManager = new ProviderManager();
  await providerManager.init();
  console.log('[BG] Provider manager initialized');
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

// ===== SIDE PANEL CONNECTION =====

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;
    console.log('[BG] Side panel connected');

    port.onMessage.addListener(async (msg) => {
      try {
        await handleSidePanelMessage(msg, port);
      } catch (err) {
        safeSend(port, { type: 'error', error: err.message });
      }
    });

    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
      if (activeAgent) {
        activeAgent.abort();
        activeAgent = null;
      }
      console.log('[BG] Side panel disconnected');
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

      // Wire up callbacks
      activeAgent.onStep = (step) => {
        safeSend(port, { type: 'step', step });
      };
      activeAgent.onStatus = (status) => {
        // Manage keep-alive based on agent status
        if (status === 'running' || status === 'paused_waiting_user') {
          startKeepAlive();
        } else {
          stopKeepAlive();
        }
        safeSend(port, { type: 'status', status });
      };
      activeAgent.onIntervention = (details) => {
        safeSend(port, { type: 'manualIntervention', details });
      };

      safeSend(port, { type: 'status', status: 'running' });

      // Run agent (async, non-blocking)
      const result = await activeAgent.run(goal);
      safeSend(port, { type: 'result', result });
      activeAgent = null;
      break;
    }

    case 'stopTask': {
      if (activeAgent) {
        activeAgent.abort();
        activeAgent = null;
        stopKeepAlive();
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
  } catch { /* alarms API may not be available in tests */ }
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
  try {
    chrome.alarms.clear(KEEP_ALIVE_ALARM);
  } catch { /* noop */ }
}

// Alarm handler: backup keep-alive
try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEP_ALIVE_ALARM) {
      if (activeAgent?.status === 'running' || activeAgent?.status === 'paused_waiting_user') {
        chrome.runtime.getPlatformInfo(() => { });
      } else {
        stopKeepAlive();
      }
    }
  });
} catch { /* noop */ }

console.log('[BG] Service worker ready');
