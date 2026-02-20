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
const btnSettings = document.getElementById('btnSettings');
const btnHistory = document.getElementById('btnHistory');
const btnHelp = document.getElementById('btnHelp');
const chatView = document.getElementById('chatView');
const settingsView = document.getElementById('settingsView');
const historyView = document.getElementById('historyView');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const tierGroups = document.getElementById('tierGroups');
const modeBadge = document.getElementById('modeBadge');

// ===== State =====
let port = null;
let isRunning = false;
let isPaused = false;
let config = null;
let providerInfo = null;
let providerStatus = null;
let currentGoal = '';

const MAX_HISTORY_ITEMS = 30;

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
      case 'testResult':
        showTestResult(msg);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[SP] Disconnected, reconnecting...');
    setTimeout(connect, 1000);
  });

  // Load config
  port.postMessage({ type: 'getConfig' });
}

connect();

// ===== Task Execution =====

function adjustGoalInputHeight() {
  goalInput.style.height = 'auto';
  const next = Math.min(goalInput.scrollHeight, 120);
  goalInput.style.height = `${Math.max(40, next)}px`;
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
  const capHeader = document.getElementById('capabilitiesHeader');
  if (capHeader) capHeader.style.display = 'none';
  resultBanner.style.display = 'none';
  resultBanner.className = 'result-banner';
  resultBanner.textContent = '';

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
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// Auto-resize textarea
goalInput.addEventListener('input', adjustGoalInputHeight);
adjustGoalInputHeight();

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
  if (result.success) {
    resultBanner.className = 'result-banner success expanded';
    const answerText = result.answer || result.summary || '';
    let html = `<div class="result-header">${icon('check-circle')} Done (${result.steps} steps): ${escapeHtml(result.summary)}</div>`;
    if (answerText && answerText !== result.summary) {
      html += `<div class="result-answer">${escapeHtml(answerText)}</div>`;
    }
    resultBanner.innerHTML = html;
  } else {
    resultBanner.className = 'result-banner failure expanded';
    resultBanner.innerHTML = `<div class="result-header">${icon('x-circle')} Failed (${result.steps} steps): ${escapeHtml(result.reason || 'Unknown error')}</div>`;
  }
}

function updateStatus(status) {
  isRunning = status === 'running';
  isPaused = status === 'paused_waiting_user';

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
  updateModeBadge();
}

function showManualIntervention(details = {}) {
  const message = details.message || 'Manual intervention required.';
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
    port.postMessage({ type: 'resumeTask' });
  });
  document.getElementById('manualStopBtn')?.addEventListener('click', () => {
    port.postMessage({ type: 'stopTask' });
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
  // Hide all views
  ['chatView', 'settingsView', 'scheduleView', 'historyView'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  // Deactivate all tabs
  ['btnHelp', 'btnSettings', 'btnSchedule', 'btnHistory'].forEach(id => {
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
  } else if (viewId === 'scheduleView') {
    sendMsg({ type: 'getScheduledTasks' });
  } else if (viewId === 'historyView') {
    renderHistory();
  }
}

btnHelp.addEventListener('click', () => switchTab('chatView', 'btnHelp'));
btnSettings.addEventListener('click', () => switchTab('settingsView', 'btnSettings'));
btnSchedule.addEventListener('click', () => switchTab('scheduleView', 'btnSchedule'));


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

    for (const item of taskHistory) {
      const el = document.createElement('div');
      el.className = 'history-item';

      const goalSpan = document.createElement('span');
      goalSpan.className = 'goal-text';
      goalSpan.textContent = item.goal;
      el.appendChild(goalSpan);

      const badge = document.createElement('span');
      badge.className = 'result-badge ' + (item.success ? 'ok' : 'fail');
      badge.innerHTML = item.success ? `${icon('check')} ${item.steps}` : `${icon('x')} ${item.steps}`;
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
