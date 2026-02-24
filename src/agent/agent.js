/**
 * Agent Loop
 *
 * Core agent that orchestrates: observe → think → act
 * Uses accessibility tree (primary) + screenshot (vision fallback)
 * Communicates with content script for page understanding and actions.
 */

import { TOOLS } from '../tools/tools.js';
import {
  AGENT_MAX_CONVERSATION_MESSAGES,
  AGENT_MAX_STEPS,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_CHARS,
  RATE_LIMIT_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
  RATE_LIMIT_MAX_RETRIES,
  REFLECTION_CONFIDENCE_THRESHOLD,
} from '../config/constants.js';
import {
  FIREWORKS_KIMI_K2P5_SYSTEM_ADDENDUM,
  GROQ_LLAMA4_MAVERICK_SYSTEM_ADDENDUM,
  QWEN3VL_OLLAMA_SYSTEM_ADDENDUM,
  SILICONFLOW_GLM_SYSTEM_ADDENDUM,
  SYSTEM_PROMPT,
} from './prompts.js';
import { contextMethods } from './context.js';
import { coverageMethods } from './coverage.js';
import { reflectionMethods } from './reflection.js';
import { stateMethods } from './state.js';

// ===== HTTP_REQUEST SECURITY HELPERS =====

/**
 * Returns true if the host resolves to a private / loopback / link-local address
 * that should not be reachable from the browser extension by default (anti-SSRF).
 */
function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  // Plain IPv4 check
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c] = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3])];
    if (a === 127) return true;                          // loopback
    if (a === 10) return true;                           // RFC-1918
    if (a === 172 && b >= 16 && b <= 31) return true;   // RFC-1918
    if (a === 192 && b === 168) return true;             // RFC-1918
    if (a === 169 && b === 254) return true;             // link-local
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT / shared
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 192 && b === 0 && c === 2) return true;   // TEST-NET
  }
  return false;
}

/** Headers that browsers / service workers must not allow callers to set. */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'cookie', 'cookie2', 'host', 'content-length', 'transfer-encoding',
  'connection', 'upgrade', 'via', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection',
]);

// Patterns blocked in javascript tool for security
const BLOCKED_JS_PATTERNS = [
  { re: /document\.cookie/i, msg: 'Access to document.cookie is blocked for security' },
  { re: /localStorage\s*[.[]/i, msg: 'Access to localStorage is blocked for security' },
  { re: /sessionStorage\s*[.[]/i, msg: 'Access to sessionStorage is blocked for security' },
  { re: /indexedDB/i, msg: 'Access to indexedDB is blocked for security' },
  { re: /\.setRequestHeader\s*\(\s*['"]Authorization/i, msg: 'Setting auth headers is blocked' },
];

const AUTH_URL_HINT_RE = /(?:^|[/?#._-])(login|log-in|signin|sign-in|auth|authorize|oauth|challenge|verify|captcha)(?:[/?#._-]|$)/i;
const CAPTCHA_HINTS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  "i'm not a robot",
  'i am not a robot',
  'verify you are human',
  'prove you are human',
  'подтвердите, что вы не робот',
  'подтвердите что вы не робот',
  'я не робот',
];
const LOGIN_HINTS = [
  'sign in',
  'signin',
  'log in',
  'login',
  'вход',
  'войти',
  'авторизац',
  'authenticate',
  'verification code',
  'two-factor',
  '2fa',
];
const PASSWORD_HINTS = [
  'password',
  'пароль',
  'passcode',
  'one-time code',
  'одноразовый код',
  'otp',
  'sms code',
];

/** Default site patterns blocked from navigation by the agent. */
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
      console.warn('[Agent] telemetry.append failed:', err?.message || err);
    });
}

function debugWarn(context, err) {
  const key = String(context || 'unknown');
  const now = Date.now();
  const last = warnTimestamps.get(key) || 0;
  if (now - last < WARN_THROTTLE_MS) return;
  warnTimestamps.set(key, now);
  const message = err?.message || String(err || 'unknown error');
  console.warn(`[Agent] ${key}: ${message}`);
  appendTelemetry('Agent', key, message);
}

export class Agent {
  constructor(providerManager, tabId) {
    this.provider = providerManager;
    this.tabId = tabId;
    this.history = [];
    this.maxSteps = AGENT_MAX_STEPS;
    this.maxConversationMessages = AGENT_MAX_CONVERSATION_MESSAGES;
    this.status = 'idle'; // idle | running | paused_waiting_user | done | failed
    this.onStep = null; // callback(step)
    this.onStatus = null; // callback(status)
    this.onIntervention = null; // callback(details)
    this._aborted = false;
    this._goal = '';
    this.metrics = null;
    this._onTabUpdated = null;
    this._lastKnownUrl = '';
    this._resumeResolver = null;
    this._isWaitingForUser = false;
    // Plan mode
    this.planMode = false;
    this.onPlan = null;
    this._planApprovalResolver = null;
    // Per-domain JS permission
    this.trustedJsDomains = new Set();
    this._jsDomainResolver = null;
    this._jsDomainDenied = false;
    this.onNotifyConnector = null;
    // Site blocklist (custom domains loaded from storage)
    this.blockedDomains = new Set(DEFAULT_BLOCKED_DOMAINS);
    // Rate limit / consecutive error tracking
    this._consecutiveRateLimitErrors = 0;
    this._consecutiveErrors = 0;
    this._rateLimitBackoffMs = 0;
    this._scratchpad = {};
    this._notifyConnectorCalls = 0;
    this._reflectionState = null;
    this._lastFindHits = [];
    this._lastFindTextMiss = null;
    this._lastPageTextSignature = '';
    this._connectedConnectorIds = [];
  }

  /**
   * Check if current provider supports vision (screenshots).
   */
  _providerSupportsVision() {
    return !!this.provider.currentProvider?.supportsVision;
  }

  _clampNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(n, min), max);
  }

  _deriveContextWindow(primaryProvider, providerConf = {}) {
    const providerName = String(primaryProvider || '').trim().toLowerCase();
    const modelName = String(providerConf.model || this.provider?.currentProvider?.model || '').trim().toLowerCase();

    if (providerName === 'ollama') {
      const numCtx = Number(providerConf.numCtx || this.provider?.currentProvider?.numCtx || 0);
      return Number.isFinite(numCtx) && numCtx > 0 ? numCtx : DEFAULT_CONTEXT_WINDOW_TOKENS;
    }
    if (providerName === 'fireworks') return 262144;
    if (providerName === 'groq') return 128000;
    if (providerName === 'generalapi') {
      if (/glm[-_]?4\.[567]/i.test(modelName)) return 131072;
      if (/^glm/i.test(modelName)) return 65536;
      return 32768;
    }
    return 32768;
  }

  _configureContextBudgetFromProvider() {
    const managerConfig = this.provider?.config || {};
    const primary = String(managerConfig.primary || '').trim();
    const providerConf = managerConfig.providers?.[primary] || {};

    const contextWindow = this._deriveContextWindow(primary, providerConf);
    this._contextWindowTokens = this._clampNumber(contextWindow, 2048, 1048576);

    const outputReserveRaw = Number(
      providerConf.maxTokens
      || this.provider?.currentProvider?.maxTokens
      || DEFAULT_RESERVED_OUTPUT_TOKENS,
    );
    this._contextReservedOutputTokens = this._clampNumber(outputReserveRaw, 256, 8192);

    const dynamicMessageLimit = this._clampNumber(
      Math.round(this._contextWindowTokens / 700),
      AGENT_MAX_CONVERSATION_MESSAGES,
      120,
    );
    this.maxConversationMessages = dynamicMessageLimit;
    this._contextBudgetDynamic = true;
  }

  _estimateConversationTokens(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    let total = 0;
    for (const msg of messages) {
      if (!msg) continue;

      total += 8;
      if (msg.role) total += 2;

      if (typeof msg.content === 'string') {
        total += Math.ceil(msg.content.length / 4);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text') {
            total += Math.ceil(String(part.text || '').length / 4);
          } else if (part.type === 'image_url') {
            total += 1200;
          } else {
            total += 24;
          }
        }
      }

      if (Array.isArray(msg.tool_calls)) {
        total += msg.tool_calls.length * 32;
        for (const tc of msg.tool_calls) {
          const argsText = String(tc?.function?.arguments || '');
          total += Math.ceil(argsText.length / 4);
        }
      }
    }

    return total;
  }

  _getRuntimeTokenLimit(kind = 'step') {
    const policy = this.runtimePolicy || {};
    if (kind === 'plan') {
      const n = Number(policy.planMaxTokens);
      if (Number.isFinite(n) && n > 0) return this._clampNumber(n, 64, 1024);
      return AGENT_PLAN_MAX_TOKENS_DEFAULT;
    }
    const n = Number(policy.stepMaxTokens);
    if (Number.isFinite(n) && n > 0) return this._clampNumber(n, 64, 1024);
    return AGENT_STEP_MAX_TOKENS_DEFAULT;
  }

  _compactAssistantText(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    return raw.slice(0, AGENT_THOUGHT_MAX_CHARS);
  }


  _runtimeDisableThinking() {
    return this.runtimePolicy?.disableThinking !== false;
  }

  _runtimeStepTemperature() {
    const n = Number(this.runtimePolicy?.stepTemperature);
    if (!Number.isFinite(n)) return 0;
    return this._clampNumber(n, 0, 1);
  }

  async _readBundledTextFile(path) {
    try {
      const url = chrome.runtime.getURL(path);
      const resp = await fetch(url);
      if (!resp.ok) return '';
      return await resp.text();
    } catch (err) {
      debugWarn(`skills.readFile.${path}`, err);
      return '';
    }
  }

  _parseSkillMarkdown(id, markdown) {
    const text = String(markdown || '').trim();
    if (!text) return null;

    const toolsMatch = text.match(/^Allowed tools:\s*(.+)$/im);
    const toolsRaw = toolsMatch ? toolsMatch[1].trim() : 'all';
    const tools = /^all$/i.test(toolsRaw)
      ? null
      : toolsRaw.split(',').map((t) => t.trim()).filter(Boolean);

    const promptMatch = text.match(/(?:^|\n)Prompt:\s*([\s\S]*)$/i);
    const prompt = (promptMatch ? promptMatch[1] : text).trim();
    if (!prompt) return null;

    return { id, tools, prompt };
  }

  async _loadSkillsContext() {
    if (this._skillsCache) return this._skillsCache;

    const indexText = await this._readBundledTextFile('src/skills/SKILLS_INDEX.md');
    const skills = {};
    for (const id of SKILL_IDS) {
      const fileName = SKILL_FILE_MAP[id];
      if (!fileName) continue;
      const raw = await this._readBundledTextFile(`src/skills/${fileName}`);
      const parsed = this._parseSkillMarkdown(id, raw);
      if (parsed) skills[id] = parsed;
    }

    if (!skills.general) {
      skills.general = {
        id: 'general',
        tools: null,
        prompt: 'Act according to the situation. Be brief and finish only when task is complete.',
      };
    }

    this._skillsCache = { indexText, skills };
    return this._skillsCache;
  }

  _parseSelectedSkillId(rawText = '') {
    const text = String(rawText || '').trim().toLowerCase();
    if (!text) return 'general';
    const match = text.match(/(search|navigate|fill_form|extract|interact|monitor|multi_step|general)/i);
    return match ? match[1].toLowerCase() : 'general';
  }

  async _selectSkillForGoal(goal, skillsContext) {
    const availableIds = Object.keys(skillsContext?.skills || {}).filter((id) => id !== 'general');
    const idsList = [...availableIds, 'general'];
    const classifierMessages = [
      {
        role: 'system',
        content: SKILL_SELECTION_PROMPT,
      },
      {
        role: 'user',
        content: `Task: ${goal}\n\nAllowed skill ids: ${idsList.join(', ')}\nReply with one skill id.`,
      },
    ];

    try {
      this.metrics.llmCalls += 1;
      const response = await this.provider.chat(classifierMessages, [], {
        maxTokens: 8,
        temperature: 0,
        thinking: !this._runtimeDisableThinking(),
        disableThinking: this._runtimeDisableThinking(),
      });
      this._recordUsage(response?.usage);
      return this._parseSelectedSkillId(response?.text || 'general');
    } catch (err) {
      debugWarn('skills.classify', err);
      return 'general';
    }
  }

  _resolveSkillTools(skillId, allTools) {
    const skill = this._skillsCache?.skills?.[skillId] || this._skillsCache?.skills?.general;
    if (!skill?.tools || !Array.isArray(skill.tools)) return allTools;
    const allowed = new Set(skill.tools);
    return allTools.filter((t) => allowed.has(t.name));
  }

  async _buildSkillSystemMessage(goal) {
    const skillsContext = await this._loadSkillsContext();
    const selectedId = await this._selectSkillForGoal(goal, skillsContext);
    const finalId = skillsContext?.skills?.[selectedId] ? selectedId : 'general';
    this._activeSkillId = finalId;
    const skill = skillsContext?.skills?.[finalId] || skillsContext?.skills?.general;

    this._emitStep({ step: 0, type: 'skill', content: `Skill selected: ${finalId}` });
    return {
      role: 'system',
      content: `Active skill: ${finalId}\n\nSkill strategy:\n${skill.prompt}\n\nUse only tools that fit this skill unless impossible, then adapt safely.`,
    };
  }

  _recoverToolCallsFromText(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];

    const allowedTools = new Set([...TOOLS.map((t) => t.name), 'done', 'fail']);
    const candidates = [];

    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
    candidates.push(raw);

    const maybeAddCall = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      const name = String(obj.name || '').trim();
      if (!allowedTools.has(name)) return;
      const args = (obj.arguments && typeof obj.arguments === 'object') ? obj.arguments : {};
      recovered.push({
        id: `recovered_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        arguments: args,
      });
    };

    const recovered = [];
    for (const source of candidates) {
      if (!source) continue;

      try {
        const parsed = JSON.parse(source);
        if (Array.isArray(parsed)) {
          for (const item of parsed) maybeAddCall(item);
        } else {
          maybeAddCall(parsed);
        }
      } catch {
        const match = source.match(/\{[\s\S]*"name"\s*:\s*"[A-Za-z_][A-Za-z0-9_]*"[\s\S]*"arguments"\s*:\s*\{[\s\S]*\}\s*\}/);
        if (!match) continue;
        try {
          const parsed = JSON.parse(match[0]);
          maybeAddCall(parsed);
        } catch {
          // ignore malformed fragments
        }
      }
      if (recovered.length > 0) break;
    }

    return recovered;
  }

  _isLikelyInformationGoal() {
    const g = String(this._goal || '').toLowerCase();
    if (!g) return false;
    return /(find|search|lookup|check|what|how|which|spell|как|пишется|найд|поиск|проверь|что такое|какой)/i.test(g);
  }

  _getLastActionToolName() {
    if (!Array.isArray(this.history) || this.history.length === 0) return '';
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const item = this.history[i];
      if (item?.type === 'action' && item?.tool) return String(item.tool);
    }
    return '';
  }

  _getStuckRecoveryToolNames() {
    const lastTool = this._getLastActionToolName();
    if (lastTool === 'read_page' || lastTool === 'get_page_text') {
      return this._isLikelyInformationGoal()
        ? ['find_text', 'get_page_text', 'read_page', 'done', 'computer', 'back']
        : ['find', 'computer', 'read_page', 'done', 'back'];
    }
    if (lastTool === 'navigate' || lastTool === 'computer' || lastTool === 'find') {
      return this._isLikelyInformationGoal()
        ? ['find_text', 'read_page', 'get_page_text', 'computer', 'done', 'back']
        : ['find', 'read_page', 'computer', 'done', 'back'];
    }
    return this._isLikelyInformationGoal()
      ? ['find_text', 'get_page_text', 'read_page', 'find', 'computer', 'done', 'back']
      : ['find', 'read_page', 'computer', 'done', 'back'];
  }

  _applyStuckToolRestriction(activeTools) {
    if (!Array.isArray(activeTools) || this._noToolOnlyStreak < 2) return activeTools;
    const preferred = this._getStuckRecoveryToolNames();
    const preferredSet = new Set(preferred);
    const filtered = activeTools.filter((t) => preferredSet.has(t.name));
    return filtered.length > 0 ? filtered : activeTools;
  }

  _buildStuckRecoveryPrompt(activeTools = []) {
    const allowedNames = Array.isArray(activeTools) ? activeTools.map((t) => t.name) : [];
    const preferred = this._getStuckRecoveryToolNames().filter((n) => allowedNames.length === 0 || allowedNames.includes(n));
    const toolList = preferred.length > 0 ? preferred.join(', ') : 'find, read_page, get_page_text, computer, done';
    const infoTail = this._isLikelyInformationGoal()
      ? 'You are in answer-extraction phase: use find_text/get_page_text to extract the concrete fact, then call done with answer + source URL.'
      : 'Use one concrete action tool now, then continue.';
    return `Stuck recovery mode: repeated text-only responses detected. Call exactly ONE native tool now, no narration. Preferred tools: ${toolList}. ${infoTail}`;
  }

  /**
   * Run the agent loop for a given goal.
   */
  async run(goal, options = {}) {
    const resumeState = options?.resumeState && typeof options.resumeState === 'object'
      ? options.resumeState
      : null;
    const hasResumeState = !!resumeState;

    this.planMode = options.planMode || false;
    this.status = 'running';
    this._aborted = false;
    this._goal = goal || '';
    this.history = [];
    this._scratchpad = {};
    this._lastKnownUrl = '';
    this._lastFindResults = [];
    this.executionPlan = null;
    this._currentPhaseIndex = -1;
    this.runtimePolicy = (options?.policy && typeof options.policy === 'object') ? options.policy : {};
    this.metrics = {
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
      errors: 0,
      duplicateToolCalls: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
      providerId: this.providerManager?.config?.primary || '',
    };
    this._lastToolKey = '';
    this._dupCount = 0;
    this._consecutiveRateLimitErrors = 0;
    this._isNavigateOnly = false;
    this._consecutiveErrors = 0;
    this._rateLimitBackoffMs = 0;
    this._toolFailStreak = 0;
    this._lastTypeFailed = false;
    this._notifyConnectorCalls = 0;
    this._reflectionState = null;
    this._lastFindHits = [];
    this._lastFindTextMiss = null;
    this._lastPageTextSignature = '';
    this._connectedConnectorIds = [];

    if (hasResumeState) {
      try {
        this.history = Array.isArray(resumeState.history) ? resumeState.history.slice(-200) : [];
      } catch {
        this.history = [];
      }
      try {
        this._scratchpad = resumeState.scratchpad && typeof resumeState.scratchpad === 'object'
          ? JSON.parse(JSON.stringify(resumeState.scratchpad))
          : {};
      } catch {
        this._scratchpad = {};
      }
      this._lastKnownUrl = String(resumeState.lastKnownUrl || '');
      const restoredNotifyCalls = Number(resumeState.notifyConnectorCalls);
      if (Number.isFinite(restoredNotifyCalls) && restoredNotifyCalls > 0) {
        this._notifyConnectorCalls = Math.min(Math.max(restoredNotifyCalls, 0), 3);
      }
      if (resumeState.reflectionState && typeof resumeState.reflectionState === 'object' && !Array.isArray(resumeState.reflectionState)) {
        this._reflectionState = resumeState.reflectionState;
      }
    }

    this._notify('running');
    this._startTabWatcher();

    // Load persisted security settings
    try {
      const stored = await chrome.storage.local.get(['customBlockedDomains', 'trustedJsDomains']);
      if (Array.isArray(stored.customBlockedDomains)) {
        for (const d of stored.customBlockedDomains) this.blockedDomains.add(d);
      }
      if (Array.isArray(stored.trustedJsDomains)) {
        for (const d of stored.trustedJsDomains) this.trustedJsDomains.add(d);
      }
    } catch (err) {
      debugWarn('run.loadSecuritySettings', err);
    }

    // Enable monitoring in content script
    try {
      await this._sendToContent('startMonitoring', {});
      await this._clearFindTextContext();
    } catch (err) {
      debugWarn('run.startMonitoring', err);
    }

    // Plan mode: generate and show plan before execution
    if (this.planMode) {
      const approved = await this._generateAndWaitForPlan(goal);
      if (!approved || this._aborted) {
        this._stopTabWatcher();
        try {
          await this._sendToContent('stopMonitoring', {});
        } catch (err) {
          debugWarn('run.stopMonitoring.planCancelled', err);
        }
        this.status = 'failed';
        this._notify('failed');
        return { success: false, reason: 'Task cancelled (plan not approved)', steps: 0, metrics: this._finalizeMetrics() };
      }
    }

    // Get current page context for multi-task awareness
    let pageContext = '';
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab?.url && !tab.url.startsWith('chrome://')) {
        pageContext = `\nCurrent page: ${tab.url}` + (tab.title ? ` ("${tab.title}")` : '');
      }
    } catch (err) {
      debugWarn('run.readCurrentTabContext', err);
    }

    // Surface connected integrations so the model can use notify_connector deterministically.
    let connectedConnectors = [];
    try {
      const stored = await chrome.storage.local.get('connectionsState');
      const integrations = Array.isArray(stored?.connectionsState?.integrations)
        ? stored.connectionsState.integrations
        : [];
      connectedConnectors = integrations
        .filter((item) => item && item.connected)
        .map((item) => String(item.id || '').trim())
        .filter(Boolean);
    } catch (err) {
      debugWarn('run.readConnectionsState', err);
    }
    this._connectedConnectorIds = connectedConnectors;

    // Build task-aware initial message
    const goalText = String(goal || '').trim();
    const startsAsNavigate = /^(open|go to|navigate|перейди|открой|зайди|покажи)\s/i.test(goalText);
    // \b does not work with Cyrillic in JS — use space/start/end boundaries for Russian words
    const hasExtraIntentEn = /\b(and|then|after|also|find|search|check|extract|fill)\b/i.test(goalText);
    const hasExtraIntentRu = /(^|\s)(и|затем|потом|также|найди|проверь|извлеки|заполни)(\s|$)/i.test(goalText);
    const hasExtraIntent = hasExtraIntentEn || hasExtraIntentRu || /[,;]/.test(goalText);
    const isNavigateOnly = startsAsNavigate && !hasExtraIntent;
    this._isNavigateOnly = isNavigateOnly;
    let taskMessage = `Task: ${goal}`;
    if (pageContext) taskMessage += pageContext;
    if (connectedConnectors.length > 0) {
      taskMessage += `\nConnected connectors available now: ${connectedConnectors.join(', ')}.`;
    }
    if (isNavigateOnly) {
      taskMessage += '\n\nThis is a navigation task. Navigate to the URL and call done immediately. Do NOT read the page or perform any other actions.';
    } else {
      taskMessage += '\n\nThe current page content is provided below. Use it to decide your first action.';
    }
    if (hasResumeState) {
      taskMessage += '\n\nThis task is resumed from a previously interrupted session. Continue from current page state and avoid repeating already completed work.';
    }

    this._configureContextBudgetFromProvider();

    let taskMessage = `Task: ${goal}`;
    if (pageContext) taskMessage += pageContext;

    const selectedSkillMessage = await this._buildSkillSystemMessage(goal);

    const messages = [
      { role: 'system', content: this._buildSystemPrompt() },
      { role: 'user', content: taskMessage },
      { role: 'system', content: 'State summary: no verified progress yet.' },
    ];

    let stepStart = 0;
    if (hasResumeState) {
      const resumeStep = Number(resumeState.nextStep);
      if (Number.isFinite(resumeStep) && resumeStep >= 0) {
        stepStart = Math.floor(resumeStep);
      } else {
        for (const item of this.history) {
          const s = Number(item?.step);
          if (Number.isFinite(s) && s >= stepStart) stepStart = s + 1;
        }
      }

      const recoveryContext = {
        recoveredAt: new Date().toISOString(),
        previousStatus: String(resumeState.status || 'unknown'),
        nextStep: stepStart,
        lastKnownUrl: this._lastKnownUrl || '',
        scratchpad: this._scratchpad || {},
        reflectionState: this._reflectionState || null,
        recentHistory: this.history.slice(-12),
      };
      let serializedRecovery = '';
      try {
        serializedRecovery = JSON.stringify(recoveryContext);
      } catch {
        serializedRecovery = '{"error":"failed_to_serialize_recovery_context"}';
      }
      if (serializedRecovery.length > 9000) {
        serializedRecovery = `${serializedRecovery.slice(0, 9000)}...[truncated]`;
      }
      this._appendMessage(messages, {
        role: 'user',
        content: `Recovered state from interrupted session:\n${serializedRecovery}\nContinue the same task from here.`,
      });
    }

    // Auto-inject page snapshot before first LLM call (non-navigate tasks only).
    // This ensures the model always has page context and cannot act blindly.
    if (!isNavigateOnly) {
      try {
        const snap = await this._sendToContent('readPage', {
          maxDepth: 8,
          maxNodes: 150,
        });
        if (snap && !snap.code) {
          const compressed = this._compressReadPageForLLM(snap);
          const snapText = JSON.stringify(compressed);
          // Inject as a synthetic assistant+tool exchange so the model sees it as prior context
          const syntheticCallId = 'call_auto_readpage';
          this._appendMessage(messages, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: syntheticCallId,
              type: 'function',
              function: { name: 'read_page', arguments: '{}' },
            }],
          });
          this._appendMessage(messages, {
            role: 'tool',
            tool_call_id: syntheticCallId,
            content: snapText.length > 8000 ? snapText.slice(0, 8000) : snapText,
          });
          this.history.push({ step: -1, type: 'action', tool: 'read_page', args: {}, result: snap });
          this._emitStep({ step: -1, type: 'action', tool: 'read_page', args: {}, result: snap });
        }
      } catch (err) {
        debugWarn('run.autoReadPage', err);
      }
    }

    try {
      const maxStepExclusive = stepStart + this.maxSteps;
      for (let step = stepStart; step < maxStepExclusive; step++) {
        if (this._aborted) {
          this.status = 'failed';
          this._notify('failed');
          return { success: false, reason: 'Aborted by user', steps: step, metrics: this._finalizeMetrics() };
        }
        const phaseLabel = '';
        if (!suppressStepBanner) {
          this._emitStep({
            step,
            type: 'thought',
            content: phaseLabel
              ? `Step ${step + 1}/${this.maxSteps} — ${phaseLabel}`
              : `Step ${step + 1}/${this.maxSteps}`,
          });
        } else {
          suppressStepBanner = false;
        }
        // Phase status updates are disabled.

        try {
          this._progressedThisStep = false;
          await this._pauseIfManualInterventionNeeded(step, messages);
          if (this._aborted) {
            this.status = 'failed';
            this._notify('failed');
            return { success: false, reason: 'Aborted by user', steps: step, metrics: this._finalizeMetrics() };
          }

          // Filter tools based on provider capabilities
          let activeTools = TOOLS;
          if (!this._providerSupportsVision()) {
            activeTools = activeTools.filter(t => t.name !== 'screenshot');
          }

          // 1) REFLECT: mandatory reasoning pass (no tools)
          const reflection = await this._runReflection(step, messages, activeTools);
          if (!reflection.ok) {
            throw new Error(`REFLECTION_INVALID: ${reflection.error || 'invalid reflection output'}`);
          }

          // Successful LLM call — reset consecutive error counters
          this._consecutiveRateLimitErrors = 0;
          this._consecutiveErrors = 0;
          this._rateLimitBackoffMs = 0;

          const digest = this._buildReflectionDigest(reflection.state);
          if (reflection.fallback) {
            this.history.push({
              step,
              type: 'error',
              error: `REFLECTION_FALLBACK: ${reflection.error || 'invalid model reflection format'}`,
            });
            this._emitStep({
              step,
              type: 'error',
              error: `REFLECTION_FALLBACK: ${reflection.error || 'invalid model reflection format'}`,
            });
            this._emitStep({
              step,
              type: 'warning',
              content: 'Model returned text without tool_call. Retrying same step with strict tool-call requirement.',
            });

            // Text-only output is a non-action turn: retry immediately without counting a step.
            suppressStepBanner = true;
            step -= 1;
            continue;
          }
          this._reflectionState = reflection.state;
          this.history.push({ step, type: 'thought', content: digest });
          this._emitStep({ step, type: 'thought', content: digest });
          this._appendMessage(messages, { role: 'assistant', content: `[REFLECTION] ${digest}` });

          // 2) STOP condition: confidence threshold + subgoal coverage
          if (reflection.state.sufficiency && reflection.state.confidence >= REFLECTION_CONFIDENCE_THRESHOLD) {
            const summary = reflection.state.summary || 'Task completed from accumulated evidence.';
            const answer = reflection.state.answer || (
              reflection.state.facts.length > 0
                ? reflection.state.facts.map((f) => `- ${f}`).join('\n')
                : ''
            );
            const prematureCheck = this._checkPrematureDone({ summary, answer });
            if (!prematureCheck.ok) {
              this._appendMessage(messages, {
                role: 'user',
                content: `Reflection marked task complete, but completion guard rejected it: ${prematureCheck.result?.error || 'unknown reason'}. Continue and gather missing evidence.`,
              });
              continue;
            }
            const coverage = this._validateDoneCoverage(summary, answer);
            if (!coverage.ok) {
              this._appendMessage(messages, {
                role: 'user',
                content: `Reflection confidence is high, but requested parts are still missing evidence: ${coverage.missing.join('; ')}. Continue and cover all parts.`,
              });
              continue;
            }

            const doneResult = { success: true, summary, answer };
            this.history.push({ step, type: 'action', tool: 'done', args: { summary, answer, auto: true }, result: doneResult });
            this._emitStep({ step, type: 'action', tool: 'done', args: { summary, answer, auto: true }, result: doneResult });
            this.status = 'done';
            this._notify('done');
            return { success: true, summary, answer, steps: step + 1, metrics: this._finalizeMetrics() };
          }

          // 3) ACT gate: no tool call without validated next_action
          const nextAction = reflection.state.next_action;
          if (!nextAction?.tool) {
            this._appendMessage(messages, {
              role: 'user',
              content: 'Reflection did not provide a valid next_action. Retry reflection and provide one concrete tool call.',
            });
            continue;
          }
          if (
            nextAction.tool === 'http_request' &&
            /на\s+сайте|website|on\s+site/i.test(String(this._goal || ''))
          ) {
            this._appendMessage(messages, {
              role: 'user',
              content: 'Do not use http_request for on-site lookup tasks when browser interaction is available. Use read_page/get_page_text/find/find_text instead.',
            });
            nextAction.tool = 'read_page';
            nextAction.args = {};
          }
          const sanitizedNextAction = this._sanitizePlannedAction(nextAction);
          nextAction.tool = sanitizedNextAction.tool;
          nextAction.args = sanitizedNextAction.args;
          if (nextAction.tool === 'done' && reflection.state.confidence < REFLECTION_CONFIDENCE_THRESHOLD) {
            this._appendMessage(messages, {
              role: 'user',
              content: `Reflection proposed done() with confidence ${Math.round(reflection.state.confidence * 100)}%, which is below threshold ${Math.round(REFLECTION_CONFIDENCE_THRESHOLD * 100)}%. Gather more evidence first.`,
            });
            continue;
          }

          const syntheticResponse = {
            text: null,
            toolCalls: [
              {
                id: `reflect_${step}_0`,
                name: nextAction.tool,
                arguments: nextAction.args || {},
              },
            ],
          };
          const result = await this._handleToolCalls(step, messages, syntheticResponse);
          if (result) return result; // terminal action (done/fail)
        } catch (err) {
          console.error(`[Agent] Step ${step} error:`, err);
          this.metrics.errors += 1;
          this.history.push({ step, type: 'error', error: err.message });
          this._emitStep({ step, type: 'error', error: err.message });

          const isRateLimit = (
            err.code === 'RATE_LIMIT_EXCEEDED' ||
            err.status === 429 ||
            err.status === 503 ||
            /429|503|rate.?limit|over capacity|service unavailable/i.test(err.message)
          );

          if (isRateLimit) {
            this._consecutiveRateLimitErrors += 1;
            this._consecutiveErrors += 1;

            // Fail fast if rate limited too many times consecutively
            if (this._consecutiveRateLimitErrors >= RATE_LIMIT_MAX_RETRIES) {
              this.status = 'failed';
              this._notify('failed');
              return { success: false, reason: 'Persistent rate limiting from API provider — unable to continue. Please wait a few minutes and retry.', steps: step + 1, metrics: this._finalizeMetrics() };
            }

            // Exponential backoff: 3s, 6s, 12s, 24s
            this._rateLimitBackoffMs = Math.min(
              RATE_LIMIT_BACKOFF_BASE_MS * (2 ** (this._consecutiveRateLimitErrors - 1)),
              RATE_LIMIT_BACKOFF_MAX_MS,
            );
            const waitSec = Math.round(this._rateLimitBackoffMs / 1000);
            console.log(`[Agent] Rate limit hit (${this._consecutiveRateLimitErrors}x consecutive). Backing off ${waitSec}s before next step.`);
            this._emitStep({ step, type: 'pause', content: `Rate limited by API. Waiting ${waitSec}s before retrying…` });
            await new Promise(r => setTimeout(r, this._rateLimitBackoffMs));

            // Tell LLM this was a transient rate limit — do NOT change strategy
            const code = err.status === 503 || /503|over capacity|service unavailable/i.test(err.message) ? '503/over-capacity' : '429';
            this._appendMessage(messages, {
              role: 'user',
              content: `API transient capacity error (${code}). This is a temporary provider issue, NOT a problem with your approach. I waited ${waitSec}s. Now retry the SAME action you were about to take. Do NOT navigate away, do NOT change strategy, do NOT try alternative sites. Just retry.`,
            });
          } else {
            // Non-rate-limit error
            this._consecutiveRateLimitErrors = 0;
            this._consecutiveErrors += 1;

            if (this._consecutiveErrors >= 6) {
              this.status = 'failed';
              this._notify('failed');
              return { success: false, reason: `Too many consecutive errors (${this._consecutiveErrors}). Last: ${err.message}`, steps: step + 1, metrics: this._finalizeMetrics() };
            }

            this._appendMessage(messages, {
              role: 'user',
              content: `Error occurred: ${err.message}. Try a different approach.`,
            });
          }
        }
      }
    } finally {
      this._stopTabWatcher();
      // Disable monitoring in content script
      try {
        await this._sendToContent('stopMonitoring', {});
      } catch (err) {
        debugWarn('run.stopMonitoring.finally', err);
      }
    }

    this.status = 'failed';
    this._notify('failed');
    return { success: false, reason: 'Max steps reached', steps: stepStart + this.maxSteps, metrics: this._finalizeMetrics() };
  }

  /**
   * Handle all tool calls from a single LLM response.
   * Groups them into one assistant message (fixes OpenAI API format).
   */
  async _handleToolCalls(step, messages, response) {
    const toolCalls = response.toolCalls;

    // Build single assistant message with ALL tool_calls
    const assistantToolCalls = toolCalls.map((tc, i) => {
      const normalizedArgs = this._normalizeToolArgs(tc.name, tc.arguments || {});
      return {
        id: tc.id || `call_${step}_${i}_${tc.name}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(normalizedArgs),
        },
        _normalized: normalizedArgs, // internal, stripped before sending
      };
    });

    this._appendMessage(messages, {
      role: 'assistant',
      content: null,
      tool_calls: assistantToolCalls.map(({ _normalized, ...tc }) => tc),
    });

    // Execute each tool and collect results
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const normalizedArgs = assistantToolCalls[i]._normalized;
      const toolCallId = assistantToolCalls[i].id;

      this.metrics.toolCalls += 1;

      // Duplicate tool call detection — skip terminal tools (done/fail)
      let isDuplicate = false;
      let duplicateNudge = '';
      if (tc.name !== 'done' && tc.name !== 'fail') {
        const toolKey = tc.name + ':' + JSON.stringify(normalizedArgs);
        if (toolKey === this._lastToolKey) {
          this._dupCount += 1;
          this.metrics.duplicateToolCalls += 1;
          if (this._dupCount >= 1) {
            isDuplicate = true;
            duplicateNudge = `You already called ${tc.name} with the same arguments ${this._dupCount + 1} times. The result will not change. Try a DIFFERENT tool or approach. For example: use find_text to search for specific content, get_page_text to read the full page, or navigate to a different URL.`;
          }
        } else {
          this._lastToolKey = toolKey;
          this._dupCount = 0;
        }

        // Generic loop detection for read-only vacillation
        if (!isDuplicate && ['save_progress', 'get_page_text', 'read_page'].includes(tc.name)) {
          const recentActions = this.history.filter(h => h.type === 'action').slice(-6);
          if (recentActions.length >= 6 && recentActions.every(h => ['save_progress', 'get_page_text', 'read_page'].includes(h.tool))) {
            isDuplicate = true;
            this.metrics.duplicateToolCalls += 1;
            duplicateNudge = `You are stuck in a loop of calling read-only tools and saving progress without taking any concrete actions. Try a DIFFERENT strategy. Open a new URL, click a link, type a search, or if you cannot find the requested information, use the fail tool to give up directly.`;
          }
        }

        // Per-domain JS permission check
        try {
          const tab = await chrome.tabs.get(this.tabId);
          if (tab?.url && !tab.url.startsWith('chrome://')) {
            const domain = new URL(tab.url).hostname;
            if (!this.trustedJsDomains.has(domain)) {
              const allowed = await this._waitForJsDomainApproval(domain);
              if (!allowed || this._aborted) {
                const result = this._makeError('JS_DOMAIN_BLOCKED', `JavaScript execution on "${domain}" was not permitted.`);
                this.history.push({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
                this._emitStep({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
                this._appendMessage(messages, {
                  role: 'tool',
                  tool_call_id: toolCallId,
                  content: JSON.stringify(result),
                });
                continue;
              }
            }
          }
        } catch (err) {
          debugWarn('tool.javascript.readTabForDomainCheck', err);
        }
      }

      // JS safety check
      let isJsBlocked = false;
      let jsBlockReason = '';
      if (tc.name === 'javascript' && !isDuplicate) {
        const blocked = this._checkJsSafety(normalizedArgs.code);
        if (blocked) {
          isJsBlocked = true;
          jsBlockReason = blocked;
        } else {
          // Per-domain JS permission check
          try {
            const tab = await chrome.tabs.get(this.tabId);
            if (tab?.url && !tab.url.startsWith('chrome://')) {
              const domain = new URL(tab.url).hostname;
              if (!this.trustedJsDomains.has(domain)) {
                const allowed = await this._waitForJsDomainApproval(domain);
                if (!allowed || this._aborted) {
                  isJsBlocked = true;
                  jsBlockReason = `JavaScript execution on "${domain}" was not permitted.`;
                }
              }
            }
          } catch (err) {
            debugWarn('tool.javascript.readTabForDomainCheck', err);
          }
        }
      }

      let result;
      if (isDuplicate) {
        result = { success: false, error: 'DUPLICATE_CALL', message: duplicateNudge };
      } else if (isJsBlocked) {
        const errType = jsBlockReason.includes('permitted') ? 'JS_DOMAIN_BLOCKED' : 'JS_BLOCKED';
        result = this._makeError(errType, jsBlockReason);
      } else {
        result = await this._executeTool(tc.name, normalizedArgs);
      }

      const observedUrl = result?.url || result?.page_url || result?.pageUrl || result?.finalUrl;
      if (observedUrl) {
        this._lastKnownUrl = String(observedUrl);
      }
      if (tc.name === 'find_text') {
        if (result?.success === false || !result?.found || Number(result?.count || 0) === 0) {
          this._lastFindTextMiss = {
            query: String(normalizedArgs?.query || '').trim().toLowerCase(),
            url: String(this._lastKnownUrl || ''),
          };
        } else {
          this._lastFindTextMiss = null;
        }
      }

      // Track tool failure streaks (excluding terminal tools)
      if (tc.name !== 'done' && tc.name !== 'fail') {
        if (result?.success === false) {
          this._toolFailStreak += 1;
        } else {
          this._toolFailStreak = 0;
        }
        // Track last type failure for empty-submit detection
        if (tc.name === 'type') {
          this._lastTypeFailed = result?.success === false;
        }
      }

      if (tc.name === 'done') {
        // Guard: reject done if recent history is mostly failures (agent giving up too early)
        const prematureCheck = this._checkPrematureDone(normalizedArgs);
        if (!prematureCheck.ok) {
          result = prematureCheck.result;
        } else {
          const coverage = this._validateDoneCoverage(normalizedArgs?.summary, normalizedArgs?.answer);
          if (!coverage.ok) {
            result = {
              success: false,
              code: 'DONE_COVERAGE_FAILED',
              error: `Early completion rejected: missing evidence for ${coverage.missing.length} requested part(s).`,
              missing: coverage.missing,
            };
          }
        }
      }

      this.history.push({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
      this._emitStep({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
      this._updateStateSummaryFromTool(tc.name, normalizedArgs, result);

      const readDoneLoopGuard = this._checkReadDoneLoopGuard(step, tc.name, result);
      if (readDoneLoopGuard?.kind === 'warn') {
        this._appendMessage(messages, {
          role: 'user',
          content: readDoneLoopGuard.prompt,
        });
      } else if (readDoneLoopGuard?.kind === 'fail') {
        this.status = 'failed';
        this._notify('failed');
        return { success: false, reason: readDoneLoopGuard.reason, steps: step + 1, metrics: this._finalizeMetrics() };
      }

      // Phase progression heuristics are disabled.

      if (tc.name === 'computer' && result?.success === false) {
        await this._attemptComputerSelfHeal(step, messages, normalizedArgs, result);
      }

      const guardedFailure = this._checkToolErrorLoopGuard(step, tc.name, result);
      if (guardedFailure) {
        if (guardedFailure.kind === 'recover_done_contract') {
          this._appendMessage(messages, {
            role: 'user',
            content: `Recovery mode: done() has failed contract validation multiple times. Do NOT call done now. First extract concrete result with tools (read_page or get_page_text), including source URL. Then call done(summary, answer) with non-empty fields and actual data.`,
          });
          continue;
        }
        if (guardedFailure.kind === 'recover_generic') {
          this._appendMessage(messages, {
            role: 'user',
            content: guardedFailure.recoveryPrompt || `Recovery mode: repeated error detected (${guardedFailure.code || 'UNKNOWN_ERROR'}). Change strategy and continue with tools.`,
          });
          continue;
        }
        this.status = 'failed';
        this._notify('failed');
        return { success: false, reason: guardedFailure.reason, steps: step + 1, metrics: this._finalizeMetrics() };
      }

      // Architecture rule: Only process screenshot vision correctly
      if (tc.name === 'screenshot' && result?.success && result?.imageBase64) {
        this._appendMessage(messages, {
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ success: true, note: 'Screenshot captured and attached as image below.' }),
        });
        const currentProvider = this.provider.currentProvider;
        if (currentProvider?.supportsVision) {
          this._appendMessage(messages,
            currentProvider.buildVisionMessage(
              'Here is the screenshot of the current page. Describe what you see and decide the next action.',
              result.imageBase64,
              result.mimeType || 'image/jpeg',
            ),
          );
        } else {
          this._appendMessage(messages, {
            role: 'user',
            content: 'Screenshot was captured but cannot be displayed (text-only model). Use read_page instead.',
          });
        }
      } else {
        // Normal tool output append
        this._appendMessage(messages, {
          role: 'tool',
          tool_call_id: toolCallId,
          content: this._serializeToolResultForLLM(tc.name, result),
        });
        if (fallbackVisionMessage) {
          this._appendMessage(messages, fallbackVisionMessage);
        }
      }

      // Keep flow deterministic: do not inject heuristic strategy mutations.
      if (tc.name === 'done' && result?.success === false) {
        const details = Array.isArray(result?.details) && result.details.length > 0
          ? result.details.join(' ')
          : (Array.isArray(result?.missing) ? `Missing coverage: ${result.missing.join(', ')}` : 'Provide missing evidence and retry done.');
        this._appendMessage(messages, {
          role: 'user',
          content: `Continue task. done was rejected by contract validation. Missing requirements: ${details}`,
        });
      }

      // Check terminal actions
      if (tc.name === 'done' && result?.success) {
        this.status = 'done';
        this._notify('done');
        return { success: true, summary: normalizedArgs.summary, answer: normalizedArgs.answer || '', steps: step + 1, metrics: this._finalizeMetrics() };
      }
      if (tc.name === 'fail') {
        this.status = 'failed';
        this._notify('failed');
        return { success: false, reason: normalizedArgs.reason, steps: step + 1, metrics: this._finalizeMetrics() };
      }

      // Screenshot → vision integration
      if (tc.name === 'screenshot' && result?.success && result?.imageBase64) {
        this._appendMessage(messages, {
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ success: true, note: 'Screenshot captured and attached as image below.' }),
        });
        // Add the actual image as a vision message
        const currentProvider = this.provider.currentProvider;
        if (currentProvider?.supportsVision) {
          this._appendMessage(messages,
            currentProvider.buildVisionMessage(
              'Here is the screenshot of the current page. Describe what you see and decide the next action.',
              result.imageBase64,
              `image/${result.format || 'png'}`
            ),
          );
        } else {
          // Text-only model — don't send image, just note
          this._appendMessage(messages, {
            role: 'user',
            content: 'Screenshot was captured but cannot be displayed (text-only model). Use read_page instead.',
          });
        }
      }

      if (tc.name === 'extract_structured' && result?.success) {
        const autoDone = this._buildShoppingAutoDoneFromStructured(result);
        if (autoDone) {
          const prematureCheck = this._checkPrematureDone(autoDone);
          if (prematureCheck.ok) {
            const coverage = this._validateDoneCoverage(autoDone.summary, autoDone.answer);
            if (coverage.ok) {
              const doneResult = { success: true, summary: autoDone.summary, answer: autoDone.answer };
              this.history.push({ step, type: 'action', tool: 'done', args: { ...autoDone, auto: true }, result: doneResult });
              this._emitStep({ step, type: 'action', tool: 'done', args: { ...autoDone, auto: true }, result: doneResult });
              this.status = 'done';
              this._notify('done');
              return { success: true, summary: autoDone.summary, answer: autoDone.answer, steps: step + 1, metrics: this._finalizeMetrics() };
            }
          }
        }
      }

      if (tc.name === 'get_page_text' && result?.success !== false) {
        const autoDone = this._buildShoppingAutoDoneFromPageText(result);
        if (autoDone) {
          const prematureCheck = this._checkPrematureDone(autoDone);
          if (prematureCheck.ok) {
            const coverage = this._validateDoneCoverage(autoDone.summary, autoDone.answer);
            if (coverage.ok) {
              const doneResult = { success: true, summary: autoDone.summary, answer: autoDone.answer };
              this.history.push({ step, type: 'action', tool: 'done', args: { ...autoDone, auto: true }, result: doneResult });
              this._emitStep({ step, type: 'action', tool: 'done', args: { ...autoDone, auto: true }, result: doneResult });
              this.status = 'done';
              this._notify('done');
              return { success: true, summary: autoDone.summary, answer: autoDone.answer, steps: step + 1, metrics: this._finalizeMetrics() };
            }
          }
        }
      }

      // Failure streak: after 3+ consecutive tool failures, inject forced reasoning
      if (this._toolFailStreak >= 3 && tc.name !== 'done' && tc.name !== 'fail') {
        const failedTools = this.history
          .slice(-this._toolFailStreak)
          .filter((h) => h?.type === 'action' && h.result?.success === false)
          .map((h) => `${h.tool}(${JSON.stringify(h.args).slice(0, 80)}) → ${h.result?.code || 'FAILED'}`)
          .join('; ');
        this._appendMessage(messages, {
          role: 'user',
          content: `[SYSTEM] ${this._toolFailStreak} consecutive tool failures: ${failedTools}. STOP and RETHINK. Your current approach is not working. You MUST try a fundamentally different strategy: navigate to a direct URL (e.g. google.com/search?q=your+query), use javascript to interact with the page, or try a completely different website. Do NOT repeat similar failing actions.`,
        });
        this._toolFailStreak = 0; // Reset so we don't spam
      }
    }

    return null; // not terminal
  }

  /**
   * Execute a tool by name.
   */
  async _executeTool(name, args) {
    switch (name) {
      case 'read_page': {
        // Check observation cache (avoid redundant reads on same URL)
        let cachedUrl = '';
        try {
          const tab = await chrome.tabs.get(this.tabId);
          cachedUrl = tab?.url || '';
        } catch { /* ignore */ }
        if (cachedUrl && !args?.viewportOnly) {
          const cached = this._getCachedObservation(cachedUrl);
          if (cached) {
            return { ...cached, fromCache: true };
          }
        }

        const _read = async () => await this._sendToContent('readPage', {
          maxDepth: Math.min(Math.max(Number(args?.maxDepth) || 12, 1), 12),
          maxNodes: Math.min(Math.max(Number(args?.maxNodes) || 180, 20), 220),
          viewportOnly: args?.viewportOnly === true,
        });

        let res = await _read();

        if (res && res.url) {
          try {
            const domain = new URL(res.url).hostname;
            // Check if domain is inside pure vision list
            if (this._containsAny(domain, PURE_VISION_DOMAINS)) {
              res.tree = null;
              res.interactiveCount = 0;
              res.nodeCount = 0;
              res.note = "PURE VISION MODE ACTIVE. DOM tree is hidden for this domain. You MUST use screenshot and computer(action, x, y) to navigate and interact.";
            }
          } catch (e) {
            // Ignore URL parsing errors
          }
        }

        if (res && res.tree && !this._aborted && !this._isWaitingForUser) {
          const haystack = JSON.stringify(res.tree).toLowerCase();
          if (this._containsAny(haystack, CAPTCHA_HINTS)) {
            this._isWaitingForUser = true;
            this.status = 'paused_waiting_user';
            this._notify('paused_waiting_user');
            this._emitIntervention({
              kind: 'captcha',
              url: res.url || '',
              title: res.title || '',
              message: 'CAPTCHA detected. Please solve it manually, then press Resume.',
            });
            await new Promise(r => { this._resumeResolver = r; });
            this._resumeResolver = null;
            this._isWaitingForUser = false;

            if (!this._aborted) {
              this.status = 'running';
              this._notify('running');
              res = await _read();
            }
          }
        }
        // Cache the result for deduplication
        if (res && res.url && res.tree) {
          this._setCachedObservation(res.url, res);
        }
        return res;
      }

      case 'get_page_text':
        {
          let scope = args.scope;
          let selector = args.selector;
          const maxChars = args.maxChars;
          const currentUrl = String(this._lastKnownUrl || '');
          const isAmazonSearch = /amazon\./i.test(currentUrl) && /\/s\?/.test(currentUrl);

          // Article-like pages usually bury useful text below heavy navigation.
          if (!scope && !selector && /\/spravka\/vopros\//i.test(currentUrl)) {
            scope = 'selector';
            selector = 'main, article, [role="main"], .content, .article, .entry-content';
          }
          if (!scope && !selector && isAmazonSearch) {
            scope = 'selector';
            selector = 'div.s-result-item[data-asin], div[data-component-type="s-search-result"]';
          }

          let result = await this._sendToContent('getPageText', {
            scope,
            selector,
            maxChars,
          });

          const resultUrl = String(result?.url || '');
          const signature = `${resultUrl}|${String(result?.text || '').slice(0, 600)}`;
          if (
            isAmazonSearch &&
            Number(result?.charCount || 0) < 80 &&
            String(result?.text || '').trim().toLowerCase() === 'main content'
          ) {
            const retryAmazon = await this._sendToContent('getPageText', {
              scope: 'selector',
              selector: 'div.s-result-item[data-asin], div[data-component-type="s-search-result"]',
              maxChars,
            });
            if (Number(retryAmazon?.charCount || 0) > Number(result?.charCount || 0)) {
              retryAmazon.autoscopedFrom = scope || 'full';
              result = retryAmazon;
            }
          }
          if ((scope || 'full') === 'full' && signature && signature === this._lastPageTextSignature) {
            const retry = await this._sendToContent('getPageText', {
              scope: 'viewport',
              maxChars,
            });
            if (retry?.text && retry.text !== result?.text) {
              retry.autoscopedFrom = 'full';
              result = retry;
            }
          }
          this._lastPageTextSignature = signature;
          return result;
        }

      case 'extract_structured':
        return await this._sendToContent('extractStructured', {
          hint: args.hint,
          selector: args.selector,
          maxItems: args.maxItems,
        });

      case 'find':
        {
          const result = await this._sendToContent('find', { query: args.query });
          this._lastFindHits = Array.isArray(result) ? result.slice(0, 20) : [];
          return result;
        }

      case 'find_text':
        {
          const query = this._sanitizeFindTextQuery(args.query);
          const findPayload = {
            query,
            caseSensitive: args.caseSensitive === true,
            wholeWord: args.wholeWord === true,
            maxResults: args.maxResults,
            scrollToFirst: args.scrollToFirst !== false,
          };
          let result = await this._sendToContent('findText', findPayload);

          const fallbackNeedle = this._deriveCurrentSearchNeedle();
          const shouldRetryWithNeedle = (
            (result?.success === false || !result?.found || Number(result?.count || 0) === 0) &&
            fallbackNeedle &&
            fallbackNeedle.toLowerCase() !== String(query || '').toLowerCase()
          );
          if (shouldRetryWithNeedle) {
            const retry = await this._sendToContent('findText', {
              ...findPayload,
              query: fallbackNeedle,
            });
            if (retry?.found || Number(retry?.count || 0) > Number(result?.count || 0)) {
              retry.autocorrectedQuery = { from: query, to: fallbackNeedle };
              result = retry;
            }
          }

          return result;
        }

      case 'navigate':
        {
          const validatedUrl = this._validateNavigateUrl(args.url);
          const siteBlocked = this._checkSiteBlocked(validatedUrl);
          if (siteBlocked) return this._makeError('SITE_BLOCKED', siteBlocked);
          await this._clearFindTextContext();
          await chrome.tabs.update(this.tabId, { url: validatedUrl });
          await this._waitForNavigation();
          // Enable monitoring on new page
          try {
            await this._sendToContent('startMonitoring', {});
          } catch (err) {
            debugWarn('tool.navigate.startMonitoring', err);
          }
          // Detect redirect — warn the model if final URL differs from requested
          const result = { success: true, url: validatedUrl };
          try {
            const tab = await chrome.tabs.get(this.tabId);
            const finalUrl = tab?.url || '';
            if (finalUrl && finalUrl !== validatedUrl) {
              const reqHost = new URL(validatedUrl).hostname;
              const finalHost = new URL(finalUrl).hostname;
              if (reqHost !== finalHost) {
                result.redirected = true;
                result.finalUrl = finalUrl;
                result.warning = `Site redirected you to ${finalUrl} instead of ${validatedUrl}. You are NOT on the requested page. Adapt: try a direct search URL (e.g. site.com/search?q=...) or use a different site.`;
              } else {
                result.finalUrl = finalUrl;
              }
            }
          } catch (err) {
            debugWarn('tool.navigate.redirectCheck', err);
          }
          // Auto-read: always return page text with navigate so the model sees the content
          try {
            const pageData = await this._sendToContent('getPageText', {});
            if (pageData?.text) {
              result.pageText = pageData.text.slice(0, 3000);
              result.pageTitle = pageData.title || '';
              result.pageUrl = pageData.url || '';
            }
          } catch (err) {
            debugWarn('tool.navigate.autoRead', err);
          }
          return result;
        }

      case 'back':
        return await this._navigateHistory('back');

      case 'click':
        {
          let clickResult = await this._sendToContent('executeAction', {
            type: 'click',
            target: args.target,
            params: { confirm: args.confirm === true, button: args.button, clickCount: args.clickCount },
          });
          if (clickResult?.success === false && (clickResult.code === 'INVALID_TARGET' || clickResult.code === 'ELEMENT_NOT_FOUND')) {
            const candidate = this._pickClickTargetFromFindHits(args.target);
            if (candidate !== null && candidate !== undefined && Number(candidate) !== Number(args.target)) {
              const retry = await this._sendToContent('executeAction', {
                type: 'click',
                target: candidate,
                params: { confirm: args.confirm === true, button: args.button, clickCount: args.clickCount },
              });
              if (retry?.success) {
                retry.autocorrectedTarget = { from: args.target, to: candidate };
                return retry;
              }
              clickResult = retry;
            }
          }
          return clickResult;
        }

      case 'type':
        {
          let typeResult = await this._sendToContent('executeAction', {
            type: 'type',
            target: args.target,
            params: { text: args.text, enter: args.enter },
          });
          // Auto-correct target using most recent find() hits when model picked wrong id.
          if (typeResult?.success === false && (typeResult.code === 'INVALID_TARGET' || typeResult.code === 'ELEMENT_NOT_FOUND')) {
            const candidate = this._pickTypeTargetFromFindHits(args.target);
            if (candidate !== null && candidate !== undefined) {
              const retry = await this._sendToContent('executeAction', {
                type: 'type',
                target: candidate,
                params: { text: args.text, enter: args.enter },
              });
              if (retry?.success) {
                retry.autocorrectedTarget = { from: args.target, to: candidate };
                return retry;
              }
              typeResult = retry;
            }
          }
          // Hint: if type fails on a non-input element, suggest search URL approach
          if (typeResult?.success === false && (typeResult.code === 'INVALID_TARGET' || typeResult.code === 'ELEMENT_NOT_FOUND')) {
            typeResult.hint = 'If you are trying to search on this site, navigate directly to a search URL instead (e.g. site.com/search?q=your+query or google.com/search?q=your+query).';
          }
          return typeResult;
        }

      case 'scroll':
        return await this._sendToContent('executeAction', {
          type: 'scroll',
          target: args.direction,
          params: { amount: args.amount || 500 },
        });

      case 'hover':
        return await this._sendToContent('executeAction', {
          type: 'hover',
          target: args.target,
          params: {},
        });

      case 'select':
        return await this._sendToContent('executeAction', {
          type: 'select',
          target: args.target,
          params: { value: args.value },
        });

      case 'press_key':
        return await this._sendToContent('executeAction', {
          type: 'press_key',
          target: null,
          params: { key: args.key, modifiers: args.modifiers },
        });

      case 'javascript':
        return await this._executeJavaScriptMainWorld(args.code);

      case 'wait_for':
        return await this._waitForCondition(args);

      case 'http_request':
        return await this._httpRequest(args);

      case 'notify_connector':
        return await this._notifyConnector(args);

      case 'list_tabs':
        return await this._listTabs();

      case 'switch_tab':
        return await this._switchTab(args);

      case 'open_tab':
        return await this._openTab(args);

      case 'screenshot':
        if (!this._providerSupportsVision()) {
          return {
            success: true,
            note: 'Screenshot skipped — text-only model. Use read_page for page structure.',
            fallback: 'read_page',
          };
        }
        return await this._takeScreenshot();

      case 'done':
        return { success: true, summary: args.summary, answer: args.answer || '' };

      case 'save_progress':
        return this._saveProgress(args);

      case 'fail':
        return { success: false, reason: args.reason };

      default:
        return this._makeError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }
  }

  /**
   * Send message to content script in the active tab.
   */
  async _sendToContent(action, payload) {
    let tabUrlBefore;
    try {
      const tab = await chrome.tabs.get(this.tabId);
      tabUrlBefore = tab.url;
    } catch (e) { }

    try {
      const response = await chrome.tabs.sendMessage(this.tabId, { action, payload });
      return response ?? this._makeError('EMPTY_CONTENT_RESPONSE', 'No response from content script');
    } catch (err) {
      const msg = String(err?.message || err);
      const needsInjection =
        msg.includes('Receiving end does not exist') ||
        msg.includes('Could not establish connection');

      if (needsInjection) {
        // ARCHITECTURAL FIX: Check if we disconnected because the action triggered a page navigation
        let navigated = false;
        try {
          const tab = await chrome.tabs.get(this.tabId);
          if (tab.status === 'loading' || (tabUrlBefore && tab.url !== tabUrlBefore)) {
            navigated = true;
          }
        } catch (e) { }

        if (navigated && (action === 'executeAction' || action === 'upload_file')) {
          // The action successfully triggered a navigation, which killed the content script.
          // Do NOT retry the action on the new page.
          return { success: true, description: `Executed ${payload?.type || action}, which triggered a page navigation.` };
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.tabId },
            files: ['src/content/content.js'],
          });
          const retryResponse = await chrome.tabs.sendMessage(this.tabId, { action, payload });
          return retryResponse ?? this._makeError('EMPTY_CONTENT_RESPONSE', 'No response from content script');
        } catch (injectErr) {
          return this._makeError('CONTENT_SCRIPT_UNAVAILABLE', `Content script injection failed: ${injectErr.message}`);
        }
      }

      return this._makeError('CONTENT_COMMUNICATION_FAILED', `Content script communication failed: ${msg}`);
    }
  }

  /**
   * Take a screenshot of the current tab.
   */
  async _takeScreenshot() {
    const MAX_WIDTH = 1280;
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: 'jpeg',
        quality: 50,
      });

      // Downscale image to a sensible size for vision models
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const MAX_WIDTH = 1280;
      let width = bitmap.width;
      let height = bitmap.height;
      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width);
        width = MAX_WIDTH;
      }
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);

      const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
      const buffer = await resizedBlob.arrayBuffer();

      const chunks = [];
      const arr = new Uint8Array(buffer);
      for (let i = 0; i < arr.length; i += 1024) {
        chunks.push(String.fromCharCode.apply(null, arr.subarray(i, i + 1024)));
      }
      const base64 = btoa(chunks.join(''));

      return {
        success: true,
        imageBase64: base64,
        format: 'jpeg',
      };
    } catch (err) {
      return this._makeError('SCREENSHOT_FAILED', `Screenshot failed: ${err.message}`);
    }
  }

  async _executeJavaScriptMainWorld(code) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'MAIN',
        func: (source) => {
          try {
            // eslint-disable-next-line no-eval
            const value = (0, eval)(source);
            if (value === undefined) return { success: true, result: 'undefined' };
            if (value === null) return { success: true, result: 'null' };
            // Serialize objects/arrays as JSON so the agent can read structured data
            if (typeof value === 'object') {
              try {
                const json = JSON.stringify(value, null, 2);
                return { success: true, result: json.slice(0, 10000) };
              } catch {
                return { success: true, result: String(value).slice(0, 5000) };
              }
            }
            return { success: true, result: String(value).slice(0, 5000) };
          } catch (err) {
            return {
              success: false,
              code: 'JS_EXEC_FAILED',
              error: err?.message || String(err),
            };
          }
        },
        args: [String(code ?? '')],
      });
      return injection?.result || this._makeError('JS_EXEC_FAILED', 'No result from JS execution');
    } catch (err) {
      return this._makeError('JS_EXEC_FAILED', err.message);
    }
  }

  async _navigateHistory(direction) {
    try {
      this._invalidateObsCache();
      await this._clearFindTextContext();
      if (direction === 'back') {
        if (typeof chrome.tabs.goBack === 'function') {
          await chrome.tabs.goBack(this.tabId);
        } else {
          await this._executeJavaScriptMainWorld('history.back()');
        }
      } else if (direction === 'forward') {
        if (typeof chrome.tabs.goForward === 'function') {
          await chrome.tabs.goForward(this.tabId);
        } else {
          await this._executeJavaScriptMainWorld('history.forward()');
        }
      } else {
        return this._makeError('INVALID_ACTION', `Unknown history direction: ${direction}`);
      }
      await this._waitForNavigation();
      try {
        await this._sendToContent('startMonitoring', {});
      } catch (err) {
        debugWarn('tool.history.startMonitoring', err);
      }
      return { success: true, direction };
    } catch (err) {
      return this._makeError('HISTORY_NAV_FAILED', err.message, { direction });
    }
  }

  async _waitForCondition(args = {}) {
    const condition = args.condition || 'navigation_complete';
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10000, 100), 120000);
    const pollMs = Math.min(Math.max(Number(args.pollMs) || 250, 50), 5000);
    const startedAt = Date.now();

    if (condition === 'element') {
      const target = args.target;
      const result = await this._sendToContent('waitForElement', {
        agentId: target,
        timeout: timeoutMs,
      });
      if (result?.found) {
        return { success: true, condition, target, waitedMs: Date.now() - startedAt };
      }
      return this._makeError('WAIT_TIMEOUT', `Element [${target}] did not appear in time`, { condition, waitedMs: Date.now() - startedAt });
    }

    if (condition === 'navigation_complete') {
      // Record URL before waiting — if it doesn't change, navigation didn't happen
      let urlBefore = '';
      try {
        const tabBefore = await chrome.tabs.get(this.tabId);
        urlBefore = tabBefore?.url || '';
      } catch (_) { /* ignore */ }

      await this._waitForNavigation(timeoutMs);

      let urlAfter = '';
      try {
        const tabAfter = await chrome.tabs.get(this.tabId);
        urlAfter = tabAfter?.url || '';
      } catch (_) { /* ignore */ }

      const navigated = urlAfter && urlBefore && urlAfter !== urlBefore;
      if (!navigated && Date.now() - startedAt >= timeoutMs - 500) {
        return this._makeError('WAIT_TIMEOUT', 'Navigation did not occur — URL unchanged after timeout. Try clicking the submit button directly or use navigate() instead.', { condition, urlBefore, urlAfter, waitedMs: Date.now() - startedAt });
      }
      return { success: true, condition, urlBefore, urlAfter, waitedMs: Date.now() - startedAt };
    }

    if (condition === 'url_includes') {
      const needle = String(args.value || '').trim();
      if (!needle) return this._makeError('INVALID_WAIT_ARGUMENTS', 'wait_for(url_includes) requires value');
      while ((Date.now() - startedAt) < timeoutMs) {
        const tab = await chrome.tabs.get(this.tabId);
        const url = String(tab?.url || '');
        if (url.includes(needle)) {
          return { success: true, condition, value: needle, url, waitedMs: Date.now() - startedAt };
        }
        await this._sleep(pollMs);
      }
      return this._makeError('WAIT_TIMEOUT', `URL did not include "${needle}" in time`, { condition, waitedMs: Date.now() - startedAt });
    }

    if (condition === 'text') {
      const needle = String(args.value || '').trim();
      if (!needle) return this._makeError('INVALID_WAIT_ARGUMENTS', 'wait_for(text) requires value');
      const needleNorm = needle.toLowerCase();
      while ((Date.now() - startedAt) < timeoutMs) {
        const page = await this._sendToContent('getPageText', {});
        const haystack = String(page?.text || '').toLowerCase();
        if (haystack.includes(needleNorm)) {
          return { success: true, condition, value: needle, waitedMs: Date.now() - startedAt };
        }
        await this._sleep(pollMs);
      }
      return this._makeError('WAIT_TIMEOUT', `Text "${needle}" did not appear in time`, { condition, waitedMs: Date.now() - startedAt });
    }

    if (condition === 'network_idle') {
      const idleMs = Math.min(Math.max(Number(args.idleMs) || 1200, 200), 30000);
      let since = Date.now();
      let lastActivity = Date.now();

      while ((Date.now() - startedAt) < timeoutMs) {
        const events = await this._sendToContent('readNetwork', { since });
        if (Array.isArray(events) && events.length > 0) {
          const lastTs = events.reduce((acc, e) => Math.max(acc, Number(e.timestamp) || 0), since);
          since = lastTs + 1;
          lastActivity = Date.now();
        }
        if ((Date.now() - lastActivity) >= idleMs) {
          return { success: true, condition, idleMs, waitedMs: Date.now() - startedAt };
        }
        await this._sleep(pollMs);
      }
      return this._makeError('WAIT_TIMEOUT', 'Network did not become idle in time', { condition, waitedMs: Date.now() - startedAt });
    }

    return this._makeError('INVALID_WAIT_CONDITION', `Unsupported wait_for condition: ${condition}`);
  }

  async _listTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return {
      success: true,
      currentTabId: this.tabId,
      tabs: tabs.map((t) => ({
        id: t.id,
        index: t.index,
        active: !!t.active,
        title: t.title || '',
        url: t.url || '',
        pinned: !!t.pinned,
      })),
    };
  }

  async _switchTab(args = {}) {
    let targetTab = null;

    if (args.tabId !== undefined && args.tabId !== null) {
      const id = Number(args.tabId);
      if (Number.isInteger(id)) {
        targetTab = await chrome.tabs.get(id);
      }
    } else if (args.index !== undefined && args.index !== null) {
      const index = Number(args.index);
      if (Number.isInteger(index) && index >= 0) {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        targetTab = tabs.find((t) => t.index === index) || null;
      }
    }

    if (!targetTab?.id) {
      return this._makeError('TAB_NOT_FOUND', 'switch_tab requires a valid tabId or index');
    }

    await chrome.tabs.update(targetTab.id, { active: true });
    this.tabId = targetTab.id;
    try {
      await this._sendToContent('startMonitoring', {});
      await this._clearFindTextContext();
    } catch (err) {
      debugWarn('tool.switchTab.startMonitoring', err);
    }
    return {
      success: true,
      tabId: targetTab.id,
      index: targetTab.index,
      title: targetTab.title || '',
      url: targetTab.url || '',
    };
  }

  async _openTab(args = {}) {
    const url = this._validateNavigateUrl(args.url);
    const siteBlocked = this._checkSiteBlocked(url);
    if (siteBlocked) return this._makeError('SITE_BLOCKED', siteBlocked);
    const active = args.active !== false;
    const tab = await chrome.tabs.create({ url, active });
    if (tab?.id) {
      // Try to add the new tab to the "Browser Agent" group
      try {
        const existingGroups = await chrome.tabGroups.query({ title: 'Browser Agent' });
        if (existingGroups.length > 0) {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: existingGroups[0].id });
        } else {
          const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
          await chrome.tabGroups.update(groupId, { title: 'Browser Agent', color: 'blue' });
        }
      } catch (err) {
        debugWarn('tool.openTab.tabGrouping', err);
      }
    }
    if (active && tab?.id) {
      this.tabId = tab.id;
      await this._waitForNavigation();
      try {
        await this._sendToContent('startMonitoring', {});
        await this._clearFindTextContext();
      } catch (err) {
        debugWarn('tool.openTab.startMonitoring', err);
      }
    }
    return { success: true, tabId: tab?.id, url, active: !!active };
  }

  async _closeTab(args = {}) {
    const tabId = args.tabId !== undefined && args.tabId !== null
      ? Number(args.tabId)
      : this.tabId;
    if (!Number.isInteger(tabId)) {
      return this._makeError('INVALID_TAB_ID', 'close_tab requires a valid tabId');
    }
    await chrome.tabs.remove(tabId);
    if (tabId === this.tabId) {
      const [next] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (next?.id) {
        this.tabId = next.id;
        try {
          await this._sendToContent('startMonitoring', {});
          await this._clearFindTextContext();
        } catch (err) {
          debugWarn('tool.closeTab.startMonitoring', err);
        }
      }
    }
    return { success: true, closedTabId: tabId, currentTabId: this.tabId };
  }

  async _clearFindTextContext() {
    try {
      await this._sendToContent('clearFindText', {});
    } catch {
      // Best-effort cleanup; ignore failures on restricted pages.
    }
  }

  /**
   * Make an arbitrary HTTP request from the service worker context (no CORS restrictions).
   * Security guardrails:
   *  - Only http/https schemes
   *  - No credentials embedded in URL
   *  - SSRF protection: private/loopback IPs blocked unless allow_private:true
   *  - Forbidden headers stripped
   *  - Request body capped at 1 MB
   *  - Response body capped at 20 000 chars
   *  - Audit log on every call
   */
  async _httpRequest(args = {}) {
    const method = (args.method || 'GET').toUpperCase();
    const rawUrl = String(args.url || '').trim();
    if (!rawUrl) return this._makeError('HTTP_REQUEST_INVALID', 'url is required');

    // --- URL parse & scheme check ---
    let parsedUrl;
    try { parsedUrl = new URL(rawUrl); } catch {
      return this._makeError('HTTP_REQUEST_INVALID', `Invalid URL: "${rawUrl}"`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return this._makeError('HTTP_REQUEST_BLOCKED',
        `Scheme "${parsedUrl.protocol}" is not allowed. Only http and https are permitted.`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      return this._makeError('HTTP_REQUEST_BLOCKED',
        'Credentials embedded in URL are not allowed. Use an Authorization header instead.');
    }

    // --- SSRF protection ---
    if (!args.allow_private && isPrivateHost(parsedUrl.hostname)) {
      return this._makeError('HTTP_REQUEST_BLOCKED',
        `Requests to private/internal networks are blocked (host: "${parsedUrl.hostname}"). ` +
        'Pass allow_private:true only if you explicitly need to reach a local service.');
    }

    const timeout = Math.min(Math.max(Number(args.timeout) || 15000, 1000), 60000);

    // --- Build headers (strip forbidden) ---
    const headers = new Headers();
    if (args.headers && typeof args.headers === 'object') {
      for (const [k, v] of Object.entries(args.headers)) {
        const kl = k.toLowerCase().trim();
        if (FORBIDDEN_REQUEST_HEADERS.has(kl)) {
          console.warn(`[Agent][http_request] Blocked forbidden header: "${k}"`);
          continue;
        }
        headers.set(String(k), String(v));
      }
    }

    // --- Build body ---
    let body;
    if (args.body !== undefined && args.body !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof args.body === 'object') {
        body = JSON.stringify(args.body);
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      } else {
        body = String(args.body);
      }
      if (body.length > MAX_REQUEST_BODY_BYTES) {
        return this._makeError('HTTP_REQUEST_INVALID',
          `Request body exceeds 1 MB limit (${body.length} bytes).`);
      }
    }

    // --- Audit log (URL only — no body/credentials) ---
    console.log(`[Agent][http_request] ${method} ${parsedUrl.origin}${parsedUrl.pathname}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(rawUrl, { method, headers, body, signal: controller.signal });
      clearTimeout(timer);

      const contentType = response.headers.get('content-type') || '';
      let data;
      const text = await response.text();
      if (contentType.includes('application/json') || contentType.includes('+json')) {
        try { data = JSON.parse(text); } catch { data = text; }
      } else {
        data = text.length > MAX_RESPONSE_CHARS
          ? text.slice(0, MAX_RESPONSE_CHARS) + `\n...[truncated — ${text.length} total chars]`
          : text;
      }

      return {
        success: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return this._makeError('HTTP_TIMEOUT', `Request to "${rawUrl}" timed out after ${timeout}ms`);
      }
      return this._makeError('HTTP_REQUEST_FAILED', err.message);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check JavaScript code for dangerous patterns.
   */
  _checkJsSafety(code) {
    if (!code) return null;
    for (const { re, msg } of BLOCKED_JS_PATTERNS) {
      if (re.test(code)) return msg;
    }
    return null;
  }

  /**
   * Wait for tab navigation to complete.
   */
  _waitForNavigation(timeout = 10000) {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const timer = setTimeout(finish, timeout);
      const listener = (tabId, info) => {
        if (tabId === this.tabId && info.status === 'complete') {
          cleanup();
          setTimeout(finish, 500);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // ===== Tab URL change watcher =====

  _startTabWatcher() {
    this._onTabUpdated = (tabId, changeInfo) => {
      if (tabId === this.tabId && changeInfo.url) {
        this._lastKnownUrl = changeInfo.url;
        // Re-enable monitoring on the new page after navigation
        this._sendToContent('startMonitoring', {}).catch(() => { });
      }
    };
    chrome.tabs.onUpdated.addListener(this._onTabUpdated);
  }

  _stopTabWatcher() {
    if (this._onTabUpdated) {
      chrome.tabs.onUpdated.removeListener(this._onTabUpdated);
      this._onTabUpdated = null;
    }
  }

  abort() {
    this._aborted = true;
    if (this._resumeResolver) {
      const resolver = this._resumeResolver;
      this._resumeResolver = null;
      resolver(false);
    }
    if (this._planApprovalResolver) {
      const resolver = this._planApprovalResolver;
      this._planApprovalResolver = null;
      resolver(false);
    }
    if (this._jsDomainResolver) {
      const resolver = this._jsDomainResolver;
      this._jsDomainResolver = null;
      resolver(false);
    }
  }

  approvePlan() {
    if (this._planApprovalResolver) {
      const resolver = this._planApprovalResolver;
      this._planApprovalResolver = null;
      resolver(true);
    }
  }

  /** Pause and ask the user whether JavaScript is allowed on the given domain. */
  async _waitForJsDomainApproval(domain) {
    this.status = 'paused_waiting_user';
    this._notify('paused_waiting_user');
    this._emitIntervention({
      type: 'jsDomainPermission',
      domain,
      message: `The agent wants to execute JavaScript on "${domain}". Allow this for the current task?`,
    });
    return new Promise((resolve) => {
      this._jsDomainResolver = resolve;
      this._jsDomainDenied = false;
    });
  }

  /** Called by service worker when user approves JS on a domain. */
  allowJsDomain(domain) {
    if (domain) {
      this.trustedJsDomains.add(domain);
      // Persist trust for this session's storage
      try {
        chrome.storage.local.get('trustedJsDomains').then(({ trustedJsDomains: stored = [] }) => {
          const updated = Array.from(new Set([...stored, domain]));
          chrome.storage.local.set({ trustedJsDomains: updated });
        }).catch(() => { });
      } catch (err) {
        debugWarn('jsDomain.persistTrustedDomain', err);
      }
    }
    if (this._jsDomainResolver) {
      const resolver = this._jsDomainResolver;
      this._jsDomainResolver = null;
      this.status = 'running';
      this._notify('running');
      resolver(true);
    }
  }

  /** Called by service worker when user denies JS on a domain. */
  denyJsDomain() {
    if (this._jsDomainResolver) {
      const resolver = this._jsDomainResolver;
      this._jsDomainResolver = null;
      this.status = 'running';
      this._notify('running');
      resolver(false);
    }
  }

  resume() {
    if (this.status !== 'paused_waiting_user' || !this._resumeResolver) return false;
    const resolver = this._resumeResolver;
    this._resumeResolver = null;
    resolver(true);
    return true;
  }

  _emitStep(step) {
    if (this.onStep) this.onStep(step);
  }

  _notify(status) {
    if (this.onStatus) this.onStatus(status);
  }

  _emitIntervention(details) {
    if (this.onIntervention) this.onIntervention(details);
  }

  /**
   * Generate a plain-text plan and wait for user approval before executing.
   */
  async _generateAndWaitForPlan(goal) {
    const planMessages = [
      { role: 'system', content: 'You are a browser automation planner. Return only a numbered list of 3-7 concise, concrete browser steps for the task. Be specific (navigate/click/type/read). Do not call tools and do not add explanations.' },
      { role: 'user', content: `Task: ${goal}\n\nList your step-by-step plan.` },
    ];
    try {
      this.metrics.llmCalls += 1;
      const response = await this.provider.chat(planMessages, []);
      this._recordUsage(response?.usage);
      const plan = response.text || 'Could not generate plan.';
      if (this.onPlan) this.onPlan(plan);
    } catch (err) {
      if (this.onPlan) this.onPlan(`Plan generation failed: ${err.message}`);
    }
    return new Promise((resolve) => {
      this._planApprovalResolver = resolve;
    });
  }

  _makeError(code, error, details = {}) {
    return { success: false, code, error, ...details };
  }

  _pickTypeTargetFromFindHits(originalTarget) {
    const hits = Array.isArray(this._lastFindHits) ? this._lastFindHits : [];
    if (hits.length === 0) return null;
    const original = Number.isFinite(Number(originalTarget)) ? Number(originalTarget) : null;
    const scored = [];
    for (const hit of hits) {
      const id = Number(hit?.agentId);
      if (!Number.isFinite(id)) continue;
      const role = String(hit?.role || '').toLowerCase();
      const tag = String(hit?.tag || '').toLowerCase();
      const inputType = String(hit?.inputType || '').toLowerCase();
      const disallowedInputTypes = new Set(['button', 'submit', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset']);
      const looksLikeInput = (
        role === 'searchbox' ||
        role === 'textbox' ||
        tag === 'textarea' ||
        (tag === 'input' && role !== 'button' && !disallowedInputTypes.has(inputType))
      );
      if (!looksLikeInput) continue;
      if (original !== null && id === original) continue;
      let score = 0;
      if (role === 'searchbox') score += 4;
      if (role === 'textbox') score += 3;
      if (tag === 'textarea') score += 2;
      if (tag === 'input') score += 1;
      const rel = Number(hit?.score);
      if (Number.isFinite(rel)) score += Math.min(Math.max(rel, 0), 25) / 25;
      scored.push({ id, score });
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0].id;
  }

  _pickClickTargetFromFindHits(originalTarget) {
    const hits = Array.isArray(this._lastFindHits) ? this._lastFindHits : [];
    if (hits.length === 0) return null;
    const original = Number.isFinite(Number(originalTarget)) ? Number(originalTarget) : null;
    const scored = [];
    for (const hit of hits) {
      const id = Number(hit?.agentId);
      if (!Number.isFinite(id)) continue;
      if (original !== null && id === original) continue;
      const role = String(hit?.role || '').toLowerCase();
      const tag = String(hit?.tag || '').toLowerCase();
      let score = 0;
      if (['button', 'link', 'menuitem', 'tab', 'option'].includes(role)) score += 3;
      if (tag === 'button' || tag === 'a' || tag === 'summary') score += 3;
      if (tag === 'input' || tag === 'select') score += 1;
      if (String(hit?.text || '').trim()) score += 1;
      const rel = Number(hit?.score);
      if (Number.isFinite(rel)) score += Math.min(Math.max(rel, 0), 25) / 25;
      scored.push({ id, score });
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    return scored[0].id;
  }

  _deriveCurrentSearchNeedle() {
    const fromUrl = [];
    const currentUrl = String(this._lastKnownUrl || '');
    if (currentUrl) {
      try {
        const parsed = new URL(currentUrl);
        for (const key of ['query', 'q', 'search', 'text', 's']) {
          const value = String(parsed.searchParams.get(key) || '').trim();
          if (value) fromUrl.push(value);
        }
      } catch {
        // ignore bad URL in state
      }
    }
    const candidates = [...fromUrl, String(this._deriveGoalQuery?.() || '').trim()]
      .map((q) => q.trim())
      .filter(Boolean);
    if (candidates.length === 0) return '';
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0].slice(0, 120);
  }

  _countRecentActionsByTool(toolNames, windowSize = 8) {
    const tools = toolNames instanceof Set ? toolNames : new Set(toolNames || []);
    if (tools.size === 0) return 0;
    const recent = this.history
      .slice(-Math.max(Number(windowSize) || 8, 1))
      .filter((h) => h?.type === 'action');
    let count = 0;
    for (const item of recent) {
      if (tools.has(item.tool)) count += 1;
    }
    return count;
  }

  _extractActionUrl(entry) {
    const result = entry?.result;
    const url = result?.url || result?.page_url || result?.pageUrl || result?.finalUrl || '';
    return String(url || '').trim();
  }

  _isHighSignalObservation(entry) {
    if (!entry || entry.type !== 'action') return false;
    const result = entry.result;
    if (result?.success === false) return false;
    switch (entry.tool) {
      case 'extract_structured':
        return Number(result?.count || 0) > 0;
      case 'find_text':
        return result?.found === true && Number(result?.count || 0) > 0;
      case 'get_page_text':
        return Number(result?.charCount || 0) >= 900;
      case 'find':
        return Array.isArray(result) && result.length >= 3;
      case 'javascript':
        return true;
      default:
        return false;
    }
  }

  _isLowSignalObservation(entry) {
    if (!entry || entry.type !== 'action') return false;
    const result = entry.result;
    switch (entry.tool) {
      case 'extract_structured':
        return Number(result?.count || 0) === 0;
      case 'find_text':
        return result?.found === false || Number(result?.count || 0) === 0;
      case 'get_page_text':
        return Number(result?.charCount || 0) < 700;
      case 'find':
        return Array.isArray(result) ? result.length === 0 : true;
      case 'read_page':
      case 'scroll':
      case 'wait_for':
        return true;
      default:
        return false;
    }
  }

  _shouldForceVisionProbe(nextTool) {
    if (!this._providerSupportsVision()) return false;
    if (nextTool === 'screenshot' || nextTool === 'done' || nextTool === 'fail') return false;

    const recent = this.history
      .slice(-8)
      .filter((h) => h?.type === 'action');
    if (recent.length < 4) return false;

    const hasRecentScreenshot = recent.some((h) => h.tool === 'screenshot');
    if (hasRecentScreenshot) return false;

    const highSignalCount = recent.filter((h) => this._isHighSignalObservation(h)).length;
    const lowSignalCount = recent.filter((h) => this._isLowSignalObservation(h)).length;
    if (highSignalCount > 0) return false;
    if (lowSignalCount < 4) return false;

    const urls = new Set(
      recent
        .map((h) => this._extractActionUrl(h))
        .filter(Boolean)
    );
    if (urls.size > 1) return false;

    return true;
  }

  _buildShoppingAutoDoneFromStructured(structuredResult) {
    const goal = String(this._goal || '');
    const goalLower = goal.toLowerCase();
    const url = String(this._lastKnownUrl || structuredResult?.page_url || '').toLowerCase();
    if (!/amazon\./i.test(`${goalLower} ${url}`)) return null;
    if (!/(find|найд|подбери|go to|amazon)/i.test(goalLower)) return null;
    if (/telegram|notion|slack|email|send|отправ/i.test(goalLower)) return null;

    const budgetMatch = goalLower.match(/(?:under|below|<=|less than|до)\s*\$?\s*(\d+(?:\.\d+)?)/i)
      || goalLower.match(/\$\s*(\d+(?:\.\d+)?)/);
    const budget = budgetMatch?.[1] ? Number(budgetMatch[1]) : null;
    if (!Number.isFinite(budget) || budget <= 0) return null;

    const rawItems = Array.isArray(structuredResult?.items) ? structuredResult.items : [];
    if (rawItems.length === 0) return null;

    const wantsHeadphones = /headphone|earbud|headset|earphone|науш/i.test(goalLower);
    const filtered = rawItems
      .filter((it) => {
        const price = Number(it?.price_value);
        if (!Number.isFinite(price) || price > budget || price <= 0) return false;
        const title = String(it?.title || '');
        if (wantsHeadphones && !/headphone|earbud|headset|earphone|buds|науш/i.test(title.toLowerCase())) {
          return false;
        }
        return title.trim().length > 0;
      })
      .sort((a, b) => Number(a?.price_value || 0) - Number(b?.price_value || 0));

    if (filtered.length === 0) return null;
    const top = filtered.slice(0, 5);
    const lines = top.map((it, idx) => {
      const title = String(it?.title || '').replace(/\s+/g, ' ').trim();
      const price = Number(it?.price_value);
      const rating = Number(it?.rating_value);
      const ratingPart = Number.isFinite(rating) ? `, rating ${rating}` : '';
      const urlPart = it?.url ? `\n${String(it.url).slice(0, 260)}` : '';
      return `${idx + 1}. ${title} — $${price.toFixed(2)}${ratingPart}${urlPart}`;
    });

    return {
      summary: `Found ${top.length} headphone options under $${budget} on Amazon.`,
      answer: `${lines.join('\n\n')}\n\nSource: ${structuredResult?.page_url || this._lastKnownUrl || ''}`,
    };
  }

  _extractAmazonItemsFromPageText(text, budget, maxItems = 8) {
    const lines = String(text || '')
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 600);
    if (lines.length === 0) return [];

    const out = [];
    const seen = new Set();
    const isNoise = (s) => /^(results|sponsored|delivery|ships to|add to cart|featured|overall pick|best seller|list:|check each product page|more results?)$/i.test(s);
    const isLikelyRating = (s) => /^\d(?:[.,]\d)?$/.test(s);
    const isLikelyCount = (s) => /^\(?[\d.,kK+]+\)?$/.test(s);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let price = null;

      if (/^[$€£¥₽₹]$/.test(line)) {
        const major = String(lines[i + 1] || '').trim();
        const minor = String(lines[i + 2] || '').trim();
        if (/^\d{1,4}$/.test(major) && /^\d{2}$/.test(minor)) {
          price = Number.parseFloat(`${major}.${minor}`);
        } else if (/^\d{1,4}(?:[.,]\d{1,2})?$/.test(major)) {
          price = Number.parseFloat(major.replace(',', '.'));
        }
      } else {
        const m = line.match(/\$\s*(\d{1,4}(?:[.,]\d{1,2})?)/);
        if (m?.[1]) price = Number.parseFloat(m[1].replace(',', '.'));
      }
      if (!Number.isFinite(price) || price <= 0 || price > budget) continue;

      let title = '';
      for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
        const candidate = lines[j];
        if (candidate.length < 14) continue;
        if (isNoise(candidate) || isLikelyRating(candidate) || isLikelyCount(candidate)) continue;
        if (/^\$/.test(candidate)) continue;
        title = candidate.slice(0, 240);
        break;
      }
      if (!title) continue;
      if (!/headphone|earbud|headset|earphone|buds|науш/i.test(title.toLowerCase())) continue;

      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      let rating = null;
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const r = lines[j];
        if (/^\d(?:[.,]\d)?$/.test(r)) {
          const n = Number.parseFloat(r.replace(',', '.'));
          if (Number.isFinite(n) && n >= 0 && n <= 5) {
            rating = n;
            break;
          }
        }
      }

      out.push({ title, price_value: price, rating_value: rating });
      if (out.length >= maxItems) break;
    }

    return out;
  }

  _buildShoppingAutoDoneFromPageText(pageResult) {
    const goal = String(this._goal || '');
    const goalLower = goal.toLowerCase();
    const url = String(this._lastKnownUrl || pageResult?.url || '').toLowerCase();
    if (!/amazon\./i.test(`${goalLower} ${url}`)) return null;
    if (!/(find|найд|подбери|go to|amazon)/i.test(goalLower)) return null;
    if (/telegram|notion|slack|email|send|отправ/i.test(goalLower)) return null;

    const budgetMatch = goalLower.match(/(?:under|below|<=|less than|до)\s*\$?\s*(\d+(?:\.\d+)?)/i)
      || goalLower.match(/\$\s*(\d+(?:\.\d+)?)/);
    const budget = budgetMatch?.[1] ? Number(budgetMatch[1]) : null;
    if (!Number.isFinite(budget) || budget <= 0) return null;

    const text = String(pageResult?.text || '');
    const items = this._extractAmazonItemsFromPageText(text, budget, 8);
    if (items.length === 0) return null;

    const top = items.slice(0, 5);
    const lines = top.map((it, idx) => {
      const ratingPart = Number.isFinite(Number(it?.rating_value)) ? `, rating ${Number(it.rating_value)}` : '';
      return `${idx + 1}. ${String(it?.title || '').trim()} — $${Number(it?.price_value || 0).toFixed(2)}${ratingPart}`;
    });

    return {
      summary: `Found ${top.length} headphone options under $${budget} on Amazon.`,
      answer: `${lines.join('\n\n')}\n\nSource: ${pageResult?.url || this._lastKnownUrl || ''}`,
    };
  }

  _sanitizeFindTextQuery(rawQuery) {
    let query = String(rawQuery || '').trim();
    if (!query) query = this._deriveCurrentSearchNeedle();
    query = query
      .replace(/^как\s+правильно\s+пишется\s+/i, '')
      .replace(/^как\s+пишется\s+/i, '')
      .replace(/\s+на\s+(?:сайте\s+)?gramota\s*\.?\s*ru.*$/i, '')
      .replace(/\s+на\s+(?:сайте\s+)?грамот[аеы]?\s*\.?\s*ру.*$/i, '')
      .replace(/\s+и\s+отправь.*$/i, '')
      .replace(/\s+отправь.*$/i, '')
      .replace(/\s+в\s+телеграм.*$/i, '')
      .replace(/^["'«“„]+|["'»”‟]+$/g, '')
      .trim();
    if (!query) query = this._deriveCurrentSearchNeedle();
    if (query.length > 120) query = query.slice(0, 120).trim();
    return query;
  }

  _shouldAvoidJavascriptForGoal() {
    const goal = String(this._goal || '').toLowerCase();
    const infoLike = /(как\s+пишется|как\s+правильно|найди|узнай|проверь|search|find|lookup|look up|spelling)/i.test(goal);
    return infoLike && Number(this._toolFailStreak || 0) < 2;
  }

  _sanitizePlannedAction(nextAction = {}) {
    const tool = String(nextAction?.tool || '').trim();
    const args = nextAction?.args && typeof nextAction.args === 'object' ? { ...nextAction.args } : {};
    const currentUrl = String(this._lastKnownUrl || '').toLowerCase();
    const isAmazonSearch = /amazon\./i.test(currentUrl) && /\/s\?/.test(currentUrl);

    if (tool === 'click') {
      const targetNum = Number(args.target);
      if (!Number.isFinite(targetNum) || targetNum <= 0) {
        const candidate = this._pickClickTargetFromFindHits(args.target);
        if (candidate !== null && candidate !== undefined) args.target = candidate;
      }
    }

    if (tool === 'find_text') {
      args.query = this._sanitizeFindTextQuery(args.query);
      const miss = this._lastFindTextMiss;
      const normalizedQuery = String(args.query || '').trim().toLowerCase();
      if (
        miss &&
        normalizedQuery &&
        miss.query === normalizedQuery &&
        miss.url &&
        miss.url === String(this._lastKnownUrl || '')
      ) {
        const fallback = this._deriveCurrentSearchNeedle();
        if (fallback && fallback.toLowerCase() !== normalizedQuery) {
          args.query = fallback;
        } else if (/gramota\.ru\/spravka\/vopros\//i.test(String(this._lastKnownUrl || ''))) {
          args.query = 'Правильно';
        }
      }
    }

    if (tool === 'extract_structured') {
      if (!args.hint && /amazon\./i.test(String(this._lastKnownUrl || ''))) {
        args.hint = 'product cards';
      }
      if (!args.maxItems && /amazon\./i.test(String(this._lastKnownUrl || ''))) {
        args.maxItems = 24;
      }
    }

    if (tool === 'notify_connector') {
      if (!args.connectorId && /telegram|телеграм/i.test(String(this._goal || ''))) {
        if (this._connectedConnectorIds.includes('telegram')) args.connectorId = 'telegram';
      }
    }

    if (tool === 'javascript' && this._shouldAvoidJavascriptForGoal()) {
      return { tool: 'read_page', args: {} };
    }

    if (isAmazonSearch) {
      const lowSignalTools = new Set(['find', 'find_text', 'read_page', 'get_page_text', 'scroll', 'wait_for']);
      const lowSignalCount = this._countRecentActionsByTool(lowSignalTools, 8);
      const recentStructured = this._countRecentActionsByTool(new Set(['extract_structured']), 8);
      const queryText = String(args.query || '').toLowerCase();
      const looksLikeFilterHunt = /price filter|under\s*\$|sort|budget|дешев|цена|фильтр/.test(queryText);
      if (
        tool !== 'extract_structured' &&
        (looksLikeFilterHunt || (lowSignalTools.has(tool) && lowSignalCount >= 2 && recentStructured === 0))
      ) {
        return { tool: 'extract_structured', args: { hint: 'product cards', maxItems: 24 } };
      }
    }

    if (this._shouldForceVisionProbe(tool)) {
      return { tool: 'screenshot', args: {} };
    }

    return { tool, args };
  }

  async _notifyConnector(args = {}) {
    const connectorId = String(args.connectorId || '').trim();
    const message = String(args.message || '').trim();

    if (!connectorId) {
      return this._makeError('INVALID_NOTIFY_CONNECTOR', 'notify_connector requires connectorId');
    }
    if (!message) {
      return this._makeError('INVALID_NOTIFY_CONNECTOR', 'notify_connector requires non-empty message');
    }
    if (this._notifyConnectorCalls >= 3) {
      return this._makeError('NOTIFY_CONNECTOR_LIMIT', 'notify_connector limit reached (max 3 calls per task)');
    }

    const meta = {
      source: 'agent_tool',
      goal: String(this._goal || ''),
      step: this.history.length,
      tabId: this.tabId,
    };

    let runtimeError = null;
    if (chrome?.runtime?.sendMessage) {
      try {
        const runtimeResponse = await new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('notify_connector timed out'));
          }, 7000);

          try {
            chrome.runtime.sendMessage({ type: 'notifyConnector', connectorId, message, meta }, (response) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(response || null);
            });
          } catch (err) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });

        if (runtimeResponse?.ok) {
          this._notifyConnectorCalls += 1;
          return {
            success: true,
            connectorId,
            delivered: true,
            path: 'runtime_message',
            delivery: runtimeResponse.delivery || null,
          };
        }
        if (runtimeResponse?.ok === false) {
          runtimeError = new Error(runtimeResponse.error || 'Connector notification failed');
        }
      } catch (err) {
        runtimeError = err;
      }
    }

    if (typeof this.onNotifyConnector === 'function') {
      try {
        const result = await this.onNotifyConnector({ connectorId, message, meta });
        if (result?.success !== false) {
          this._notifyConnectorCalls += 1;
          return {
            success: true,
            connectorId,
            delivered: true,
            path: 'direct_callback',
            delivery: result?.delivery || null,
          };
        }
        return this._makeError('CONNECTOR_NOTIFY_FAILED', result?.error || 'Connector notification failed');
      } catch (err) {
        return this._makeError('CONNECTOR_NOTIFY_FAILED', err?.message || String(err));
      }
    }

    return this._makeError(
      'CONNECTOR_NOTIFY_FAILED',
      runtimeError?.message || 'Connector notification unavailable in this runtime',
    );
  }

  _buildSystemPrompt() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const datePrefix = `Today's date: ${dateStr}.\n\n`;
    if (this._isOllamaQwen3VL()) {
      return `${datePrefix}${SYSTEM_PROMPT}${QWEN3VL_OLLAMA_SYSTEM_ADDENDUM}`;
    }
    if (this._isFireworksKimiK2P5()) {
      return `${datePrefix}${SYSTEM_PROMPT}${FIREWORKS_KIMI_K2P5_SYSTEM_ADDENDUM}`;
    }
    if (this._isGroqLlama4Maverick()) {
      return `${datePrefix}${SYSTEM_PROMPT}${GROQ_LLAMA4_MAVERICK_SYSTEM_ADDENDUM}`;
    }
    if (this._isSiliconFlowGLM()) {
      return `${datePrefix}${SYSTEM_PROMPT}${SILICONFLOW_GLM_SYSTEM_ADDENDUM}`;
    }
    return `${datePrefix}${SYSTEM_PROMPT}`;
  }

  _isOllamaQwen3VL() {
    const primary = this.provider?.config?.primary;
    if (primary !== 'ollama') return false;
    const configuredModel = this.provider?.config?.providers?.ollama?.model;
    const runtimeModel = this.provider?.providers?.ollama?.model;
    const model = String(configuredModel || runtimeModel || '').toLowerCase();
    return /qwen3[-_]?vl/.test(model);
  }

  _isFireworksKimiK2P5() {
    const primary = this.provider?.config?.primary;
    if (primary !== 'fireworks') return false;
    const configuredModel = this.provider?.config?.providers?.fireworks?.model;
    const runtimeModel = this.provider?.providers?.fireworks?.model;
    const model = String(configuredModel || runtimeModel || '').toLowerCase();
    return /kimi[-_]?k2p?5|kimi-k2\.5|accounts\/fireworks\/models\/kimi-k2p5/.test(model);
  }

  _isGroqLlama4Maverick() {
    const primary = this.provider?.config?.primary;
    if (primary !== 'groq') return false;
    const configuredModel = this.provider?.config?.providers?.groq?.model;
    const runtimeModel = this.provider?.providers?.groq?.model;
    const model = String(configuredModel || runtimeModel || '').toLowerCase();
    return /llama[-_]?4[-_]?maverick|meta-llama\/llama-4-maverick-17b-128e-instruct/.test(model);
  }

  _isSiliconFlowGLM() {
    const primary = this.provider?.config?.primary;
    if (primary !== 'siliconflow') return false;
    const configuredModel = this.provider?.config?.providers?.siliconflow?.model;
    const runtimeModel = this.provider?.providers?.siliconflow?.model;
    const model = String(configuredModel || runtimeModel || '').toLowerCase();
    return /glm[-_]?4\.6v|zai-org\/glm-4\.6v/.test(model);
  }

  _checkSiteBlocked(url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      for (const blocked of this.blockedDomains) {
        const b = blocked.replace(/^www\./, '').toLowerCase();
        if (hostname === b || hostname.endsWith('.' + b)) {
          return `Navigation to "${hostname}" is blocked by the site blocklist. Remove the domain from the blocklist in Settings if you need access.`;
        }
      }
    } catch (err) {
      debugWarn('checkSiteBlocked.parseUrl', err);
    }
    return null;
  }

  _finalizeOnStepLimit() {
    return {
      success: false,
      reason: `Max steps reached (${this.maxSteps}) before explicit done().`,
      steps: this.maxSteps,
      metrics: this._finalizeMetrics(),
    };
  }

  _validateDoneContract(summary = '', answer = '') {
    const summaryText = String(summary || '').trim();
    const answerText = String(answer || '').trim();

    const failures = [];
    if (!summaryText) {
      failures.push('done() requires non-empty summary.');
    }
    if (!answerText) {
      failures.push('done() requires non-empty answer.');
    }

    if (this.pageState.usedFindText && !this.pageState.hasReadContext) {
      failures.push('done() after find_text requires context read via read_page or get_page_text before completion.');
    }

    if (failures.length > 0) {
      return {
        ok: false,
        reason: `Completion rejected: ${failures.join(' ')}`,
        details: failures,
      };
    }

    return { ok: true, details: [] };
  }

  _repairDoneArgs(summary = '', answer = '', assistantText = '') {
    const summaryText = String(summary || '').trim();
    const answerText = String(answer || '').trim();
    if (summaryText && answerText) {
      return { repaired: false, summary: summaryText, answer: answerText };
    }

    const raw = String(assistantText || '').trim();
    if (!raw) {
      return { repaired: false, summary: summaryText, answer: answerText };
    }

    let parsed = null;
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }

    let repairedSummary = summaryText;
    let repairedAnswer = answerText;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!repairedSummary && typeof parsed.summary === 'string') {
        repairedSummary = parsed.summary.trim();
      }
      if (!repairedAnswer && typeof parsed.answer === 'string') {
        repairedAnswer = parsed.answer.trim();
      }
    }

    if (!repairedSummary || !repairedAnswer) {
      const summaryMatch = raw.match(/(?:^|\n)\s*summary\s*[:=-]\s*(.+)$/im);
      const answerMatch = raw.match(/(?:^|\n)\s*answer\s*[:=-]\s*([\s\S]+)$/im);
      if (!repairedSummary && summaryMatch?.[1]) {
        repairedSummary = summaryMatch[1].trim();
      }
      if (!repairedAnswer && answerMatch?.[1]) {
        repairedAnswer = answerMatch[1].trim();
      }
    }

    const repaired = (!summaryText && !!repairedSummary) || (!answerText && !!repairedAnswer);
    return {
      repaired,
      summary: repairedSummary,
      answer: repairedAnswer,
    };
  }

  _checkToolErrorLoopGuard(step, toolName, result) {
    const normalizedTool = String(toolName || '').trim().toLowerCase();

    // fail() is a terminal explicit decision; do not intercept it with loop recovery.
    if (normalizedTool === 'fail') {
      return null;
    }

    if (!result || result.success !== false) {
      this._lastToolErrorCode = '';
      this._sameToolErrorCount = 0;
      if (normalizedTool === 'computer') {
        this._computerErrorCode = '';
        this._computerErrorCount = 0;
      }
      return null;
    }

    const code = String(result.code || result.error || 'UNKNOWN_TOOL_ERROR').trim();
    if (!code) {
      this._lastToolErrorCode = '';
      this._sameToolErrorCount = 0;
      if (normalizedTool === 'computer') {
        this._computerErrorCode = '';
        this._computerErrorCount = 0;
      }
      return null;
    }

    // done() contract failures are recoverable: activate correction mode instead of hard fail.
    if (normalizedTool === 'done' && code === 'DONE_CONTRACT_FAILED') {
      if (this._lastToolErrorCode === 'DONE_CONTRACT_FAILED') {
        this._sameToolErrorCount += 1;
      } else {
        this._lastToolErrorCode = 'DONE_CONTRACT_FAILED';
        this._sameToolErrorCount = 1;
      }

      if (this._sameToolErrorCount >= TOOL_ERROR_LOOP_GUARD_THRESHOLD) {
        const reason = `Loop recovery triggered: DONE_CONTRACT_FAILED repeated ${this._sameToolErrorCount} times. Switching to extraction-first recovery.`;
        console.warn(`[Agent] ${reason}`);
        appendTelemetry('Agent', 'loopGuard.doneRecovery', reason);
        this._emitStep({
          step,
          type: 'pause',
          content: reason,
          code: 'DONE_CONTRACT_RECOVERY',
          repeatCount: this._sameToolErrorCount,
        });
        this._sameToolErrorCount = 0;
        this._lastToolErrorCode = '';
        return { kind: 'recover_done_contract', reason };
      }

      return null;
    }

    if (normalizedTool === 'computer' && COMPUTER_LOOP_GUARD_CODES.has(code)) {
      if (this._computerErrorCode === code) {
        this._computerErrorCount += 1;
      } else {
        this._computerErrorCode = code;
        this._computerErrorCount = 1;
      }

      if (this._computerErrorCount >= TOOL_ERROR_LOOP_GUARD_THRESHOLD) {
        const reason = `Computer loop warning: ${code} repeated ${this._computerErrorCount} times for computer actions. Continuing with self-heal (no hard stop).`;
        console.warn(`[Agent] ${reason}`);
        appendTelemetry('Agent', 'loopGuard.computerWarning', reason);
        this.history.push({
          step,
          type: 'pause',
          content: reason,
          code: 'COMPUTER_ERROR_LOOP_WARNING',
          repeatedCode: code,
          repeatCount: this._computerErrorCount,
        });
        this._emitStep({
          step,
          type: 'pause',
          content: reason,
          code: 'COMPUTER_ERROR_LOOP_WARNING',
          repeatedCode: code,
          repeatCount: this._computerErrorCount,
        });

        // Do not fail the run for computer target/action loops.
        // Keep trying with recovery instructions and refreshed observations.
        this._computerErrorCode = '';
        this._computerErrorCount = 0;
      }

      // Skip generic hard guard for known recoverable computer errors.
      return null;
    }

    if (this._lastToolErrorCode === code) {
      this._sameToolErrorCount += 1;
    } else {
      this._lastToolErrorCode = code;
      this._sameToolErrorCount = 1;
    }

    if (this._sameToolErrorCount < TOOL_ERROR_LOOP_GUARD_THRESHOLD) {
      return null;
    }

    const reason = `Loop guard triggered: ${code} repeated ${this._sameToolErrorCount} times consecutively (latest tool: ${toolName}). Stopping to prevent unproductive retries.`;
    console.warn(`[Agent] ${reason}`);
    appendTelemetry('Agent', 'loopGuard.toolErrorRecovery', reason);
    this.history.push({
      step,
      type: 'pause',
      content: reason,
      code: 'TOOL_ERROR_LOOP_RECOVERY',
      repeatedCode: code,
      repeatCount: this._sameToolErrorCount,
    });
    this._emitStep({
      step,
      type: 'pause',
      content: reason,
      code: 'TOOL_ERROR_LOOP_RECOVERY',
      repeatedCode: code,
      repeatCount: this._sameToolErrorCount,
    });

    const recoveryPrompt = this._buildLoopRecoveryPrompt(code, normalizedTool);
    this._sameToolErrorCount = 0;
    this._lastToolErrorCode = '';
    return { kind: 'recover_generic', reason, code, recoveryPrompt };
  }

  _buildLoopRecoveryPrompt(code, toolName) {
    const c = String(code || '').toUpperCase();
    if (c === 'MISSING_TARGET' || c === 'INVALID_TARGET') {
      return 'Recovery mode: repeated target errors. First call find or read_page, then use a fresh numeric target ID. If IDs stay unstable, use screenshot and computer(action="click", x=..., y=...) and reacquire a fresh target.';
    }
    if (c === 'ELEMENT_NOT_FOUND') {
      return 'Recovery mode: element keeps disappearing. Call screenshot, switch to coordinate click, then read_page to continue with fresh IDs.';
    }
    if (c === 'UNKNOWN_COMPUTER_ACTION') {
      return 'Recovery mode: use only valid computer actions: click, type, scroll, hover, select, key, drag, form_input. Retry with a valid action and arguments.';
    }
    if (c.includes('WAIT_TIMEOUT')) {
      return 'Recovery mode: waiting strategy is not working. Re-observe the page (read_page/get_page_text), then choose a different interaction path instead of repeating the same wait.';
    }
    return `Recovery mode: repeated error ${c} on tool ${toolName || 'unknown'}. Change strategy, re-observe current page state, and continue without repeating the same failing call.`;
  }

  async _attemptComputerSelfHeal(step, messages, args, result) {
    const code = String(result?.code || '').trim();
    if (!COMPUTER_LOOP_GUARD_CODES.has(code)) return false;
    if (this._computerSelfHealAttempts >= MAX_COMPUTER_SELF_HEAL_ATTEMPTS) return false;

    this._computerSelfHealAttempts += 1;
    let observation = null;
    try {
      observation = await this._executeTool('read_page', {
        maxDepth: 8,
        maxNodes: 160,
        viewportOnly: false,
      });
    } catch (err) {
      observation = this._makeError('SELF_HEAL_READ_FAILED', err?.message || String(err));
    }

    const observationSummary = observation?.success === false
      ? `Auto-read failed: ${observation?.error || observation?.code || 'unknown error'}.`
      : `Auto-read refreshed page context${observation?.url ? ` (${observation.url})` : ''}; interactive=${observation?.interactiveCount ?? '?'}.`;

    this._appendMessage(messages, {
      role: 'user',
      content: `Self-heal triggered after computer(${String(args?.action || 'unknown')}) failed with ${code}. ${observationSummary} Retry with a fresh numeric target ID from the latest page tree. Do not reuse stale or placeholder targets.`,
    });

    // Vision fallback for repeated target errors:
    // if model keeps sending null/invalid target IDs, provide screenshot guidance
    // so it can click by coordinates and then reacquire a fresh element ID.
    const shouldAttachVision =
      this._providerSupportsVision() &&
      (code === 'MISSING_TARGET' || code === 'INVALID_TARGET');

    if (shouldAttachVision) {
      try {
        const shot = await this._executeTool('screenshot', {});
        if (shot?.success && shot?.imageBase64) {
          const currentProvider = this.provider.currentProvider;
          if (currentProvider?.buildVisionMessage) {
            this._appendMessage(messages,
              currentProvider.buildVisionMessage(
                'Target ID recovery required: previous computer() calls used missing/invalid target. Use this screenshot to identify coordinates and call computer(action="click", x=..., y=...) first, then call read_page/find and continue with a fresh numeric target ID.',
                shot.imageBase64,
                shot.mimeType || 'image/jpeg',
              ),
            );
            this._emitStep({ step, type: 'pause', content: 'Self-heal: attached screenshot for coordinate fallback.' });
          }
        }
      } catch (err) {
        debugWarn('selfHeal.computer.visionFallback', err);
      }
    }

    this.metrics.selfHeals += 1;
    this._emitStep({ step, type: 'pause', content: `Self-heal: refreshed page context after ${code}.` });
    appendTelemetry('Agent', 'selfHeal.computer', `Self-heal #${this._computerSelfHealAttempts} after ${code}.`);

    // Reset computer-specific loop counter after a recovery action.
    this._computerErrorCode = '';
    this._computerErrorCount = 0;
    return true;
  }

  _recoverComputerTargetFromContext(action) {
    const targetActions = new Set(['click', 'type', 'hover', 'select', 'form_input']);
    if (!targetActions.has(String(action || '').trim().toLowerCase())) return null;
    const candidates = Array.isArray(this._lastFindResults) ? this._lastFindResults : [];
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      const id = Number(candidate?.agentId);
      if (!Number.isInteger(id)) continue;
      const score = Number(candidate?.score || 0);
      if (!Number.isFinite(score) || score < 1) continue;
      return id;
    }
    return null;
  }

  // Heuristic relevance scoring removed.

  _checkSiteBlocked(url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      for (const blocked of this.blockedDomains) {
        const b = blocked.replace(/^www\./, '').toLowerCase();
        if (hostname === b || hostname.endsWith('.' + b)) {
          return `Navigation to "${hostname}" is blocked by the site blocklist. Remove the domain from the blocklist in Settings if you need access.`;
        }
      }
    } catch (err) {
      debugWarn('checkSiteBlocked.parseUrl', err);
    }
    return null;
  }

  _validateNavigateUrl(url) {
    let raw = String(url || '').trim();
    // Auto-add https:// if LLM sends bare domain (e.g. "gramota.ru")
    if (raw && !raw.includes('://') && !raw.startsWith('about:')) {
      raw = 'https://' + raw;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid URL: "${url}". Use a full http/https URL like https://example.com`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
    }
    return parsed.toString();
  }

  _goalAllowsSensitiveActions() {
    const text = String(this._goal || '').toLowerCase();
    const allowTerms = [
      'confirm', 'i confirm', 'i approve', 'approved', 'yes, proceed',
      'подтверждаю', 'разрешаю', 'одобряю', 'можно отправить', 'можно удалить',
      'send email', 'delete', 'remove', 'pay', 'purchase', 'checkout', 'transfer',
      'отправь', 'удали', 'оплати', 'переведи', 'купи',
    ];
    return allowTerms.some((term) => text.includes(term));
  }

  _goalExplicitlyRequestsAuthPage() {
    const text = String(this._goal || '').toLowerCase();
    return [
      'login page',
      'sign in page',
      'auth page',
      'oauth page',
      'страница входа',
      'страницу входа',
      'экран входа',
      'окно входа',
    ].some((term) => text.includes(term));
  }

  _containsAny(haystack, terms) {
    if (!haystack) return false;
    return terms.some((t) => haystack.includes(t));
  }


  async _detectManualIntervention() {
    let tab;
    try {
      tab = await chrome.tabs.get(this.tabId);
    } catch {
      return null;
    }

    const url = String(tab?.url || '');
    if (!/^https?:\/\//i.test(url)) return null;
    const title = String(tab?.title || '');
    const source = `${url}\n${title}`.toLowerCase();

    let pageText = '';
    try {
      const page = await this._sendToContent('getPageText', {});
      pageText = String(page?.text || '').toLowerCase().slice(0, 10000);
    } catch {
      // Best effort: some pages are restricted.
    }

    const haystack = `${source}\n${pageText}`;
    const hasCaptcha = this._containsAny(haystack, CAPTCHA_HINTS);
    if (hasCaptcha) {
      return {
        kind: 'captcha',
        url,
        title,
        message: 'CAPTCHA detected. Please solve it manually, then press Resume.',
      };
    }

    const hasAuthUrlHint = AUTH_URL_HINT_RE.test(url) || AUTH_URL_HINT_RE.test(title);
    const hasLoginHint = this._containsAny(haystack, LOGIN_HINTS);
    const hasPasswordHint = this._containsAny(haystack, PASSWORD_HINTS);

    let hasPasswordField = false;
    let hasOtpField = false;
    try {
      const probe = await this._executeJavaScriptMainWorld(`(() => {
        const isVis = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return false;
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const pass = Array.from(document.querySelectorAll('input[type="password"], input[name*="pass" i], input[id*="pass" i]'));
        const otp = Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i]'));
        return JSON.stringify({
          hasPasswordField: pass.some(isVis),
          hasOtpField: otp.some(isVis)
        });
      })()`);
      if (probe?.success && typeof probe.result === 'string' && probe.result.startsWith('{')) {
        const parsed = JSON.parse(probe.result);
        hasPasswordField = parsed?.hasPasswordField === true;
        hasOtpField = parsed?.hasOtpField === true;
      }
    } catch {
      // No-op, fallback to URL/title/text heuristics.
    }

    const looksLikeLogin = hasPasswordField || hasOtpField || ((hasAuthUrlHint || hasLoginHint) && hasPasswordHint);
    if (!looksLikeLogin) return null;

    return {
      kind: 'login',
      url,
      title,
      message: 'Login/verification page detected. Please sign in manually, then press Resume.',
    };
  }

  async _pauseIfManualInterventionNeeded(step, messages) {
    if (this._isWaitingForUser || this._aborted) return;
    const details = await this._detectManualIntervention();
    if (!details) return;
    if (details.kind === 'login' && this._goalExplicitlyRequestsAuthPage()) return;

    this._isWaitingForUser = true;
    this.status = 'paused_waiting_user';
    this._notify('paused_waiting_user');

    const pauseStep = {
      step,
      type: 'pause',
      reason: details.message,
      url: details.url,
      kind: details.kind,
    };
    this.history.push(pauseStep);
    this._emitStep(pauseStep);
    this._emitIntervention(details);

    const resumed = await new Promise((resolve) => {
      this._resumeResolver = resolve;
    });
    this._resumeResolver = null;
    this._isWaitingForUser = false;

    if (!resumed || this._aborted) return;

    this.status = 'running';
    this._notify('running');

    this._appendMessage(messages, {
      role: 'user',
      content: 'Manual step has been completed by the user (login/CAPTCHA). Continue the original task from the current page state.',
    });
  }

}

Object.assign(Agent.prototype, contextMethods, coverageMethods, reflectionMethods, stateMethods);
