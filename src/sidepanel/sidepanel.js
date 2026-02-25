/**
 * Side Panel UI Logic
 *
 * Connects to background service worker via chrome.runtime.connect.
 * Handles: task input, step rendering, settings management, task history.
 */

// ===== DOM Elements =====

/** Generate icon HTML span */
function icon(name, extra) {
  return `<span class="i i-${name}${extra ? ' ' + extra : ''}"></span>`;
}
const stepsContainer = document.getElementById('stepsContainer');
const emptyState = document.getElementById('emptyState');
const goalInput = document.getElementById('goalInput');
const sendBtn = document.getElementById('sendBtn');
const resultBanner = document.getElementById('resultBanner');
const statusDot = document.getElementById('statusDot');
const btnClose = document.getElementById('btnClose');
const btnSaveShortcut = document.getElementById('btnSaveShortcut');
const btnPlanMode = document.getElementById('btnPlanMode');
const btnSettings = document.getElementById('btnSettings');
const btnSchedule = document.getElementById('btnSchedule');
const btnHistory = document.getElementById('btnHistory');
const btnHelp = document.getElementById('btnHelp');
const btnCapabilities = document.getElementById('btnCapabilities');
const btnConnections = document.getElementById('btnConnections');
const chatView = document.getElementById('chatView');
const settingsView = document.getElementById('settingsView');
const historyView = document.getElementById('historyView');
const connectionsView = document.getElementById('connectionsView');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const tierGroups = document.getElementById('tierGroups');
const modeBadge = document.getElementById('modeBadge');
const suggestionsContainer = document.getElementById('suggestionsContainer');
const connActiveCount = document.getElementById('connActiveCount');
const connActiveList = document.getElementById('connActiveList');
const connAvailableList = document.getElementById('connAvailableList');
const connCustomList = document.getElementById('connCustomList');
const connRoutingList = document.getElementById('connRoutingList');
const btnAddCustomConnection = document.getElementById('btnAddCustomConnection');
const connectorQuickActions = document.getElementById('connectorQuickActions');
const shortcutsDropdown = document.getElementById('shortcutsDropdown');
const appVersion = document.getElementById('appVersion');

// ===== State =====
let port = null;
let isRunning = false;
let isPaused = false;
let config = null;
let providerInfo = null;
let providerStatus = null;
let currentGoal = '';
let planMode = false;
let siteBlocklist = [];
let scheduledTasks = [];
let trackerBlockerEnabled = true;
let reconnectTimer = null;
let connectionsState = null;
let recoverableSession = null;
let activeTabContext = null;
let shortcutsPanelOpen = false;
let shortcutsPanelMode = 'manual';
let shortcutsPanelQuery = '';
let savedShortcuts = [];
let shortcutDraftMatches = [];
let scheduleDraftConnectorIds = [];
let activeInterventionDetails = null;
const expandedConnectionIds = new Set();

const MAX_HISTORY_ITEMS = 30;
const CONNECTIONS_STORAGE_KEY = 'connectionsState';
const SHORTCUTS_STORAGE_KEY = 'savedShortcuts';
const MAX_SHORTCUTS = 40;

function scheduleReconnect(delayMs = 300) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}

function sendMsg(msg) {
  if (!port) {
    scheduleReconnect();
    return;
  }
  try {
    port.postMessage(msg);
  } catch (e) {
    const text = String(e?.message || e || '').toLowerCase();
    if (text.includes('disconnected port object')) {
      port = null;
      scheduleReconnect();
      return;
    }
    console.warn('[SP] postMessage failed:', e?.message || e);
  }
}

function requestActiveTabContext() {
  sendMsg({ type: 'getActiveTabContext' });
}

function renderAppVersion() {
  if (!appVersion) return;
  try {
    const version = String(chrome?.runtime?.getManifest?.()?.version || '').trim();
    if (!version) return;
    appVersion.textContent = `v${version}`;
  } catch {
    // Keep fallback text from HTML.
  }
}

btnClose?.addEventListener('click', () => {
  window.close();
});

function normalizeShortcutName(raw) {
  let text = String(raw || '').trim().toLowerCase();
  text = text.replace(/^\/+/, '');
  text = text.replace(/\s+/g, '-');
  text = text.replace(/[^\p{L}\p{N}_-]+/gu, '-');
  text = text.replace(/-+/g, '-');
  text = text.replace(/^-+|-+$/g, '');
  return text.slice(0, 32);
}

function normalizeShortcutPrompt(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function normalizeShortcutRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeShortcutName(raw.name || raw.id || '');
  const prompt = normalizeShortcutPrompt(raw.prompt || raw.text || '');
  if (!name || !prompt) return null;
  const updatedAt = Number(raw.updatedAt);
  return {
    name,
    prompt,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

function sortShortcuts(items = []) {
  return items
    .slice()
    .sort((a, b) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
}

function parseSlashShortcut(text = '') {
  const source = String(text || '').trimStart();
  if (!source.startsWith('/')) return null;
  const match = source.match(/^\/([^\s]*)\s*([\s\S]*)$/);
  if (!match) return null;
  const name = normalizeShortcutName(match[1] || '');
  const tail = String(match[2] || '');
  return {
    name,
    hasTail: tail.trim().length > 0,
    raw: source,
  };
}

function findShortcutByName(name) {
  const key = normalizeShortcutName(name);
  if (!key) return null;
  return savedShortcuts.find((item) => item.name === key) || null;
}

function suggestShortcutName(promptText = '') {
  const source = String(promptText || '').trim();
  const slash = source.match(/^\/([^\s]+)/);
  if (slash?.[1]) {
    const parsed = normalizeShortcutName(slash[1]);
    if (parsed) return parsed;
  }
  const compact = source
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
    .trim();
  if (!compact) return `shortcut-${savedShortcuts.length + 1}`;
  const words = compact.split(/\s+/).filter(Boolean).slice(0, 3);
  const candidate = normalizeShortcutName(words.join('-'));
  return candidate || `shortcut-${savedShortcuts.length + 1}`;
}

async function persistShortcuts() {
  try {
    await chrome.storage.local.set({
      [SHORTCUTS_STORAGE_KEY]: savedShortcuts.slice(0, MAX_SHORTCUTS),
    });
  } catch (err) {
    console.warn('[SP] persistShortcuts failed:', err?.message || err);
  }
}

async function loadShortcuts() {
  try {
    const stored = await chrome.storage.local.get(SHORTCUTS_STORAGE_KEY);
    const rawItems = Array.isArray(stored?.[SHORTCUTS_STORAGE_KEY]) ? stored[SHORTCUTS_STORAGE_KEY] : [];
    const normalized = rawItems
      .map((item) => normalizeShortcutRecord(item))
      .filter(Boolean);
    savedShortcuts = sortShortcuts(normalized).slice(0, MAX_SHORTCUTS);
  } catch (err) {
    savedShortcuts = [];
    console.warn('[SP] loadShortcuts failed:', err?.message || err);
  }
  if (shortcutsPanelOpen) renderShortcutsPanel();
}

function updateGoalInput(value) {
  goalInput.value = String(value || '');
  adjustGoalInputHeight();
  refreshShortcutDraftPanel();
  goalInput.focus();
  goalInput.setSelectionRange(goalInput.value.length, goalInput.value.length);
}

function showShortcutMessage(text) {
  resultBanner.style.display = '';
  resultBanner.className = 'result-banner warning';
  resultBanner.dataset.mode = '';
  resultBanner.textContent = String(text || '');
}

function applyShortcutToInput(name) {
  const shortcut = findShortcutByName(name);
  if (!shortcut) return false;
  updateGoalInput(shortcut.prompt);
  if (shortcutsPanelMode === 'slash') {
    setShortcutsPanelOpen(false);
  }
  return true;
}

async function removeShortcut(name) {
  const key = normalizeShortcutName(name);
  if (!key) return;
  savedShortcuts = savedShortcuts.filter((item) => item.name !== key);
  await persistShortcuts();
  renderShortcutsPanel();
}

async function saveCurrentShortcut() {
  const raw = String(goalInput.value || '').trim();
  if (!raw) {
    shortcutsPanelMode = 'manual';
    shortcutsPanelQuery = '';
    setShortcutsPanelOpen(true);
    return;
  }

  let prompt = raw;
  const slashInline = raw.match(/^\/([^\s]+)\s+([\s\S]+)$/);
  let suggestedName = suggestShortcutName(raw);
  if (slashInline?.[1] && slashInline?.[2]) {
    suggestedName = normalizeShortcutName(slashInline[1]);
    prompt = String(slashInline[2] || '').trim();
  }
  prompt = normalizeShortcutPrompt(prompt);
  if (!prompt) {
    showShortcutMessage('Shortcut prompt cannot be empty.');
    return;
  }

  const entered = window.prompt('Shortcut name (without /)', suggestedName);
  if (entered === null) return;
  const name = normalizeShortcutName(entered);
  if (!name) {
    showShortcutMessage('Invalid shortcut name.');
    return;
  }

  savedShortcuts = savedShortcuts.filter((item) => item.name !== name);
  savedShortcuts.unshift({ name, prompt, updatedAt: Date.now() });
  savedShortcuts = sortShortcuts(savedShortcuts).slice(0, MAX_SHORTCUTS);
  await persistShortcuts();
  shortcutsPanelMode = 'manual';
  shortcutsPanelQuery = '';
  setShortcutsPanelOpen(true);
  showShortcutMessage(`Saved shortcut /${name}`);
}

function renderShortcutsPanel() {
  if (!shortcutsDropdown) return;
  const mode = shortcutsPanelMode === 'slash' ? 'slash' : 'manual';
  const query = normalizeShortcutName(shortcutsPanelQuery || '');
  const source = sortShortcuts(savedShortcuts);
  const visible = mode === 'slash' && query
    ? source.filter((item) => item.name.startsWith(query))
    : source;
  shortcutDraftMatches = visible.slice(0, MAX_SHORTCUTS);

  if (visible.length === 0) {
    const message = mode === 'slash'
      ? `No shortcut for "/${query}". Save one with bookmark button.`
      : 'No saved shortcuts yet.';
    shortcutsDropdown.innerHTML = `
      <div class="shortcut-item">
        <span class="shortcut-text">${escapeHtml(message)}</span>
      </div>
    `;
    return;
  }

  shortcutsDropdown.innerHTML = visible
    .map((item) => {
      const preview = item.prompt.length > 80 ? `${item.prompt.slice(0, 80)}...` : item.prompt;
      return `
        <div class="shortcut-item" data-shortcut-name="${escapeAttr(item.name)}">
          <span class="shortcut-text"><b>/${escapeHtml(item.name)}</b> — ${escapeHtml(preview)}</span>
          <button class="shortcut-del" data-shortcut-del="${escapeAttr(item.name)}" title="Delete shortcut">×</button>
        </div>
      `;
    })
    .join('');

  shortcutsDropdown.querySelectorAll('.shortcut-item[data-shortcut-name]').forEach((itemEl) => {
    itemEl.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-shortcut-del]')) return;
      const name = itemEl.getAttribute('data-shortcut-name') || '';
      applyShortcutToInput(name);
    });
  });

  shortcutsDropdown.querySelectorAll('[data-shortcut-del]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const name = btn.getAttribute('data-shortcut-del') || '';
      await removeShortcut(name);
    });
  });
}

function refreshShortcutDraftPanel() {
  const parsed = parseSlashShortcut(goalInput.value || '');
  if (parsed && !parsed.hasTail) {
    shortcutsPanelMode = 'slash';
    shortcutsPanelQuery = parsed.name || '';
    setShortcutsPanelOpen(true);
    return;
  }
  if (shortcutsPanelMode === 'slash') {
    setShortcutsPanelOpen(false);
  }
}

function resolveGoalFromShortcutInput(rawGoal) {
  const goal = String(rawGoal || '').trim();
  const parsed = parseSlashShortcut(goal);
  if (!parsed || parsed.hasTail) {
    return { status: 'none', goal };
  }
  if (!parsed.name) {
    return { status: 'blocked', reason: 'Type shortcut name after "/"' };
  }

  const exact = findShortcutByName(parsed.name);
  if (exact) {
    return { status: 'resolved', goal: exact.prompt, shortcut: exact };
  }

  if (shortcutDraftMatches.length === 1) {
    return {
      status: 'resolved',
      goal: shortcutDraftMatches[0].prompt,
      shortcut: shortcutDraftMatches[0],
    };
  }

  return { status: 'blocked', reason: `Shortcut "/${parsed.name}" not found.` };
}

function setShortcutsPanelOpen(nextOpen) {
  shortcutsPanelOpen = !!nextOpen;
  btnSaveShortcut?.classList.toggle('active', shortcutsPanelOpen);
  btnSaveShortcut?.setAttribute('aria-pressed', shortcutsPanelOpen ? 'true' : 'false');
  if (!shortcutsDropdown) return;
  if (shortcutsPanelOpen) {
    renderShortcutsPanel();
    shortcutsDropdown.style.display = 'block';
    return;
  }
  shortcutsDropdown.style.display = 'none';
}

function setPlanMode(nextValue) {
  planMode = !!nextValue;
  btnPlanMode?.classList.toggle('active', planMode);
  btnPlanMode?.setAttribute('aria-pressed', planMode ? 'true' : 'false');
}

function pickBestProviderInTier(tierProviders) {
  if (!Array.isArray(tierProviders) || tierProviders.length === 0) return null;

  // 1) Prefer currently available providers.
  for (const { name } of tierProviders) {
    if (providerStatus?.[name]?.available) return name;
  }
  // 2) Then providers that are at least configured.
  for (const { name } of tierProviders) {
    if (providerStatus?.[name]?.configured) return name;
  }
  // 3) Fallback to first in tier.
  return tierProviders[0].name;
}

// ===== Connect to Background =====

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });

  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'step':
        renderStep(msg.step);
        break;
      case 'status':
        updateStatus(msg.status);
        break;
      case 'result':
        showResult(msg.result);
        saveTaskToHistory(currentGoal, msg.result);
        break;
      case 'manualIntervention':
        showManualIntervention(msg.details);
        break;
      case 'error':
        renderError(msg.error);
        break;
      case 'config':
        config = msg.config;
        providerInfo = msg.providerInfo;
        providerStatus = msg.status;
        renderSettings();
        break;
      case 'configUpdated':
        if (msg.config) config = msg.config;
        if (msg.status) providerStatus = msg.status;
        renderSettings();
        break;
      case 'activeTabContext':
        activeTabContext = msg.context && typeof msg.context === 'object' ? msg.context : null;
        renderSuggestionCloud();
        break;
      case 'testResult':
        showTestResult(msg);
        break;
      case 'scheduledTasks':
        scheduledTasks = msg.tasks || [];
        renderScheduledTasks();
        break;
      case 'blocklist':
        siteBlocklist = msg.domains || [];
        renderBlocklist();
        break;
      case 'blocklistUpdated':
        siteBlocklist = msg.domains || [];
        renderBlocklist();
        break;
      case 'trackerBlockerState':
        trackerBlockerEnabled = !!msg.enabled;
        renderTrackerBlockerToggle();
        break;
      case 'connectionTestResult':
        applyConnectionTestResult(msg);
        break;
      case 'connectionActionResult':
        applyConnectionActionResult(msg);
        break;
      case 'recoverableSession':
        recoverableSession = msg.session || null;
        showRecoverableSession(recoverableSession);
        break;
      case 'recoverableSessionCleared':
        recoverableSession = null;
        hideRecoverableSessionBanner();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    console.log('[SP] Disconnected, reconnecting...');
    scheduleReconnect(1000);
  });

  // Load config
  port.postMessage({ type: 'getConfig' });
  port.postMessage({ type: 'getActiveTabContext' });
}

connect();
renderAppVersion();

// ===== Task Execution =====

function adjustGoalInputHeight() {
  goalInput.style.height = 'auto';
  const next = Math.min(goalInput.scrollHeight, 120);
  goalInput.style.height = `${Math.max(40, next)}px`;
  goalInput.style.overflowY = goalInput.scrollHeight > 120 ? 'auto' : 'hidden';
}

sendBtn.addEventListener('click', () => {
  if (isPaused) {
    if (String(activeInterventionDetails?.type || '') === 'jsDomainPermission') {
      const domain = String(activeInterventionDetails?.domain || '').trim();
      sendMsg({ type: 'jsDomainAllow', domain });
      return;
    }
    sendMsg({ type: 'resumeTask' });
    return;
  }

  if (isRunning) {
    sendMsg({ type: 'stopTask' });
    return;
  }

  const resolved = resolveGoalFromShortcutInput(goalInput.value);
  if (resolved.status === 'blocked') {
    showShortcutMessage(resolved.reason || 'Unknown shortcut.');
    return;
  }
  const goal = String(resolved.goal || '').trim();
  if (!goal) return;

  if (resolved.status === 'resolved') {
    updateGoalInput(goal);
  }

  currentGoal = goal;

  // Clear previous steps and restore from collapsed state
  stepsContainer.innerHTML = '';
  stepsContainer.classList.remove('finished');
  stepsContainer.classList.remove('has-open-log');
  stepsContainer.classList.remove('no-log');
  emptyState.style.display = 'none';
  const capHeader = document.getElementById('capabilitiesHeader');
  if (capHeader) capHeader.style.display = 'none';
  resultBanner.style.display = 'none';
  resultBanner.className = 'result-banner';
  resultBanner.textContent = '';
  resultBanner.dataset.mode = '';
  recoverableSession = null;

  // Add user goal
  const goalEl = document.createElement('div');
  goalEl.className = 'step thought';
  const goalHeader = document.createElement('div');
  goalHeader.className = 'step-header';
  goalHeader.innerHTML = `<span class="i i-target"></span> Goal`;
  goalEl.appendChild(goalHeader);
  goalEl.appendChild(document.createTextNode(goal));
  stepsContainer.appendChild(goalEl);

  sendMsg({ type: 'startTask', goal, planMode });
  goalInput.value = '';
  adjustGoalInputHeight();
  if (shortcutsPanelMode === 'slash') {
    setShortcutsPanelOpen(false);
  }
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// Auto-resize textarea
goalInput.addEventListener('input', () => {
  adjustGoalInputHeight();
  refreshShortcutDraftPanel();
});
adjustGoalInputHeight();
setPlanMode(false);
setShortcutsPanelOpen(false);
renderSuggestionCloud();
loadConnectionsState();
loadShortcuts();

// ===== Rendering =====

function renderStep(step) {
  emptyState.style.display = 'none';

  const el = document.createElement('div');

  if (step.type === 'thought') {
    el.className = 'step thought';
    const header = document.createElement('div');
    header.className = 'step-header';
    header.innerHTML = `${icon('thought')} Step ${step.step}`;
    el.appendChild(header);
    el.appendChild(document.createTextNode(step.content || ''));
  } else if (step.type === 'action') {
    el.className = 'step action';
    let detail = '';
    if (step.args) {
      const summary = summarizeArgs(step.tool, step.args);
      if (summary) detail = `<span style="color:var(--text2)"> — ${escapeHtml(summary)}</span>`;
    }
    let resultHtml = '';
    if (step.result) {
      let resultStr = '';
      if (typeof step.result === 'string') {
        resultStr = step.result;
      } else {
        try {
          resultStr = JSON.stringify(step.result, null, 2);
        } catch {
          resultStr = '[unserializable result]';
        }
      }
      if (resultStr.length > 10) {
        resultHtml = `<pre>${escapeHtml(resultStr.slice(0, 800))}${resultStr.length > 800 ? '\n...' : ''}</pre>`;
      }
    }
    el.innerHTML = `<div class="step-header">${icon('bolt')} Step ${step.step}</div><span class="tool-name">${escapeHtml(step.tool || '')}</span>${detail}${resultHtml}`;
  } else if (step.type === 'error') {
    el.className = 'step error';
    const header = document.createElement('div');
    header.className = 'step-header';
    header.innerHTML = `${icon('x-circle')} Error`;
    el.appendChild(header);
    el.appendChild(document.createTextNode(step.error || ''));
  } else if (step.type === 'pause') {
    el.className = 'step pause';
    const header = document.createElement('div');
    header.className = 'step-header';
    header.innerHTML = `${icon('bolt')} Paused`;
    el.appendChild(header);
    const text = step.reason || 'Manual intervention required.';
    el.appendChild(document.createTextNode(text));
    if (step.url) {
      const urlEl = document.createElement('div');
      urlEl.style.marginTop = '6px';
      urlEl.style.fontSize = '11px';
      urlEl.style.color = 'var(--text2)';
      urlEl.textContent = step.url;
      el.appendChild(urlEl);
    }
  }

  stepsContainer.appendChild(el);
  stepsContainer.scrollTop = stepsContainer.scrollHeight;
}

function renderError(msg) {
  const el = document.createElement('div');
  el.className = 'step error';
  const header = document.createElement('div');
  header.className = 'step-header';
  header.innerHTML = `${icon('x-circle')} Error`;
  el.appendChild(header);
  el.appendChild(document.createTextNode(msg || ''));
  stepsContainer.appendChild(el);
  stepsContainer.scrollTop = stepsContainer.scrollHeight;
}

function hostMatches(hostname, domains) {
  if (!hostname || !Array.isArray(domains)) return false;
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function getSiteLabel(hostname) {
  const clean = String(hostname || '').replace(/^www\./, '');
  if (!clean) return 'this site';
  return clean;
}

function buildContextualPrompts(context) {
  const fallback = [
    'Read this page and summarize it in 3 sentences',
    'Extract the key facts from this page into bullet points',
    'Find the most important action on this page and do it',
    'Check this page for errors or broken flows',
    'Compare this page with 2 alternatives and recommend one',
  ];
  const hostname = String(context?.hostname || '').toLowerCase();
  const pathname = String(context?.pathname || '').toLowerCase();
  const title = String(context?.title || '').trim();
  const searchQuery = String(context?.searchQuery || '').trim();
  const site = getSiteLabel(hostname);

  if (!hostname) return fallback;

  const shoppingDomains = ['amazon.com', 'ebay.com', 'walmart.com', 'aliexpress.com', 'etsy.com', 'bestbuy.com'];
  const searchDomains = ['google.com', 'bing.com', 'duckduckgo.com', 'yandex.com'];
  const videoDomains = ['youtube.com', 'youtu.be', 'vimeo.com', 'twitch.tv'];
  const codeDomains = ['github.com', 'gitlab.com', 'bitbucket.org'];
  const docsDomains = ['readthedocs.io', 'developer.mozilla.org', 'docs.python.org', 'learn.microsoft.com'];
  const socialDomains = ['x.com', 'twitter.com', 'reddit.com', 'linkedin.com'];
  const travelDomains = ['booking.com', 'airbnb.com', 'expedia.com', 'kayak.com', 'skyscanner.com', 'tripadvisor.com'];

  if (hostMatches(hostname, searchDomains) || pathname.includes('/search')) {
    const queryPart = searchQuery || title || 'this query';
    return [
      `Open top 5 results for "${queryPart}" and rank them by relevance`,
      `Summarize the SERP for "${queryPart}" with pros and cons of each result`,
      `Find official sources for "${queryPart}" and ignore low-quality pages`,
      `Collect key facts from the first page results and build a short brief`,
      `Compare 3 best results for "${queryPart}" and recommend one`,
    ];
  }

  if (hostMatches(hostname, shoppingDomains)) {
    return [
      `Extract product name, price, rating, and seller details from this ${site} page`,
      `Find cheaper alternatives to this product and compare total cost`,
      `Summarize top positive and negative reviews for this listing`,
      `Check delivery time, return policy, and hidden fees on this page`,
      `Compare this product with 2 similar options and recommend one`,
    ];
  }

  if (hostMatches(hostname, travelDomains)) {
    return [
      `Extract best options on ${site} by price, rating, and cancellation policy`,
      'Compare these travel options and select the best value choice',
      'Find the earliest and cheapest option that matches my dates',
      'Summarize extra fees, baggage/cancellation terms, and total final price',
      'Build a shortlist of top 3 options with clear tradeoffs',
    ];
  }

  if (hostMatches(hostname, videoDomains)) {
    return [
      `Summarize this video page on ${site} and list key takeaways`,
      'Extract topic, main claims, and action items from this content',
      'Scan comments and summarize common feedback themes',
      'Find related videos covering the same topic with better depth',
      'Create a short outline from this video content',
    ];
  }

  if (hostMatches(hostname, codeDomains)) {
    return [
      `Summarize this repository/page on ${site} and its core purpose`,
      'Review open issues/PRs and identify the highest-impact next task',
      'Extract setup steps and create a quick start checklist',
      'Find risks, TODOs, or blockers visible on this page',
      'Map main modules/files and explain architecture briefly',
    ];
  }

  if (hostMatches(hostname, docsDomains) || pathname.includes('/docs') || pathname.includes('/documentation')) {
    return [
      `Summarize this documentation page on ${site} in a practical checklist`,
      'Extract code examples and explain when to use each one',
      'Find prerequisites and common mistakes from this guide',
      'Create a step-by-step implementation plan from this doc',
      'Compare this doc approach with an alternative method',
    ];
  }

  if (hostMatches(hostname, socialDomains)) {
    return [
      `Summarize the main discussion on this ${site} page`,
      'Extract the strongest arguments and counterarguments',
      'Identify actionable insights from this thread/post',
      'Find original sources linked in this discussion',
      'Create a neutral summary with key viewpoints',
    ];
  }

  if (/\/(login|signin|signup|register|checkout|cart|billing|payment)/.test(pathname)) {
    return [
      `Inspect this ${site} flow and list required fields before submitting`,
      'Check this form for missing/invalid fields and highlight blockers',
      'Draft safe step-by-step actions to complete this flow',
      'Summarize what data is requested and why',
      'Find where this flow can fail and how to recover',
    ];
  }

  return [
    `Summarize this page on ${site} and list the key next actions`,
    `Extract structured data from this ${site} page into a table`,
    `Find the most relevant sections on ${site} for my goal`,
    `Check this ${site} page for usability or content issues`,
    `Prepare a quick brief based on this page from ${site}`,
  ];
}

function renderSuggestionCloud() {
  if (!suggestionsContainer) return;
  const prompts = buildContextualPrompts(activeTabContext);

  suggestionsContainer.innerHTML = prompts
    .map((p) => `<button class="prompt-chip" data-prompt="${escapeAttr(p)}">${escapeHtml(p)}</button>`)
    .join('');

  suggestionsContainer.querySelectorAll('.prompt-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      goalInput.value = btn.dataset.prompt || '';
      adjustGoalInputHeight();
      goalInput.focus();
      goalInput.setSelectionRange(goalInput.value.length, goalInput.value.length);
    });
  });
}

function showResult(result) {
  // 1. Wrap existing steps into a collapsible <details>
  const stepElements = Array.from(stepsContainer.children);
  let logDetails = null;
  stepsContainer.classList.add('finished');
  stepsContainer.classList.remove('has-open-log');
  stepsContainer.classList.remove('no-log');

  if (stepElements.length > 0) {
    const details = document.createElement('details');
    details.className = 'log-collapse';
    logDetails = details;

    const summary = document.createElement('summary');
    summary.textContent = `${result.steps || stepElements.length} steps — click to expand log`;
    details.appendChild(summary);

    const wrapper = document.createElement('div');
    wrapper.className = 'collapsed-steps';
    stepElements.forEach(el => wrapper.appendChild(el));
    details.appendChild(wrapper);

    stepsContainer.innerHTML = '';
    stepsContainer.appendChild(details);
    const syncLogState = () => {
      stepsContainer.classList.toggle('has-open-log', details.open);
    };
    details.addEventListener('toggle', syncLogState);
    syncLogState();
  } else {
    // Keep the top area fully collapsed when no per-step log is available.
    stepsContainer.innerHTML = '';
    stepsContainer.classList.add('no-log');
  }

  // 2. Show expanded result banner (duplicates done info outside the collapsible log)
  resultBanner.style.display = '';
  if (result.success) {
    resultBanner.className = 'result-banner success expanded';
    resultBanner.dataset.mode = '';
    const summaryText = String(result.summary || '').trim();
    const answerText = String(result.answer || summaryText || '').trim();
    let html = `<details class="result-collapse" open><summary><div class="result-header">${icon('check-circle')} Done (${result.steps} steps): ${escapeHtml(summaryText || 'Completed')}</div></summary>`;
    if (answerText && answerText !== result.summary) {
      html += `<div class="result-collapse-body"><div class="result-answer">${renderMarkdown(answerText)}</div></div>`;
    }
    html += '</details>';
    resultBanner.innerHTML = html;
  } else {
    resultBanner.className = 'result-banner failure expanded';
    resultBanner.dataset.mode = '';
    const status = String(result.status || '').toLowerCase();
    const headerLabel = status === 'timeout'
      ? 'Timeout'
      : (status === 'partial' || String(result.partial_result?.status || '') === 'partial')
        ? 'Partial'
        : 'Failed';
    const reasonText = String(result.reason || 'Unknown error').trim();
    const answerText = String(result.answer || result.summary || '').trim();
    let html = `<details class="result-collapse" open><summary><div class="result-header">${icon('x-circle')} ${headerLabel} (${result.steps} steps): ${escapeHtml(reasonText)}</div></summary>`;
    if (answerText) {
      html += `<div class="result-collapse-body"><div class="result-answer">${renderMarkdown(answerText)}</div>`;
      const suggestion = String(result.partial_result?.suggestion || '').trim();
      if (suggestion) {
        html += `<div style="margin-top:8px;color:var(--text2);font-size:11px;">Next step: ${escapeHtml(suggestion)}</div>`;
      }
      html += '</div>';
    }
    html += '</details>';
    resultBanner.innerHTML = html;
  }

  const resultDetails = resultBanner.querySelector('.result-collapse');
  if (logDetails && resultDetails) {
    const syncLogVsResult = () => {
      if (logDetails.open) {
        resultDetails.open = false;
      }
      resultBanner.classList.toggle('collapsed-by-log', !!logDetails.open);
    };
    logDetails.addEventListener('toggle', syncLogVsResult);
    resultDetails.addEventListener('toggle', () => {
      if (resultDetails.open) {
        logDetails.open = false;
      }
      resultBanner.classList.toggle('collapsed-by-log', !!logDetails.open);
    });
    syncLogVsResult();
  }

  // Keep the final answer visible without manual scrolling.
  requestAnimationFrame(() => {
    resultBanner.scrollIntoView({ behavior: 'smooth', block: 'end' });
    stepsContainer.scrollTop = stepsContainer.scrollHeight;
  });
}

function hideRecoverableSessionBanner() {
  if (resultBanner.dataset.mode !== 'recover') return;
  resultBanner.style.display = 'none';
  resultBanner.className = 'result-banner';
  resultBanner.textContent = '';
  resultBanner.dataset.mode = '';
}

function showRecoverableSession(session) {
  if (!session || isRunning || isPaused) return;
  const goal = String(session.goal || '').trim();
  if (!goal) return;
  const stepNum = Number(session.nextStep || 0);
  const stepLabel = Number.isFinite(stepNum) && stepNum > 0 ? `~${stepNum} steps captured` : 'Progress captured';
  const urlLine = session.lastKnownUrl
    ? `<div style="margin-top:4px;color:var(--text2);font-size:11px;">${escapeHtml(session.lastKnownUrl)}</div>`
    : '';
  resultBanner.style.display = '';
  resultBanner.className = 'result-banner warning';
  resultBanner.dataset.mode = 'recover';
  resultBanner.innerHTML = `
    <div class="result-header">${icon('bolt')} Recovered unfinished task</div>
    <div style="margin-top:6px;color:var(--text);font-weight:400;">${escapeHtml(goal)}</div>
    <div style="margin-top:6px;color:var(--text2);font-size:11px;">${escapeHtml(stepLabel)} · Last update ${formatHistoryTime(session.updatedAt)}</div>
    ${urlLine}
    <div style="margin-top:8px;color:var(--text2);font-size:11px;">Resume to continue from saved state, or discard to clear it.</div>
    <div class="manual-actions">
      <button id="recoverResumeBtn">Resume</button>
      <button id="recoverDiscardBtn">Discard</button>
    </div>
  `;
  document.getElementById('recoverResumeBtn')?.addEventListener('click', () => {
    currentGoal = goal;
    sendMsg({ type: 'resumeRecoveredTask' });
  });
  document.getElementById('recoverDiscardBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'discardRecoveredTask' });
  });
}

function updateStatus(status) {
  isRunning = status === 'running';
  isPaused = status === 'paused_waiting_user';
  if (!isPaused) activeInterventionDetails = null;

  let dotClass = '';
  if (isRunning) dotClass = ' running';
  else if (isPaused) dotClass = ' paused';
  else if (status === 'failed') dotClass = ' error';
  statusDot.className = 'dot' + dotClass;

  if (isRunning) {
    sendBtn.innerHTML = icon('stop');
    sendBtn.className = 'send-btn stop';
    sendBtn.title = 'Stop';
  } else if (isPaused) {
    sendBtn.innerHTML = icon('play');
    sendBtn.className = 'send-btn resume';
    sendBtn.title = 'Resume';
  } else {
    sendBtn.innerHTML = icon('play');
    sendBtn.className = 'send-btn';
    sendBtn.title = 'Run';
  }

  goalInput.disabled = isRunning || isPaused;
  if (isRunning && resultBanner.dataset.mode === 'recover') {
    hideRecoverableSessionBanner();
  }
  if (!isPaused && resultBanner.classList.contains('warning') && resultBanner.dataset.mode !== 'recover') {
    resultBanner.style.display = 'none';
    resultBanner.className = 'result-banner';
    resultBanner.textContent = '';
    resultBanner.dataset.mode = '';
  }
  updateModeBadge();
}

function showManualIntervention(details = {}) {
  activeInterventionDetails = details && typeof details === 'object' ? { ...details } : null;
  const message = details.message || 'Manual intervention required.';
  const isJsDomainPermission = String(details.type || '') === 'jsDomainPermission';
  const isHumanGuidance = String(details.type || '') === 'humanGuidance';
  const isLimitGuard = String(details.type || '') === 'limitGuard' || String(details.kind || '') === 'limit_guard';
  resultBanner.style.display = '';
  resultBanner.className = 'result-banner warning';
  resultBanner.dataset.mode = 'manual';
  if (isJsDomainPermission) {
    const domain = String(details.domain || '').trim();
    resultBanner.innerHTML = `
      <div class="result-header">${icon('bolt')} Permission required</div>
      <div style="margin-top:6px;color:var(--text);font-weight:400;">${escapeHtml(message)}</div>
      ${domain ? `<div style="margin-top:6px;color:var(--text2);font-size:11px;">Domain: ${escapeHtml(domain)}</div>` : ''}
      <div style="margin-top:8px;color:var(--text2);font-size:11px;">Allow to continue this step, or block JavaScript for this domain.</div>
      <div class="manual-actions">
        <button id="manualAllowJsBtn">Allow</button>
        <button id="manualDenyJsBtn">Block</button>
        <button id="manualStopBtn">Stop</button>
      </div>
    `;
  } else if (isLimitGuard) {
    const limitReason = String(details.limitReason || '').trim();
    resultBanner.innerHTML = `
      <div class="result-header">${icon('bolt')} Paused: limit reached</div>
      <div style="margin-top:6px;color:var(--text);font-weight:400;">${escapeHtml(message)}</div>
      ${limitReason ? `<div style="margin-top:8px;color:var(--text2);font-size:11px;">${escapeHtml(limitReason)}</div>` : ''}
      <div style="margin-top:8px;color:var(--text2);font-size:11px;">Choose Continue to proceed, or Stop to end this run.</div>
      <div class="manual-actions">
        <button id="manualResumeBtn">Continue</button>
        <button id="manualStopBtn">Stop</button>
      </div>
    `;
  } else if (isHumanGuidance) {
    const facts = Array.isArray(details.facts) ? details.facts.slice(0, 4) : [];
    const unknowns = Array.isArray(details.unknowns) ? details.unknowns.slice(0, 3) : [];
    const blockers = Array.isArray(details.blockers) ? details.blockers.slice(0, 6) : [];
    const confidence = Number(details.confidence);
    const remainingSteps = Number(details.remainingSteps);
    const factsHtml = facts.length > 0
      ? `<ul class="manual-guidance-list">${facts.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('')}</ul>`
      : '<div class="manual-guidance-empty">No confirmed facts yet.</div>';
    const unknownsHtml = unknowns.length > 0
      ? `<ul class="manual-guidance-list">${unknowns.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('')}</ul>`
      : '<div class="manual-guidance-empty">No explicit factual unknowns were provided.</div>';
    const blockersHtml = blockers.length > 0
      ? `<ul class="manual-guidance-list">${blockers.map((item) => `<li>${escapeHtml(String(item))}</li>`).join('')}</ul>`
      : '<div class="manual-guidance-empty">No procedural blockers were provided.</div>';
    const meta = [
      Number.isFinite(confidence) ? `Confidence: ${Math.round(confidence)}%` : '',
      Number.isFinite(remainingSteps) ? `Steps left: ${remainingSteps}` : '',
    ].filter(Boolean).join(' · ');
    resultBanner.innerHTML = `
      <div class="result-header">${icon('bolt')} Paused: your guidance is needed</div>
      <div style="margin-top:6px;color:var(--text);font-weight:400;">${escapeHtml(message)}</div>
      ${meta ? `<div class="manual-guidance-meta">${escapeHtml(meta)}</div>` : ''}
      ${details.url ? `<div style="margin-top:4px;color:var(--text2);font-size:11px;">${escapeHtml(details.url)}</div>` : ''}
      <div class="manual-guidance-block">
        <div class="manual-guidance-title">What is already found</div>
        ${factsHtml}
      </div>
      <div class="manual-guidance-block">
        <div class="manual-guidance-title">What is still unclear</div>
        ${unknownsHtml}
      </div>
      <div class="manual-guidance-block">
        <div class="manual-guidance-title">Why I paused</div>
        ${blockersHtml}
      </div>
      <div class="manual-guidance-block">
        <div class="manual-guidance-title">Your guidance (optional)</div>
        <input id="manualGuidanceInput" class="manual-guidance-input" type="text" placeholder="Example: use found facts and finish with final answer now">
      </div>
      <div class="manual-actions">
        <button id="manualResumeBtn">Continue</button>
        <button id="manualPartialBtn">Finish partial</button>
        <button id="manualStopBtn">Stop</button>
      </div>
    `;
  } else {
    resultBanner.innerHTML = `
      <div class="result-header">${icon('bolt')} Paused: your help is needed</div>
      <div style="margin-top:6px;color:var(--text);font-weight:400;">${escapeHtml(message)}</div>
      ${details.url ? `<div style="margin-top:4px;color:var(--text2);font-size:11px;">${escapeHtml(details.url)}</div>` : ''}
      <div style="margin-top:8px;color:var(--text2);font-size:11px;">Complete it in the page, then press Resume.</div>
      <div class="manual-actions">
        <button id="manualResumeBtn">Resume</button>
        <button id="manualStopBtn">Stop</button>
      </div>
    `;
  }
  document.getElementById('manualResumeBtn')?.addEventListener('click', () => {
    const guidance = document.getElementById('manualGuidanceInput')?.value || '';
    sendMsg({ type: 'resumeTask', guidance });
  });
  document.getElementById('manualGuidanceInput')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const guidance = document.getElementById('manualGuidanceInput')?.value || '';
    sendMsg({ type: 'resumeTask', guidance });
  });
  document.getElementById('manualPartialBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'finishPartialTask' });
  });
  document.getElementById('manualAllowJsBtn')?.addEventListener('click', () => {
    const domain = String(details.domain || '').trim();
    sendMsg({ type: 'jsDomainAllow', domain });
  });
  document.getElementById('manualDenyJsBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'jsDomainDeny' });
  });
  document.getElementById('manualStopBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'stopTask' });
  });
}

function summarizeArgs(tool, args) {
  switch (tool) {
    case 'click': return `element [${args.target}]`;
    case 'mouse_move': return args.target ? `element [${args.target}]` : `(${args.x}, ${args.y})`;
    case 'middle_click': return `element [${args.target}]`;
    case 'triple_click': return `element [${args.target}]`;
    case 'left_mouse_down': return args.target ? `element [${args.target}]` : `(${args.x}, ${args.y})`;
    case 'left_mouse_up': return args.target ? `element [${args.target}]` : `(${args.x}, ${args.y})`;
    case 'click_at': return `(${args.x}, ${args.y})`;
    case 'drag_at': return `(${args.fromX}, ${args.fromY}) → (${args.toX}, ${args.toY})`;
    case 'double_click': return `element [${args.target}]`;
    case 'right_click': return `element [${args.target}]`;
    case 'drag_drop': return `[${args.source}] → [${args.target}]`;
    case 'type': return `"${args.text?.slice(0, 30)}" → [${args.target}]`;
    case 'navigate': return args.url?.slice(0, 50);
    case 'back': return 'history back';
    case 'forward': return 'history forward';
    case 'reload': return 'reload tab';
    case 'scroll': return `${args.direction} ${args.amount || 500}px`;
    case 'find': return `"${args.query}"`;
    case 'find_text': return `"${args.query}"`;
    case 'find_text_next': return args.wrap === false ? 'next (no wrap)' : 'next';
    case 'find_text_prev': return args.wrap === false ? 'prev (no wrap)' : 'prev';
    case 'hover': return `element [${args.target}]`;
    case 'press_key': return args.key;
    case 'hold_key': return `${args.state || 'hold'} ${args.key || ''}`.trim();
    case 'press_hotkey': return `${(args.modifiers || []).join('+')}${args.modifiers?.length ? '+' : ''}${args.key}`;
    case 'select': return `"${args.value}" in [${args.target}]`;
    case 'wait_for': return `${args.condition}`;
    case 'switch_frame': return args.main ? 'main frame' : `${args.target ?? args.index}`;
    case 'upload_file': return `${(args.files || []).length} file(s) → [${args.target}]`;
    case 'download_status': return args.state || 'any';
    case 'list_tabs': return 'current window';
    case 'switch_tab': return args.tabId ? `tab ${args.tabId}` : `index ${args.index}`;
    case 'open_tab': return args.url?.slice(0, 50);
    case 'close_tab': return args.tabId ? `tab ${args.tabId}` : 'current tab';
    case 'javascript': return args.code?.slice(0, 40) + '...';
    case 'done': return args.summary?.slice(0, 50);
    case 'fail': return args.reason?.slice(0, 50);
    default: return '';
  }
}

// ===== Settings =====


function switchTab(viewId, btnId) {
  if (viewId !== 'chatView') setShortcutsPanelOpen(false);

  // Hide all views
  ['chatView', 'capabilitiesView', 'connectionsView', 'settingsView', 'scheduleView', 'historyView'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  // Deactivate all tabs
  ['btnHelp', 'btnCapabilities', 'btnConnections', 'btnSettings', 'btnSchedule', 'btnHistory'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });

  // Activate selected
  const targetView = document.getElementById(viewId);
  if (targetView) targetView.classList.add('active');
  
  const targetBtn = document.getElementById(btnId);
  if (targetBtn) targetBtn.classList.add('active');

  if (viewId === 'settingsView') {
    sendMsg({ type: 'getConfig' });
    sendMsg({ type: 'getBlocklist' });
    sendMsg({ type: 'getTrackerBlockerState' });
  } else if (viewId === 'scheduleView') {
    sendMsg({ type: 'getScheduledTasks' });
  } else if (viewId === 'historyView') {
    renderHistory();
  } else if (viewId === 'connectionsView') {
    renderConnections();
    renderConnectionsDiagnostics();
  } else if (viewId === 'chatView') {
    requestActiveTabContext();
  }
}

btnHelp.addEventListener('click', () => switchTab('chatView', 'btnHelp'));
btnCapabilities?.addEventListener('click', () => switchTab('capabilitiesView', 'btnCapabilities'));
btnConnections?.addEventListener('click', () => switchTab('connectionsView', 'btnConnections'));
btnSettings.addEventListener('click', () => switchTab('settingsView', 'btnSettings'));
btnSchedule.addEventListener('click', () => switchTab('scheduleView', 'btnSchedule'));
btnHistory.addEventListener('click', () => switchTab('historyView', 'btnHistory'));

btnSaveShortcut?.addEventListener('click', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (String(goalInput.value || '').trim()) {
    await saveCurrentShortcut();
    return;
  }
  shortcutsPanelMode = 'manual';
  shortcutsPanelQuery = '';
  setShortcutsPanelOpen(!shortcutsPanelOpen);
});

shortcutsDropdown?.addEventListener('click', (event) => {
  event.stopPropagation();
});

btnPlanMode?.addEventListener('click', () => {
  setPlanMode(!planMode);
});

window.addEventListener('focus', () => {
  requestActiveTabContext();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestActiveTabContext();
});

document.addEventListener('click', (event) => {
  if (!shortcutsPanelOpen) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (btnSaveShortcut?.contains(target) || shortcutsDropdown?.contains(target)) return;
  setShortcutsPanelOpen(false);
});

function updateModeBadge() {
  if (!modeBadge) return;
  if (isPaused) {
    modeBadge.textContent = 'PAUSED';
    modeBadge.style.color = 'var(--warning)';
    modeBadge.style.background = 'rgba(231, 190, 121, 0.15)';
    return;
  }
  if (isRunning) {
    modeBadge.textContent = 'RUNNING';
    modeBadge.style.color = 'var(--accent)';
    modeBadge.style.background = 'rgba(212, 162, 78, 0.15)';
    return;
  }
  modeBadge.textContent = config?.primary ? String(config.primary).toUpperCase() : 'IDLE';
  modeBadge.style.color = 'var(--text2)';
  modeBadge.style.background = 'rgba(255,255,255,0.04)';
}

function collectProviderConfig(name) {
  return {
    apiKey: document.getElementById(`key_${name}`)?.value?.trim() || '',
    model: document.getElementById(`model_${name}`)?.value?.trim() || '',
    baseUrl: document.getElementById(`url_${name}`)?.value?.trim() || '',
  };
}

function saveProviderConfig(name) {
  if (!config) return;
  const providers = { ...(config.providers || {}) };
  providers[name] = collectProviderConfig(name);
  config.providers = providers;
  sendMsg({ type: 'updateConfig', config: { providers } });
}

function renderSettings() {
  if (!tierGroups) return;
  if (!config || !providerInfo) {
    tierGroups.innerHTML = '';
    return;
  }

  const tierDefs = {
    recommended: { title: 'POWERFUL', desc: 'Most capable', icon: icon('star') },
    budget: { title: 'TURBO', desc: 'Fastest inference', icon: icon('bolt') },
    free: { title: 'FREE', desc: 'Fully private', icon: icon('ollama') },
  };
  const orderedTiers = ['recommended', 'budget', 'free'];
  const groups = { recommended: [], budget: [], free: [] };

  for (const [name, info] of Object.entries(providerInfo)) {
    const tier = (info?.tier && groups[info.tier]) ? info.tier : 'recommended';
    groups[tier].push({ name, info });
  }

  tierGroups.innerHTML = '';
  for (const tierKey of orderedTiers) {
    const list = groups[tierKey];
    if (!list || list.length === 0) continue;

    const tierMeta = tierDefs[tierKey];
    const details = document.createElement('details');
    details.className = 'settings-tier';

    details.innerHTML = `
      <summary>
        <div class="settings-tier-row">
          <div class="settings-tier-left">
            <span class="tier-arrow"></span>
            <span>${tierMeta.icon}</span>
            <span class="settings-tier-title">${escapeHtml(tierMeta.title)}</span>
          </div>
          <span class="settings-tier-right">${escapeHtml(tierMeta.desc)}</span>
        </div>
      </summary>
      <div class="settings-tier-body"></div>
    `;

    const body = details.querySelector('.settings-tier-body');

    for (const { name, info } of list) {
      const provConf = config.providers?.[name] || {};
      const status = providerStatus?.[name];
      const statusLabel = status?.available ? 'Connected' : (status?.configured ? 'Configured' : 'Not configured');
      const statusClass = status?.available ? 'ok' : (status?.configured ? 'warn' : 'unknown');
      const apiKeyLabel = {
        fireworks: 'Fireworks API Key',
        xai: 'xAI API Key',
        groq: 'Groq API Key',
        siliconflow: 'SiliconFlow API Key',
      }[name] || 'API Key';

      const card = document.createElement('div');
      card.className = `provider-card${config.primary === name ? ' active' : ''}`;
      card.innerHTML = `
        <div class="provider-top">
          <div class="provider-name"><span class="status-dot ${statusClass}"></span> ${escapeHtml(info?.label || name)}</div>
          <div class="provider-pricing">${escapeHtml(info?.pricing || '')}</div>
        </div>
        <div class="provider-note">${escapeHtml(info?.note || '')}</div>
        ${name !== 'ollama' ? `
          <div class="provider-label-row">
            <label class="provider-label">${escapeHtml(apiKeyLabel)}</label>
            ${info?.signupUrl ? `<a class="provider-key-link" href="${escapeAttr(info.signupUrl)}" target="_blank" rel="noopener noreferrer">Get key ↗</a>` : ''}
          </div>
          <input class="provider-input" type="password" id="key_${name}" value="${escapeAttr(provConf.apiKey || '')}" placeholder="Enter API key">
        ` : ''}
        <label class="provider-label">MODEL</label>
        <input class="provider-input" type="text" id="model_${name}" value="${escapeAttr(provConf.model || info?.defaultModel || '')}" placeholder="Model">
        ${name === 'ollama' ? `
          <label class="provider-label">BASE URL</label>
          <input class="provider-input" type="text" id="url_${name}" value="${escapeAttr(provConf.baseUrl || 'http://localhost:11434/v1')}" placeholder="http://localhost:11434/v1">
        ` : ''}
        <div class="provider-actions">
          <button class="test-btn" data-provider="${name}">Test</button>
          <span class="test-status ${statusClass}" id="testStatus_${name}">${escapeHtml(statusLabel)}</span>
        </div>
        <button class="provider-select-btn" data-select-provider="${name}">
          ${config.primary === name ? `${icon('check')} Active` : `Use ${escapeHtml(info?.label || name)}`}
        </button>
      `;
      body.appendChild(card);

      const keyEl = document.getElementById(`key_${name}`);
      const modelEl = document.getElementById(`model_${name}`);
      const urlEl = document.getElementById(`url_${name}`);
      keyEl?.addEventListener('change', () => saveProviderConfig(name));
      modelEl?.addEventListener('change', () => saveProviderConfig(name));
      urlEl?.addEventListener('change', () => saveProviderConfig(name));

      card.querySelector('.test-btn')?.addEventListener('click', () => {
        const providerConfig = collectProviderConfig(name);
        config.providers = { ...(config.providers || {}), [name]: providerConfig };
        const el = document.getElementById(`testStatus_${name}`);
        if (el) el.textContent = 'Testing...';
        sendMsg({ type: 'testProvider', providerName: name, providerConfig });
      });

      card.querySelector('.provider-select-btn')?.addEventListener('click', () => {
        if (config.primary === name) return;
        config.primary = name;
        sendMsg({ type: 'updateConfig', config: { primary: name } });
        renderSettings();
        updateModeBadge();
      });
    }

    tierGroups.appendChild(details);
  }
}

function showTestResult(msg) {
  const el = document.getElementById(`testStatus_${msg.providerName}`);
  if (!el) return;
  if (msg.success) {
    el.textContent = `Connected${msg.latencyMs ? ` (${msg.latencyMs}ms)` : ''}`;
    el.className = 'test-status ok';
  } else {
    el.textContent = `Failed: ${msg.error || 'Unknown error'}`;
    el.className = 'test-status warn';
  }
}

function isSensitiveDebugKey(key) {
  return /(token|secret|password|api[_-]?key|authorization|webhook|service|smtp)/i.test(String(key || ''));
}

function maskDebugValue(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= 6) return '*'.repeat(Math.min(6, text.length));
  return `${text.slice(0, 2)}${'*'.repeat(Math.min(10, text.length - 4))}${text.slice(-2)}`;
}

function maskConnectionsDebugObject(value, key = '') {
  if (value == null) return value;
  if (isSensitiveDebugKey(key)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return maskDebugValue(value);
    }
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskConnectionsDebugObject(item, key));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = maskConnectionsDebugObject(v, k);
    }
    return out;
  }
  return value;
}

async function renderConnectionsDiagnostics() {
  const el = document.getElementById('connectionsDiagnosticsSection');
  if (!el) return;

  let storedState = null;
  let errorText = '';
  try {
    const stored = await chrome.storage.local.get(CONNECTIONS_STORAGE_KEY);
    storedState = stored?.[CONNECTIONS_STORAGE_KEY] || null;
  } catch (err) {
    errorText = err?.message || String(err);
  }

  const normalized = storedState ? normalizeConnectionsState(storedState) : null;
  const masked = normalized ? maskConnectionsDebugObject(normalized) : null;
  const jsonText = JSON.stringify(masked || { connectionsState: null }, null, 2);
  const connected = Array.isArray(normalized?.integrations)
    ? normalized.integrations.filter((item) => item?.connected).length
    : 0;
  const total = Array.isArray(normalized?.integrations) ? normalized.integrations.length : 0;

  el.innerHTML = `
    <div class="blocklist-card" style="padding:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <div style="font-size:11px;color:var(--text2);">
          ${escapeHtml(`Storage key: ${CONNECTIONS_STORAGE_KEY} · ${connected}/${total} connected · ${formatHistoryTime(Date.now())}`)}
        </div>
        <div class="diag-actions">
          <button class="icon-btn diag-action-btn" id="connectionsDiagRefreshBtn" title="Refresh diagnostics" aria-label="Refresh diagnostics">${icon('clock')}</button>
          <button class="icon-btn diag-action-btn" id="connectionsDiagCopyBtn" title="Copy masked JSON" aria-label="Copy masked JSON">${icon('clipboard')}</button>
        </div>
      </div>
      ${errorText ? `<div style="margin-bottom:8px;color:var(--error);font-size:11px;">${escapeHtml(`Read failed: ${errorText}`)}</div>` : ''}
      <pre style="margin:0;max-height:280px;overflow:auto;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:11px;line-height:1.35;color:var(--text2);">${escapeHtml(jsonText)}</pre>
    </div>
  `;

  document.getElementById('connectionsDiagRefreshBtn')?.addEventListener('click', () => {
    renderConnectionsDiagnostics();
  });
  document.getElementById('connectionsDiagCopyBtn')?.addEventListener('click', async (evt) => {
    try {
      await navigator.clipboard.writeText(jsonText);
      const btn = evt?.currentTarget;
      if (btn instanceof HTMLElement) {
        const originalTitle = btn.title;
        btn.classList.add('active');
        btn.title = 'Copied';
        setTimeout(() => {
          btn.classList.remove('active');
          btn.title = originalTitle;
        }, 1000);
      }
    } catch {
      // Clipboard may be unavailable in some extension contexts.
    }
  });
}

function renderBlocklist() {
  const el = document.getElementById('blocklistSection');
  if (!el) return;
  const isEmpty = siteBlocklist.length === 0;
  const chipsHtml = siteBlocklist.length === 0
    ? ''
    : siteBlocklist.map((d, i) => `
        <div class="block-chip">
          <span>${escapeHtml(d)}</span>
          <button class="block-chip-del" data-idx="${i}" title="Remove">×</button>
        </div>`
    ).join('');
  const emptyHtml = isEmpty ? `<div class="empty-muted blocklist-empty">No blocked domains</div>` : '';
  el.innerHTML = `
    <div class="blocklist-card blocklist-mode">
      <div id="blocklistItems" class="blocklist-chips">${chipsHtml}</div>
      <div class="add-row">
        <input id="blocklistInput" type="text" placeholder="domain.com">
        <button id="blocklistAddBtn">Block</button>
      </div>
      ${emptyHtml}
    </div>`;
  el.querySelectorAll('.block-chip-del').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      siteBlocklist.splice(idx, 1);
      sendMsg({ type: 'updateBlocklist', domains: siteBlocklist });
      renderBlocklist();
    });
  });
  document.getElementById('blocklistAddBtn')?.addEventListener('click', () => {
    const input = document.getElementById('blocklistInput');
    const val = (input?.value || '').trim().replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*/, '');
    if (!val || siteBlocklist.includes(val)) {
      if (input) input.value = '';
      return;
    }
    siteBlocklist.push(val);
    sendMsg({ type: 'updateBlocklist', domains: siteBlocklist });
    input.value = '';
    renderBlocklist();
  });
}

function renderTrackerBlockerToggle() {
  const el = document.getElementById('trackerBlockerSection');
  if (!el) return;
  const checked = trackerBlockerEnabled ? 'checked' : '';
  el.innerHTML = `
    <div class="blocklist-card" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="i i-ban" style="font-size:16px;color:var(--text2);"></span>
        <span style="font-size:13px;color:var(--text1);">Enable during agent runs</span>
      </div>
      <label class="toggle-switch">
        <input type="checkbox" id="trackerBlockerToggle" ${checked}>
        <span class="toggle-slider"></span>
      </label>
    </div>`;
  document.getElementById('trackerBlockerToggle')?.addEventListener('change', (e) => {
    trackerBlockerEnabled = e.target.checked;
    sendMsg({ type: 'setTrackerBlockerState', enabled: trackerBlockerEnabled });
  });
}

function normalizeConnectorIdList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function getSchedulableConnectors() {
  const integrations = Array.isArray(connectionsState?.integrations) ? connectionsState.integrations : [];
  return integrations
    .filter((item) => item?.connected && getMissingRequiredConnectionFields(item).length === 0)
    .map((item) => ({
      id: String(item.id || '').trim(),
      label: String(item.label || item.id || 'Connector').trim(),
      icon: String(item.icon || 'cloud').trim() || 'cloud',
    }))
    .filter((item) => item.id);
}

function renderScheduledTasks() {
  const el = document.getElementById('scheduledTasksSection');
  if (!el) return;
  const schedulableConnectors = getSchedulableConnectors();
  const schedulableById = new Map(schedulableConnectors.map((item) => [item.id, item]));
  const connectorMetaById = (id) => {
    if (schedulableById.has(id)) return schedulableById.get(id);
    const conn = getConnectionById(id);
    return {
      id,
      label: conn?.label || id,
      icon: conn?.icon || 'cloud',
    };
  };
  const periodClass = (min) => {
    if (min === 30) return 'is-30m';
    if (min === 60) return 'is-hourly';
    if (min === 360) return 'is-6h';
    if (min === 1440) return 'is-daily';
    if (min < 60) return 'is-short';
    return 'is-default';
  };
  const periodLabel = (min) => {
    if (min < 60) return `${min} min`;
    if (min === 60) return 'Hourly';
    if (min === 360) return 'Every 6h';
    if (min < 1440) return `Every ${min / 60}h`;
    return 'Daily';
  };

  const itemsHtml = scheduledTasks.length === 0
    ? `<div class="queue-empty">No scheduled tasks yet</div>`
    : `
      <div class="queue-scheduled-label">SCHEDULED · ${scheduledTasks.length}</div>
      <div class="queue-task-list">
        ${scheduledTasks.map((t) => {
          const active = t.enabled !== false;
          const goalText = (t.goal || '').trim();
          const connectorIds = normalizeConnectorIdList(t.connectorIds || []);
          const connectorsHtml = connectorIds.length > 0
            ? `<div class="queue-task-connectors">${connectorIds.map((id) => {
              const meta = connectorMetaById(id);
              return `<span class="icon-btn queue-task-connector-icon" title="${escapeAttr(meta.label)}">${icon(meta.icon || 'cloud')}</span>`;
            }).join('')}</div>`
            : '';
          return `
          <div class="queue-task-card${active ? '' : ' paused'}">
            <div class="queue-task-top">
              <div class="queue-task-name">${escapeHtml(t.name || 'Task')}</div>
              <span class="queue-period-pill ${periodClass(t.periodMinutes || 60)}">${escapeHtml(periodLabel(t.periodMinutes || 60))}</span>
            </div>
            <div class="queue-task-goal">${escapeHtml(goalText || 'No goal')}</div>
            ${connectorsHtml}
            <div class="queue-task-bottom">
              <button class="queue-task-toggle${active ? '' : ' off'}" data-id="${escapeAttr(t.id)}" data-enabled="${active ? '1' : '0'}" title="${active ? 'Disable task' : 'Enable task'}">
                <span class="queue-task-switch"><span class="queue-task-knob"></span></span>
                <span class="queue-task-state-label">${active ? 'Active' : 'Inactive'}</span>
              </button>
              <button class="queue-remove-btn" data-id="${escapeAttr(t.id)}">Remove</button>
            </div>
          </div>`;
        }).join('')}
      </div>`;

  el.innerHTML = `
    <div class="queue-form-card">
      <div class="queue-stack">
        <input id="schedGoalInput" type="text" placeholder="Task goal" class="queue-goal">
        <div class="queue-row">
          <input id="schedNameInput" type="text" placeholder="Name" class="queue-name">
          <select id="schedPeriodSelect" class="queue-period">
            <option value="30">30 min</option>
            <option value="60" selected>Hourly</option>
            <option value="360">Every 6h</option>
            <option value="1440">Daily</option>
          </select>
          <button id="schedAddBtn" class="queue-add-btn">Add</button>
        </div>
        <div class="queue-row queue-connector-row">
          <div id="schedConnectorPicker" class="queue-connector-picker"></div>
        </div>
      </div>
    </div>
    ${itemsHtml}`;

  const connectorPickerEl = document.getElementById('schedConnectorPicker');
  const availableConnectorIds = new Set(schedulableConnectors.map((item) => item.id));
  scheduleDraftConnectorIds = normalizeConnectorIdList(scheduleDraftConnectorIds).filter((id) => availableConnectorIds.has(id));

  const renderConnectorPicker = () => {
    if (!connectorPickerEl) return;
    if (schedulableConnectors.length === 0) {
      connectorPickerEl.innerHTML = `<span class="queue-connector-empty">No active connectors yet</span>`;
      return;
    }
    connectorPickerEl.innerHTML = schedulableConnectors
      .map((item) => {
        const selected = scheduleDraftConnectorIds.includes(item.id);
        const stateText = selected ? 'selected' : 'not selected';
        return `<button class="icon-btn queue-connector-toggle${selected ? ' active' : ' off'}" data-connector-id="${escapeAttr(item.id)}" title="${escapeAttr(`${item.label}: ${stateText}`)}">${icon(item.icon || 'cloud')}</button>`;
      })
      .join('');
    connectorPickerEl.querySelectorAll('.queue-connector-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.dataset.connectorId || '').trim();
        if (!id) return;
        if (scheduleDraftConnectorIds.includes(id)) {
          scheduleDraftConnectorIds = scheduleDraftConnectorIds.filter((item) => item !== id);
        } else {
          scheduleDraftConnectorIds.push(id);
          scheduleDraftConnectorIds = normalizeConnectorIdList(scheduleDraftConnectorIds);
        }
        renderConnectorPicker();
      });
    });
  };
  renderConnectorPicker();

  el.querySelectorAll('.queue-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => sendMsg({ type: 'removeScheduledTask', id: btn.dataset.id }));
  });
  el.querySelectorAll('.queue-task-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const enabled = btn.dataset.enabled === '1';
      sendMsg({ type: 'toggleScheduledTask', id, enabled: !enabled });
    });
  });
  document.getElementById('schedAddBtn')?.addEventListener('click', () => {
    const goal = document.getElementById('schedGoalInput')?.value.trim();
    const name = document.getElementById('schedNameInput')?.value.trim() || goal?.slice(0, 30) || 'Task';
    const periodMinutes = parseInt(document.getElementById('schedPeriodSelect')?.value || '60', 10);
    if (!goal) return;
    const connectorIds = normalizeConnectorIdList(scheduleDraftConnectorIds);
    sendMsg({ type: 'addScheduledTask', name, goal, periodMinutes, connectorIds });
    scheduleDraftConnectorIds = [];
    document.getElementById('schedGoalInput').value = '';
    document.getElementById('schedNameInput').value = '';
    renderConnectorPicker();
  });
}

function defaultConnectionsState() {
  return {
    integrations: [
      {
        id: 'telegram',
        label: 'Telegram',
        desc: 'Send notifications to your chat',
        icon: 'send',
        connected: false,
        status: 'ready',
        actionChips: ['Send message', 'Alert on change', 'Send report'],
        details: [
          { label: 'Bot', key: 'bot' },
          { label: 'Chat ID', key: 'chatId' },
        ],
        values: { bot: '@browser_agent_bot', chatId: '', token: '' },
        configFields: [
          { key: 'token', label: 'Bot Token', type: 'password', placeholder: 'Bot token' },
          { key: 'chatId', label: 'Chat ID', type: 'text', placeholder: 'Chat ID' },
        ],
      },
      {
        id: 'notion',
        label: 'Notion',
        desc: 'Save results to your workspace',
        icon: 'notion',
        connected: false,
        status: 'ready',
        actionChips: ['Create page', 'Add to DB', 'Update'],
        details: [{ label: 'Database', key: 'database' }],
        values: { database: 'Research Logs', token: '', databaseId: '' },
        configFields: [
          { key: 'token', label: 'Integration Token', type: 'password', placeholder: 'secret_...' },
          { key: 'databaseId', label: 'Database ID', type: 'text', placeholder: 'database id' },
        ],
      },
      {
        id: 'slack',
        label: 'Slack',
        desc: 'Post messages to channels',
        icon: 'message-square',
        connected: false,
        status: 'ready',
        actionChips: [],
        details: [],
        values: { webhookUrl: '' },
        configFields: [{ key: 'webhookUrl', label: 'Webhook URL', type: 'text', placeholder: 'https://hooks.slack.com/services/...' }],
      },
      {
        id: 'airtable',
        label: 'Airtable',
        desc: 'Log data to spreadsheets',
        icon: 'database',
        connected: false,
        status: 'ready',
        actionChips: [],
        details: [],
        values: { apiKey: '', baseId: '' },
        configFields: [
          { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'pat...' },
          { key: 'baseId', label: 'Base ID', type: 'text', placeholder: 'app...' },
        ],
      },
      {
        id: 'sheets',
        label: 'Google Sheets',
        desc: 'Append rows to spreadsheets',
        icon: 'clipboard',
        connected: false,
        status: 'ready',
        actionChips: [],
        details: [],
        values: { appScriptUrl: '' },
        configFields: [{ key: 'appScriptUrl', label: 'Apps Script URL', type: 'text', placeholder: 'https://script.google.com/macros/s/...' }],
      },
      {
        id: 'discord',
        label: 'Discord',
        desc: 'Send to channels via webhook',
        icon: 'globe',
        connected: false,
        status: 'ready',
        actionChips: [],
        details: [],
        values: { webhookUrl: '' },
        configFields: [{ key: 'webhookUrl', label: 'Webhook URL', type: 'text', placeholder: 'https://discord.com/api/webhooks/...' }],
      },
      {
        id: 'email',
        label: 'Email',
        desc: 'Get task results in your inbox',
        icon: 'mail',
        connected: false,
        status: 'ready',
        actionChips: [],
        details: [],
        values: { email: '', service: '' },
        configFields: [
          { key: 'email', label: 'Email Address', type: 'email', placeholder: 'you@example.com' },
          { key: 'service', label: 'SMTP or Service', type: 'text', placeholder: 'SendGrid API key or SMTP URL' },
        ],
      },
      {
        id: 'webhook_1',
        label: 'Custom Webhook',
        desc: 'POST to Zapier, Make, n8n, or your API',
        icon: 'link',
        connected: false,
        status: 'ready',
        custom: true,
        actionChips: [],
        details: [{ label: 'URL', key: 'url' }],
        values: { name: 'Webhook 1', url: '', method: 'POST', headers: '{}' },
        configFields: [
          { key: 'name', label: 'Name', type: 'text', placeholder: 'My webhook' },
          { key: 'url', label: 'URL', type: 'text', placeholder: 'https://hooks.example.com/...' },
          { key: 'method', label: 'Method', type: 'text', placeholder: 'POST / GET / PUT' },
          { key: 'headers', label: 'Headers (JSON)', type: 'text', placeholder: '{"Authorization":"Bearer ..."}' },
        ],
      },
    ],
    routing: {
      desktop: true,
      telegram: false,
      notion: false,
      slack: false,
    },
  };
}

const REQUIRED_CONNECTION_FIELDS_BY_ID = Object.freeze({
  telegram: ['token', 'chatId'],
  notion: ['token', 'databaseId'],
  slack: ['webhookUrl'],
  airtable: ['apiKey', 'baseId'],
  sheets: ['appScriptUrl'],
  discord: ['webhookUrl'],
  email: ['email', 'service'],
});

function getRequiredConnectionFields(conn) {
  const explicit = Array.isArray(conn?.configFields)
    ? conn.configFields
      .filter((field) => field?.required === true && field?.key)
      .map((field) => String(field.key).trim())
      .filter(Boolean)
    : [];
  if (explicit.length > 0) return explicit;
  if (conn?.custom) return ['url'];
  return REQUIRED_CONNECTION_FIELDS_BY_ID[String(conn?.id || '').trim()] || [];
}

function getMissingRequiredConnectionFields(conn) {
  return getRequiredConnectionFields(conn).filter((key) => {
    const value = conn?.values?.[key];
    return !String(value ?? '').trim();
  });
}

function getConnectionFieldLabel(conn, key) {
  const field = Array.isArray(conn?.configFields)
    ? conn.configFields.find((item) => String(item?.key || '').trim() === key)
    : null;
  return field?.label || key;
}

function normalizeConnectionsState(state) {
  const fallback = defaultConnectionsState();
  if (!state || typeof state !== 'object') return fallback;

  const defaultIntegrations = Array.isArray(fallback.integrations) ? fallback.integrations : [];
  const storedIntegrations = Array.isArray(state.integrations) ? state.integrations : [];
  const defaultsById = new Map(defaultIntegrations.map((item) => [item.id, item]));

  const normalizedIntegrations = [];
  const seen = new Set();

  for (const raw of storedIntegrations) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    if (!id || seen.has(id)) continue;

    const base = defaultsById.get(id);
    if (base) {
      normalizedIntegrations.push({
        ...base,
        ...raw,
        id,
        actionChips: Array.isArray(raw.actionChips) ? raw.actionChips : (base.actionChips || []),
        details: Array.isArray(raw.details) ? raw.details : (base.details || []),
        configFields: Array.isArray(raw.configFields) ? raw.configFields : (base.configFields || []),
        values: { ...(base.values || {}), ...(raw.values || {}) },
      });
    } else {
      normalizedIntegrations.push({
        ...raw,
        id,
        actionChips: Array.isArray(raw.actionChips) ? raw.actionChips : [],
        details: Array.isArray(raw.details) ? raw.details : [],
        configFields: Array.isArray(raw.configFields) ? raw.configFields : [],
        values: { ...(raw.values || {}) },
      });
    }
    seen.add(id);
  }

  for (const base of defaultIntegrations) {
    if (seen.has(base.id)) continue;
    normalizedIntegrations.push({
      ...base,
      values: { ...(base.values || {}) },
    });
  }

  const validatedIntegrations = normalizedIntegrations.map((item) => {
    const next = {
      ...item,
      values: { ...(item.values || {}) },
    };
    if (next.connected && getMissingRequiredConnectionFields(next).length > 0) {
      next.connected = false;
      next.status = 'ready';
    }
    return next;
  });

  return {
    ...fallback,
    ...state,
    integrations: validatedIntegrations,
    routing: {
      ...(fallback.routing || {}),
      ...(state.routing && typeof state.routing === 'object' ? state.routing : {}),
    },
  };
}

function serializeConnectionsState(state) {
  const normalized = normalizeConnectionsState(state);
  try {
    return JSON.parse(JSON.stringify(normalized));
  } catch {
    return normalizeConnectionsState(null);
  }
}

async function loadConnectionsState() {
  try {
    const stored = await chrome.storage.local.get(CONNECTIONS_STORAGE_KEY);
    connectionsState = normalizeConnectionsState(stored?.[CONNECTIONS_STORAGE_KEY]);
    renderConnections();
  } catch (err) {
    console.warn('[SP] loadConnectionsState failed:', err?.message || err);
    connectionsState = normalizeConnectionsState(null);
    renderConnections();
  }
}

async function saveConnectionsState() {
  if (!connectionsState) return;
  try {
    await chrome.storage.local.set({ [CONNECTIONS_STORAGE_KEY]: serializeConnectionsState(connectionsState) });
  } catch (err) {
    console.warn('[SP] saveConnectionsState failed:', err?.message || err);
  }
}

function getConnectionById(id) {
  return connectionsState?.integrations?.find((c) => c.id === id) || null;
}

function isConnectorRouteEnabled(routeId) {
  if (!routeId) return false;
  const explicit = connectionsState?.routing?.[routeId];
  if (typeof explicit === 'boolean') return explicit;
  return true;
}

function connectedIntegrations() {
  return (connectionsState?.integrations || []).filter((item) => item?.connected);
}

function renderConnectorQuickActions() {
  if (!connectorQuickActions) return;
  if (!connectionsState) {
    connectorQuickActions.innerHTML = '';
    return;
  }

  const connected = connectedIntegrations();
  connectorQuickActions.innerHTML = connected.map((conn) => {
    const on = isConnectorRouteEnabled(conn.id);
    const stateText = on ? 'enabled' : 'disabled';
    return `<button class="icon-btn connector-toggle${on ? ' active' : ' off'}" data-connector-id="${escapeAttr(conn.id)}" title="${escapeAttr(`${conn.label}: ${stateText}`)}">${icon(conn.icon || 'cloud')}</button>`;
  }).join('');

  connectorQuickActions.querySelectorAll('.connector-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const connectorId = btn.dataset.connectorId;
      if (!connectorId) return;
      connectionsState.routing = connectionsState.routing || {};
      connectionsState.routing[connectorId] = !isConnectorRouteEnabled(connectorId);
      await saveConnectionsState();
      renderConnections();
    });
  });
}

function renderConnectionCard(item) {
  const connected = !!item.connected;
  const statusText = item.status === 'ready' ? 'READY' : 'LIVE';
  const statusClass = item.status === 'ready' ? 'ready' : 'live';
  const isOpen = expandedConnectionIds.has(item.id);
  const detailRows = connected && Array.isArray(item.details)
    ? item.details.map((d) => `
      <div class="conn-detail-row">
        <span class="conn-detail-label">${escapeHtml(d.label)}</span>
        <span class="conn-detail-value">${escapeHtml(item.values?.[d.key] || 'Not set')}</span>
      </div>`).join('')
    : '';
  const chips = connected && Array.isArray(item.actionChips) && item.actionChips.length
    ? `<div class="conn-chip-row">${item.actionChips.map((chip) => `<button class="conn-chip conn-chip-btn" data-chip-action="${escapeAttr(actionKeyFromLabel(chip))}">${escapeHtml(chip)}</button>`).join('')}</div>`
    : '';
  const fields = (item.configFields || []).map((f) => `
    <div class="conn-field">
      <label class="conn-label">${escapeHtml(f.label)}</label>
      <input class="conn-input" data-field="${escapeAttr(f.key)}" type="${escapeAttr(f.type || 'text')}" placeholder="${escapeAttr(f.placeholder || '')}" autocomplete="${escapeAttr(f.type === 'password' ? 'new-password' : 'off')}">
    </div>
  `).join('');
  const errorHtml = item.lastError ? `<div class="conn-desc" style="margin-top:8px;color:var(--error);">${escapeHtml(item.lastError)}</div>` : '';

  return `
    <div class="conn-card${connected ? ' connected' : ''}" data-conn-id="${escapeAttr(item.id)}">
      <div class="conn-top">
        <div class="conn-icon-box">${icon(item.icon || 'cloud')}</div>
        <div class="conn-main">
          <div class="conn-name-row">
            <span class="conn-name">${escapeHtml(item.label)}</span>
            ${connected ? `<span class="conn-state ${statusClass}">${statusText}</span>` : ''}
          </div>
          <div class="conn-desc">${escapeHtml(item.desc)}</div>
        </div>
        <button class="conn-btn" data-action="${connected ? 'edit' : 'connect'}">${connected ? 'Edit' : (item.custom ? 'Add' : 'Connect')}</button>
      </div>
      ${detailRows ? `<div class="conn-details">${detailRows}</div>` : ''}
      ${chips}
      <div class="conn-config${isOpen ? ' show' : ''}">
        ${fields}
        <div class="conn-config-actions">
          <button class="conn-btn" data-action="save">${connected ? 'Save' : 'Save & Connect'}</button>
          <button class="conn-btn" data-action="test">Test</button>
          ${connected ? '<button class="conn-btn danger" data-action="disconnect">Disconnect</button>' : ''}
        </div>
      </div>
      ${errorHtml}
    </div>
  `;
}

function renderConnections() {
  if (!connectionsState) connectionsState = defaultConnectionsState();
  renderConnectorQuickActions();
  if (!connectionsView || !connActiveList || !connAvailableList || !connCustomList || !connRoutingList) return;

  const integrations = connectionsState.integrations || [];
  const active = integrations.filter((c) => c.connected && !c.custom);
  const available = integrations.filter((c) => !c.connected && !c.custom);
  const custom = integrations.filter((c) => c.custom);

  if (connActiveCount) connActiveCount.textContent = `${active.length} connected`;
  connActiveList.innerHTML = active.map(renderConnectionCard).join('');
  connAvailableList.innerHTML = available.map(renderConnectionCard).join('');
  connCustomList.innerHTML = custom.map(renderConnectionCard).join('');

  const connTarget = (id) => {
    if (id === 'desktop') return 'Browser';
    const c = getConnectionById(id);
    if (!c || !c.connected) return 'not connected';
    if (id === 'telegram') return c.values?.bot || 'Telegram';
    if (id === 'notion') return c.values?.database || 'Workspace';
    if (id === 'slack') return c.values?.webhookUrl ? 'Webhook' : 'not connected';
    return c.label;
  };

  const routes = [
    { id: 'desktop', label: 'Desktop notification', icon: 'bell' },
    { id: 'telegram', label: 'Telegram', icon: 'send' },
    { id: 'notion', label: 'Notion', icon: 'notion' },
    { id: 'slack', label: 'Slack', icon: 'message-square' },
  ];
  connRoutingList.innerHTML = routes.map((r) => {
    const on = r.id === 'desktop'
      ? connectionsState.routing?.desktop === true
      : isConnectorRouteEnabled(r.id);
    return `
    <div class="conn-route-row" data-route-id="${escapeAttr(r.id)}">
      <label class="toggle-switch conn-route-switch" title="Toggle ${escapeAttr(r.label)}">
        <input type="checkbox" class="conn-route-toggle-input" ${on ? 'checked' : ''} aria-label="Toggle ${escapeAttr(r.label)}">
        <span class="toggle-slider"></span>
      </label>
      <span class="conn-route-label">${icon(r.icon)} ${escapeHtml(r.label)}</span>
      <span class="conn-route-target">${escapeHtml(connTarget(r.id))}</span>
    </div>
  `;
  }).join('');

  const wireCardList = (root) => {
    root.querySelectorAll('.conn-card').forEach((card) => {
      const connId = card.dataset.connId;
      if (!connId) return;
      const syncValuesFromInputs = (conn) => {
        if (!conn) return;
        card.querySelectorAll('.conn-input').forEach((input) => {
          const key = input.dataset.field;
          if (!key) return;
          const raw = input.value.trim();
          const isDirty = input.dataset.dirty === '1';
          conn.values = conn.values || {};
          if (!isDirty && input.type === 'password' && !raw && conn.values[key]) return;
          conn.values[key] = raw;
          input.dataset.dirty = '0';
        });
      };
      const hydrateInputsFromState = () => {
        const conn = getConnectionById(connId);
        if (!conn) return;
        card.querySelectorAll('.conn-input').forEach((input) => {
          const key = input.dataset.field;
          if (!key) return;
          const value = conn.values?.[key];
          input.value = value == null ? '' : String(value);
          input.dataset.dirty = '0';
        });
      };
      hydrateInputsFromState();

      let autosaveTimer = null;
      card.querySelectorAll('.conn-input').forEach((input) => {
        input.addEventListener('input', () => {
          input.dataset.dirty = '1';
          if (autosaveTimer) clearTimeout(autosaveTimer);
          autosaveTimer = setTimeout(async () => {
            const conn = getConnectionById(connId);
            if (!conn) return;
            syncValuesFromInputs(conn);
            await saveConnectionsState();
          }, 250);
        });
        input.addEventListener('change', async () => {
          input.dataset.dirty = '1';
          const conn = getConnectionById(connId);
          if (!conn) return;
          syncValuesFromInputs(conn);
          await saveConnectionsState();
        });
      });

      card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
        expandedConnectionIds.has(connId) ? expandedConnectionIds.delete(connId) : expandedConnectionIds.add(connId);
        renderConnections();
      });
      card.querySelector('[data-action="connect"]')?.addEventListener('click', () => {
        expandedConnectionIds.add(connId);
        renderConnections();
      });
      card.querySelector('[data-action="save"]')?.addEventListener('click', async () => {
        const conn = getConnectionById(connId);
        if (!conn) return;
        syncValuesFromInputs(conn);
        const missingFields = getMissingRequiredConnectionFields(conn);
        if (missingFields.length > 0) {
          conn.connected = false;
          conn.status = 'ready';
          conn.lastError = `Fill required fields: ${missingFields.map((key) => getConnectionFieldLabel(conn, key)).join(', ')}`;
          expandedConnectionIds.add(connId);
          await saveConnectionsState();
          renderConnections();
          return;
        }
        conn.lastError = '';
        conn.connected = true;
        conn.status = conn.status || 'ready';
        expandedConnectionIds.delete(connId);
        await saveConnectionsState();
        renderConnections();
      });
      card.querySelector('[data-action="test"]')?.addEventListener('click', async () => {
        const conn = getConnectionById(connId);
        if (!conn) return;
        syncValuesFromInputs(conn);
        conn.lastError = '';
        conn.status = 'ready';
        await saveConnectionsState();
        sendMsg({ type: 'testConnection', connection: conn });
      });
      card.querySelector('[data-action="disconnect"]')?.addEventListener('click', async () => {
        const conn = getConnectionById(connId);
        if (!conn) return;
        conn.connected = false;
        conn.status = 'ready';
        expandedConnectionIds.delete(connId);
        await saveConnectionsState();
        renderConnections();
      });

      card.querySelectorAll('.conn-chip-btn').forEach((chipBtn) => {
        chipBtn.addEventListener('click', async () => {
          const conn = getConnectionById(connId);
          if (!conn) return;
          const action = chipBtn.dataset.chipAction || '';
          chipBtn.disabled = true;
          sendMsg({ type: 'connectionAction', connection: conn, action });
          setTimeout(() => { chipBtn.disabled = false; }, 900);
        });
      });
    });
  };

  wireCardList(connActiveList);
  wireCardList(connAvailableList);
  wireCardList(connCustomList);

  connRoutingList.querySelectorAll('.conn-route-row .conn-route-toggle-input').forEach((toggleEl) => {
    toggleEl.addEventListener('change', async () => {
      const row = toggleEl.closest('.conn-route-row');
      const routeId = row?.dataset.routeId;
      if (!routeId) return;
      connectionsState.routing = connectionsState.routing || {};
      connectionsState.routing[routeId] = !!toggleEl.checked;
      await saveConnectionsState();
      renderConnections();
    });
  });

  renderConnectionsDiagnostics();
}

function actionKeyFromLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

btnAddCustomConnection?.addEventListener('click', async () => {
  if (!connectionsState) connectionsState = defaultConnectionsState();
  const idx = connectionsState.integrations.filter((c) => c.custom).length + 1;
  const id = `webhook_${Date.now()}`;
  connectionsState.integrations.push({
    id,
    label: 'Custom Webhook',
    desc: 'POST to Zapier, Make, n8n, or your API',
    icon: 'link',
    connected: false,
    status: 'ready',
    custom: true,
    actionChips: [],
    details: [{ label: 'URL', key: 'url' }],
    values: { name: `Webhook ${idx}`, url: '', method: 'POST', headers: '{}' },
    configFields: [
      { key: 'name', label: 'Name', type: 'text', placeholder: 'My webhook' },
      { key: 'url', label: 'URL', type: 'text', placeholder: 'https://hooks.example.com/...' },
      { key: 'method', label: 'Method', type: 'text', placeholder: 'POST / GET / PUT' },
      { key: 'headers', label: 'Headers (JSON)', type: 'text', placeholder: '{"Authorization":"Bearer ..."}' },
    ],
  });
  expandedConnectionIds.add(id);
  await saveConnectionsState();
  renderConnections();
});

async function applyConnectionTestResult(msg) {
  if (!connectionsState || !msg?.connectionId) return;
  const conn = getConnectionById(msg.connectionId);
  if (!conn) return;
  if (msg.ok) {
    conn.status = 'live';
    conn.lastError = '';
  } else {
    conn.status = 'ready';
    conn.lastError = msg.error || 'Connection test failed';
  }
  await saveConnectionsState();
  renderConnections();
}

async function applyConnectionActionResult(msg) {
  if (!connectionsState || !msg?.connectionId) return;
  const conn = getConnectionById(msg.connectionId);
  if (!conn) return;
  if (msg.ok) {
    conn.status = 'live';
    conn.lastError = '';
    if (msg.routing && typeof msg.routing === 'object') {
      connectionsState.routing = { ...(connectionsState.routing || {}), ...msg.routing };
    }
  } else {
    conn.lastError = msg.error || 'Action failed';
  }
  await saveConnectionsState();
  renderConnections();
}


async function saveTaskToHistory(goal, result) {
  if (!goal) return;
  try {
    const { taskHistory = [] } = await chrome.storage.local.get('taskHistory');
    taskHistory.unshift({
      goal,
      success: !!result?.success,
      summary: result?.summary || result?.reason || '',
      steps: result?.steps || 0,
      timestamp: Date.now(),
    });
    if (taskHistory.length > MAX_HISTORY_ITEMS) taskHistory.length = MAX_HISTORY_ITEMS;
    await chrome.storage.local.set({ taskHistory });
  } catch { /* noop */ }
}

async function renderHistory() {
  try {
    const { taskHistory = [] } = await chrome.storage.local.get('taskHistory');
    historyList.innerHTML = '';
    historyEmpty.style.display = taskHistory.length === 0 ? 'block' : 'none';
    if (historyTelemetry) {
      historyTelemetry.style.display = 'none';
      historyTelemetry.innerHTML = '';
    }

    taskHistory.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'history-item ' + (item.success ? 'ok' : 'fail');
      el.dataset.index = String(index);

      const content = document.createElement('div');
      content.className = 'history-main';

      const goal = document.createElement('div');
      goal.className = 'history-goal';
      goal.textContent = item.goal || 'Task';
      content.appendChild(goal);

      const meta = document.createElement('div');
      meta.className = 'history-meta';
      const steps = Number(item.steps || 0);
      const stepsLabel = `${steps} ${steps === 1 ? 'step' : 'steps'}`;
      const whenLabel = formatAgoShort(item.timestamp);
      meta.textContent = `${stepsLabel}   ${whenLabel}`;
      content.appendChild(meta);

      const badge = document.createElement('span');
      badge.className = 'history-status ' + (item.success ? 'ok' : 'fail');
      badge.innerHTML = item.success ? icon('check') : icon('x');

      el.appendChild(content);
      el.appendChild(badge);

      el.addEventListener('click', () => {
        showHistoryDetails(item, el);
      });

      historyList.appendChild(el);
    });
  } catch { /* noop */ }
}

// ===== Utils =====

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function formatAgoShort(ts) {
  if (!ts) return 'now';
  const diff = Math.max(0, Date.now() - Number(ts));
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return `${hr}h ${remMin}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatHistoryTime(ts) {
  if (!ts) return 'Unknown time';
  const d = new Date(Number(ts));
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

function showHistoryDetails(item, activeEl) {
  if (!historyTelemetry) return;
  historyList.querySelectorAll('.history-item.active').forEach((node) => node.classList.remove('active'));
  activeEl?.classList.add('active');

  const steps = Number(item?.steps || 0);
  const statusText = item?.success ? 'Completed' : 'Failed';
  const summary = item?.summary || (item?.success ? 'Completed without summary.' : 'No failure reason recorded.');
  const when = formatHistoryTime(item?.timestamp);

  historyTelemetry.innerHTML = `
    <div class="history-detail-goal">${escapeHtml(item?.goal || 'Task')}</div>
    <div class="history-detail-meta">${steps} ${steps === 1 ? 'step' : 'steps'} · ${statusText} · ${when}</div>
    <div class="history-detail-summary">${escapeHtml(summary)}</div>
  `;
  historyTelemetry.style.display = 'block';
}

function renderMarkdown(text) {
  if (!text) return '';

  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let codeLines = [];
  let olItems = [];
  let olCurrentItem = [];

  const flushOl = () => {
    if (!inOl) return;
    if (olCurrentItem.length > 0) {
      olItems.push(olCurrentItem.join('<br>'));
      olCurrentItem = [];
    }
    out.push('<ol>');
    for (const item of olItems) out.push(`<li>${item}</li>`);
    out.push('</ol>');
    olItems = [];
    inOl = false;
  };

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    flushOl();
  };

  const flushCode = () => {
    if (!inCode) return;
    out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    inCode = false;
    codeLines = [];
  };

  const inline = (raw) => {
    let s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);
    return s;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) flushCode();
      else {
        closeLists();
        inCode = true;
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const h = line.match(/^\s*#{1,3}\s+(.*)$/);
    if (h) {
      closeLists();
      out.push(`<p><strong>${inline(h[1])}</strong></p>`);
      continue;
    }

    const ol = line.match(/^\s*(?:\*\*|__)?\s*\d+[\.\)]\s+(.*?)(?:\*\*|__)?\s*$/);
    if (ol) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) {
        inOl = true;
        olItems = [];
        olCurrentItem = [];
      }
      if (olCurrentItem.length > 0) {
        olItems.push(olCurrentItem.join('<br>'));
      }
      olCurrentItem = [inline(ol[1])];
      continue;
    }

    const ul = line.match(/^\s*(?:[-*]|•)\s+(.*)$/);
    if (ul) {
      if (inOl) flushOl();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    if (inOl) {
      if (line.trim() === '') {
        // Keep numbered list continuous even with blank separators.
        continue;
      }
      // Treat plain lines after "1. ..." as continuation of the same list item.
      olCurrentItem.push(inline(line.trim()));
      continue;
    }

    if (line.trim() === '') {
      closeLists();
      out.push('<br>');
      continue;
    }

    closeLists();
    out.push(`<p>${inline(line)}</p>`);
  }

  flushCode();
  closeLists();
  return out.join('');
}
