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
const contextBudgetBadge = document.getElementById('contextBudgetBadge');
const btnSettings = document.getElementById('btnSettings');
const btnBack = document.getElementById('btnBack');
const btnHistory = document.getElementById('btnHistory');
const btnHistoryBack = document.getElementById('btnHistoryBack');
const btnHelp = document.getElementById('btnHelp');
const btnHelpBack = document.getElementById('btnHelpBack');
const btnSchedule = document.getElementById('btnSchedule');
const btnScheduleBack = document.getElementById('btnScheduleBack');
const chatView = document.getElementById('chatView');
const settingsView = document.getElementById('settingsView');
const historyView = document.getElementById('historyView');
const helpView = document.getElementById('helpView');
const scheduleView = document.getElementById('scheduleView');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const historyTelemetry = document.getElementById('historyTelemetry');
const btnClearTelemetry = document.getElementById('btnClearTelemetry');
const tierGroups = document.getElementById('tierGroups');
const modeBadge = document.getElementById('modeBadge');
const btnPlanMode = document.getElementById('btnPlanMode');
const btnNotionSave = document.getElementById('btnNotionSave');
const btnSaveShortcut = document.getElementById('btnSaveShortcut');
const shortcutsDropdown = document.getElementById('shortcutsDropdown');
const planBanner = document.getElementById('planBanner');
const phaseStatus = document.getElementById('phaseStatus');

// ===== State =====
let port = null;
let isRunning = false;
let isPaused = false;
let config = null;
let providerInfo = null;
let providerStatus = null;
let currentGoal = '';
let planMode = false;
let shortcuts = [];
let scheduledTasks = [];
let currentPhaseSnapshot = null;
let contextBudgetState = null;

const WARN_THROTTLE_MS = 10000;
const warnTimestamps = new Map();
const MAX_TELEMETRY_ITEMS = 30;

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
      console.warn('[SP] telemetry.append failed:', err?.message || err);
    });
}

function debugWarn(context, err) {
  const key = String(context || 'unknown');
  const now = Date.now();
  const last = warnTimestamps.get(key) || 0;
  if (now - last < WARN_THROTTLE_MS) return;
  warnTimestamps.set(key, now);
  const message = err?.message || String(err || 'unknown error');
  console.warn(`[SP] ${key}: ${message}`);
  appendTelemetry('SP', key, message);
}

/** Safe wrapper for port.postMessage — handles disconnected port gracefully. */
function sendMsg(msg) {
  try { if (port) port.postMessage(msg); }
  catch (e) { console.warn('[SP] Port send failed:', e.message); }
}

/** Calculate cost from metrics using provider pricing rates. */
function calcCost(m) {
  if (!m || !m.tokens || !providerInfo) return 0;
  const pid = m.providerId || config?.primary;
  const info = providerInfo[pid];
  if (!info || !info.costPerMTokenIn) return 0;
  const inCost = (m.tokens.prompt / 1_000_000) * info.costPerMTokenIn;
  const outCost = (m.tokens.completion / 1_000_000) * info.costPerMTokenOut;
  return inCost + outCost;
}
let siteBlocklist = [];

const MAX_HISTORY_ITEMS = 30;

// ===== Shortcuts =====

async function loadShortcuts() {
  try {
    const { shortcuts: stored = [] } = await chrome.storage.local.get('shortcuts');
    shortcuts = stored;
  } catch (err) {
    debugWarn('shortcuts.load', err);
  }
}

async function saveShortcuts() {
  try {
    await chrome.storage.local.set({ shortcuts });
  } catch (err) {
    debugWarn('shortcuts.save', err);
  }
}

function renderShortcutsDropdown(filter) {
  if (!shortcutsDropdown || !goalInput) return;
  const q = (filter === '/' ? '' : filter.slice(1)).toLowerCase();
  const items = shortcuts.filter(s => !q || s.name.toLowerCase().includes(q) || s.text.toLowerCase().includes(q));
  if (items.length === 0) {
    shortcutsDropdown.style.display = 'none';
    return;
  }
  shortcutsDropdown.innerHTML = items.map((s, i) =>
    `<div class="shortcut-item" data-index="${i}">
      <span class="i i-bookmark" style="font-size:12px;opacity:0.6;"></span>
      <span class="shortcut-text" title="${escapeAttr(s.text)}"><strong>/${escapeHtml(s.name)}</strong> — ${escapeHtml(s.text.slice(0, 60))}${s.text.length > 60 ? '…' : ''}</span>
      <button class="shortcut-del" data-idx="${i}" title="Delete">✕</button>
    </div>`
  ).join('');
  shortcutsDropdown.style.display = 'block';

  shortcutsDropdown.querySelectorAll('.shortcut-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('shortcut-del')) {
        const idx = parseInt(e.target.dataset.idx);
        shortcuts.splice(idx, 1);
        saveShortcuts();
        shortcutsDropdown.style.display = 'none';
        goalInput.value = '';
        adjustGoalInputHeight();
        return;
      }
      const idx = parseInt(el.dataset.index);
      goalInput.value = shortcuts[idx].text;
      adjustGoalInputHeight();
      shortcutsDropdown.style.display = 'none';
      goalInput.focus();
    });
  });
}

btnSaveShortcut?.addEventListener('click', async () => {
  const text = goalInput.value.trim();
  if (!text) return;
  const name = prompt('Shortcut name (used as /name):');
  if (!name || !name.trim()) return;
  shortcuts.push({ name: name.trim(), text });
  await saveShortcuts();
  btnSaveShortcut.style.color = 'var(--accent)';
  setTimeout(() => { btnSaveShortcut.style.color = ''; }, 1000);
});

// ===== Plan Mode =====

btnPlanMode?.addEventListener('click', () => {
  planMode = !planMode;
  btnPlanMode.classList.toggle('active', planMode);
  btnPlanMode.title = planMode ? 'Plan mode ON — click to disable' : 'Ask before acting (plan mode)';
});

// ===== Save to Notion =====

btnNotionSave?.addEventListener('click', () => {
  const TEMPLATE =
    'Read this page and save a summary to Notion. ' +
    'Use http_request POST https://api.notion.com/v1/pages with headers ' +
    '{"Authorization": "Bearer NOTION_TOKEN", "Notion-Version": "2022-06-28"} ' +
    'and body {"parent": {"database_id": "DATABASE_ID"}, ' +
    '"properties": {"title": [{"text": {"content": "<page title>"}}]}, ' +
    '"children": [{"object": "block", "type": "paragraph", ' +
    '"paragraph": {"rich_text": [{"text": {"content": "<summary>"}}]}}]}';
  goalInput.value = TEMPLATE;
  goalInput.focus();
  goalInput.select();
  adjustGoalInputHeight();
  btnNotionSave.style.color = 'var(--accent)';
  setTimeout(() => { btnNotionSave.style.color = ''; }, 1000);
});

function showPlanBanner(planText) {
  if (!planBanner) return;
  planBanner.innerHTML = `
    <div class="plan-header">${icon('list-checks')} Planned steps</div>
    <div class="plan-text">${escapeHtml(planText)}</div>
    <div class="plan-actions">
      <button class="btn-approve" id="btnApprovePlan">▶ Execute</button>
      <button class="btn-cancel" id="btnCancelPlan">✕ Cancel</button>
    </div>`;
  planBanner.style.display = 'block';

  document.getElementById('btnApprovePlan').addEventListener('click', () => {
    planBanner.style.display = 'none';
    sendMsg({ type: 'approvePlan' });
  });
  document.getElementById('btnCancelPlan').addEventListener('click', () => {
    planBanner.style.display = 'none';
    sendMsg({ type: 'stopTask' });
  });
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
        if (planBanner) planBanner.style.display = 'none';
        resetPhaseStatus();
        showResult(msg.result);
        saveTaskToHistory(currentGoal, msg.result);
        break;
      case 'plan':
        showPlanBanner(msg.plan);
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
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[SP] Disconnected, reconnecting...');
    setTimeout(connect, 1000);
  });

  // Load config
  sendMsg({ type: 'getConfig' });
  loadShortcuts();
  loadContextualSuggestions();
}

connect();

// ===== Contextual Suggestions =====

const SUGGESTION_MAP = [
  { patterns: ['github.com/issues', 'github.com/pulls'], suggestions: ['Assign all unassigned issues to me', 'Close all issues labeled "wontfix"', 'List issues opened this week', 'Find all issues with no comments'] },
  { patterns: ['github.com'], suggestions: ['Count stars and forks and tell me', 'Find the most active contributor', 'List all open PRs waiting for review', 'Find TODO comments in the source code', 'Check if there is a CHANGELOG'] },
  { patterns: ['google.com/search', 'bing.com/search', 'duckduckgo.com'], suggestions: ['Open every result in a new tab', 'Copy all URLs from the results', 'Find the newest result and open it', 'Summarize top 5 results in one paragraph'] },
  { patterns: ['youtube.com/watch'], suggestions: ['Get the full transcript of this video', 'Find the top 5 most liked comments', 'List all chapters with timestamps', 'Check how many views and likes', 'Find the channel and subscribe'] },
  { patterns: ['youtube.com'], suggestions: ['Find the most viewed video on this channel', 'Get the latest upload', 'Search for tutorials on this channel'] },
  { patterns: ['twitter.com', 'x.com'], suggestions: ['Collect all links posted in this thread', 'Find the most liked reply', 'Summarize this thread in 3 sentences', 'Find who retweeted the most', 'Save all image URLs from this page'] },
  { patterns: ['linkedin.com/in/'], suggestions: ['Extract name, title, company and email', 'Find their recent posts', 'Check mutual connections', 'Save profile summary to clipboard'] },
  { patterns: ['linkedin.com'], suggestions: ['Find remote jobs posted today', 'Collect all job titles and companies', 'Apply to the first matching job'] },
  { patterns: ['reddit.com/r/'], suggestions: ['Find the most controversial post today', 'Collect all external links in this thread', 'Summarize top 3 comments', 'Find posts with most awards', 'List all moderators'] },
  { patterns: ['amazon.com'], suggestions: ['Find the cheapest variant of this item', 'Extract all 1-star reviews', 'Check if this item is sold by Amazon directly', 'Find similar items under $50', 'Add to cart and go to checkout'] },
  { patterns: ['ebay.com'], suggestions: ['Find the same item cheaper', 'Sort by price low to high', 'Check seller feedback score'] },
  { patterns: ['wikipedia.org'], suggestions: ['Give me the TL;DR of this article', 'List all people mentioned', 'Find all citations and external links', 'Extract all dates and events into a timeline'] },
  { patterns: ['docs.google.com/spreadsheet'], suggestions: ['Summarize what this spreadsheet contains', 'Find all empty cells in column A', 'Tell me the total in the last row'] },
  { patterns: ['docs.google.com', 'drive.google.com'], suggestions: ['Summarize this document in bullet points', 'Extract all action items', 'Find all headings and make a table of contents', 'Count how many times a word appears'] },
  { patterns: ['notion.so'], suggestions: ['Extract all unchecked tasks', 'Find all linked databases', 'Summarize this page in 5 bullet points', 'List all pages linked here'] },
  { patterns: ['stackoverflow.com'], suggestions: ['Extract all code snippets from answers', 'Find the accepted answer and explain it', 'List alternative solutions from comments', 'Find related questions'] },
  { patterns: ['news.ycombinator.com'], suggestions: ['Open the top story', 'Collect all links on the front page', 'Find posts about AI today', 'List all Ask HN posts'] },
  { patterns: ['producthunt.com'], suggestions: ['Find top products launched today', 'Collect all product names and URLs', 'Find products with most upvotes'] },
  { patterns: ['gmail.com', 'mail.google.com'], suggestions: ['Find all unread emails from today', 'List emails with attachments', 'Find the latest email from my boss', 'Search for emails about invoices'] },
  { patterns: ['calendar.google.com'], suggestions: ['List all events for today', 'Find my next meeting', 'Create an event tomorrow at 10am'] },
  { patterns: ['figma.com'], suggestions: ['List all frames on this page', 'Find all components', 'Check who last edited this file'] },
  { patterns: ['trello.com'], suggestions: ['List all cards in "In Progress"', 'Find overdue cards', 'Move all done cards to archive'] },
  { patterns: ['jira'], suggestions: ['Find all tickets assigned to me', 'List bugs with high priority', 'Find tickets with no assignee'] },
];

const DEFAULT_SUGGESTIONS = [
  'Summarize this page in 5 bullets',
  'Find all emails and phone numbers',
  'Extract every price on the page',
  'Click the first button you find',
  'Take a screenshot',
  'Get page title and meta description',
  'Find and fill the search box',
  'List all links on this page',
];

async function loadContextualSuggestions() {
  if (isRunning) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
      renderSuggestions(DEFAULT_SUGGESTIONS, null);
      return;
    }

    const tabUrl = tab.url.toLowerCase();
    let suggestions = DEFAULT_SUGGESTIONS;
    for (const { patterns, suggestions: s } of SUGGESTION_MAP) {
      if (patterns.some(p => tabUrl.includes(p))) {
        suggestions = s;
        break;
      }
    }
    renderSuggestions(suggestions, tab.title);
  } catch (err) {
    debugWarn('suggestions.loadContextual', err);
  }
}

function renderSuggestions(suggestions, tabTitle) {
  const el = document.getElementById('emptyState');
  if (!el) return;
  const titleHtml = tabTitle ? `<p style="font-weight:600;color:var(--text);margin-bottom:6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(tabTitle)}</p>` : '';
  const chipsHtml = suggestions.map(s =>
    `<button class="suggestion-chip" data-text="${escapeAttr(s)}">${escapeHtml(s)}</button>`
  ).join('');
  el.innerHTML = `
    <img src="../../icons/icon48.png" alt="Browser Agent" width="40" height="40" style="opacity:0.85">
    ${titleHtml}
    <p>I'll click, type and navigate for you.</p>
    <div class="suggestion-chips">${chipsHtml}</div>
  `;
  el.querySelectorAll('.suggestion-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      goalInput.value = btn.dataset.text;
      adjustGoalInputHeight();
      goalInput.focus();
    });
  });
}

// ===== Task Execution =====

function adjustGoalInputHeight() {
  if (!goalInput.value) {
    goalInput.style.height = '38px';
    goalInput.style.overflowY = 'hidden';
    return;
  }
  goalInput.style.height = '0';
  const next = Math.min(goalInput.scrollHeight, 120);
  goalInput.style.height = `${Math.max(38, next)}px`;
  goalInput.style.overflowY = goalInput.scrollHeight > 120 ? 'auto' : 'hidden';
}

sendBtn.addEventListener('click', () => {
  if (isPaused) {
    sendMsg({ type: 'resumeTask' });
    return;
  }

  if (isRunning) {
    sendMsg({ type: 'stopTask' });
    return;
  }

  const goal = goalInput.value.trim();
  if (!goal) return;

  currentGoal = goal;

  // Clear previous steps and restore from collapsed state
  stepsContainer.innerHTML = '';
  stepsContainer.classList.remove('finished');
  emptyState.style.display = 'none';
  resetPhaseStatus();
  resultBanner.style.display = 'none';
  resultBanner.className = 'result-banner';
  resultBanner.textContent = '';

  // Add user goal
  const goalEl = document.createElement('div');
  goalEl.className = 'step thought';
  const goalHeader = document.createElement('div');
  goalHeader.className = 'step-header';
  goalHeader.innerHTML = `${icon('target')} Goal`;
  goalEl.appendChild(goalHeader);
  goalEl.appendChild(document.createTextNode(goal));
  stepsContainer.appendChild(goalEl);

  sendMsg({ type: 'startTask', goal, planMode });
  goalInput.value = '';
  adjustGoalInputHeight();
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
  const val = goalInput.value;
  if (val.startsWith('/')) {
    renderShortcutsDropdown(val);
  } else {
    shortcutsDropdown.style.display = 'none';
  }
});
adjustGoalInputHeight();

// Close dropdown on Escape
goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { shortcutsDropdown.style.display = 'none'; }
});

// ===== Rendering =====

function renderStep(step) {
  if (step?.type === 'phaseStatus') {
    updatePhaseStatus(step);
    return;
  }
  if (step?.type === 'contextBudget') {
    updateContextBudgetBadge(step);
    return;
  }

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

function showResult(result) {
  // 1. Wrap existing steps into a collapsible <details>
  const stepElements = Array.from(stepsContainer.children);
  if (stepElements.length > 0) {
    const details = document.createElement('details');
    details.className = 'log-collapse';

    const summary = document.createElement('summary');
    summary.textContent = `${result.steps || stepElements.length} steps — click to expand log`;
    details.appendChild(summary);

    const wrapper = document.createElement('div');
    wrapper.className = 'collapsed-steps';
    stepElements.forEach(el => wrapper.appendChild(el));
    details.appendChild(wrapper);

    stepsContainer.innerHTML = '';
    stepsContainer.appendChild(details);
    stepsContainer.classList.add('finished');
  }

  // 2. Show expanded result banner (duplicates done info outside the collapsible log)
  resultBanner.style.display = '';
  const m = result.metrics;
  const metaItems = [];
  metaItems.push(`${result.steps} steps`);
  if (m) {
    const secs = Math.round((m.durationMs || 0) / 1000);
    if (secs > 0) metaItems.push(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`);
    if (m.tokens && m.tokens.total > 0) {
      const tk = m.tokens.total;
      metaItems.push(tk >= 1000 ? `${(tk / 1000).toFixed(1)}k tok` : `${tk} tok`);
    }
    const cost = calcCost(m);
    if (cost > 0) metaItems.push(`$${cost.toFixed(4)}`);
    if (m.errors > 0) metaItems.push(`${m.errors} err`);
    if (m.duplicateToolCalls > 0) metaItems.push(`${m.duplicateToolCalls} dup`);
  }
  const metaStr = metaItems.join(' \u00b7 ');
  if (result.success) {
    resultBanner.className = 'result-banner success expanded';
    const answerText = result.answer || result.summary || '';
    let html = `<div class="result-header">${icon('check-circle')} Done (${metaStr}): ${escapeHtml(result.summary)}</div>`;
    if (answerText && answerText !== result.summary) {
      html += `<div class="result-answer">${renderMarkdown(answerText)}</div>`;
    }
    resultBanner.innerHTML = html;
  } else {
    resultBanner.className = 'result-banner failure expanded';
    resultBanner.innerHTML = `<div class="result-header">${icon('x-circle')} Failed (${metaStr}): ${escapeHtml(result.reason || 'Unknown error')}</div>`;
  }
}

function updateStatus(status) {
  isRunning = status === 'running';
  isPaused = status === 'paused_waiting_user';

  // Hide plan approval banner whenever we're not actively waiting for approval
  // (guards against stale banner after reconnect replay)
  if (!isPaused) {
    planBanner.style.display = 'none';
  }

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
  if (!isPaused && resultBanner.classList.contains('warning')) {
    resultBanner.style.display = 'none';
    resultBanner.className = 'result-banner';
    resultBanner.textContent = '';
  }
  if (!isRunning && !isPaused) {
    resetPhaseStatus();
    clearContextBudgetBadge();
  }
  updateModeBadge();
}

function updateContextBudgetBadge(step) {
  if (!contextBudgetBadge || !step) return;

  const level = step.level === 'critical' ? 'critical' : 'warning';
  const pct = Number.isFinite(Number(step.percent)) ? Number(step.percent) : Math.round((Number(step.ratio) || 0) * 100);
  const phase = String(step.phase || '');

  contextBudgetState = {
    level,
    percent: Math.max(0, Math.min(100, pct)),
    phase,
  };

  contextBudgetBadge.className = `context-badge ${level}`;
  contextBudgetBadge.textContent = `${contextBudgetState.percent}% ctx`;
  contextBudgetBadge.title = level === 'critical'
    ? (phase === 'autocompact'
      ? `Context usage ${contextBudgetState.percent}%. Automatic compaction applied.`
      : `Context usage ${contextBudgetState.percent}%. High pressure.`)
    : `Context usage ${contextBudgetState.percent}%. Approaching budget limit.`;
  contextBudgetBadge.style.display = 'inline-flex';
}

function clearContextBudgetBadge() {
  contextBudgetState = null;
  if (!contextBudgetBadge) return;
  contextBudgetBadge.className = 'context-badge';
  contextBudgetBadge.textContent = '';
  contextBudgetBadge.title = '';
  contextBudgetBadge.style.display = 'none';
}

function updatePhaseStatus(step) {
  if (!phaseStatus) return;
  currentPhaseSnapshot = step || null;
  if (!currentPhaseSnapshot) {
    resetPhaseStatus();
    return;
  }

  const phaseIndex = Number(currentPhaseSnapshot.phaseIndex || 0);
  const phaseTotal = Number(currentPhaseSnapshot.phaseTotal || 0);
  const evidenceScore = Number(currentPhaseSnapshot.evidenceScore || 0);
  const evidenceRequired = Number(currentPhaseSnapshot.evidenceRequired || 0);
  const observationCount = Number(currentPhaseSnapshot.observationCount || 0);
  const observationsRequired = Number(currentPhaseSnapshot.observationsRequired || 0);
  const revision = Number(currentPhaseSnapshot.planRevision || 1);
  const phaseName = currentPhaseSnapshot.phaseName || '—';
  const phaseObjective = currentPhaseSnapshot.phaseObjective || '';
  const completionSignal = currentPhaseSnapshot.completionSignal || '';
  const replanReason = currentPhaseSnapshot.lastReplanReason || '';
  const replanStep = Number(currentPhaseSnapshot.lastReplanStep || 0);

  const replanText = replanReason
    ? `Last replan: step ${replanStep || '—'} · ${replanReason}`
    : 'Last replan: none';

  const evidenceReady = evidenceScore >= evidenceRequired;
  const observationsReady = observationCount >= observationsRequired;
  const phaseReady = evidenceReady && observationsReady;
  const phaseStateText = phaseReady ? 'ready' : 'in progress';

  phaseStatus.innerHTML = `
    <div class="phase-header">
      ${icon('layers')} Current phase
      <span class="phase-state ${phaseReady ? 'ready' : ''}">${escapeHtml(phaseStateText)}</span>
    </div>
    <div class="phase-title">${escapeHtml(`Phase ${phaseIndex}/${phaseTotal}: ${phaseName}`)}</div>
    <div style="color:var(--text2);font-size:11px;">${escapeHtml(phaseObjective)}</div>
    <div style="color:var(--text2);font-size:11px;margin-top:4px;">Signal: ${escapeHtml(completionSignal || 'verified observation')}</div>
    <div class="phase-meta">
      <span class="phase-chip ${evidenceReady ? 'ready' : 'pending'}">Evidence ${evidenceScore}/${evidenceRequired}</span>
      <span class="phase-chip ${observationsReady ? 'ready' : 'pending'}">Observations ${observationCount}/${observationsRequired}</span>
      <span class="phase-chip">Plan rev ${revision}</span>
    </div>
    <div class="phase-replan">${escapeHtml(replanText)}</div>
  `;
  phaseStatus.style.display = 'block';
}

function resetPhaseStatus() {
  currentPhaseSnapshot = null;
  if (!phaseStatus) return;
  phaseStatus.style.display = 'none';
  phaseStatus.innerHTML = '';
}

function showManualIntervention(details = {}) {
  const message = details.message || 'Manual intervention required.';

  // Special UI for per-domain JS permission
  if (details.type === 'jsDomainPermission') {
    resultBanner.style.display = '';
    resultBanner.className = 'result-banner warning';
    resultBanner.innerHTML = `
      <div class="result-header">${icon('bolt')} JS Permission Required</div>
      <div style="margin-top:6px;color:var(--text);font-weight:400;">${escapeHtml(message)}</div>
      <div class="manual-actions">
        <button id="jsDomainAllowBtn">Allow JS on ${escapeHtml(details.domain || 'this domain')}</button>
        <button id="jsDomainDenyBtn">Deny</button>
      </div>
    `;
    document.getElementById('jsDomainAllowBtn')?.addEventListener('click', () => {
      resultBanner.style.display = 'none';
      sendMsg({ type: 'jsDomainAllow', domain: details.domain });
    });
    document.getElementById('jsDomainDenyBtn')?.addEventListener('click', () => {
      resultBanner.style.display = 'none';
      sendMsg({ type: 'jsDomainDeny' });
    });
    return;
  }

  resultBanner.style.display = '';
  resultBanner.className = 'result-banner warning';
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
  document.getElementById('manualResumeBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'resumeTask' });
  });
  document.getElementById('manualStopBtn')?.addEventListener('click', () => {
    sendMsg({ type: 'stopTask' });
  });
}

function summarizeArgs(tool, args) {
  switch (tool) {
    case 'computer': {
      const a = args.action;
      if (a === 'click') return `${args.button === 'right' ? 'right-click' : 'click'} [${args.target}]`;
      if (a === 'type') return `"${args.text?.slice(0, 30)}" → [${args.target}]`;
      if (a === 'scroll') return `${args.direction} ${args.amount || 500}px`;
      if (a === 'hover') return `element [${args.target}]`;
      if (a === 'select') return `"${args.value}" in [${args.target}]`;
      if (a === 'key') return `${(args.modifiers || []).join('+')}${args.modifiers?.length ? '+' : ''}${args.key}`;
      if (a === 'drag') return `(${args.fromX}, ${args.fromY}) → (${args.toX}, ${args.toY})`;
      if (a === 'form_input') return `[${args.target}] = ${args.value ?? args.checked}`;
      return a || '';
    }
    case 'navigate': return args.url?.slice(0, 50);
    case 'back': return 'history back';
    case 'forward': return 'history forward';
    case 'reload': return 'reload tab';
    case 'find': return `"${args.query}"`;
    case 'find_text': return `"${args.query}"`;
    case 'find_text_next': return args.wrap === false ? 'next (no wrap)' : 'next';
    case 'find_text_prev': return args.wrap === false ? 'prev (no wrap)' : 'prev';
    case 'wait_for': return `${args.condition}`;
    case 'switch_frame': return args.main ? 'main frame' : `${args.target ?? args.index}`;
    case 'upload_file': return `${(args.files || []).length} file(s) → [${args.target}]`;
    case 'list_tabs': return 'current window';
    case 'switch_tab': return args.tabId ? `tab ${args.tabId}` : `index ${args.index}`;
    case 'open_tab': return args.url?.slice(0, 50);
    case 'close_tab': return args.tabId ? `tab ${args.tabId}` : 'current tab';
    case 'get_network_requests': return `since=${args.since || 0}`;
    case 'get_console_logs': return `since=${args.since || 0} level=${args.level || 'error'}`;
    case 'resize_window': return `${args.width}×${args.height}`;
    case 'http_request': return `${args.method || 'GET'} ${args.url?.slice(0, 60)}`;
    case 'javascript': return args.code?.slice(0, 40) + '...';
    case 'done': return args.summary?.slice(0, 50);
    case 'fail': return args.reason?.slice(0, 50);
    default: return '';
  }
}

// ===== Settings =====

btnSettings?.addEventListener('click', () => {
  chatView.classList.remove('active');
  historyView.classList.remove('active');
  helpView.classList.remove('active');
  scheduleView.classList.remove('active');
  settingsView.classList.add('active');
  sendMsg({ type: 'getConfig' });
  sendMsg({ type: 'getBlocklist' });
});

btnBack?.addEventListener('click', () => {
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  helpView.classList.remove('active');
  scheduleView.classList.remove('active');
  chatView.classList.add('active');
});

btnHelp?.addEventListener('click', () => {
  chatView.classList.remove('active');
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  scheduleView.classList.remove('active');
  helpView.classList.add('active');
});

btnHelpBack?.addEventListener('click', () => {
  helpView.classList.remove('active');
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  scheduleView.classList.remove('active');
  chatView.classList.add('active');
});

btnSchedule?.addEventListener('click', () => {
  chatView.classList.remove('active');
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  helpView.classList.remove('active');
  scheduleView.classList.add('active');
  sendMsg({ type: 'getScheduledTasks' });
});

btnScheduleBack?.addEventListener('click', () => {
  scheduleView.classList.remove('active');
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  helpView.classList.remove('active');
  chatView.classList.add('active');
});

function renderSettings() {
  if (!config || !providerInfo) return;

  const tiers = {
    recommended: { icon: icon('star', 'i-lg'), title: 'POWERFUL', desc: 'Most capable.', providers: [] },
    budget: { icon: icon('bolt', 'i-lg'), title: 'TURBO', desc: 'Fastest inference.', providers: [] },
    free: { icon: icon('ollama', 'i-lg'), title: 'FREE', desc: 'No-cost options.', providers: [] },
  };

  for (const [name, info] of Object.entries(providerInfo)) {
    const tier = info.tier || 'budget';
    if (tiers[tier]) tiers[tier].providers.push({ name, info });
  }

  const activeTier = providerInfo[config.primary]?.tier || 'budget';
  tierGroups.innerHTML = '';

  for (const [tierKey, tier] of Object.entries(tiers)) {
    if (tier.providers.length === 0) continue;
    const isActive = tierKey === activeTier;
    const group = document.createElement('details');
    group.className = 'tier-group' + (isActive ? ' active' : '');
    if (isActive) group.open = true;
    const providerDisplayNames = {
      fireworks: 'Fireworks',
      generalapi: 'General API Endpoint',
      groq: 'Groq',
      ollama: 'Ollama',
    };

    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="tier-arrow"></span><div class="tier-header">
      <h3>${tier.icon} ${escapeHtml(tier.title)}</h3>
      <span class="tier-desc">${escapeHtml(tier.desc)}</span>
    </div>`;
    group.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'tier-body';

    for (const { name, info } of tier.providers) {
      const status = providerStatus?.[name];
      const provConf = config.providers?.[name] || {};
      const card = document.createElement('div');
      card.className = 'provider-card' + (config.primary === name ? ' active' : '');
      const providerKeyLabel = providerDisplayNames[name] || info?.label || name;

      const statusClass = status?.available ? 'ok' : status?.configured ? 'fail' : 'unknown';
      const statusLabel = status?.available ? 'Connected' : status?.configured ? 'Error' : 'Not configured';

      card.innerHTML = `
        <div class="card-header">
          <h3><span class="status-dot ${statusClass}"></span>${escapeHtml(info.label || '')}</h3>
          <span class="pricing">${escapeHtml(info.pricing || '')}</span>
        </div>
        <div class="note">${escapeHtml(info.note || '')}</div>
        ${name !== 'ollama' ? `
          <label style="display:flex;justify-content:space-between;align-items:center;">${escapeHtml(providerKeyLabel)} API Key <a href="${escapeAttr(info.signupUrl || '#')}" target="_blank" style="font-size:10px;color:var(--accent);text-decoration:none;">Get key ↗</a></label>
          <input type="password" id="key_${name}" value="${escapeAttr(provConf.apiKey || '')}" placeholder="Enter API key">
        ` : ''}
        <label>Model</label>
        <input type="text" id="model_${name}" value="${escapeAttr(provConf.model || '')}" placeholder="Model name">
        ${(name === 'ollama' || name === 'generalapi') ? `
          <label>Base URL</label>
          <input type="text" id="url_${name}" value="${escapeAttr(provConf.baseUrl || (name === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.z.ai/api/paas/v4'))}" placeholder="${name === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.z.ai/api/paas/v4'}">
        ` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <button class="test-btn" data-provider="${name}">Test</button>
          <span class="test-status" id="testStatus_${name}" style="font-size:11px;color:var(--text2);">${escapeHtml(statusLabel)}</span>
        </div>
        <button class="tier-activate-btn provider-select-btn" data-select-provider="${name}" style="margin-top:8px;">
          ${config.primary === name ? icon('check') + ' Active' : 'Use ' + escapeHtml(info.label || name)}
        </button>
      `;

      body.appendChild(card);

      // Bind events (deferred to allow DOM insertion)
      setTimeout(() => {
        card.querySelectorAll('input').forEach(input => {
          input.addEventListener('change', () => saveProviderConfig(name));
        });
        card.querySelector('.test-btn')?.addEventListener('click', () => {
          const providerConfig = collectProviderConfig(name);
          config.providers = { ...config.providers, [name]: providerConfig };
          const el = document.getElementById(`testStatus_${name}`);
          if (el) el.textContent = 'Testing...';
          sendMsg({ type: 'testProvider', providerName: name, providerConfig });
        });
        const selectBtn = card.querySelector('.provider-select-btn');
        if (selectBtn && config.primary !== name) {
          selectBtn.addEventListener('click', () => {
            config.primary = name;
            sendMsg({ type: 'updateConfig', config: { primary: name } });
            renderSettings();
            updateModeBadge();
          });
        }
      }, 0);
    }

    group.appendChild(body);
    tierGroups.appendChild(group);
  }

  updateModeBadge();
}

function updateModeBadge() {
  if (!modeBadge || !config || !providerInfo) return;
  const info = providerInfo[config.primary];
  if (!info) { modeBadge.textContent = ''; return; }
  if (info.vision) {
    modeBadge.textContent = 'Vision';
    modeBadge.style.background = 'rgba(0, 184, 148, 0.15)';
    modeBadge.style.color = 'var(--success)';
  } else {
    modeBadge.textContent = 'Text';
    modeBadge.style.background = 'rgba(139, 143, 163, 0.15)';
    modeBadge.style.color = 'var(--text2)';
  }
}

function saveProviderConfig(name) {
  const providers = { ...config.providers };
  providers[name] = collectProviderConfig(name);

  config.providers = providers;
  sendMsg({ type: 'updateConfig', config: { providers } });
}

function collectProviderConfig(name) {
  const keyEl = document.getElementById(`key_${name}`);
  const modelEl = document.getElementById(`model_${name}`);
  const urlEl = document.getElementById(`url_${name}`);
  return {
    ...(config.providers?.[name] || {}),
    ...(keyEl && { apiKey: keyEl.value }),
    ...(modelEl && { model: modelEl.value }),
    ...(urlEl && { baseUrl: urlEl.value }),
  };
}

function showTestResult(msg) {
  const el = document.getElementById(`testStatus_${msg.provider}`);
  if (!el) return;
  providerStatus = providerStatus || {};
  providerStatus[msg.provider] = {
    ...(providerStatus[msg.provider] || {}),
    configured: msg.provider === 'ollama'
      ? true
      : !!config?.providers?.[msg.provider]?.apiKey,
    available: !!msg.available,
    model: config?.providers?.[msg.provider]?.model || providerStatus[msg.provider]?.model || '',
    isPrimary: config?.primary === msg.provider,
  };
  if (msg.available) {
    el.innerHTML = `${icon('check-circle')} Connected`;
    el.style.color = 'var(--success)';
  } else {
    el.innerHTML = `${icon('x-circle')} ` + escapeHtml(msg.error || 'Failed');
    el.style.color = 'var(--error)';
  }
}

// ===== Site Blocklist =====

function renderBlocklist() {
  const el = document.getElementById('blocklistSection');
  if (!el) return;
  const itemsHtml = siteBlocklist.length === 0
    ? `<div style="font-size:11px;color:var(--text2);text-align:center;padding:8px 0;">No blocked domains.</div>`
    : siteBlocklist.map((d, i) => `
        <div class="blocklist-item">
          <span>${escapeHtml(d)}</span>
          <button class="del-btn" data-idx="${i}" title="Remove">✕</button>
        </div>`
    ).join('');
  el.innerHTML = `
    <div class="settings-section">
      <div id="blocklistItems">${itemsHtml}</div>
      <div class="add-row">
        <input id="blocklistInput" type="text" placeholder="domain.com">
        <button id="blocklistAddBtn">Block</button>
      </div>
    </div>`;
  el.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      siteBlocklist.splice(idx, 1);
      sendMsg({ type: 'updateBlocklist', domains: siteBlocklist });
      renderBlocklist();
    });
  });
  document.getElementById('blocklistAddBtn')?.addEventListener('click', () => {
    const input = document.getElementById('blocklistInput');
    const val = (input?.value || '').trim().replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*/, '');
    if (!val || siteBlocklist.includes(val)) { input.value = ''; return; }
    siteBlocklist.push(val);
    sendMsg({ type: 'updateBlocklist', domains: siteBlocklist });
    input.value = '';
    renderBlocklist();
  });
}

// ===== Scheduled Tasks =====

function renderScheduledTasks() {
  const el = document.getElementById('scheduledTasksSection');
  if (!el) return;
  const periodLabel = (min) => {
    if (min < 60) return `every ${min} min`;
    if (min === 60) return 'hourly';
    if (min < 1440) return `every ${min / 60}h`;
    return 'daily';
  };
  const itemsHtml = scheduledTasks.length === 0
    ? `<div style="font-size:11px;color:var(--text2);text-align:center;padding:8px 0;">No scheduled tasks.</div>`
    : scheduledTasks.map(t => `
        <div class="schedule-item">
          <div>
            <strong>${escapeHtml(t.name)}</strong>
            <span class="schedule-meta">${periodLabel(t.periodMinutes)}</span>
            <div style="font-size:10px;color:var(--text2);margin-top:2px;">${escapeHtml(t.goal.slice(0, 60))}${t.goal.length > 60 ? '…' : ''}</div>
          </div>
          <button class="del-btn" data-id="${escapeAttr(t.id)}" title="Remove">✕</button>
        </div>`
    ).join('');
  el.innerHTML = `
    <div class="settings-section">
      <div>${itemsHtml}</div>
      <div class="add-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <input id="schedGoalInput" type="text" placeholder="Task goal (e.g. 'Check for new emails')" style="height:28px;box-sizing:border-box;font-size:12px;">
        <div style="display:flex;align-items:center;gap:6px;width:100%;">
          <input id="schedNameInput" type="text" placeholder="Name" style="flex:1;height:28px;box-sizing:border-box;">
          <select id="schedPeriodSelect" style="background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:0 6px;font-size:11px;font-family:inherit;outline:none;line-height:1;height:28px;box-sizing:border-box;width:90px;">
            <option value="30">Every 30 min</option>
            <option value="60" selected>Hourly</option>
            <option value="360">Every 6h</option>
            <option value="1440">Daily</option>
          </select>
          <button id="schedAddBtn" style="height:28px;box-sizing:border-box;">Add</button>
        </div>
      </div>
    </div>`;
  el.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sendMsg({ type: 'removeScheduledTask', id: btn.dataset.id });
    });
  });
  document.getElementById('schedAddBtn')?.addEventListener('click', () => {
    const goal = document.getElementById('schedGoalInput')?.value.trim();
    const name = document.getElementById('schedNameInput')?.value.trim() || goal?.slice(0, 30) || 'Task';
    const periodMinutes = parseInt(document.getElementById('schedPeriodSelect')?.value || '60');
    if (!goal) return;
    sendMsg({ type: 'addScheduledTask', name, goal, periodMinutes });
    document.getElementById('schedGoalInput').value = '';
    document.getElementById('schedNameInput').value = '';
  });
}

// ===== History =====

btnHistory?.addEventListener('click', () => {
  chatView.classList.remove('active');
  settingsView.classList.remove('active');
  helpView.classList.remove('active');
  scheduleView.classList.remove('active');
  historyView.classList.add('active');
  renderHistory();
});

btnHistoryBack?.addEventListener('click', () => {
  historyView.classList.remove('active');
  settingsView.classList.remove('active');
  helpView.classList.remove('active');
  scheduleView.classList.remove('active');
  chatView.classList.add('active');
});

btnClearTelemetry?.addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ diagnosticTelemetry: [] });
    await renderHistory();
  } catch (err) {
    debugWarn('history.clearTelemetry', err);
  }
});

async function saveTaskToHistory(goal, result) {
  if (!goal) return;
  try {
    const { taskHistory = [] } = await chrome.storage.local.get('taskHistory');
    const m = result?.metrics;
    const cost = m ? calcCost(m) : 0;
    taskHistory.unshift({
      goal,
      success: !!result?.success,
      summary: result?.summary || result?.reason || '',
      steps: result?.steps || 0,
      durationMs: m?.durationMs || 0,
      errors: m?.errors || 0,
      duplicateToolCalls: m?.duplicateToolCalls || 0,
      tokens: m?.tokens?.total || 0,
      cost,
      timestamp: Date.now(),
    });
    if (taskHistory.length > MAX_HISTORY_ITEMS) taskHistory.length = MAX_HISTORY_ITEMS;
    await chrome.storage.local.set({ taskHistory });
  } catch (err) {
    debugWarn('history.saveTask', err);
  }
}

async function renderHistory() {
  try {
    const { taskHistory = [], diagnosticTelemetry = [] } = await chrome.storage.local.get(['taskHistory', 'diagnosticTelemetry']);
    historyList.innerHTML = '';
    historyEmpty.style.display = taskHistory.length === 0 ? 'block' : 'none';
    if (historyTelemetry) {
      if (diagnosticTelemetry.length === 0) {
        historyTelemetry.style.display = 'none';
      } else {
        const latest = diagnosticTelemetry.slice(0, 3)
          .map(item => `${escapeHtml(item.source)}:${escapeHtml(item.context)} — ${escapeHtml(item.message)}`)
          .join('<br>');
        historyTelemetry.innerHTML = `<strong>Recent warnings</strong><br>${latest}`;
        historyTelemetry.style.display = 'block';
      }
    }

    for (const item of taskHistory) {
      const el = document.createElement('div');
      el.className = 'history-item';

      const goalSpan = document.createElement('span');
      goalSpan.className = 'goal-text';
      goalSpan.textContent = item.goal;
      el.appendChild(goalSpan);

      const badge = document.createElement('span');
      badge.className = 'result-badge ' + (item.success ? 'ok' : 'fail');
      const metaParts = [`${item.steps}`];
      if (item.durationMs > 0) {
        const secs = Math.round(item.durationMs / 1000);
        metaParts.push(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m`);
      }
      if (item.tokens > 0) {
        metaParts.push(item.tokens >= 1000 ? `${(item.tokens / 1000).toFixed(1)}k` : `${item.tokens}`);
      }
      if (item.cost > 0) metaParts.push(`$${item.cost.toFixed(4)}`);
      if (item.errors > 0) metaParts.push(`${item.errors}err`);
      badge.innerHTML = item.success
        ? `${icon('check')} ${metaParts.join('\u00b7')}`
        : `${icon('x')} ${metaParts.join('\u00b7')}`;
      el.appendChild(badge);

      el.addEventListener('click', () => {
        goalInput.value = item.goal;
        adjustGoalInputHeight();
        historyView.classList.remove('active');
        chatView.classList.add('active');
        goalInput.focus();
      });

      historyList.appendChild(el);
    }
  } catch (err) {
    debugWarn('history.render', err);
  }
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

function renderMarkdown(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  const out = [];
  let inOl = false, inUl = false;

  const closeList = () => {
    if (inOl) { out.push('</ol>'); inOl = false; }
    if (inUl) { out.push('</ul>'); inUl = false; }
  };

  const inlineFormat = (s) => {
    // escape first, then restore tags
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/__(\S[^_]*)__/g, '<strong>$1</strong>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    return s;
  };

  for (let line of lines) {
    const olMatch = line.match(/^\s*(\d+)\.\s+(.*)/);
    const ulMatch = line.match(/^\s*[-*]\s+(.*)/);
    const h1 = line.match(/^#\s+(.*)/);
    const h2 = line.match(/^##\s+(.*)/);
    const h3 = line.match(/^###\s+(.*)/);

    if (h3) {
      closeList();
      out.push(`<strong>${inlineFormat(h3[1])}</strong>`);
    } else if (h2) {
      closeList();
      out.push(`<strong>${inlineFormat(h2[1])}</strong>`);
    } else if (h1) {
      closeList();
      out.push(`<strong>${inlineFormat(h1[1])}</strong>`);
    } else if (olMatch) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${inlineFormat(olMatch[2])}</li>`);
    } else if (ulMatch) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
    } else if (line.trim() === '') {
      closeList();
      out.push('<br>');
    } else {
      closeList();
      out.push(`<p>${inlineFormat(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}
