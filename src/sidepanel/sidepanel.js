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
const btnBack = document.getElementById('btnBack');
const btnHistory = document.getElementById('btnHistory');
const btnHistoryBack = document.getElementById('btnHistoryBack');
const btnHelp = document.getElementById('btnHelp');
const btnHelpBack = document.getElementById('btnHelpBack');
const chatView = document.getElementById('chatView');
const settingsView = document.getElementById('settingsView');
const historyView = document.getElementById('historyView');
const helpView = document.getElementById('helpView');
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

  // Clear previous steps and hide capabilities
  stepsContainer.innerHTML = '';
  stepsContainer.classList.remove('finished');
  stepsContainer.style.display = 'flex'; // show steps
  
  const emptyStateEl = document.getElementById('emptyState');
  if (emptyStateEl) emptyStateEl.style.display = 'none'; // hide accordions
  const capabilitiesHeader = document.getElementById('capabilitiesHeader');
  if (capabilitiesHeader) capabilitiesHeader.style.display = 'none'; // hide header
  const suggestionsContainer = document.getElementById('suggestionsContainer');
  if (suggestionsContainer) suggestionsContainer.style.display = 'none';

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

btnSettings.addEventListener('click', () => {
  chatView.classList.remove('active');
  historyView.classList.remove('active');
  helpView.classList.remove('active');
  settingsView.classList.add('active');
  port.postMessage({ type: 'getConfig' });
});

btnBack.addEventListener('click', () => {
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  helpView.classList.remove('active');
  chatView.classList.add('active');
});

btnHelp.addEventListener('click', () => {
  chatView.classList.remove('active');
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  helpView.classList.add('active');
});

btnHelpBack.addEventListener('click', () => {
  helpView.classList.remove('active');
  settingsView.classList.remove('active');
  historyView.classList.remove('active');
  chatView.classList.add('active');
});

function renderSettings() {
  if (!config || !providerInfo) return;

  const tiers = {
    recommended: { icon: icon('star'), title: 'RECOMMENDED', desc: 'Best quality.', providers: [] },
    budget: { icon: icon('dollar'), title: 'BUDGET', desc: 'Cheapest option.', providers: [] },
    free: { icon: icon('home'), title: 'FREE', desc: 'Runs locally.', providers: [] },
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
    const group = document.createElement('div');
    group.className = 'tier-group' + (isActive ? ' active' : '');
    const providerDisplayNames = {
      siliconflow: 'SiliconFlow',
      groq: 'Groq',
      ollama: 'Ollama',
    };
    group.innerHTML = `<div class="tier-header">
      <h3>${tier.icon} ${escapeHtml(tier.title)}</h3>
      <span class="tier-desc">${escapeHtml(tier.desc)}</span>
    </div>`;

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
          <label>${escapeHtml(providerKeyLabel)} API Key</label>
          <input type="password" id="key_${name}" value="${escapeAttr(provConf.apiKey || '')}" placeholder="Enter API key">
        ` : ''}
        <label>Model</label>
        <input type="text" id="model_${name}" value="${escapeAttr(provConf.model || '')}" placeholder="Model name">
        ${name === 'ollama' ? `
          <label>Base URL</label>
          <input type="text" id="url_${name}" value="${escapeAttr(provConf.baseUrl || 'http://localhost:11434/v1')}" placeholder="http://localhost:11434/v1">
        ` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <button class="test-btn" data-provider="${name}">Test Connection</button>
          <span class="test-status" id="testStatus_${name}" style="font-size:11px;color:var(--text2);">${escapeHtml(statusLabel)}</span>
        </div>
      `;

      group.appendChild(card);

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
          port.postMessage({ type: 'testProvider', providerName: name, providerConfig });
        });
      }, 0);
    }

    // Activate tier button
    const activateBtn = document.createElement('button');
    activateBtn.className = 'tier-activate-btn';
    if (isActive) {
      activateBtn.innerHTML = `${icon('check')} Active`;
    } else {
      const selectedProvider = pickBestProviderInTier(tier.providers);
      activateBtn.textContent = `Use ${tier.title}`;
      activateBtn.addEventListener('click', () => {
        if (selectedProvider) {
          config.primary = selectedProvider;
          port.postMessage({ type: 'updateConfig', config: { primary: selectedProvider } });
          renderSettings();
          updateModeBadge();
        }
      });
    }

    group.appendChild(activateBtn);
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
  port.postMessage({ type: 'updateConfig', config: { providers } });
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

// ===== History =====

btnHistory.addEventListener('click', () => {
  chatView.classList.remove('active');
  settingsView.classList.remove('active');
  helpView.classList.remove('active');
  historyView.classList.add('active');
  renderHistory();
});

btnHistoryBack.addEventListener('click', () => {
  historyView.classList.remove('active');
  settingsView.classList.remove('active');
  helpView.classList.remove('active');
  chatView.classList.add('active');
});

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
