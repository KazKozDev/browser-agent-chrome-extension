/**
 * Agent Loop
 *
 * Core agent that orchestrates: observe → think → act
 * Uses accessibility tree (primary) + screenshot (vision fallback)
 * Communicates with content script for page understanding and actions.
 */

import { TOOLS } from '../tools/tools.js';
import {
  AGENT_MAX_ESTIMATED_COST_USD,
  AGENT_MAX_CONVERSATION_MESSAGES,
  AGENT_MAX_STEPS,
  AGENT_MAX_TOTAL_TOKENS,
  AGENT_MAX_WALL_CLOCK_MS,
  HUMAN_GUIDANCE_CONFIDENCE_MIN,
  HUMAN_GUIDANCE_MAX_ESCALATIONS_PER_RUN,
  HUMAN_GUIDANCE_NEAR_CONFIDENCE_MIN,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_CHARS,
  RATE_LIMIT_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
  RATE_LIMIT_MAX_RETRIES,
  REFLECTION_CHAT_SOFT_TIMEOUT_MS,
  REFLECTION_CONFIDENCE_THRESHOLD,
  REFLECTION_MAX_ACTIONS_PER_STEP,
  SNAPSHOT_MAX_ITEMS,
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

const AUTH_URL_HINT_RE = /(?:^|[/?#._-])(login|log-in|signin|sign-in|auth|authorize|oauth|challenge|verify|captcha)(?:[/?#._-]|$)/i;
const CAPTCHA_HINTS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  "i'm not a robot",
  'i am not a robot',
  'verify you are human',
  'prove you are human',
  'confirm you are not a robot',
  'i am human',
];
const LOGIN_HINTS = [
  'sign in',
  'signin',
  'log in',
  'login',
  'authentication',
  'authorize',
  'authenticate',
  'verification code',
  'two-factor',
  '2fa',
];
const PASSWORD_HINTS = [
  'password',
  'passcode',
  'one-time code',
  'one-time password',
  'otp',
  'sms code',
];

/**
 * Read-only tools safe for parallel execution.
 * These do NOT mutate page state and can run concurrently via Promise.all.
 * Excludes: screenshot (special vision handling), http_request (side effects).
 */
const PARALLEL_SAFE_TOOLS = new Set([
  'read_page',
  'get_page_text',
  'extract_structured',
  'find',
  'find_text',
  'list_tabs',
]);

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

const WARN_THROTTLE_MS = 10000;
const MAX_TELEMETRY_ITEMS = 30;
const warnTimestamps = new Map();

function appendTelemetry(source, context, message) {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
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

const BLOCKED_ACTION_CODES = new Set([
  'SITE_BLOCKED',
  'HTTP_REQUEST_BLOCKED',
  'CONFIRMATION_REQUIRED',
  'INVALID_TARGET',
  'ELEMENT_NOT_FOUND',
  'INVALID_ACTION',
  'DUPLICATE_CALL',
  'ACTION_LOOP_GUARD',
]);

const NO_PROGRESS_WARN_THRESHOLD = 5;
const NO_PROGRESS_FAIL_THRESHOLD = 9;
const COMPLETION_REJECT_WARN_THRESHOLD = 2;
const COMPLETION_REJECT_FAIL_THRESHOLD = 5;
const SEMANTIC_REPEAT_WINDOW = 12;
const SERP_READ_LOOP_THRESHOLD = 3;
const EARLY_TOKEN_BURN_MIN_STEP = 3;
const EARLY_TOKEN_BURN_RATIO = 0.68;
const EARLY_TOKEN_PROJECTION_RATIO = 1.2;
const MAX_DEAD_END_RECOVERY_ATTEMPTS = 2;

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
    this._pendingResumeGuidance = '';
    this._activePauseKind = '';
    this._isWaitingForUser = false;
    // Plan mode
    this.planMode = false;
    this.onPlan = null;
    this._planApprovalResolver = null;
    this.onNotifyConnector = null;
    // Site blocklist (custom domains loaded from storage)
    this.blockedDomains = new Set(DEFAULT_BLOCKED_DOMAINS.map(normalizeBlockedDomain).filter(Boolean));
    // Rate limit / consecutive error tracking
    this._consecutiveRateLimitErrors = 0;
    this._consecutiveErrors = 0;
    this._rateLimitBackoffMs = 0;
    this._scratchpad = {};
    this._subGoals = [];
    this._historySummary = null;
    this._stateSnapshots = [];
    this._notifyConnectorCalls = 0;
    this._reflectionState = null;
    this._lastFindHits = [];
    this._lastFindTextMiss = null;
    this._lastPageTextSignature = '';
    this._connectedConnectorIds = [];
    this._visitedUrls = new Map();
    this._lastBlockedAction = null;
    this._lastBlockedSignature = '';
    this._blockedRepeatCount = 0;
    this._lastNormalizationTelemetryAt = 0;
    this._lastNormalizationTelemetryKey = '';
    this._noProgressStreak = 0;
    this._lastProgressUrl = '';
    this._lastProgressEvidence = '';
    this._serpReadLoopCount = 0;
    this._lastSerpCandidateUrls = [];
    this._reflectionNoActionStreak = 0;
    this._humanGuidanceEscalationCount = 0;
    this._manualPartialRequested = false;
    this._activePauseKind = '';
    this._resourceBudgets = {
      maxWallClockMs: AGENT_MAX_WALL_CLOCK_MS,
      maxTotalTokens: AGENT_MAX_TOTAL_TOKENS,
      maxEstimatedCostUsd: AGENT_MAX_ESTIMATED_COST_USD,
    };
    this._budgetLimitsBypassed = false;
    this._reflectionChatSoftTimeoutMs = REFLECTION_CHAT_SOFT_TIMEOUT_MS;
  }

  /**
   * Check if current provider supports vision (screenshots).
   */
  _providerSupportsVision() {
    return !!this.provider.currentProvider?.supportsVision;
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
    const requestedBudgets = options?.budgets && typeof options.budgets === 'object' ? options.budgets : {};
    const resolveBudget = (value, fallback, min, allowDisable = false) => {
      const raw = Number(value);
      if (Number.isFinite(raw)) {
        if (allowDisable && raw <= 0) return 0;
        return Math.max(raw, min);
      }
      const fb = Number(fallback);
      if (Number.isFinite(fb)) {
        if (allowDisable && fb <= 0) return 0;
        return Math.max(fb, min);
      }
      return allowDisable ? 0 : min;
    };
    this._resourceBudgets = {
      maxWallClockMs: resolveBudget(
        requestedBudgets.maxWallClockMs,
        AGENT_MAX_WALL_CLOCK_MS,
        10_000,
        true,
      ),
      maxTotalTokens: resolveBudget(
        requestedBudgets.maxTotalTokens,
        AGENT_MAX_TOTAL_TOKENS,
        1_000,
        false,
      ),
      maxEstimatedCostUsd: resolveBudget(
        requestedBudgets.maxEstimatedCostUsd,
        AGENT_MAX_ESTIMATED_COST_USD,
        0.01,
        false,
      ),
    };
    const reflectionTimeoutMs = Number(options?.reflectionTimeoutMs);
    this._reflectionChatSoftTimeoutMs = Number.isFinite(reflectionTimeoutMs) && reflectionTimeoutMs > 0
      ? Math.min(Math.max(Math.round(reflectionTimeoutMs), 1000), 180000)
      : REFLECTION_CHAT_SOFT_TIMEOUT_MS;
    this.history = [];
    this._scratchpad = {};
    this._subGoals = [];
    this._historySummary = null;
    this._stateSnapshots = [];
    this._lastKnownUrl = '';
    this.metrics = {
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
      errors: 0,
      duplicateToolCalls: 0,
      parallelBatches: 0,
      parallelToolCalls: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
      cost: { estimatedUsd: 0, provider: this.provider?.config?.primary || '' },
      providerId: this.providerManager?.config?.primary || '',
      normalization: {
        total: 0,
        changed: 0,
      },
      invalidActions: {
        total: 0,
        repeated: 0,
      },
      completion: {
        doneAttempts: 0,
        rejectedNoSubstance: 0,
      },
      stepLimit: {
        reached: false,
        failed: 0,
      },
      budgets: {
        configured: {
          wallClockMs: this._resourceBudgets.maxWallClockMs,
          totalTokens: this._resourceBudgets.maxTotalTokens,
          estimatedCostUsd: this._resourceBudgets.maxEstimatedCostUsd,
        },
        exceeded: null,
      },
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
    this._visitedUrls = new Map();
    this._lastBlockedAction = null;
    this._lastBlockedSignature = '';
    this._blockedRepeatCount = 0;
    this._lastNormalizationTelemetryAt = 0;
    this._lastNormalizationTelemetryKey = '';
    this._noProgressStreak = 0;
    this._lastProgressUrl = String(this._lastKnownUrl || '');
    this._lastProgressEvidence = '';
    this._serpReadLoopCount = 0;
    this._lastSerpCandidateUrls = [];
    this._reflectionNoActionStreak = 0;
    this._humanGuidanceEscalationCount = 0;
    this._manualPartialRequested = false;
    this._pendingResumeGuidance = '';
    this._activePauseKind = '';
    this._budgetLimitsBypassed = false;

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
      try {
        this._historySummary = resumeState.historySummary && typeof resumeState.historySummary === 'object'
          ? JSON.parse(JSON.stringify(resumeState.historySummary))
          : null;
      } catch {
        this._historySummary = null;
      }
      try {
        if (Array.isArray(resumeState.subGoals) && typeof this._restoreSubGoals === 'function') {
          this._restoreSubGoals(resumeState.subGoals);
        }
      } catch {
        this._subGoals = [];
      }
      try {
        if (Array.isArray(resumeState.stateSnapshots) && typeof this._restoreStateSnapshots === 'function') {
          this._restoreStateSnapshots(resumeState.stateSnapshots);
        }
      } catch {
        this._stateSnapshots = [];
      }
      this._lastKnownUrl = String(resumeState.lastKnownUrl || '');
      const restoredNotifyCalls = Number(resumeState.notifyConnectorCalls);
      if (Number.isFinite(restoredNotifyCalls) && restoredNotifyCalls > 0) {
        this._notifyConnectorCalls = Math.min(Math.max(restoredNotifyCalls, 0), 3);
      }
      if (resumeState.reflectionState && typeof resumeState.reflectionState === 'object' && !Array.isArray(resumeState.reflectionState)) {
        this._reflectionState = resumeState.reflectionState;
      }
      const restoredEscalationCount = Number(resumeState.humanGuidanceEscalationCount);
      if (Number.isFinite(restoredEscalationCount) && restoredEscalationCount > 0) {
        this._humanGuidanceEscalationCount = Math.min(Math.max(Math.floor(restoredEscalationCount), 0), 3);
      }
      if (Array.isArray(resumeState.visitedUrls)) {
        for (const item of resumeState.visitedUrls) {
          const key = String(item?.url || '').trim();
          const count = Number(item?.count || 0);
          if (!key || !Number.isFinite(count) || count <= 0) continue;
          this._visitedUrls.set(key, {
            count: Math.min(Math.max(Math.floor(count), 1), 50),
            lastResult: String(item?.lastResult || '').slice(0, 240),
          });
          if (this._visitedUrls.size >= 120) break;
        }
      }
    }

    if ((!Array.isArray(this._subGoals) || this._subGoals.length === 0) && typeof this._initializeSubGoals === 'function') {
      this._initializeSubGoals(this._goal);
    }

    this._notify('running');
    this._startTabWatcher();

    // Load persisted security settings
    try {
      const stored = await chrome.storage.local.get(['customBlockedDomains']);
      if (Array.isArray(stored.customBlockedDomains)) {
        for (const d of stored.customBlockedDomains) {
          const domain = normalizeBlockedDomain(d);
          if (!domain) continue;
          this.blockedDomains.add(domain);
        }
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
        return this._buildTerminalResult({
          success: false,
          status: 'failed',
          reason: 'Task cancelled (plan not approved)',
          steps: 0,
        });
      }
    }

    // Get current page context for multi-task awareness
    let pageContext = '';
    let currentTabUrl = '';
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab?.url && !tab.url.startsWith('chrome://')) {
        currentTabUrl = String(tab.url);
        this._lastKnownUrl = currentTabUrl;
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
    const startsAsNavigate = /^(open|go to|navigate|visit|show)\s/i.test(goalText);
    const hasExtraIntentEn = /\b(and|then|after|also|find|search|check|extract|fill)\b/i.test(goalText);
    const hasExtraIntent = hasExtraIntentEn || /[,;]/.test(goalText);
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

    const messages = [
      { role: 'system', content: this._buildSystemPrompt() },
      { role: 'user', content: taskMessage },
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
        subGoals: Array.isArray(this._subGoals) ? this._subGoals : [],
        historySummary: this._historySummary || null,
        stateSnapshots: Array.isArray(this._stateSnapshots)
          ? this._stateSnapshots.slice(-3).map((item) => ({
            id: item?.id || '',
            createdAt: item?.createdAt || '',
            reason: item?.reason || '',
            tool: item?.tool || '',
            step: item?.step ?? null,
            tabUrl: item?.tabUrl || '',
            cookieCount: Number(item?.cookieCount || 0),
          }))
          : [],
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
    const skipInitialSnapshot = this._shouldSkipInitialSnapshot(goalText, currentTabUrl);
    if (!isNavigateOnly && !skipInitialSnapshot) {
      try {
        const snap = await this._sendToContent('readPage', {
          maxDepth: 6,
          maxNodes: 90,
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
    } else if (skipInitialSnapshot) {
      this._appendMessage(messages, {
        role: 'user',
        content: 'Skip initial page snapshot: current page is a heavy app and likely unrelated to the target goal. Navigate/read directly on the target site.',
      });
    }

    try {
      const maxStepExclusive = stepStart + this.maxSteps;
      for (let step = stepStart; step < maxStepExclusive; step++) {
        if (this._aborted) {
          this.status = 'failed';
          this._notify('failed');
          return this._buildTerminalResult({
            success: false,
            status: 'failed',
            reason: 'Aborted by user',
            steps: step,
          });
        }
        const preStepBudgetStop = this._checkResourceBudgets(step);
        if (preStepBudgetStop) {
          const decision = await this._pauseForLimiterOverride(step, messages, preStepBudgetStop, 'pre_step_budget_check');
          if (decision?.continued) {
            continue;
          }
          this.status = 'failed';
          this._notify('failed');
          return preStepBudgetStop;
        }

        try {
          await this._pauseIfManualInterventionNeeded(step, messages);
          if (this._aborted) {
            this.status = 'failed';
            this._notify('failed');
            return this._buildTerminalResult({
              success: false,
              status: 'failed',
              reason: 'Aborted by user',
              steps: step,
            });
          }
          if (typeof this._maybeSummarizeHistory === 'function') {
            try {
              await this._maybeSummarizeHistory(messages, step, false);
            } catch (err) {
              debugWarn('run.historySummary', err);
            }
          }

          // Filter tools based on provider capabilities
          let activeTools = TOOLS;
          if (!this._providerSupportsVision()) {
            activeTools = TOOLS.filter(t => t.name !== 'screenshot');
          }
          const stepBudget = {
            total: this.maxSteps,
            used: Math.max(step - stepStart, 0),
            remaining: Math.max(maxStepExclusive - step, 0),
          };

          // 1) REFLECT: mandatory reasoning pass (no tools)
          const reflection = await this._runReflection(step, messages, activeTools, stepBudget);
          if (reflection?.budgetTerminal) {
            const decision = await this._pauseForLimiterOverride(step, messages, reflection.budgetTerminal, 'reflection_budget_precheck');
            if (decision?.continued) {
              continue;
            }
            this.status = 'failed';
            this._notify('failed');
            return reflection.budgetTerminal;
          }
          if (!reflection.ok) {
            throw new Error(`REFLECTION_INVALID: ${reflection.error || 'invalid reflection output'}`);
          }

          // Successful LLM call — reset consecutive error counters
          this._consecutiveRateLimitErrors = 0;
          this._consecutiveErrors = 0;
          this._rateLimitBackoffMs = 0;

          const digest = this._buildReflectionDigest(reflection.state, stepBudget);
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
          }
          this._reflectionState = reflection.state;
          this.history.push({ step, type: 'thought', content: digest });
          this._emitStep({ step, type: 'thought', content: digest });
          this._appendMessage(messages, { role: 'assistant', content: `[REFLECTION] ${digest}` });
          const postReflectionBudgetStop = this._checkResourceBudgets(step + 1);
          if (postReflectionBudgetStop) {
            const decision = await this._pauseForLimiterOverride(step + 1, messages, postReflectionBudgetStop, 'post_reflection_budget_check');
            if (decision?.continued) {
              continue;
            }
            this.status = 'failed';
            this._notify('failed');
            return postReflectionBudgetStop;
          }
          const autoComplete = this._maybeAutoCompleteFromEvidence(reflection.state, stepBudget, step);
          if (autoComplete) {
            this.status = 'done';
            this._notify('done');
            return autoComplete;
          }
          const guidanceEscalation = await this._maybeEscalateForHumanGuidance(
            step,
            messages,
            reflection.state,
            stepBudget,
          );
          if (guidanceEscalation?.aborted) {
            if (this._manualPartialRequested) {
              const bestEffort = this._buildBestEffortCompletionFromReflection?.();
              const hasPartial = !!(
                String(bestEffort?.summary || '').trim() ||
                String(bestEffort?.answer || '').trim()
              );
              this.status = 'failed';
              this._notify('failed');
              return this._buildTerminalResult({
                success: false,
                status: hasPartial ? 'partial' : 'failed',
                partialStatus: hasPartial ? 'partial' : 'failed',
                reason: hasPartial
                  ? 'User requested partial completion during human-guidance escalation.'
                  : 'User requested partial completion, but no evidence was available.',
                summary: String(bestEffort?.summary || ''),
                answer: String(bestEffort?.answer || ''),
                steps: step + 1,
                suggestion: hasPartial
                  ? 'If needed, run again with one explicit verification instruction.'
                  : 'Re-run and gather at least one direct source quote before partial completion.',
              });
            }
            this.status = 'failed';
            this._notify('failed');
            return this._buildTerminalResult({
              success: false,
              status: 'failed',
              reason: 'Aborted during human-guidance escalation',
              steps: step + 1,
            });
          }
          if (guidanceEscalation?.resumed) {
            continue;
          }

          // 2) STOP condition: confidence threshold + subgoal coverage
          if (reflection.state.sufficiency && reflection.state.confidence >= REFLECTION_CONFIDENCE_THRESHOLD) {
            const summary = reflection.state.summary || 'Task completed from accumulated evidence.';
            let answer = reflection.state.answer || (
              reflection.state.facts.length > 0
                ? reflection.state.facts.map((f) => `- ${f}`).join('\n')
                : ''
            );
            if (this.metrics?.completion) this.metrics.completion.doneAttempts += 1;
            const allowPartialCoverage = stepBudget.remaining <= 2;
            const prematureCheck = this._checkPrematureDone({ summary, answer });
            if (!prematureCheck.ok) {
              const reject = await this._handleCompletionRejectedNoAction(
                step,
                messages,
                activeTools,
                stepBudget,
                {
                  code: String(prematureCheck.result?.code || 'PREMATURE_DONE'),
                  reason: String(prematureCheck.result?.reason || prematureCheck.result?.error || 'premature completion'),
                  searchQuery: String(reflection.state?.search_query || ''),
                },
              );
              if (reject?.terminal) return reject.result;
              if (reject?.handled) continue;
              this._appendMessage(messages, {
                role: 'user',
                content: `Reflection marked task complete, but completion guard rejected it: ${prematureCheck.result?.error || 'unknown reason'}. Continue and gather missing evidence.`,
              });
              continue;
            }
            const quality = this._validateDoneQuality(summary, answer);
            if (!quality.ok) {
              if (this.metrics?.completion) this.metrics.completion.rejectedNoSubstance += 1;
              const reject = await this._handleCompletionRejectedNoAction(
                step,
                messages,
                activeTools,
                stepBudget,
                {
                  code: 'DONE_QUALITY_FAILED',
                  reason: String(quality.reason || 'done quality validation failed'),
                  searchQuery: String(reflection.state?.search_query || ''),
                },
              );
              if (reject?.terminal) return reject.result;
              if (reject?.handled) continue;
              this._appendMessage(messages, {
                role: 'user',
                content: `Reflection marked task complete, but done quality check failed: ${quality.reason}. Provide a substantive result that directly answers the goal.`,
              });
              continue;
            }
            const coverage = this._validateDoneCoverage(summary, answer, { allowPartial: allowPartialCoverage });
            if (!coverage.ok) {
              const reject = await this._handleCompletionRejectedNoAction(
                step,
                messages,
                activeTools,
                stepBudget,
                {
                  code: 'DONE_COVERAGE_FAILED',
                  reason: `missing evidence for ${coverage.missing.length} requested part(s): ${coverage.missing.join('; ')}`,
                  searchQuery: String(reflection.state?.search_query || ''),
                },
              );
              if (reject?.terminal) return reject.result;
              if (reject?.handled) continue;
              this._appendMessage(messages, {
                role: 'user',
                content: `Reflection confidence is high, but requested parts are still missing evidence: ${coverage.missing.join('; ')}. Continue and cover all parts.`,
              });
              continue;
            }
            if (coverage.partial && Array.isArray(coverage.missing) && coverage.missing.length > 0) {
              answer = `${answer}\n\nUnverified parts due to step limit:\n${coverage.missing.map((m) => `- ${m}`).join('\n')}`.trim();
            }
            if (typeof this._applyCoverageToSubGoals === 'function') {
              this._applyCoverageToSubGoals(coverage.missing || []);
            }

            this._reflectionNoActionStreak = 0;
            const doneResult = { success: true, summary, answer };
            this.history.push({ step, type: 'action', tool: 'done', args: { summary, answer, auto: true }, result: doneResult });
            this._emitStep({ step, type: 'action', tool: 'done', args: { summary, answer, auto: true }, result: doneResult });
            this.status = 'done';
            this._notify('done');
            return this._buildTerminalResult({
              success: true,
              status: 'complete',
              summary,
              answer,
              steps: step + 1,
            });
          }

          // 3) ACT gate: no tool call without validated planned actions
          const rawPlannedActions = Array.isArray(reflection.state?.actions)
            ? reflection.state.actions
            : (reflection.state?.next_action ? [reflection.state.next_action] : []);
          const plannedActions = rawPlannedActions
            .slice(0, REFLECTION_MAX_ACTIONS_PER_STEP)
            .filter((action) => action && typeof action === 'object' && !Array.isArray(action) && String(action.tool || '').trim());
          if (plannedActions.length === 0) {
            this._reflectionNoActionStreak += 1;
            this._noProgressStreak += 1;
            if (this._reflectionNoActionStreak >= COMPLETION_REJECT_FAIL_THRESHOLD) {
              this.status = 'failed';
              this._notify('failed');
              return this._buildTerminalResult({
                success: false,
                status: 'stuck',
                reason: 'Reflection produced no actionable next step repeatedly; failing to avoid an infinite reasoning loop.',
                steps: step + 1,
              });
            }
            this._appendMessage(messages, {
              role: 'user',
              content: 'Reflection did not provide valid actions. Retry reflection and provide 1-4 concrete tool calls.',
            });
            continue;
          }
          const normalizedPlannedActions = [];
          for (const planned of plannedActions) {
            const candidate = {
              tool: String(planned.tool || '').trim(),
              args: planned.args && typeof planned.args === 'object' ? { ...planned.args } : {},
            };
            if (
              candidate.tool === 'http_request' &&
              /website|on\s+site/i.test(String(this._goal || ''))
            ) {
              this._appendMessage(messages, {
                role: 'user',
                content: 'Do not use http_request for on-site lookup tasks when browser interaction is available. Use read_page/get_page_text/find/find_text instead.',
              });
              candidate.tool = 'read_page';
              candidate.args = {};
            }

            const sanitized = this._sanitizePlannedAction(candidate);
            if (!sanitized?.tool) continue;
            if (sanitized.tool === 'done' && reflection.state.confidence < REFLECTION_CONFIDENCE_THRESHOLD) {
              this._appendMessage(messages, {
                role: 'user',
                content: `Reflection proposed done() with confidence ${Math.round(reflection.state.confidence * 100)}%, which is below threshold ${Math.round(REFLECTION_CONFIDENCE_THRESHOLD * 100)}%. Gather more evidence first.`,
              });
              continue;
            }
            normalizedPlannedActions.push({
              tool: sanitized.tool,
              args: sanitized.args || {},
            });
          }
          if (normalizedPlannedActions.length === 0) {
            this._appendMessage(messages, {
              role: 'user',
              content: 'Reflection actions were invalid after sanitization. Retry reflection with actionable browser tools.',
            });
            continue;
          }

          const syntheticResponse = {
            text: null,
            toolCalls: normalizedPlannedActions.map((action, idx) => ({
              id: `reflect_${step}_${idx}`,
              name: action.tool,
              arguments: action.args || {},
            })),
          };
          this._reflectionNoActionStreak = 0;
          const result = await this._handleToolCalls(step, messages, syntheticResponse, stepBudget);
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
              return this._buildTerminalResult({
                success: false,
                status: 'failed',
                reason: 'Persistent rate limiting from API provider — unable to continue. Please wait a few minutes and retry.',
                steps: step + 1,
              });
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
              return this._buildTerminalResult({
                success: false,
                status: 'failed',
                reason: `Too many consecutive errors (${this._consecutiveErrors}). Last: ${err.message}`,
                steps: step + 1,
              });
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

    if (this.metrics?.stepLimit) {
      this.metrics.stepLimit.reached = true;
      this.metrics.stepLimit.failed += 1;
    }
    const bestEffort = this._buildBestEffortCompletionFromReflection?.();
    const partialSummary = String(bestEffort?.summary || '').trim();
    const reasonBase = 'Step limit reached before producing a verified result that satisfies the task goal.';
    const reason = partialSummary
      ? `${reasonBase} Last partial summary: ${partialSummary.slice(0, 240)}`
      : reasonBase;
    this.status = 'failed';
    this._notify('failed');
    return this._buildTerminalResult({
      success: false,
      status: partialSummary ? 'partial' : 'stuck',
      partialStatus: partialSummary ? 'partial' : 'stuck',
      reason,
      summary: String(bestEffort?.summary || ''),
      answer: String(bestEffort?.answer || ''),
      steps: stepStart + this.maxSteps,
    });
  }

  /**
   * Handle all tool calls from a single LLM response.
   * Groups them into one assistant message (fixes OpenAI API format).
   */
  async _handleToolCalls(step, messages, response, stepBudget = null) {
    const toolCalls = response.toolCalls;
    const allowPartialCoverage = Number(stepBudget?.remaining) <= 2;

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
      content: response.text || null,
      tool_calls: assistantToolCalls.map(({ _normalized, ...tc }) => tc),
    });

    // ── Parallel pre-execution for independent read-only tools ──
    // Identify groups of 2+ consecutive parallel-safe tools and execute them
    // concurrently. Results are cached; the sequential loop below uses the cache
    // instead of re-executing, preserving all existing validation logic.
    const _parallelCache = new Map();
    {
      let groupStart = 0;
      while (groupStart < toolCalls.length) {
        // Find consecutive parallel-safe tools
        let groupEnd = groupStart;
        while (
          groupEnd < toolCalls.length &&
          PARALLEL_SAFE_TOOLS.has(toolCalls[groupEnd].name)
        ) {
          groupEnd++;
        }
        const groupLen = groupEnd - groupStart;
        if (groupLen >= 2) {
          // Pre-execute this group in parallel
          const promises = [];
          for (let k = groupStart; k < groupEnd; k++) {
            const args = assistantToolCalls[k]._normalized;
            const name = toolCalls[k].name;
            promises.push(
              this._executeTool(name, args).catch((err) => ({
                success: false,
                error: err?.message || String(err),
                code: 'PARALLEL_EXEC_ERROR',
              })),
            );
          }
          const results = await Promise.all(promises);
          for (let k = 0; k < groupLen; k++) {
            _parallelCache.set(assistantToolCalls[groupStart + k].id, results[k]);
          }
          this.metrics.parallelBatches += 1;
          this.metrics.parallelToolCalls += groupLen;
        }
        groupStart = groupEnd + (groupLen === 0 ? 1 : 0);
      }
    }

    // Execute each tool and collect results
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const normalizedArgs = assistantToolCalls[i]._normalized;
      const toolCallId = assistantToolCalls[i].id;

      this.metrics.toolCalls += 1;

      // Duplicate tool call detection — skip terminal tools (done/fail)
      let isDuplicate = false;
      let duplicateNudge = '';
      let duplicateHint = null;
      if (tc.name !== 'done' && tc.name !== 'fail') {
        const toolKey = tc.name + ':' + JSON.stringify(normalizedArgs);
        if (toolKey === this._lastToolKey) {
          const allowRepeat = this._shouldAllowImmediateRepeat(tc.name, normalizedArgs);
          if (!allowRepeat) {
            this._dupCount += 1;
            this.metrics.duplicateToolCalls += 1;
            if (this._dupCount >= 1) {
              isDuplicate = true;
              duplicateNudge = `You already called ${tc.name} with the same arguments ${this._dupCount + 1} times. The result will not change. Try a DIFFERENT tool or approach. For example: use find_text to search for specific content, get_page_text to read the full page, or navigate to a different URL.`;
              duplicateHint = tc.name === 'scroll'
                ? {
                  strategy: 'change_scroll_strategy',
                  nextTool: 'press_key',
                  args: { key: 'End' },
                  avoidRepeat: true,
                }
                : {
                  strategy: 'change_tool_or_args',
                  nextTool: 'read_page',
                  args: {},
                  avoidRepeat: true,
                };
            }
          } else {
            this._dupCount = 0;
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
            duplicateHint = {
              strategy: 'break_read_only_loop',
              nextTool: 'navigate',
              args: {},
              avoidRepeat: true,
            };
          }
        }

        // Advanced cyclic loop detection (A-B-A-B-A pattern)
        if (!isDuplicate && this.history) {
          const recentActions = this.history.filter(h => h.type === 'action').slice(-10);
          if (recentActions.length >= 4) {
            // Create a simple fingerprint for the action
            const getFingerprint = (h) => {
              let target = h.args?.target || h.args?.url || h.args?.direction || h.args?.query || '';
              return `${h.tool}:${target}`.trim();
            };
            const currentFingerprint = getFingerprint({ tool: tc.name, args: normalizedArgs });
            const actionHashes = [...recentActions.map(getFingerprint), currentFingerprint];

            const len = actionHashes.length;
            if (len >= 5) {
              const last = actionHashes[len - 1];
              const prev1 = actionHashes[len - 2];
              const prev2 = actionHashes[len - 3];
              const prev3 = actionHashes[len - 4];
              const prev4 = actionHashes[len - 5];

              // If A-B-A-B-A
              if (last === prev2 && last === prev4 && prev1 === prev3 && last !== prev1) {
                isDuplicate = true;
                this.metrics.duplicateToolCalls += 1;
                duplicateNudge = `SYSTEM ERROR: CYCLIC LOOP DETECTED. You are repeating the same sequence of actions (${last} <-> ${prev1}). The page state is not progressing. You MUST try a completely different approach or use the fail tool to give up.`;
                duplicateHint = {
                  strategy: 'break_cyclic_loop',
                  nextTool: 'navigate',
                  args: {},
                  avoidRepeat: true,
                };
              }
            }
          }
        }

        if (!isDuplicate) {
          const semanticRepeat = this._detectSemanticRepeat(tc.name, normalizedArgs);
          if (semanticRepeat?.repeated) {
            isDuplicate = true;
            this.metrics.duplicateToolCalls += 1;
            duplicateNudge = `Repeated low-signal action detected (${tc.name}) on the same page without new evidence. Stop repeating this action and switch strategy.`;
            duplicateHint = semanticRepeat.hint || {
              strategy: 'change_strategy',
              nextTool: 'navigate',
              args: {},
              avoidRepeat: true,
            };
          }
        }

        if (!isDuplicate) {
          const serpGuard = this._buildSerpLoopGuard(tc.name);
          if (serpGuard?.blocked) {
            isDuplicate = true;
            this.metrics.duplicateToolCalls += 1;
            duplicateNudge = serpGuard.reason;
            duplicateHint = serpGuard.hint || {
              strategy: 'leave_search_results_page',
              nextTool: 'navigate',
              args: {},
              avoidRepeat: true,
            };
          }
        }
      }

      let result;
      let preActionSnapshot = null;
      if (isDuplicate) {
        result = this._makeError('DUPLICATE_CALL', duplicateNudge, {
          hint: duplicateHint || {
            strategy: 'change_tool_or_args',
            nextTool: 'read_page',
            args: {},
            avoidRepeat: true,
          },
          retryable: false,
        });
      } else {
        const snapshotReason = this._isRiskyActionForSnapshot(tc.name, normalizedArgs);
        if (snapshotReason) {
          try {
            preActionSnapshot = await this._captureStateSnapshot(snapshotReason, tc.name, normalizedArgs, step);
          } catch (err) {
            debugWarn('tool.captureSnapshot', err);
            preActionSnapshot = null;
          }
        }
        // Use cached parallel result if available, otherwise execute sequentially
        if (_parallelCache.has(toolCallId)) {
          result = _parallelCache.get(toolCallId);
        } else {
          result = await this._executeTool(tc.name, normalizedArgs);
        }
      }
      if (preActionSnapshot?.success && result && typeof result === 'object') {
        result.preActionSnapshotId = preActionSnapshot.snapshotId;
        result.preActionSnapshotReason = preActionSnapshot.reason;
      }
      result = this._standardizeToolError(result, { tool: tc.name, args: normalizedArgs });
      result = this._applyBlockedActionLoopGuard(tc.name, normalizedArgs, result);

      const observedUrl = result?.url || result?.page_url || result?.pageUrl || result?.finalUrl;
      if (observedUrl) {
        this._lastKnownUrl = String(observedUrl);
      }

      if (result?.success === false && result?.code === 'SENSITIVE_DATA_BLOCKED') {
        this._isWaitingForUser = true;
        this.status = 'paused_waiting_user';
        this._notify('paused_waiting_user');

        const pauseMsg = 'Please enter payment/sensitive data manually.';
        const pauseStep = {
          step,
          type: 'pause',
          reason: pauseMsg,
          url: this._lastKnownUrl,
          kind: 'payment_auth',
        };
        this.history.push(pauseStep);
        this._emitStep(pauseStep);
        this._emitIntervention({
          kind: 'payment_auth',
          url: this._lastKnownUrl,
          title: 'Manual Input Required',
          message: pauseMsg,
        });

        await new Promise((resolve) => {
          this._resumeResolver = resolve;
        });
        this._resumeResolver = null;
        this._isWaitingForUser = false;

        if (this._aborted) {
          this.status = 'failed';
          this._notify('failed');
          return this._buildTerminalResult({
            success: false,
            status: 'failed',
            reason: 'Aborted during manual intervention',
            steps: step + 1,
          });
        }

        this.status = 'running';
        this._notify('running');

        this._appendMessage(messages, {
          role: 'user',
          content: 'The user has manually entered the sensitive data. Continue the original task.',
        });

        break;
      }


      // Abort batch if navigation-triggering tool was called
      if (['navigate', 'back', 'forward', 'reload', 'open_tab', 'switch_tab', 'close_tab', 'switch_frame'].includes(tc.name) && result?.success) {
        if (i < toolCalls.length - 1) {
          this._appendMessage(messages, {
            role: 'user',
            content: `[SYSTEM] Batch execution aborted early: ${tc.name} changes the page layout. Read the new page before doing anything else.`
          });
          break;
        }
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
      if (tc.name === 'extract_structured') {
        this._rememberSerpCandidateUrls(result);
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

      let doneCoverageMissing = [];
      if (tc.name === 'done') {
        if (this.metrics?.completion) this.metrics.completion.doneAttempts += 1;
        // Guard: reject done if recent history is mostly failures (agent giving up too early)
        const prematureCheck = this._checkPrematureDone(normalizedArgs);
        if (!prematureCheck.ok) {
          result = prematureCheck.result;
        } else {
          const quality = this._validateDoneQuality(
            normalizedArgs?.summary,
            normalizedArgs?.answer,
          );
          if (!quality.ok) {
            if (this.metrics?.completion) this.metrics.completion.rejectedNoSubstance += 1;
            result = {
              success: false,
              code: 'DONE_QUALITY_FAILED',
              reason: quality.reason,
              error: quality.reason,
              hint: {
                strategy: 'collect_substantive_result',
                nextTool: quality.nextTool || 'get_page_text',
                args: {},
                avoidRepeat: true,
              },
              retryable: false,
            };
          } else {
            const coverage = this._validateDoneCoverage(
              normalizedArgs?.summary,
              normalizedArgs?.answer,
              { allowPartial: allowPartialCoverage },
            );
            doneCoverageMissing = Array.isArray(coverage?.missing) ? coverage.missing : [];
            if (!coverage.ok) {
              result = {
                success: false,
                code: 'DONE_COVERAGE_FAILED',
                reason: `Early completion rejected: missing evidence for ${coverage.missing.length} requested part(s).`,
                error: `Early completion rejected: missing evidence for ${coverage.missing.length} requested part(s).`,
                missing: coverage.missing,
                hint: {
                  strategy: 'cover_missing_subgoals',
                  nextTool: 'get_page_text',
                  args: {},
                  missing: coverage.missing,
                  avoidRepeat: true,
                },
                retryable: false,
              };
            } else if (coverage.partial && Array.isArray(coverage.missing) && coverage.missing.length > 0) {
              const extra = `\n\nUnverified parts due to step limit:\n${coverage.missing.map((m) => `- ${m}`).join('\n')}`;
              normalizedArgs.answer = `${String(normalizedArgs.answer || '').trim()}${extra}`.trim();
            }
          }
        }
        result = this._standardizeToolError(result, { tool: tc.name, args: normalizedArgs });
      }

      this.history.push({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
      this._emitStep({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
      if (tc.name === 'done') {
        if (result?.success && typeof this._applyCoverageToSubGoals === 'function') {
          this._applyCoverageToSubGoals(doneCoverageMissing);
        }
      } else if (tc.name !== 'fail' && typeof this._updateSubGoalsAfterAction === 'function') {
        this._updateSubGoalsAfterAction(step, tc.name, normalizedArgs, result);
      }

      // Check terminal actions
      if (tc.name === 'done' && result?.success) {
        this.status = 'done';
        this._notify('done');
        return this._buildTerminalResult({
          success: true,
          status: 'complete',
          summary: normalizedArgs.summary,
          answer: normalizedArgs.answer || '',
          steps: step + 1,
        });
      }
      if (tc.name === 'fail') {
        this.status = 'failed';
        this._notify('failed');
        return this._buildTerminalResult({
          success: false,
          status: 'failed',
          reason: normalizedArgs.reason,
          steps: step + 1,
        });
      }
      if (result?.success === false && result?.code === 'POLICY_CONFLICT') {
        this.status = 'failed';
        this._notify('failed');
        return this._buildTerminalResult({
          success: false,
          status: 'failed',
          reason: result.reason || 'Blocked by policy with no viable fallback path.',
          steps: step + 1,
        });
      }

      const progress = this._trackProgress(tc.name, result);
      if (progress.noProgressStreak >= NO_PROGRESS_FAIL_THRESHOLD) {
        const bestEffort = this._buildBestEffortCompletionFromReflection?.();
        const hasBestEffort = !!(
          String(bestEffort?.summary || '').trim() ||
          String(bestEffort?.answer || '').trim()
        );
        const hadHumanGuidanceEscalation = Number(this._humanGuidanceEscalationCount || 0) >= 1;
        if (hasBestEffort) {
          this.status = 'failed';
          this._notify('failed');
          return this._buildTerminalResult({
            success: false,
            status: 'partial',
            partialStatus: 'partial',
            reason: hadHumanGuidanceEscalation
              ? `No meaningful progress for ${progress.noProgressStreak} consecutive steps after human-guidance escalation. Returning best-effort result from collected evidence.`
              : `No meaningful progress for ${progress.noProgressStreak} consecutive steps. Returning best-effort result from collected evidence.`,
            summary: String(bestEffort.summary || ''),
            answer: String(bestEffort.answer || ''),
            steps: step + 1,
            suggestion: hadHumanGuidanceEscalation
              ? 'If you need stricter certainty, provide one explicit instruction for the missing verification and rerun.'
              : 'If you need stricter certainty, rerun with a narrower query or one explicit verification instruction.',
          });
        }
        this.status = 'failed';
        this._notify('failed');
        return this._buildTerminalResult({
          success: false,
          status: 'stuck',
          reason: `No meaningful progress for ${progress.noProgressStreak} consecutive steps. Failing fast to avoid loops.`,
          steps: step + 1,
        });
      }

      // Screenshot → vision integration
      if (tc.name === 'screenshot' && result?.success && result?.imageBase64) {
        const somSummary = this._summarizeSomForPrompt(result?.som);
        this._appendMessage(messages, {
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({
            success: true,
            note: 'Screenshot captured and attached as image below.',
            som: somSummary || undefined,
          }),
        });
        // Add the actual image as a vision message
        const currentProvider = this.provider.currentProvider;
        if (currentProvider?.supportsVision) {
          const prompt = [
            'Here is the screenshot of the current page.',
            somSummary
              ? 'The image contains numbered Set-of-Mark boxes; these numbers correspond to agent IDs from read_page/find.'
              : '',
            somSummary?.legend ? `Visible marks: ${somSummary.legend}` : '',
            somSummary?.structuredJson
              ? `Structured SoM marks (JSON, pixel coordinates): ${somSummary.structuredJson}`
              : '',
            'Describe what you see and decide the next action.',
          ].filter(Boolean).join('\n');
          this._appendMessage(messages,
            currentProvider.buildVisionMessage(
              prompt,
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
      } else {
        this._appendMessage(messages, {
          role: 'tool',
          tool_call_id: toolCallId,
          content: this._serializeToolResultForLLM(tc.name, result),
        });
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
          content: `[SYSTEM] ${this._toolFailStreak} consecutive tool failures: ${failedTools}. STOP and RETHINK. Your current approach is not working. You MUST try a fundamentally different strategy: navigate to a direct URL (e.g. google.com/search?q=your+query), refresh targets with read_page/find, or try a completely different website. Do NOT repeat similar failing actions.`,
        });
        this._toolFailStreak = 0; // Reset so we don't spam
      }

      if (progress.noProgressStreak >= NO_PROGRESS_WARN_THRESHOLD) {
        this._appendMessage(messages, {
          role: 'user',
          content: `[SYSTEM] No meaningful progress for ${progress.noProgressStreak} consecutive steps. Current strategy is not producing verified state changes or factual results. Switch to a different fallback path now. If no viable path remains, call fail with explicit reason.`,
        });
      }
    }

    return null; // not terminal
  }

  /**
   * Execute a tool by name.
   */
  async _executeTool(name, args) {
    switch (name) {
      case 'read_page':
        {
          const goalText = String(this._goal || '').toLowerCase();
          const formLikeGoal = /(fill|form|login|sign\s?in|signup|register|input|enter|type)/i.test(goalText);
          const extractionLikeGoal = /(extract|read|collect|news|result|table|list|price|product|find|search|item)/i.test(goalText);
          const defaultMaxDepth = formLikeGoal ? 9 : 12;
          const defaultMaxNodes = formLikeGoal ? 130 : (extractionLikeGoal ? 210 : 180);
          const result = await this._sendToContent('readPage', {
            maxDepth: Math.min(Math.max(Number(args?.maxDepth) || defaultMaxDepth, 1), 12),
            maxNodes: Math.min(Math.max(Number(args?.maxNodes) || defaultMaxNodes, 20), 260),
            viewportOnly: formLikeGoal ? true : undefined,
          });
          if (result && result.success !== false && this._isSparseAccessibilityTreeResult(result)) {
            result.sparseAx = true;
            result.sparseAxReason = 'Low interactive density in AX tree; consider screenshot-based probing.';
          }
          return result;
        }

      case 'get_page_text':
        {
          let scope = args.scope;
          let selector = args.selector;
          const maxChars = args.maxChars;
          const currentUrl = String(this._lastKnownUrl || '');

          // Article-like pages usually bury useful text below heavy navigation.
          if (!scope && !selector && /\/spravka\/vopros\//i.test(currentUrl)) {
            scope = 'selector';
            selector = 'main, article, [role="main"], .content, .article, .entry-content';
          }

          let result = await this._sendToContent('getPageText', {
            scope,
            selector,
            maxChars,
          });

          const resultUrl = String(result?.url || '');
          const signature = `${resultUrl}|${String(result?.text || '').slice(0, 600)}`;
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
          const hadExplicitQuery = typeof args.query === 'string' && args.query.trim().length > 0;
          const query = this._sanitizeFindTextQuery(args.query, {
            allowFallbackWhenEmpty: true,
            source: 'execute.find_text.query',
          });
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
            !hadExplicitQuery &&
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

          // Dead URL recovery: if the destination is an error/404 page, try a nearby canonical URL once.
          try {
            const deadEnd = this._detectDeadEndNavigationResult(result, validatedUrl);
            if (deadEnd?.isDeadEnd) {
              result.deadEnd = true;
              result.deadEndReason = deadEnd.reason;
              const recovery = await this._attemptDeadEndRecoveryNavigation(validatedUrl, result);
              if (recovery?.recovered) {
                result.recoveredFromDeadEnd = true;
                result.recoveryFrom = recovery.from;
                result.recoveryTo = recovery.url;
                result.url = recovery.url;
                result.finalUrl = recovery.url;
                result.pageUrl = recovery.pageUrl || recovery.url;
                result.pageTitle = recovery.pageTitle || result.pageTitle || '';
                result.pageText = String(recovery.pageText || result.pageText || '').slice(0, 3000);
                if (result.warning) {
                  result.warning = `${result.warning} ${recovery.note}`.trim();
                } else {
                  result.warning = recovery.note;
                }
              } else {
                const fallbackHint = `The destination appears unavailable (${deadEnd.reason}). Try a sibling URL or the site root before continuing.`;
                result.warning = result.warning ? `${result.warning} ${fallbackHint}`.trim() : fallbackHint;
              }
            }
          } catch (err) {
            debugWarn('tool.navigate.deadEndRecovery', err);
          }

          // Track revisits to the same URL path to reduce looping on dead-end pages.
          try {
            const effectiveUrl = String(result.finalUrl || result.pageUrl || validatedUrl || '').trim();
            if (effectiveUrl) {
              const parsed = new URL(effectiveUrl);
              const urlKey = `${parsed.origin}${parsed.pathname}`;
              const prev = this._visitedUrls.get(urlKey);
              const nextCount = (prev?.count || 0) + 1;
              const snippetSource = String(result.pageText || result.warning || '').trim();
              const snippet = snippetSource.slice(0, 200);
              this._visitedUrls.set(urlKey, { count: nextCount, lastResult: snippet });
              if (nextCount >= 3) {
                const revisitWarning = `This page was already visited ${nextCount} times in this task; prefer a different source/query if progress is low.`;
                result.visitedCount = nextCount;
                if (result.warning) {
                  result.warning = `${result.warning} ${revisitWarning}`.trim();
                } else {
                  result.warning = revisitWarning;
                }
                if (prev?.lastResult) {
                  result.previousVisitSnippet = String(prev.lastResult).slice(0, 200);
                }
              }
            }
          } catch (err) {
            debugWarn('tool.navigate.visitTracking', err);
          }
          return result;
        }

      case 'back':
        return await this._navigateHistory('back');

      case 'forward':
        return await this._navigateHistory('forward');

      case 'reload':
        return await this._reloadTab(args);

      case 'click':
        {
          const targets = Array.isArray(args.target) ? args.target : [args.target];
          let clickResult = null;
          for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            clickResult = await this._sendToContent('executeAction', {
              type: 'click',
              target: t,
              params: { confirm: args.confirm === true, button: args.button, clickCount: args.clickCount },
            });
            if (clickResult?.success === false && (clickResult.code === 'INVALID_TARGET' || clickResult.code === 'ELEMENT_NOT_FOUND')) {
              const candidate = this._pickClickTargetFromFindHits(t);
              if (candidate !== null && candidate !== undefined && Number(candidate) !== Number(t)) {
                const retry = await this._sendToContent('executeAction', {
                  type: 'click',
                  target: candidate,
                  params: { confirm: args.confirm === true, button: args.button, clickCount: args.clickCount },
                });
                if (retry?.success) {
                  retry.autocorrectedTarget = { from: t, to: candidate };
                  clickResult = retry;
                } else {
                  clickResult = retry;
                }
              }
            }
            if (clickResult?.success === false) return clickResult;
          }
          return targets.length > 1 ? { success: true, description: `Clicked ${targets.length} elements` } : clickResult;
        }

      case 'type':
        {
          const targets = Array.isArray(args.target) ? args.target : [args.target];
          const texts = Array.isArray(args.text) ? args.text : [args.text];
          let typeResult = null;

          for (let i = 0; i < targets.length; i++) {
            const t = targets[i];
            const textToType = texts[i] !== undefined ? texts[i] : texts[texts.length - 1] || '';
            const pressEnter = args.enter === true || String(args.enter).toLowerCase() === 'true';
            // Only press enter on the last element if it's a batch
            const enterForThis = pressEnter && (i === targets.length - 1);

            typeResult = await this._sendToContent('executeAction', {
              type: 'type',
              target: t,
              params: { text: textToType, enter: enterForThis },
            });

            if (typeResult?.success === false && (typeResult.code === 'INVALID_TARGET' || typeResult.code === 'ELEMENT_NOT_FOUND')) {
              const candidate = this._pickTypeTargetFromFindHits(t);
              if (candidate !== null && candidate !== undefined) {
                const retry = await this._sendToContent('executeAction', {
                  type: 'type',
                  target: candidate,
                  params: { text: textToType, enter: enterForThis },
                });
                if (retry?.success) {
                  retry.autocorrectedTarget = { from: t, to: candidate };
                  typeResult = retry;
                } else {
                  typeResult = retry;
                }
              }
            }
            if (typeResult?.success === false) {
              if (typeResult.code === 'INVALID_TARGET' || typeResult.code === 'ELEMENT_NOT_FOUND') {
                typeResult.hint = 'If you are trying to search on this site, navigate directly to a search URL instead (e.g. site.com/search?q=your+query or google.com/search?q=your+query).';
              }
              return typeResult;
            }
          }
          return targets.length > 1 ? { success: true, description: `Typed text into ${targets.length} fields` } : typeResult;
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

      case 'close_tab':
        return await this._closeTab(args);

      case 'switch_frame':
        return await this._switchFrame(args);

      case 'restore_snapshot':
        return await this._restoreStateSnapshot(args);

      case 'screenshot':
        if (!this._providerSupportsVision()) {
          return {
            success: true,
            note: 'Screenshot skipped — text-only model. Use read_page for page structure.',
            fallback: 'read_page',
          };
        }
        return await this._takeScreenshot(args);

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
    try {
      const response = await chrome.tabs.sendMessage(this.tabId, { action, payload });
      return response ?? this._makeError('EMPTY_CONTENT_RESPONSE', 'No response from content script');
    } catch (err) {
      const msg = String(err?.message || err);
      const needsInjection =
        msg.includes('Receiving end does not exist') ||
        msg.includes('Could not establish connection');

      if (needsInjection) {
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
  async _takeScreenshot(args = {}) {
    try {
      const wantSom = args?.som === undefined ? true : this._normalizeBoolean(args?.som) === true;
      const autoCrop = args?.autoCrop === undefined ? true : this._normalizeBoolean(args?.autoCrop) === true;
      const maxMarks = Math.min(Math.max(Number(args?.maxMarks) || 24, 4), 80);
      const profile = this._getScreenshotOptimizationProfile(args);
      let overlayMarks = [];

      if (wantSom) {
        try {
          const marksResult = await this._sendToContent('getSomMarks', { maxMarks });
          if (marksResult && marksResult.success !== false && Array.isArray(marksResult.marks)) {
            overlayMarks = marksResult.marks
              .map((mark) => ({
                id: Number(mark?.id),
                x: Number(mark?.x),
                y: Number(mark?.y),
                w: Number(mark?.w),
                h: Number(mark?.h),
                label: String(mark?.label || '').slice(0, 120),
              }))
              .filter((mark) =>
                Number.isInteger(mark.id)
                && Number.isFinite(mark.x)
                && Number.isFinite(mark.y)
                && Number.isFinite(mark.w)
                && Number.isFinite(mark.h)
                && mark.w > 2
                && mark.h > 2)
              .slice(0, maxMarks);
          }
        } catch (err) {
          debugWarn('screenshot.som', err);
        }
      }

      let captureWindowId = null;
      try {
        const tab = await chrome.tabs.get(this.tabId);
        if (Number.isInteger(tab?.windowId)) {
          captureWindowId = tab.windowId;
        }
      } catch {
        // Best-effort: fallback to default window when tab lookup is unavailable.
      }

      const dataUrl = await chrome.tabs.captureVisibleTab(captureWindowId, {
        format: 'jpeg',
        quality: 50,
      });

      // Downscale image to a sensible size for vision models
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const cropRect = this._resolveScreenshotCropRect(
        bitmap.width,
        bitmap.height,
        overlayMarks,
        args,
        autoCrop,
      );
      const source = cropRect || { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
      const fitted = this._fitScreenshotDimensions(source.w, source.h, profile);
      const width = fitted.width;
      const height = fitted.height;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(
        bitmap,
        source.x,
        source.y,
        source.w,
        source.h,
        0,
        0,
        width,
        height,
      );
      const visibleMarks = this._projectSomMarksToCrop(overlayMarks, cropRect).slice(0, maxMarks);
      const scaleX = width / Math.max(source.w, 1);
      const scaleY = height / Math.max(source.h, 1);
      if (ctx && visibleMarks.length > 0) {
        this._drawSomOverlay(ctx, visibleMarks, scaleX, scaleY, width, height);
      }

      const resizedBlob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: profile.quality,
      });
      const buffer = await resizedBlob.arrayBuffer();

      const chunks = [];
      const arr = new Uint8Array(buffer);
      for (let i = 0; i < arr.length; i += 1024) {
        chunks.push(String.fromCharCode.apply(null, arr.subarray(i, i + 1024)));
      }
      const base64 = btoa(chunks.join(''));
      const summarizedSom = this._summarizeSomForPrompt({
        markCount: visibleMarks.length,
        marks: this._projectSomMarksToOutput(visibleMarks, scaleX, scaleY),
      });

      return {
        success: true,
        imageBase64: base64,
        format: 'jpeg',
        image: {
          width,
          height,
          sourceWidth: source.w,
          sourceHeight: source.h,
          cropped: !!cropRect,
        },
        som: wantSom ? {
          enabled: true,
          markCount: visibleMarks.length,
          marks: this._projectSomMarksToOutput(visibleMarks, scaleX, scaleY).slice(0, 12),
          legend: summarizedSom?.legend || '',
        } : {
          enabled: false,
          markCount: 0,
          marks: [],
          legend: '',
        },
      };
    } catch (err) {
      const message = String(err?.message || err || 'Unknown screenshot error');
      if (/Either the '<all_urls>' or 'activeTab' permission is required/i.test(message)) {
        return this._makeError(
          'SCREENSHOT_PERMISSION_REQUIRED',
          'Screenshot permission is missing for the current tab. Reload the extension after updating permissions and retry.',
        );
      }
      return this._makeError('SCREENSHOT_FAILED', `Screenshot failed: ${err.message}`);
    }
  }

  _getScreenshotOptimizationProfile(args = {}) {
    const primary = String(this?.provider?.config?.primary || '').toLowerCase();
    const model = String(this?.provider?.currentProvider?.model || '').toLowerCase();
    let maxWidth = 1280;
    let maxHeight = 1280;
    let maxPixels = 1_250_000;
    let quality = 0.6;

    if (primary === 'ollama' || /qwen|llama|scout|8b|7b/.test(model)) {
      maxWidth = 1024;
      maxHeight = 1024;
      maxPixels = 900_000;
      quality = 0.55;
    }

    const userMaxWidth = Number(args?.maxWidth);
    const userMaxHeight = Number(args?.maxHeight);
    const userQuality = Number(args?.quality);
    if (Number.isFinite(userMaxWidth)) {
      maxWidth = Math.min(Math.max(Math.round(userMaxWidth), 512), 1920);
    }
    if (Number.isFinite(userMaxHeight)) {
      maxHeight = Math.min(Math.max(Math.round(userMaxHeight), 512), 1920);
    }
    if (Number.isFinite(userQuality)) {
      quality = Math.min(Math.max(userQuality, 0.4), 0.85);
    }

    return {
      maxWidth,
      maxHeight,
      maxPixels,
      quality,
    };
  }

  _fitScreenshotDimensions(sourceWidth, sourceHeight, profile = {}) {
    const srcW = Math.max(Math.round(Number(sourceWidth) || 1), 1);
    const srcH = Math.max(Math.round(Number(sourceHeight) || 1), 1);
    const maxWidth = Math.max(Math.round(Number(profile.maxWidth) || 1280), 1);
    const maxHeight = Math.max(Math.round(Number(profile.maxHeight) || 1280), 1);
    const maxPixels = Math.max(Number(profile.maxPixels) || 1_250_000, 1);

    const byWidth = maxWidth / srcW;
    const byHeight = maxHeight / srcH;
    const byPixels = Math.sqrt(maxPixels / Math.max(srcW * srcH, 1));
    const scale = Math.min(1, byWidth, byHeight, byPixels);

    return {
      width: Math.max(Math.round(srcW * scale), 1),
      height: Math.max(Math.round(srcH * scale), 1),
    };
  }

  _normalizeScreenshotCropRect(raw, imageWidth, imageHeight) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const w = Number(raw.w ?? raw.width);
    const h = Number(raw.h ?? raw.height);
    if (![x, y, w, h].every(Number.isFinite)) return null;

    const left = Math.max(Math.min(Math.round(x), imageWidth - 1), 0);
    const top = Math.max(Math.min(Math.round(y), imageHeight - 1), 0);
    const right = Math.max(Math.min(Math.round(x + w), imageWidth), left + 1);
    const bottom = Math.max(Math.min(Math.round(y + h), imageHeight), top + 1);
    if ((right - left) < 40 || (bottom - top) < 40) return null;
    return {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
      reason: 'explicit',
    };
  }

  _resolveScreenshotCropRect(imageWidth, imageHeight, marks = [], args = {}, autoCrop = true) {
    const explicit = this._normalizeScreenshotCropRect(args?.crop, imageWidth, imageHeight);
    if (explicit) return explicit;
    if (!autoCrop) return null;
    if (!Array.isArray(marks) || marks.length < 2) return null;

    const validMarks = marks
      .map((mark) => ({
        x: Number(mark?.x),
        y: Number(mark?.y),
        w: Number(mark?.w),
        h: Number(mark?.h),
      }))
      .filter((mark) => Number.isFinite(mark.x)
        && Number.isFinite(mark.y)
        && Number.isFinite(mark.w)
        && Number.isFinite(mark.h)
        && mark.w > 2
        && mark.h > 2);

    if (validMarks.length < 2) return null;

    let minX = imageWidth;
    let minY = imageHeight;
    let maxX = 0;
    let maxY = 0;
    for (const mark of validMarks) {
      minX = Math.min(minX, mark.x);
      minY = Math.min(minY, mark.y);
      maxX = Math.max(maxX, mark.x + mark.w);
      maxY = Math.max(maxY, mark.y + mark.h);
    }

    const boundsW = Math.max(maxX - minX, 1);
    const boundsH = Math.max(maxY - minY, 1);
    const coverage = (boundsW * boundsH) / Math.max(imageWidth * imageHeight, 1);
    if (coverage >= 0.88) return null;

    const margin = Math.max(Math.min(Math.round(Math.max(boundsW, boundsH) * 0.12), 160), 24);
    const x = Math.max(Math.round(minX - margin), 0);
    const y = Math.max(Math.round(minY - margin), 0);
    const right = Math.min(Math.round(maxX + margin), imageWidth);
    const bottom = Math.min(Math.round(maxY + margin), imageHeight);
    const w = Math.max(right - x, 1);
    const h = Math.max(bottom - y, 1);
    const cropCoverage = (w * h) / Math.max(imageWidth * imageHeight, 1);
    if (w < 40 || h < 40 || cropCoverage >= 0.95) return null;

    return { x, y, w, h, reason: 'som_bounds' };
  }

  _projectSomMarksToCrop(marks = [], cropRect = null) {
    if (!Array.isArray(marks) || marks.length === 0) return [];
    if (!cropRect) return marks.map((mark) => ({ ...mark }));

    const cx1 = Number(cropRect.x) || 0;
    const cy1 = Number(cropRect.y) || 0;
    const cx2 = cx1 + Math.max(Number(cropRect.w) || 0, 0);
    const cy2 = cy1 + Math.max(Number(cropRect.h) || 0, 0);
    const projected = [];

    for (const mark of marks) {
      const id = Number(mark?.id);
      const x = Number(mark?.x);
      const y = Number(mark?.y);
      const w = Number(mark?.w);
      const h = Number(mark?.h);
      if (!Number.isInteger(id) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
      if (w <= 2 || h <= 2) continue;

      const mx1 = x;
      const my1 = y;
      const mx2 = x + w;
      const my2 = y + h;
      const ix1 = Math.max(mx1, cx1);
      const iy1 = Math.max(my1, cy1);
      const ix2 = Math.min(mx2, cx2);
      const iy2 = Math.min(my2, cy2);
      if ((ix2 - ix1) <= 2 || (iy2 - iy1) <= 2) continue;

      projected.push({
        id,
        label: String(mark?.label || '').slice(0, 120),
        x: ix1 - cx1,
        y: iy1 - cy1,
        w: ix2 - ix1,
        h: iy2 - iy1,
      });
    }

    return projected;
  }

  _projectSomMarksToOutput(marks = [], scaleX = 1, scaleY = 1) {
    if (!Array.isArray(marks) || marks.length === 0) return [];
    const sx = Number.isFinite(Number(scaleX)) && Number(scaleX) > 0 ? Number(scaleX) : 1;
    const sy = Number.isFinite(Number(scaleY)) && Number(scaleY) > 0 ? Number(scaleY) : 1;
    return marks.map((mark) => ({
      id: Number(mark.id),
      label: String(mark.label || '').slice(0, 120),
      x: Math.max(Math.round((Number(mark.x) || 0) * sx), 0),
      y: Math.max(Math.round((Number(mark.y) || 0) * sy), 0),
      w: Math.max(Math.round((Number(mark.w) || 0) * sx), 1),
      h: Math.max(Math.round((Number(mark.h) || 0) * sy), 1),
    })).filter((mark) => Number.isInteger(mark.id));
  }

  _summarizeSomForPrompt(som = null) {
    if (!som || !Array.isArray(som.marks) || som.marks.length === 0) return null;
    const maxLegendItems = 8;
    const structuredMarks = this._buildSomStructuredMarks(som, 10);
    const legend = som.marks
      .slice(0, maxLegendItems)
      .map((mark) => {
        const id = Number(mark?.id);
        if (!Number.isInteger(id)) return null;
        const label = String(mark?.label || '').trim().replace(/\s+/g, ' ').slice(0, 48);
        return label ? `[${id}] ${label}` : `[${id}]`;
      })
      .filter(Boolean)
      .join('; ');
    return {
      markCount: Math.max(Number(som.markCount) || 0, som.marks.length),
      legend,
      structuredMarks,
      structuredJson: structuredMarks.length > 0 ? JSON.stringify(structuredMarks) : '',
    };
  }

  _buildSomStructuredMarks(som = null, maxItems = 10) {
    if (!som || !Array.isArray(som.marks)) return [];
    const cap = Math.min(Math.max(Number(maxItems) || 10, 1), 20);
    return som.marks
      .slice(0, cap)
      .map((mark) => {
        const id = Number(mark?.id);
        if (!Number.isInteger(id)) return null;
        const x = Math.round(Number(mark?.x) || 0);
        const y = Math.round(Number(mark?.y) || 0);
        const w = Math.round(Number(mark?.w) || 0);
        const h = Math.round(Number(mark?.h) || 0);
        if (w <= 0 || h <= 0) return null;
        const label = String(mark?.label || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        return {
          id,
          label,
          x,
          y,
          w,
          h,
        };
      })
      .filter(Boolean);
  }

  _drawSomOverlay(ctx, marks, scaleX, scaleY, canvasWidth, canvasHeight) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffe600';
    ctx.fillStyle = 'rgba(16, 16, 16, 0.92)';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 13px monospace';

    for (const mark of marks) {
      const id = Number(mark?.id);
      if (!Number.isInteger(id)) continue;
      const x = Math.round((Number(mark?.x) || 0) * scaleX);
      const y = Math.round((Number(mark?.y) || 0) * scaleY);
      const w = Math.max(Math.round((Number(mark?.w) || 0) * scaleX), 4);
      const h = Math.max(Math.round((Number(mark?.h) || 0) * scaleY), 4);
      if (x > canvasWidth || y > canvasHeight || (x + w) < 0 || (y + h) < 0) continue;

      ctx.strokeRect(x, y, w, h);
      const tag = `[${id}]`;
      const textWidth = Math.ceil(ctx.measureText(tag).width) + 10;
      const labelX = Math.max(Math.min(x, canvasWidth - textWidth), 0);
      const labelY = Math.max(y - 18, 0);
      ctx.fillRect(labelX, labelY, textWidth, 18);
      ctx.fillStyle = '#ffe600';
      ctx.fillText(tag, labelX + 5, labelY + 2);
      ctx.fillStyle = 'rgba(16, 16, 16, 0.92)';
    }
    ctx.restore();
  }

  async _executeHistoryFallback(direction) {
    const dir = String(direction || '').toLowerCase();
    const runBack = dir === 'back';
    const runForward = dir === 'forward';
    if (!runBack && !runForward) {
      return this._makeError('INVALID_ACTION', `Unknown history direction: ${direction}`);
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'MAIN',
        func: (goBack) => {
          if (goBack) {
            window.history.back();
          } else {
            window.history.forward();
          }
        },
        args: [runBack],
      });
      return { success: true };
    } catch (err) {
      return this._makeError('HISTORY_NAV_FAILED', err?.message || String(err), { direction: dir });
    }
  }

  async _navigateHistory(direction) {
    try {
      await this._clearFindTextContext();
      if (direction === 'back') {
        if (typeof chrome.tabs.goBack === 'function') {
          await chrome.tabs.goBack(this.tabId);
        } else {
          const fallback = await this._executeHistoryFallback('back');
          if (fallback?.success === false) return fallback;
        }
      } else if (direction === 'forward') {
        if (typeof chrome.tabs.goForward === 'function') {
          await chrome.tabs.goForward(this.tabId);
        } else {
          const fallback = await this._executeHistoryFallback('forward');
          if (fallback?.success === false) return fallback;
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

  async _reloadTab(args = {}) {
    try {
      const bypassCache = args?.bypassCache === true;
      await this._clearFindTextContext();
      await chrome.tabs.reload(this.tabId, { bypassCache });
      await this._waitForNavigation();
      try {
        await this._sendToContent('startMonitoring', {});
      } catch (err) {
        debugWarn('tool.reload.startMonitoring', err);
      }
      return { success: true, tabId: this.tabId, bypassCache };
    } catch (err) {
      return this._makeError('RELOAD_FAILED', err?.message || String(err), {
        tabId: this.tabId,
      });
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
      // Try to add the new tab to the "BrowseAgent" group
      try {
        const existingGroups = await chrome.tabGroups.query({ title: 'BrowseAgent' });
        if (existingGroups.length > 0) {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: existingGroups[0].id });
        } else {
          const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
          await chrome.tabGroups.update(groupId, { title: 'BrowseAgent', color: 'blue' });
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

  async _switchFrame(args = {}) {
    try {
      const payload = {
        main: args?.main === true,
      };
      if (args?.target !== undefined && args?.target !== null) payload.target = args.target;
      if (args?.index !== undefined && args?.index !== null) payload.index = args.index;

      if (!payload.main && payload.target === undefined && payload.index === undefined) {
        return this._makeError('INVALID_FRAME_TARGET', 'switch_frame requires main=true, target, or index');
      }

      const result = await this._sendToContent('switchFrame', payload);
      if (!result?.success) return result;
      await this._clearFindTextContext();
      return result;
    } catch (err) {
      return this._makeError('FRAME_SWITCH_FAILED', err?.message || String(err));
    }
  }

  _restoreStateSnapshots(items = []) {
    if (!Array.isArray(items)) {
      this._stateSnapshots = [];
      return this._stateSnapshots;
    }
    const restored = [];
    for (const raw of items.slice(-SNAPSHOT_MAX_ITEMS)) {
      const snapshot = raw && typeof raw === 'object' ? raw : {};
      const tabUrl = String(snapshot.tabUrl || '').trim();
      if (!tabUrl) continue;
      const cookies = Array.isArray(snapshot.cookies)
        ? snapshot.cookies
          .slice(0, 200)
          .map((cookie) => ({
            name: String(cookie?.name || '').slice(0, 120),
            value: String(cookie?.value || '').slice(0, 2048),
            domain: String(cookie?.domain || '').slice(0, 240),
            path: String(cookie?.path || '/').slice(0, 200) || '/',
            secure: !!cookie?.secure,
            httpOnly: !!cookie?.httpOnly,
            sameSite: String(cookie?.sameSite || '').slice(0, 40),
            expirationDate: Number.isFinite(Number(cookie?.expirationDate)) ? Number(cookie.expirationDate) : undefined,
            storeId: String(cookie?.storeId || '').slice(0, 120),
          }))
          .filter((cookie) => cookie.name && cookie.domain)
        : [];
      restored.push({
        id: String(snapshot.id || `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        createdAt: String(snapshot.createdAt || new Date().toISOString()),
        step: Number.isFinite(Number(snapshot.step)) ? Number(snapshot.step) : null,
        reason: String(snapshot.reason || '').slice(0, 220),
        tool: String(snapshot.tool || '').slice(0, 80),
        tabId: Number.isFinite(Number(snapshot.tabId)) ? Number(snapshot.tabId) : this.tabId,
        tabUrl,
        viewport: snapshot.viewport && typeof snapshot.viewport === 'object'
          ? {
            url: String(snapshot.viewport.url || tabUrl),
            frame: String(snapshot.viewport.frame || ''),
            scroll: {
              x: Math.max(Number(snapshot.viewport?.scroll?.x) || 0, 0),
              y: Math.max(Number(snapshot.viewport?.scroll?.y) || 0, 0),
            },
          }
          : null,
        cookies,
        cookieCount: Number.isFinite(Number(snapshot.cookieCount))
          ? Number(snapshot.cookieCount)
          : cookies.length,
      });
    }
    this._stateSnapshots = restored.slice(-SNAPSHOT_MAX_ITEMS);
    return this._stateSnapshots;
  }

  _isRiskyActionForSnapshot(tool, args = {}) {
    const safeTool = String(tool || '').trim();
    if (!safeTool || safeTool === 'restore_snapshot') return null;
    if (safeTool === 'click' && this._normalizeBoolean(args.confirm) === true) {
      return 'confirmed_click';
    }
    if (safeTool === 'type' && this._normalizeBoolean(args.enter) === true) {
      return 'type_submit_enter';
    }
    if (safeTool === 'press_key') {
      const key = String(args.key || '').trim().toLowerCase();
      if (key === 'enter' || key === 'return') return 'press_enter';
    }
    return null;
  }

  async _captureStateSnapshot(reason, tool, args = {}, step = null) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(this.tabId);
    } catch {
      tab = null;
    }
    const tabUrl = String(tab?.url || this._lastKnownUrl || '').trim();
    if (!/^https?:\/\//i.test(tabUrl)) {
      return { success: false, skipped: true, reason: 'snapshot capture skipped outside http(s) context' };
    }

    let viewport = null;
    try {
      const state = await this._sendToContent('getViewportState', {});
      if (state && state.success !== false) {
        viewport = {
          url: String(state.url || tabUrl),
          frame: String(state.frame || ''),
          scroll: {
            x: Math.max(Math.round(Number(state?.scroll?.x) || 0), 0),
            y: Math.max(Math.round(Number(state?.scroll?.y) || 0), 0),
          },
        };
      }
    } catch (err) {
      debugWarn('snapshot.capture.viewport', err);
    }

    let cookies = [];
    if (chrome.cookies?.getAll) {
      try {
        const rawCookies = await chrome.cookies.getAll({ url: tabUrl });
        cookies = (Array.isArray(rawCookies) ? rawCookies : [])
          .slice(0, 200)
          .map((cookie) => ({
            name: String(cookie?.name || '').slice(0, 120),
            value: String(cookie?.value || '').slice(0, 2048),
            domain: String(cookie?.domain || '').slice(0, 240),
            path: String(cookie?.path || '/').slice(0, 200) || '/',
            secure: !!cookie?.secure,
            httpOnly: !!cookie?.httpOnly,
            sameSite: String(cookie?.sameSite || '').slice(0, 40),
            expirationDate: Number.isFinite(Number(cookie?.expirationDate)) ? Number(cookie.expirationDate) : undefined,
            storeId: String(cookie?.storeId || '').slice(0, 120),
          }))
          .filter((cookie) => cookie.name && cookie.domain);
      } catch (err) {
        debugWarn('snapshot.capture.cookies', err);
      }
    }

    const snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      step: Number.isFinite(Number(step)) ? Number(step) : null,
      reason: String(reason || 'manual').slice(0, 220),
      tool: String(tool || '').slice(0, 80),
      args: args && typeof args === 'object' ? { ...args } : {},
      tabId: Number.isFinite(Number(this.tabId)) ? Number(this.tabId) : null,
      tabUrl,
      viewport,
      cookies,
      cookieCount: cookies.length,
    };

    this._stateSnapshots.push(snapshot);
    if (this._stateSnapshots.length > SNAPSHOT_MAX_ITEMS) {
      this._stateSnapshots.splice(0, this._stateSnapshots.length - SNAPSHOT_MAX_ITEMS);
    }
    return {
      success: true,
      snapshotId: snapshot.id,
      reason: snapshot.reason,
      cookieCount: snapshot.cookieCount,
      tabUrl: snapshot.tabUrl,
    };
  }

  _resolveSnapshotForRestore(args = {}) {
    const snapshots = Array.isArray(this._stateSnapshots) ? this._stateSnapshots : [];
    if (snapshots.length === 0) return null;
    const snapshotId = String(args?.snapshotId || '').trim();
    if (snapshotId) {
      return snapshots.find((item) => String(item?.id || '') === snapshotId) || null;
    }
    const idxRaw = Number(args?.index);
    const idx = Number.isFinite(idxRaw) ? Math.max(Math.floor(idxRaw), 0) : 0;
    const pointer = snapshots.length - 1 - idx;
    if (pointer < 0 || pointer >= snapshots.length) return null;
    return snapshots[pointer];
  }

  _cookieSignature(cookie = {}) {
    return [
      String(cookie.name || '').trim(),
      String(cookie.domain || '').trim().toLowerCase(),
      String(cookie.path || '/').trim() || '/',
    ].join('|');
  }

  _buildCookieRestoreUrl(cookie = {}) {
    const domainRaw = String(cookie.domain || '').trim();
    const domain = domainRaw.replace(/^\./, '');
    if (!domain) return '';
    const pathRaw = String(cookie.path || '/').trim() || '/';
    const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
    const protocol = cookie.secure ? 'https://' : 'http://';
    return `${protocol}${domain}${path}`;
  }

  async _restoreStateSnapshot(args = {}) {
    const snapshot = this._resolveSnapshotForRestore(args);
    if (!snapshot) {
      return this._makeError('SNAPSHOT_NOT_FOUND', 'Requested snapshot was not found');
    }

    const restoreUrl = args.restoreUrl !== false;
    const restoreCookies = args.restoreCookies !== false;
    const restoreScroll = args.restoreScroll !== false;
    const warnings = [];
    const outcome = {
      success: true,
      snapshotId: snapshot.id,
      restored: {
        url: false,
        cookies: { restored: 0, removed: 0, total: Array.isArray(snapshot.cookies) ? snapshot.cookies.length : 0 },
        scroll: false,
      },
      tabUrl: snapshot.tabUrl,
    };

    const targetUrl = String(snapshot.tabUrl || '').trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      return this._makeError('SNAPSHOT_INVALID', 'Snapshot does not contain a valid http/https URL');
    }

    if (restoreUrl) {
      const blocked = this._checkSiteBlocked(targetUrl);
      if (blocked) return this._makeError('SITE_BLOCKED', blocked);
      try {
        const currentTab = await chrome.tabs.get(this.tabId);
        const currentUrl = String(currentTab?.url || '');
        if (currentUrl !== targetUrl) {
          await chrome.tabs.update(this.tabId, { url: targetUrl });
          await this._waitForNavigation();
          try {
            await this._sendToContent('startMonitoring', {});
            await this._clearFindTextContext();
          } catch (err) {
            debugWarn('snapshot.restore.startMonitoring', err);
          }
          this._lastKnownUrl = targetUrl;
          outcome.restored.url = true;
        } else {
          outcome.restored.url = true;
        }
      } catch (err) {
        return this._makeError('SNAPSHOT_RESTORE_NAV_FAILED', err?.message || String(err));
      }
    }

    if (restoreCookies) {
      if (!chrome.cookies?.getAll || !chrome.cookies?.set) {
        warnings.push('Cookies API unavailable; cookie rollback skipped.');
      } else {
        try {
          const wantedCookies = Array.isArray(snapshot.cookies) ? snapshot.cookies : [];
          const desired = new Map();
          for (const cookie of wantedCookies) {
            const key = this._cookieSignature(cookie);
            if (!key || desired.has(key)) continue;
            desired.set(key, cookie);
          }

          const currentCookies = await chrome.cookies.getAll({ url: targetUrl });
          const seenCurrent = Array.isArray(currentCookies) ? currentCookies : [];
          for (const cookie of seenCurrent) {
            const key = this._cookieSignature(cookie);
            if (desired.has(key)) continue;
            const removalUrl = this._buildCookieRestoreUrl(cookie);
            if (!removalUrl) continue;
            try {
              await chrome.cookies.remove({
                url: removalUrl,
                name: String(cookie.name || ''),
                storeId: cookie.storeId,
              });
              outcome.restored.cookies.removed += 1;
            } catch {
              // Best effort: continue restoring other cookies.
            }
          }

          for (const cookie of desired.values()) {
            const cookieUrl = this._buildCookieRestoreUrl(cookie);
            if (!cookieUrl) continue;
            const details = {
              url: cookieUrl,
              name: String(cookie.name || ''),
              value: String(cookie.value || ''),
              path: String(cookie.path || '/'),
              secure: !!cookie.secure,
              httpOnly: !!cookie.httpOnly,
              sameSite: cookie.sameSite || undefined,
              expirationDate: Number.isFinite(Number(cookie.expirationDate)) ? Number(cookie.expirationDate) : undefined,
              storeId: cookie.storeId || undefined,
              domain: cookie.domain || undefined,
            };
            try {
              await chrome.cookies.set(details);
              outcome.restored.cookies.restored += 1;
            } catch {
              // Best effort: continue restoring other cookies.
            }
          }
        } catch (err) {
          warnings.push(`Cookie rollback failed: ${err?.message || String(err)}`);
        }
      }
    }

    if (restoreScroll && snapshot.viewport?.scroll) {
      try {
        const scroll = snapshot.viewport.scroll || {};
        const result = await this._sendToContent('setViewportState', {
          x: Math.max(Number(scroll.x) || 0, 0),
          y: Math.max(Number(scroll.y) || 0, 0),
        });
        if (result?.success) {
          outcome.restored.scroll = true;
        } else {
          warnings.push(String(result?.error || result?.reason || 'Failed to restore scroll position.'));
        }
      } catch (err) {
        warnings.push(`Scroll rollback failed: ${err?.message || String(err)}`);
      }
    }

    if (warnings.length > 0) outcome.warnings = warnings;
    return outcome;
  }

  async _getDownloadStatus(args = {}) {
    if (!chrome.downloads || typeof chrome.downloads.search !== 'function') {
      return this._makeError('DOWNLOADS_API_UNAVAILABLE', 'Downloads API unavailable. Add "downloads" permission in manifest.');
    }

    const state = args.state && args.state !== 'any' ? String(args.state) : undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const query = { limit };
    if (state) query.state = state;

    const items = await chrome.downloads.search(query);
    return {
      success: true,
      total: items.length,
      downloads: items.map((d) => ({
        id: d.id,
        state: d.state,
        filename: d.filename || '',
        url: d.url || '',
        bytesReceived: d.bytesReceived || 0,
        totalBytes: d.totalBytes || 0,
        error: d.error || '',
        startTime: d.startTime || '',
        endTime: d.endTime || '',
      })),
    };
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
   * Wait for tab navigation to complete.
   */
  async _waitForDomSettle(timeoutMs = 3000, quietMs = 450) {
    try {
      const result = await this._sendToContent('waitForDomSettle', {
        timeoutMs: Math.min(Math.max(Number(timeoutMs) || 3000, 200), 10000),
        quietMs: Math.min(Math.max(Number(quietMs) || 450, 100), 3000),
      });
      if (result?.success !== false) return result;
    } catch (err) {
      debugWarn('waitForDomSettle', err);
    }
    await this._sleep(Math.min(Math.max(Number(quietMs) || 450, 120), 1500));
    return { success: true, settled: false, fallback: 'sleep' };
  }

  async _waitForNavigation(timeout = 10000) {
    await new Promise((resolve) => {
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
          finish();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await this._waitForDomSettle(Math.min(Math.max(Number(timeout) || 10000, 1000), 4500), 500);
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
    this._activePauseKind = '';
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
  }

  approvePlan() {
    if (this._planApprovalResolver) {
      const resolver = this._planApprovalResolver;
      this._planApprovalResolver = null;
      resolver(true);
    }
  }

  resume(guidance = '') {
    this._pendingResumeGuidance = String(guidance || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (this.status !== 'paused_waiting_user') return false;

    // Generic pause (manual intervention / limiter / guidance).
    if (this._resumeResolver) {
      const resolver = this._resumeResolver;
      this._resumeResolver = null;
      resolver(true);
      return true;
    }
    return false;
  }

  requestPartialCompletion() {
    if (this.status !== 'paused_waiting_user' || !this._resumeResolver) return false;
    if (this._activePauseKind !== 'guidance_needed') return false;
    this._manualPartialRequested = true;
    const resolver = this._resumeResolver;
    this._resumeResolver = null;
    resolver(false);
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

  _buildPartialResult(status = 'failed', reason = '', options = {}) {
    const normalized = new Set(['complete', 'partial', 'failed', 'timeout', 'stuck']).has(String(status || ''))
      ? String(status)
      : 'failed';
    const remainingSubGoals = Array.isArray(options?.remaining_subgoals)
      ? options.remaining_subgoals
      : (typeof this._getRemainingSubGoals === 'function' ? this._getRemainingSubGoals(6) : []);
    const cleanRemaining = remainingSubGoals
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    let suggestion = String(options?.suggestion || '').trim();
    if (!suggestion) {
      if (normalized === 'timeout') {
        suggestion = 'Retry with a narrower scope or higher resource budget.';
      } else if (normalized === 'stuck') {
        suggestion = 'Try a different source/site or simplify the goal to unblock progress.';
      } else if (normalized === 'partial') {
        suggestion = 'Validate missing sub-goals and continue from the current state.';
      } else if (normalized === 'failed') {
        suggestion = 'Inspect the failure reason and retry with adjusted constraints.';
      }
    }
    return {
      status: normalized,
      reason: String(reason || '').slice(0, 400),
      remaining_subgoals: cleanRemaining,
      suggestion: suggestion.slice(0, 240),
    };
  }

  _buildTerminalResult({ success, status, reason = '', summary = '', answer = '', steps = 0, suggestion = '', partialStatus = '' } = {}) {
    const finalStatus = String(status || (success ? 'complete' : 'failed'));
    const partial = this._buildPartialResult(partialStatus || finalStatus, reason, { suggestion });
    const result = {
      success: !!success,
      status: finalStatus,
      steps: Number.isFinite(Number(steps)) ? Number(steps) : 0,
      partial_result: partial,
      metrics: this._finalizeMetrics(),
    };
    if (reason) result.reason = String(reason);
    if (summary) result.summary = String(summary);
    if (answer !== undefined && answer !== null && String(answer).trim()) {
      result.answer = String(answer);
    }
    return result;
  }

  _checkResourceBudgets(step = 0) {
    if (this._budgetLimitsBypassed) return null;

    const budgets = this._resourceBudgets || {};
    const wallClockLimit = Math.max(Number(budgets.maxWallClockMs) || 0, 0);
    const tokenLimit = Math.max(Number(budgets.maxTotalTokens) || 0, 0);
    const costLimit = Math.max(Number(budgets.maxEstimatedCostUsd) || 0, 0);

    const now = Date.now();
    const elapsedMs = Math.max(now - Number(this?.metrics?.startedAt || now), 0);
    const totalTokens = Math.max(Number(this?.metrics?.tokens?.total || 0), 0);
    const estimatedCost = Math.max(Number(this?.metrics?.cost?.estimatedUsd || 0), 0);
    const stepIndex = Math.max(Number(step) || 0, 0);

    const exceed = (kind, detail) => {
      if (this.metrics?.budgets && typeof this.metrics.budgets === 'object') {
        this.metrics.budgets.exceeded = { kind, ...detail };
      }
      const bestEffort = this._buildBestEffortCompletionFromReflection?.();
      const hasPartial = !!(bestEffort?.summary || bestEffort?.answer);
      const reason = kind === 'wall_clock'
        ? `Time budget exceeded: ${elapsedMs}ms > ${wallClockLimit}ms.`
        : kind === 'tokens'
          ? `Token budget exceeded: ${totalTokens} > ${tokenLimit}.`
          : kind === 'tokens_projection'
            ? `Token burn-rate projection exceeded budget early: projected ${detail?.projectedAtCurrentBurn || 0} > ${tokenLimit} at step ${stepIndex}.`
          : `Cost budget exceeded: $${estimatedCost.toFixed(4)} > $${costLimit.toFixed(4)}.`;
      return this._buildTerminalResult({
        success: false,
        status: 'timeout',
        partialStatus: hasPartial ? 'partial' : 'timeout',
        reason,
        summary: bestEffort?.summary || '',
        answer: bestEffort?.answer || '',
        steps: Math.max(Number(step) || 0, 0),
        suggestion: 'Resume with tighter scope or increase task budget limits.',
      });
    };

    if (wallClockLimit > 0 && elapsedMs >= wallClockLimit) {
      return exceed('wall_clock', { elapsedMs, limitMs: wallClockLimit });
    }
    if (tokenLimit > 0 && totalTokens >= tokenLimit) {
      return exceed('tokens', { totalTokens, limit: tokenLimit });
    }
    if (
      tokenLimit > 0 &&
      stepIndex >= EARLY_TOKEN_BURN_MIN_STEP &&
      stepIndex <= Math.max(Math.ceil(this.maxSteps * 0.6), EARLY_TOKEN_BURN_MIN_STEP)
    ) {
      const burnRatio = totalTokens / tokenLimit;
      const avgPerStep = totalTokens / Math.max(stepIndex, 1);
      const projectedAtCurrentBurn = Math.round(avgPerStep * Math.max(this.maxSteps, stepIndex));
      const projectionRatio = projectedAtCurrentBurn / tokenLimit;
      if (burnRatio >= EARLY_TOKEN_BURN_RATIO && projectionRatio >= EARLY_TOKEN_PROJECTION_RATIO) {
        return exceed('tokens_projection', {
          totalTokens,
          limit: tokenLimit,
          burnRatio,
          projectedAtCurrentBurn,
          projectionRatio,
          step: stepIndex,
          maxSteps: this.maxSteps,
        });
      }
    }
    if (costLimit > 0 && estimatedCost >= costLimit) {
      return exceed('cost', { estimatedCostUsd: estimatedCost, limitUsd: costLimit });
    }
    return null;
  }

  async _pauseForLimiterOverride(step, messages, terminalResult = null, source = '') {
    if (this._isWaitingForUser || this._aborted) {
      return { continued: false };
    }

    const limitReason = String(
      terminalResult?.reason ||
      terminalResult?.partial_result?.reason ||
      'Execution was paused by a runtime limiter.'
    ).trim();
    const pauseMessage = `${limitReason} Continue anyway?`;

    this._isWaitingForUser = true;
    this._activePauseKind = 'limit_guard';
    this.status = 'paused_waiting_user';
    this._notify('paused_waiting_user');

    const pauseStep = {
      step,
      type: 'pause',
      reason: pauseMessage,
      url: this._lastKnownUrl,
      kind: 'limit_guard',
    };
    this.history.push(pauseStep);
    this._emitStep(pauseStep);
    this._emitIntervention({
      kind: 'limit_guard',
      type: 'limitGuard',
      url: this._lastKnownUrl,
      source: String(source || ''),
      limitReason,
      message: pauseMessage,
    });

    const resumed = await new Promise((resolve) => {
      this._resumeResolver = resolve;
    });

    this._resumeResolver = null;
    this._isWaitingForUser = false;
    this._activePauseKind = '';

    if (!resumed || this._aborted) {
      return { continued: false };
    }

    const resumeGuidance = String(this._pendingResumeGuidance || '').trim();
    this._pendingResumeGuidance = '';
    this._budgetLimitsBypassed = true;

    this.status = 'running';
    this._notify('running');
    this._appendMessage(messages, {
      role: 'user',
      content: resumeGuidance
        ? `User chose to continue after limiter pause. Apply this guidance: "${resumeGuidance}". Continue without budget guard interruptions for the current run and finish safely.`
        : 'User chose to continue after limiter pause. Continue without budget guard interruptions for the current run and finish safely.',
    });

    return { continued: true };
  }

  _makeError(code, reason, details = {}) {
    const out = details && typeof details === 'object' ? { ...details } : {};
    const message = String(reason || out.reason || out.error || 'Unknown error');
    const retryable = typeof out.retryable === 'boolean'
      ? out.retryable
      : /TIMEOUT|RATE_LIMIT|OVER_CAPACITY|TEMPORARY|RETRY/i.test(String(code || ''));
    const hint = Object.prototype.hasOwnProperty.call(out, 'hint') ? out.hint : null;
    delete out.reason;
    delete out.error;
    delete out.retryable;
    return {
      success: false,
      code: String(code || 'TOOL_ERROR'),
      reason: message,
      error: message,
      hint,
      retryable,
      ...out,
    };
  }

  _logNormalizationPair(source, input, normalized) {
    const raw = input === undefined || input === null ? '' : String(input);
    const norm = normalized === undefined || normalized === null ? '' : String(normalized);
    if (this.metrics?.normalization) {
      this.metrics.normalization.total += 1;
      if (raw !== norm) this.metrics.normalization.changed += 1;
    }
    // Hot-path guard: avoid storage writes unless there is an actual change.
    if (raw === norm) return;

    const now = Date.now();
    const key = `${String(source || 'unknown')}|${raw.slice(0, 120)}|${norm.slice(0, 120)}`;
    // Throttle diagnostics on hot path.
    if (key === this._lastNormalizationTelemetryKey && (now - this._lastNormalizationTelemetryAt) < 8000) {
      return;
    }
    if ((now - this._lastNormalizationTelemetryAt) < 1200) {
      return;
    }
    this._lastNormalizationTelemetryKey = key;
    this._lastNormalizationTelemetryAt = now;
    if (!this.metrics.normalization.samples) {
      this.metrics.normalization.samples = [];
    }
    this.metrics.normalization.samples.unshift({
      source: String(source || 'unknown'),
      input: raw.slice(0, 240),
      normalized: norm.slice(0, 240),
      changed: true,
      timestamp: now,
    });
    if (this.metrics.normalization.samples.length > 20) {
      this.metrics.normalization.samples.length = 20;
    }
  }

  _defaultHintForBlockedError(code, tool, args = {}, reason = '') {
    switch (code) {
      case 'SITE_BLOCKED':
      case 'HTTP_REQUEST_BLOCKED':
        return {
          strategy: 'use_allowed_destination',
          nextTool: 'navigate',
          args: {},
          avoidRepeat: true,
          message: 'Choose a different allowed URL or source.',
        };
      case 'CONFIRMATION_REQUIRED':
        return {
          strategy: 'retry_with_confirmation',
          nextTool: 'click',
          args: { ...args, confirm: true },
          avoidRepeat: false,
          message: 'Retry once with confirm=true if the user explicitly asked for this action.',
        };
      case 'INVALID_TARGET':
      case 'ELEMENT_NOT_FOUND':
        return {
          strategy: 'refresh_targets',
          nextTool: 'read_page',
          args: {},
          avoidRepeat: true,
          message: 'Refresh element IDs, then locate target again with find/read_page.',
        };
      case 'INVALID_ACTION':
      case 'DUPLICATE_CALL':
      case 'ACTION_LOOP_GUARD':
        if (/javascript:/i.test(String(reason || ''))) {
          return {
            strategy: 'change_submit_method',
            nextTool: 'press_key',
            args: { key: 'Enter' },
            avoidRepeat: true,
            message: 'Action relies on blocked javascript: link; try keyboard submit or a normal page control.',
          };
        }
        return {
          strategy: 'change_strategy',
          nextTool: tool === 'find_text' ? 'get_page_text' : 'read_page',
          args: {},
          avoidRepeat: true,
          message: 'Do not repeat the same invalid action. Use an alternative tool.',
        };
      default:
        return null;
    }
  }

  _standardizeToolError(result, context = {}) {
    if (!result || result.success !== false) return result;
    const code = String(result.code || 'TOOL_ERROR');
    const reason = String(result.reason || result.error || result.message || 'Tool failed');
    const providedHint = result.hint;
    let hint = providedHint;
    if (typeof hint === 'string') {
      hint = { message: hint };
    } else if (!hint || typeof hint !== 'object' || Array.isArray(hint)) {
      hint = null;
    }
    const fallbackHint = this._defaultHintForBlockedError(
      code,
      context.tool,
      context.args || {},
      reason,
    );
    if (!hint && fallbackHint) hint = fallbackHint;

    const retryable = typeof result.retryable === 'boolean'
      ? result.retryable
      : (
        /TIMEOUT|RATE_LIMIT|OVER_CAPACITY|TEMPORARY|RETRY/i.test(code) ||
        /retry/i.test(reason)
      );

    return {
      ...result,
      success: false,
      code,
      reason,
      error: reason,
      hint,
      retryable,
    };
  }

  _isBlockedActionFailure(tool, result) {
    if (!result || result.success !== false) return false;
    if (tool === 'done' || tool === 'fail') return false;
    return BLOCKED_ACTION_CODES.has(String(result.code || ''));
  }

  _hasViableFallbackHint(tool, hint, blockedCode = '') {
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return false;
    const nextTool = String(hint.nextTool || '').trim();
    if (!nextTool) return false;
    if (hint.avoidRepeat === true && nextTool === String(tool || '')) return false;
    const knownTool = TOOLS.some((t) => t?.name === nextTool);
    if (!knownTool) return false;
    const blocked = String(blockedCode || '').toUpperCase();
    if (
      blocked === 'INVALID_ACTION' &&
      ['read_page', 'find_text'].includes(nextTool)
    ) {
      return false;
    }
    return true;
  }

  _urlLoopKey(rawUrl = '', includeQuery = false) {
    const url = String(rawUrl || '').trim();
    if (!url) return '';
    try {
      const parsed = new URL(url);
      let key = `${parsed.origin}${parsed.pathname || '/'}`;
      if (includeQuery) {
        const q = String(
          parsed.searchParams.get('q') ||
          parsed.searchParams.get('query') ||
          parsed.searchParams.get('p') ||
          parsed.searchParams.get('text') ||
          ''
        ).trim().toLowerCase();
        if (q) key += `?q=${q.slice(0, 160)}`;
      }
      return key.toLowerCase();
    } catch {
      return '';
    }
  }

  _isLikelySerpUrl(rawUrl = '') {
    const url = String(rawUrl || '').trim();
    if (!url) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const hasQuery = ['q', 'query', 'p', 'text', 'k', 'search', 'keyword'].some((key) => {
      const value = String(parsed.searchParams.get(key) || '').trim();
      return value.length > 0;
    });
    const searchHosts = [
      /(^|\.)google\./,
      /(^|\.)bing\.com$/,
      /(^|\.)duckduckgo\.com$/,
      /(^|\.)search\.yahoo\.com$/,
      /(^|\.)ecosia\.org$/,
      /(^|\.)brave\.com$/,
      /(^|\.)yandex\./,
      /(^|\.)baidu\.com$/,
      /(^|\.)search\.aol\.com$/,
    ];
    const onSearchHost = searchHosts.some((re) => re.test(host));
    if (onSearchHost && hasQuery) return true;
    if (!hasQuery) return false;
    return (
      /^\/(?:search|s|results?)\b/.test(path) ||
      /\/search\//.test(path) ||
      /^\/web\/search/.test(path)
    );
  }

  _isSerpReadOnlyTool(tool) {
    return new Set([
      'read_page',
      'get_page_text',
      'find_text',
      'find',
      'extract_structured',
      'screenshot',
      'save_progress',
    ]).has(String(tool || ''));
  }

  _normalizeSerpCandidateUrl(rawUrl = '', baseUrl = '') {
    const value = String(rawUrl || '').trim();
    if (!value) return '';
    let parsed;
    try {
      parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
    } catch {
      return '';
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    // Search engines often wrap outbound links in redirect URLs.
    if (/(^|\.)google\./.test(host) && path === '/url') {
      const wrapped = String(parsed.searchParams.get('q') || parsed.searchParams.get('url') || '').trim();
      if (wrapped) return this._normalizeSerpCandidateUrl(wrapped, '');
    }
    if (/(^|\.)duckduckgo\.com$/.test(host) && path.startsWith('/l/')) {
      const wrapped = String(parsed.searchParams.get('uddg') || '').trim();
      if (wrapped) return this._normalizeSerpCandidateUrl(wrapped, '');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (this._isLikelySerpUrl(parsed.toString())) return '';
    return parsed.toString();
  }

  _rememberSerpCandidateUrls(result = null) {
    if (!result || result.success === false) return;
    const pageUrl = String(result.page_url || result.url || this._lastKnownUrl || '').trim();
    if (!this._isLikelySerpUrl(pageUrl)) return;
    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length === 0) return;
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const candidate = this._normalizeSerpCandidateUrl(item?.url, pageUrl);
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
      if (out.length >= 12) break;
    }
    if (out.length > 0) {
      this._lastSerpCandidateUrls = out;
    }
  }

  _pickSerpOutboundUrl() {
    const candidates = Array.isArray(this._lastSerpCandidateUrls) ? this._lastSerpCandidateUrls : [];
    for (const candidate of candidates) {
      const key = this._urlLoopKey(candidate, false);
      if (!key) continue;
      const visitMeta = this._visitedUrls.get(key);
      if (Number(visitMeta?.count || 0) >= 2) continue;
      return candidate;
    }
    return '';
  }

  _detectSemanticRepeat(tool, args = {}) {
    const toolName = String(tool || '').trim();
    if (!toolName) return { repeated: false };
    const guardedTools = new Set([
      'read_page',
      'get_page_text',
      'find_text',
      'find',
      'extract_structured',
      'screenshot',
      'save_progress',
    ]);
    if (!guardedTools.has(toolName)) return { repeated: false };

    const currentPageKey = this._urlLoopKey(this._lastKnownUrl, true);
    const recent = this.history
      .filter((item) => item?.type === 'action')
      .slice(-SEMANTIC_REPEAT_WINDOW);

    let sameIntentCount = 0;
    let lowSignalCount = 0;
    for (const item of recent) {
      if (String(item.tool || '') !== toolName) continue;
      if (!this._isSameActionIntent(toolName, item.args || {}, args || {})) continue;
      const itemUrl = this._extractActionUrl(item) || this._lastKnownUrl;
      const itemPageKey = this._urlLoopKey(itemUrl, true);
      if (currentPageKey && itemPageKey && itemPageKey !== currentPageKey) continue;
      sameIntentCount += 1;
      if (item.result?.success === false || this._isLowSignalObservation(item)) {
        lowSignalCount += 1;
      }
    }

    const repeated = sameIntentCount >= 2 && (
      lowSignalCount >= 1 ||
      toolName === 'screenshot' ||
      toolName === 'save_progress'
    );
    if (!repeated) return { repeated: false };

    if (this._isLikelySerpUrl(this._lastKnownUrl)) {
      const outboundUrl = this._pickSerpOutboundUrl();
      if (outboundUrl) {
        return {
          repeated: true,
          hint: {
            strategy: 'leave_search_results_page',
            nextTool: 'navigate',
            args: { url: outboundUrl },
            avoidRepeat: true,
          },
        };
      }
      return {
        repeated: true,
        hint: {
          strategy: 'extract_result_links',
          nextTool: 'extract_structured',
          args: { hint: 'result links', maxItems: 20 },
          avoidRepeat: true,
        },
      };
    }

    return {
      repeated: true,
      hint: {
        strategy: 'change_observation_mode',
        nextTool: toolName === 'find_text' ? 'get_page_text' : 'read_page',
        args: toolName === 'find_text' ? { scope: 'full' } : {},
        avoidRepeat: true,
      },
    };
  }

  _buildSerpLoopGuard(nextTool = '') {
    const tool = String(nextTool || '').trim();
    if (!this._isLikelySerpUrl(this._lastKnownUrl)) {
      this._serpReadLoopCount = 0;
      return { blocked: false };
    }
    if (!this._isSerpReadOnlyTool(tool)) {
      this._serpReadLoopCount = 0;
      return { blocked: false };
    }

    const currentSerpKey = this._urlLoopKey(this._lastKnownUrl, true);
    const recent = this.history
      .filter((item) => item?.type === 'action')
      .slice(-10)
      .reverse();

    let readCount = 0;
    let outboundAttempted = false;
    for (const item of recent) {
      const itemUrl = this._extractActionUrl(item) || this._lastKnownUrl;
      const itemSerpKey = this._urlLoopKey(itemUrl, true);
      if (currentSerpKey && itemSerpKey && itemSerpKey !== currentSerpKey) continue;
      if (!this._isLikelySerpUrl(itemUrl)) continue;
      const itemTool = String(item.tool || '');
      if (['click', 'navigate', 'open_tab', 'switch_tab'].includes(itemTool) && item.result?.success !== false) {
        outboundAttempted = true;
        break;
      }
      if (this._isSerpReadOnlyTool(itemTool)) {
        readCount += 1;
      }
    }

    this._serpReadLoopCount = readCount;
    if (outboundAttempted || readCount < SERP_READ_LOOP_THRESHOLD) {
      return { blocked: false };
    }

    const outboundUrl = this._pickSerpOutboundUrl();
    if (outboundUrl) {
      return {
        blocked: true,
        reason: `Search-results loop detected (${readCount} read-only actions on the same SERP). Open a target result page now instead of re-reading the SERP.`,
        hint: {
          strategy: 'leave_search_results_page',
          nextTool: 'navigate',
          args: { url: outboundUrl },
          avoidRepeat: true,
        },
      };
    }
    return {
      blocked: true,
      reason: `Search-results loop detected (${readCount} read-only actions on the same SERP). Extract links or open a result instead of re-reading this page.`,
      hint: {
        strategy: 'extract_result_links',
        nextTool: 'extract_structured',
        args: { hint: 'result links', maxItems: 20 },
        avoidRepeat: true,
      },
    };
  }

  _buildActionIntentKey(tool, args = {}) {
    const safeArgs = args && typeof args === 'object' ? args : {};
    if (['click', 'type', 'select', 'hover'].includes(tool)) {
      return `target:${String(safeArgs.target ?? '')}`;
    }
    if (tool === 'find_text') {
      return `query:${String(safeArgs.query || '').trim().toLowerCase()}`;
    }
    if (tool === 'navigate' || tool === 'open_tab') {
      return `url:${String(safeArgs.url || '').trim().toLowerCase()}`;
    }
    return JSON.stringify(safeArgs);
  }

  _isSameActionIntent(tool, leftArgs = {}, rightArgs = {}) {
    return this._buildActionIntentKey(tool, leftArgs) === this._buildActionIntentKey(tool, rightArgs);
  }

  _shouldAllowImmediateRepeat(tool, args = {}) {
    const toolName = String(tool || '').trim();
    if (toolName !== 'scroll') return false;
    const previousAction = [...(this.history || [])]
      .reverse()
      .find((item) => item?.type === 'action');
    if (!previousAction || previousAction.tool !== 'scroll') return false;
    if (!this._isSameActionIntent('scroll', previousAction.args || {}, args || {})) return false;
    if (previousAction.result?.success === false) return false;
    if (previousAction.result?.moved === false) return false;
    return previousAction.result?.moved === true;
  }

  _applyBlockedActionLoopGuard(tool, args, result) {
    if (!this._isBlockedActionFailure(tool, result)) {
      this._lastBlockedAction = null;
      this._lastBlockedSignature = '';
      this._blockedRepeatCount = 0;
      return result;
    }

    if (this.metrics?.invalidActions) {
      this.metrics.invalidActions.total += 1;
    }

    const intentKey = this._buildActionIntentKey(tool, args || {});
    const signature = `${tool}|${String(result.code || '')}|${intentKey}`;
    if (signature === this._lastBlockedSignature) {
      this._blockedRepeatCount += 1;
      if (this.metrics?.invalidActions) {
        this.metrics.invalidActions.repeated += 1;
      }
    } else {
      this._lastBlockedSignature = signature;
      this._blockedRepeatCount = 0;
    }

    this._lastBlockedAction = {
      tool,
      args: args && typeof args === 'object' ? { ...args } : {},
      hint: result.hint || null,
      code: String(result.code || ''),
    };

    if (this._blockedRepeatCount >= 2) {
      const hasFallback = this._hasViableFallbackHint(tool, result.hint, result.code);
      if (!hasFallback) {
        return this._makeError(
          'POLICY_CONFLICT',
          `Action "${tool}" is repeatedly blocked by policy and there is no viable fallback strategy.`,
          {
            blockedCode: result.code,
            hint: {
              strategy: 'fail_fast_policy_conflict',
              avoidRepeat: true,
            },
            retryable: false,
          },
        );
      }
    }

    if (this._blockedRepeatCount >= 1) {
      return this._makeError(
        'ACTION_LOOP_GUARD',
        `Repeated blocked action detected for "${tool}" (${result.code}). Switch to fallback action.`,
        {
          blockedCode: result.code,
          hint: {
            strategy: 'fallback_after_block',
            nextTool: result?.hint?.nextTool || 'read_page',
            args: result?.hint?.args || {},
            avoidRepeat: true,
          },
          retryable: false,
        },
      );
    }
    return result;
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
    const fromReflection = String(this._reflectionState?.search_query || '').trim();
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
    const candidates = [fromReflection, ...fromUrl, String(this._deriveGoalQuery?.() || '').trim()]
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

  _extractProgressEvidence(tool, result) {
    if (!result || result.success === false) return '';
    if (tool === 'find_text') {
      if (result.found === true && Number(result.count || 0) > 0) {
        return `find_text:${String(result.query || '').toLowerCase()}#${Number(result.count || 0)}`;
      }
      return '';
    }
    if (tool === 'get_page_text') {
      const text = String(result.text || '').trim();
      if (text.length < 40) return '';
      return `page_text:${String(result.url || '')}|${text.slice(0, 160)}`;
    }
    if (tool === 'extract_structured') {
      const count = Number(result.count || 0);
      if (count <= 0) return '';
      return `structured:${count}|${String(result.page_url || result.url || '')}`;
    }
    if (tool === 'find' && Array.isArray(result) && result.length > 0) {
      const top = result[0];
      return `find:${String(top?.agentId || '')}|${String(top?.text || '').slice(0, 80)}`;
    }
    return '';
  }

  _isProgressTool(tool) {
    return new Set([
      'navigate',
      'reload',
      'open_tab',
      'switch_tab',
      'close_tab',
      'back',
      'forward',
      'switch_frame',
      'get_page_text',
      'find_text',
      'extract_structured',
      'find',
      'read_page',
    ]).has(String(tool || ''));
  }

  _trackProgress(tool, result) {
    if (!this._isProgressTool(tool)) {
      return { progressed: false, noProgressStreak: this._noProgressStreak };
    }

    if (!result || result.success === false) {
      this._noProgressStreak += 1;
      return { progressed: false, noProgressStreak: this._noProgressStreak };
    }

    const currentUrl = String(
      result?.finalUrl || result?.url || result?.page_url || result?.pageUrl || this._lastKnownUrl || ''
    ).trim();
    const urlChanged = !!(currentUrl && this._lastProgressUrl && currentUrl !== this._lastProgressUrl);
    const evidence = this._extractProgressEvidence(tool, result);
    const evidenceChanged = !!(evidence && evidence !== this._lastProgressEvidence);
    const strongProgress = urlChanged || evidenceChanged;

    if (strongProgress) {
      this._noProgressStreak = 0;
      if (currentUrl) this._lastProgressUrl = currentUrl;
      if (evidence) this._lastProgressEvidence = evidence;
      return { progressed: true, noProgressStreak: 0 };
    }

    this._noProgressStreak += 1;
    return { progressed: false, noProgressStreak: this._noProgressStreak };
  }

  _buildForcedEvidenceAction(activeTools = [], searchQuery = '') {
    const allowed = new Set((activeTools || []).map((t) => t?.name).filter(Boolean));
    const query = String(searchQuery || '').trim();
    if (allowed.has('get_page_text')) {
      return { tool: 'get_page_text', args: { scope: 'full' } };
    }
    if (allowed.has('extract_structured')) {
      return { tool: 'extract_structured', args: { hint: 'results', maxItems: 20 } };
    }
    if (allowed.has('find_text') && query) {
      return { tool: 'find_text', args: { query } };
    }
    if (allowed.has('read_page')) {
      return { tool: 'read_page', args: {} };
    }
    return null;
  }

  _collectHumanGuidanceSignals(reflectionState = null, stepBudget = null) {
    const confidence = Number(reflectionState?.confidence || 0);
    const noProgress = Number(this._noProgressStreak || 0);
    const dupSignals = (
      Math.max(Number(this._dupCount || 0), 0) +
      Math.max(Number(this._blockedRepeatCount || 0), 0) +
      Math.max(Number(this._serpReadLoopCount || 0), 0)
    );
    const remaining = Math.max(Number(stepBudget?.remaining) || 0, 0);
    const reflectionNoActionStreak = Number(this._reflectionNoActionStreak || 0);
    const factsCount = Array.isArray(reflectionState?.facts) ? reflectionState.facts.length : 0;
    const answerText = String(reflectionState?.answer || '').trim();
    const summaryText = String(reflectionState?.summary || '').trim();
    const hasEvidence = factsCount > 0 || !!answerText || !!summaryText;
    const actions = Array.isArray(reflectionState?.actions)
      ? reflectionState.actions
      : (reflectionState?.next_action ? [reflectionState.next_action] : []);
    const lowSignalActionTools = new Set(['read_page', 'get_page_text', 'find_text', 'save_progress']);
    const mostlyLowSignal = actions.length === 0 || actions.every((a) => lowSignalActionTools.has(String(a?.tool || '')));
    return {
      confidence,
      noProgress,
      dupSignals,
      remaining,
      reflectionNoActionStreak,
      hasEvidence,
      mostlyLowSignal,
      actionsCount: actions.length,
    };
  }

  _maybeAutoCompleteFromEvidence(reflectionState = null, stepBudget = null, currentStep = 0) {
    if (!reflectionState || typeof reflectionState !== 'object') return null;
    if (reflectionState.sufficiency === true) return null;

    const facts = Array.isArray(reflectionState.facts)
      ? reflectionState.facts.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const unknowns = Array.isArray(reflectionState.unknowns)
      ? reflectionState.unknowns.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (facts.length < 2 || unknowns.length > 0) return null;

    const signals = this._collectHumanGuidanceSignals(reflectionState, stepBudget);
    const confidence = Number(signals.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < HUMAN_GUIDANCE_NEAR_CONFIDENCE_MIN) return null;

    const pressure =
      signals.noProgress >= NO_PROGRESS_WARN_THRESHOLD ||
      signals.dupSignals > 0 ||
      signals.reflectionNoActionStreak >= COMPLETION_REJECT_WARN_THRESHOLD;
    if (!pressure || !signals.mostlyLowSignal) return null;

    const summary = String(reflectionState.summary || '').trim()
      || 'Task completed from consistent evidence on the current page.';
    const answer = String(reflectionState.answer || '').trim()
      || facts.map((f) => `- ${f}`).join('\n');

    const prematureCheck = this._checkPrematureDone({ summary, answer });
    if (!prematureCheck?.ok) return null;
    const quality = this._validateDoneQuality(summary, answer);
    if (!quality?.ok) return null;
    const coverage = this._validateDoneCoverage(summary, answer, { allowPartial: false });
    if (!coverage?.ok) return null;

    if (this.metrics?.completion) this.metrics.completion.doneAttempts += 1;
    return this._buildTerminalResult({
      success: true,
      status: 'complete',
      summary,
      answer,
      steps: Math.max(Number(currentStep) || 0, 0) + 1,
    });
  }

  _buildHumanGuidanceBlockers(reflectionState = null, stepBudget = null) {
    const signals = this._collectHumanGuidanceSignals(reflectionState, stepBudget);
    const blockers = [];
    const confidencePct = Math.round(Math.max(Math.min(Number(signals.confidence || 0), 1), 0) * 100);
    const doneThresholdPct = Math.round(REFLECTION_CONFIDENCE_THRESHOLD * 100);

    if (Number.isFinite(signals.confidence) && signals.confidence < REFLECTION_CONFIDENCE_THRESHOLD) {
      blockers.push(`Confidence ${confidencePct}% is below done threshold ${doneThresholdPct}%.`);
    }
    if (signals.noProgress >= NO_PROGRESS_WARN_THRESHOLD) {
      blockers.push(`No meaningful progress for ${signals.noProgress} consecutive steps.`);
    }
    if (signals.dupSignals > 0) {
      blockers.push(`Repeated/duplicate action signals detected (${signals.dupSignals}).`);
    }
    if (signals.reflectionNoActionStreak >= COMPLETION_REJECT_WARN_THRESHOLD) {
      blockers.push('Recent completion attempts were rejected without decisive new evidence.');
    }
    if (signals.mostlyLowSignal) {
      blockers.push('Current planned actions are low-signal and likely to repeat the same loop.');
    }
    if (signals.remaining <= 2) {
      blockers.push(`Step budget is nearly exhausted (${signals.remaining} steps left).`);
    }
    if (blockers.length === 0) {
      blockers.push('Agent is not converging to a final answer despite collected evidence.');
    }
    return blockers.slice(0, 6);
  }

  _shouldEscalateForHumanGuidance(reflectionState = null, stepBudget = null) {
    if (!reflectionState || typeof reflectionState !== 'object') return false;
    if (this._isWaitingForUser || this._aborted) return false;
    if (Number(this._humanGuidanceEscalationCount || 0) >= HUMAN_GUIDANCE_MAX_ESCALATIONS_PER_RUN) return false;
    if (reflectionState.sufficiency === true) return false;

    const signals = this._collectHumanGuidanceSignals(reflectionState, stepBudget);
    const confidence = Number(signals.confidence || 0);
    if (!Number.isFinite(confidence) || confidence >= REFLECTION_CONFIDENCE_THRESHOLD) {
      return false;
    }
    const noProgress = signals.noProgress;
    const dupSignals = signals.dupSignals;
    const isStrictMedium = confidence >= HUMAN_GUIDANCE_CONFIDENCE_MIN;
    const isNearMediumUnderLoop = confidence >= HUMAN_GUIDANCE_NEAR_CONFIDENCE_MIN && (noProgress > 0 || dupSignals > 0);
    if (!isStrictMedium && !isNearMediumUnderLoop) return false;

    if (!signals.hasEvidence) return false;

    const remaining = signals.remaining;
    const pressure =
      noProgress >= NO_PROGRESS_WARN_THRESHOLD ||
      signals.reflectionNoActionStreak >= COMPLETION_REJECT_WARN_THRESHOLD ||
      remaining <= 2 ||
      dupSignals > 0;
    if (!pressure) return false;

    const mostlyLowSignal = signals.mostlyLowSignal;
    if (!mostlyLowSignal && remaining > 1 && signals.reflectionNoActionStreak < COMPLETION_REJECT_WARN_THRESHOLD) {
      return false;
    }
    return true;
  }

  async _pauseForHumanGuidance(step, messages, reflectionState = {}, stepBudget = null) {
    this._isWaitingForUser = true;
    this._activePauseKind = 'guidance_needed';
    this._humanGuidanceEscalationCount = Number(this._humanGuidanceEscalationCount || 0) + 1;
    this.status = 'paused_waiting_user';
    this._notify('paused_waiting_user');

    const confidencePct = Math.round(Math.max(Math.min(Number(reflectionState?.confidence || 0), 1), 0) * 100);
    const facts = Array.isArray(reflectionState?.facts) ? reflectionState.facts.slice(0, 4) : [];
    const unknowns = Array.isArray(reflectionState?.unknowns) ? reflectionState.unknowns.slice(0, 3) : [];
    const blockers = this._buildHumanGuidanceBlockers(reflectionState, stepBudget);
    const remaining = Math.max(Number(stepBudget?.remaining) || 0, 0);
    const reason = `Medium-confidence plateau (${confidencePct}%). Review current page/state and provide guidance by adjusting context manually, then press Resume.`;
    const pauseStep = {
      step,
      type: 'pause',
      reason,
      url: this._lastKnownUrl,
      kind: 'guidance_needed',
      confidence: confidencePct,
      remainingSteps: remaining,
      blockers,
    };
    this.history.push(pauseStep);
    this._emitStep(pauseStep);
    this._emitIntervention({
      kind: 'guidance_needed',
      type: 'humanGuidance',
      url: this._lastKnownUrl,
      confidence: confidencePct,
      remainingSteps: remaining,
      message: reason,
      facts,
      unknowns,
      blockers,
    });

    const resumed = await new Promise((resolve) => {
      this._resumeResolver = resolve;
    });
    this._resumeResolver = null;
    this._isWaitingForUser = false;
    this._activePauseKind = '';

    if (!resumed || this._aborted) return { aborted: true, resumed: false };
    const resumeGuidance = String(this._pendingResumeGuidance || '').trim();
    this._pendingResumeGuidance = '';

    this.status = 'running';
    this._notify('running');
    this._appendMessage(messages, {
      role: 'user',
      content: resumeGuidance
        ? `The user resumed with guidance: "${resumeGuidance}". Prioritize this instruction. Avoid repeating read_page/find_text with identical inputs. If current facts already answer the goal, call done now with a concise final answer.`
        : 'The user reviewed progress and resumed. Avoid repeating read_page/find_text with identical inputs. If current facts already answer the goal, call done now with a concise final answer and only note remaining uncertainty if any.',
    });
    return { resumed: true, aborted: false };
  }

  async _maybeEscalateForHumanGuidance(step, messages, reflectionState = null, stepBudget = null) {
    if (!this._shouldEscalateForHumanGuidance(reflectionState, stepBudget)) {
      return { resumed: false, aborted: false };
    }
    return await this._pauseForHumanGuidance(step, messages, reflectionState, stepBudget);
  }

  async _handleCompletionRejectedNoAction(step, messages, activeTools, stepBudget, options = {}) {
    const code = String(options?.code || 'COMPLETION_REJECTED');
    const reason = String(options?.reason || 'Completion guard rejected the result.');
    const searchQuery = String(options?.searchQuery || '');

    this._reflectionNoActionStreak += 1;
    this._noProgressStreak += 1;
    const errorText = `COMPLETION_REJECTED(${code}): ${reason}`;
    const errorStep = { step, type: 'error', code, error: errorText };
    this.history.push(errorStep);
    this._emitStep(errorStep);

    if (this._reflectionNoActionStreak >= COMPLETION_REJECT_FAIL_THRESHOLD) {
      this.status = 'failed';
      this._notify('failed');
      return {
        terminal: true,
        result: this._buildTerminalResult({
          success: false,
          status: 'stuck',
          reason: `Completion deadlock: ${this._reflectionNoActionStreak} consecutive completion rejections without actions. Last reason: ${reason}`,
          steps: step + 1,
        }),
      };
    }

    if (this._reflectionNoActionStreak >= COMPLETION_REJECT_WARN_THRESHOLD) {
      const forced = this._buildForcedEvidenceAction(activeTools, searchQuery);
      if (forced) {
        this._appendMessage(messages, {
          role: 'user',
          content: `Completion keeps getting rejected (${this._reflectionNoActionStreak}x). Forced evidence step: call ${forced.tool} now and continue only after fresh evidence.`,
        });
        const syntheticResponse = {
          text: null,
          toolCalls: [{ id: `forced_${step}_0`, name: forced.tool, arguments: forced.args || {} }],
        };
        const toolResult = await this._handleToolCalls(step, messages, syntheticResponse, stepBudget);
        this._reflectionNoActionStreak = 0;
        if (toolResult) {
          return { terminal: true, result: toolResult };
        }
        return { handled: true };
      }
    }

    return { handled: false };
  }

  _shouldForceVisionProbe(nextTool) {
    if (!this._providerSupportsVision()) return false;
    if (nextTool === 'screenshot' || nextTool === 'done' || nextTool === 'fail') return false;

    const recent = this.history
      .slice(-8)
      .filter((h) => h?.type === 'action');
    const hasRecentScreenshot = recent.some((h) => h.tool === 'screenshot');
    if (hasRecentScreenshot) return false;

    const sparseSensitiveTools = new Set(['read_page', 'find', 'click', 'type', 'hover', 'select']);
    const lastReadPage = recent
      .slice()
      .reverse()
      .find((h) => h?.tool === 'read_page' && h?.result?.success !== false);
    if (
      sparseSensitiveTools.has(String(nextTool || '').trim()) &&
      lastReadPage &&
      this._isSparseAccessibilityTreeResult(lastReadPage.result)
    ) {
      return true;
    }
    if (recent.length < 4) return false;

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

  _isSparseAccessibilityTreeResult(result = {}) {
    if (!result || typeof result !== 'object') return false;
    if (result.success === false) return false;
    const interactiveCount = Math.max(Number(result.interactiveCount) || 0, 0);
    const nodeCount = Math.max(Number(result.nodeCount) || 0, 0);
    const root = result.tree && typeof result.tree === 'object' ? result.tree : null;
    const rootChildren = Array.isArray(root?.children) ? root.children : [];
    const rootInteractiveChildren = rootChildren.filter((child) => child && typeof child === 'object' && child.id !== undefined).length;
    const rootText = String(root?.name || '').trim();
    return (
      interactiveCount <= 2 &&
      rootInteractiveChildren < 3 &&
      (nodeCount <= 14 || rootChildren.length <= 2) &&
      rootText.length < 40
    );
  }

  _sanitizeFindTextQuery(rawQuery, options = {}) {
    const allowFallbackWhenEmpty = options?.allowFallbackWhenEmpty === true;
    const input = rawQuery === undefined || rawQuery === null ? '' : String(rawQuery);

    // Keep semantic Unicode symbols intact; drop only control/service chars.
    let query = input
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    query = query.replace(/^["'«“„]+|["'»”‟]+$/g, '').trim();

    // Fallback is allowed only when the original query is truly empty.
    if (!query && allowFallbackWhenEmpty) {
      query = String(this._deriveCurrentSearchNeedle() || '').trim();
    }
    if (query.length > 240) query = query.slice(0, 240).trim();
    return query;
  }

  _buildAlternativeNeedle(query = '') {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return '';
    const words = text
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter(Boolean);
    if (words.length <= 3) return '';
    const stopWords = new Set([
      'the', 'a', 'an', 'to', 'for', 'and', 'or', 'of', 'in', 'on', 'at', 'from', 'with',
      'what', 'how', 'this', 'that', 'about', 'for', 'or', 'on', 'by', 'from', 'in', 'to', 'and',
    ]);
    const filtered = words.filter((w) => w.length > 2 && !stopWords.has(w));
    const base = filtered.length >= 3 ? filtered : words;
    const compact = base.slice(0, 4).join(' ').trim();
    if (!compact) return '';
    if (compact === text) return '';
    return compact.slice(0, 140);
  }

  _sanitizePlannedAction(nextAction = {}) {
    const tool = String(nextAction?.tool || '').trim();
    const args = nextAction?.args && typeof nextAction.args === 'object' ? { ...nextAction.args } : {};
    if (
      this._lastBlockedAction &&
      this._lastBlockedAction.tool === tool &&
      this._isSameActionIntent(tool, this._lastBlockedAction.args, args)
    ) {
      const blockedHint = this._lastBlockedAction.hint;
      if (blockedHint?.nextTool && blockedHint.nextTool !== tool) {
        return {
          tool: String(blockedHint.nextTool),
          args: blockedHint.args && typeof blockedHint.args === 'object' ? { ...blockedHint.args } : {},
        };
      }
    }

    const semanticRepeat = this._detectSemanticRepeat(tool, args);
    if (semanticRepeat?.repeated && semanticRepeat?.hint?.nextTool) {
      const nextTool = String(semanticRepeat.hint.nextTool || '').trim();
      if (nextTool && nextTool !== tool) {
        return {
          tool: nextTool,
          args: semanticRepeat.hint.args && typeof semanticRepeat.hint.args === 'object'
            ? { ...semanticRepeat.hint.args }
            : {},
        };
      }
    }

    const serpGuard = this._buildSerpLoopGuard(tool);
    if (serpGuard?.blocked && serpGuard?.hint?.nextTool) {
      const nextTool = String(serpGuard.hint.nextTool || '').trim();
      if (nextTool && nextTool !== tool) {
        return {
          tool: nextTool,
          args: serpGuard.hint.args && typeof serpGuard.hint.args === 'object'
            ? { ...serpGuard.hint.args }
            : {},
        };
      }
    }

    if (tool === 'click') {
      const targetNum = Number(args.target);
      if (!Number.isFinite(targetNum) || targetNum <= 0) {
        const candidate = this._pickClickTargetFromFindHits(args.target);
        if (candidate !== null && candidate !== undefined) args.target = candidate;
      }
    }

    if (tool === 'find_text') {
      const hadExplicitQuery = typeof args.query === 'string' && args.query.trim().length > 0;
      args.query = this._sanitizeFindTextQuery(args.query, {
        allowFallbackWhenEmpty: true,
        source: 'planned.find_text.query',
      });
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
        } else {
          const alt = this._buildAlternativeNeedle(normalizedQuery);
          if (alt && alt !== normalizedQuery) {
            args.query = alt;
          } else if (hadExplicitQuery && this._isLikelySerpUrl(this._lastKnownUrl)) {
            return { tool: 'extract_structured', args: { hint: 'result links', maxItems: 20 } };
          }
        }
      }
    }

    if (tool === 'notify_connector') {
      if (!args.connectorId && /telegram/i.test(String(this._goal || ''))) {
        if (this._connectedConnectorIds.includes('telegram')) args.connectorId = 'telegram';
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
    return /llama[-_]?4[-_]?maverick|llama[-_]?4[-_]?scout|meta-llama\/llama-4-(?:maverick-17b-128e|scout-17b-16e)-instruct/.test(model);
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
      const hostname = normalizeBlockedDomain(new URL(url).hostname);
      if (!hostname) return null;
      for (const blocked of this.blockedDomains) {
        const b = normalizeBlockedDomain(blocked);
        if (!b) continue;
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
    // Auto-add https:// if LLM sends bare domain (e.g. "example.com")
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
    if (parsed.username || parsed.password) {
      throw new Error('URLs with embedded credentials (user:pass@host) are not allowed');
    }
    return parsed.toString();
  }

  _detectDeadEndNavigationResult(result = {}, requestedUrl = '') {
    const pageTitle = String(result?.pageTitle || result?.title || '').trim();
    const pageText = String(result?.pageText || result?.text || '').slice(0, 2000);
    const effectiveUrl = String(result?.finalUrl || result?.pageUrl || result?.url || requestedUrl || '').trim();
    const titleLower = pageTitle.toLowerCase();
    const bodyLower = pageText.toLowerCase();
    const urlLower = effectiveUrl.toLowerCase();

    let score = 0;
    let reason = '';
    if (/\b404\b/.test(titleLower)) {
      score += 2;
      reason = reason || 'HTTP 404 title';
    }
    if (/\b(page\s+not\s+found|not\s+found|doesn['’]?t\s+exist)\b/.test(titleLower)) {
      score += 2;
      reason = reason || 'not-found title';
    }
    if (/\b404\b/.test(bodyLower)) {
      score += 1;
      reason = reason || '404 text';
    }
    if (/\b(page\s+not\s+found|not\s+found|no\s+longer\s+available|gone|cannot\s+be\s+found|wasn['’]?t\s+found|this\s+page\s+isn['’]?t\s+available)\b/.test(bodyLower)) {
      score += 1;
      reason = reason || 'dead-end text';
    }
    if (/(^|[/?#._-])(404|not[-_]?found|error)([/?#._-]|$)/.test(urlLower)) {
      score += 1;
      reason = reason || 'error-like URL';
    }

    return {
      isDeadEnd: score >= 2,
      reason: reason || '',
      score,
      effectiveUrl,
      pageTitle,
    };
  }

  _buildDeadEndRecoveryCandidates(primaryUrl = '', fallbackUrl = '') {
    const source = String(primaryUrl || fallbackUrl || '').trim();
    if (!source) return [];
    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      return [];
    }
    const current = parsed.toString();
    const candidates = [];
    const seen = new Set([current]);
    const pushCandidate = (url) => {
      const value = String(url || '').trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      candidates.push(value);
    };
    const withPath = (pathname) => {
      const copy = new URL(parsed.toString());
      copy.pathname = pathname || '/';
      copy.search = '';
      copy.hash = '';
      return copy.toString();
    };

    const path = String(parsed.pathname || '/');
    const trimmedPunctuation = path.replace(/[)\].,;:'"!?\u2019]+$/g, '') || '/';
    if (trimmedPunctuation !== path) {
      pushCandidate(withPath(trimmedPunctuation));
    }
    const withoutApostrophes = trimmedPunctuation.replace(/%27|'/gi, '');
    if (withoutApostrophes && withoutApostrophes !== trimmedPunctuation) {
      pushCandidate(withPath(withoutApostrophes));
    }
    const segments = trimmedPunctuation.split('/').filter(Boolean);
    if (segments.length > 1) {
      const parent = '/' + segments.slice(0, -1).join('/');
      pushCandidate(withPath(parent));
    }
    if (trimmedPunctuation !== '/') {
      pushCandidate(withPath('/'));
    }
    return candidates;
  }

  async _attemptDeadEndRecoveryNavigation(requestedUrl = '', currentResult = {}) {
    const currentUrl = String(currentResult?.finalUrl || currentResult?.pageUrl || currentResult?.url || requestedUrl || '').trim();
    const candidates = this._buildDeadEndRecoveryCandidates(currentUrl, requestedUrl)
      .slice(0, MAX_DEAD_END_RECOVERY_ATTEMPTS);
    if (candidates.length === 0) return { recovered: false };

    for (const candidate of candidates) {
      const blocked = this._checkSiteBlocked(candidate);
      if (blocked) continue;
      try {
        await this._clearFindTextContext();
        await chrome.tabs.update(this.tabId, { url: candidate });
        await this._waitForNavigation();
        try {
          await this._sendToContent('startMonitoring', {});
        } catch (err) {
          debugWarn('tool.navigate.deadEndRecovery.startMonitoring', err);
        }
        const pageData = await this._sendToContent('getPageText', {});
        const probe = {
          url: candidate,
          pageUrl: pageData?.url || candidate,
          pageTitle: pageData?.title || '',
          pageText: pageData?.text || '',
        };
        const deadEnd = this._detectDeadEndNavigationResult(probe, candidate);
        if (!deadEnd.isDeadEnd) {
          return {
            recovered: true,
            from: currentUrl,
            url: String(pageData?.url || candidate),
            pageUrl: String(pageData?.url || candidate),
            pageTitle: String(pageData?.title || ''),
            pageText: String(pageData?.text || '').slice(0, 3000),
            note: `Recovered from dead-end page by trying a nearby URL: ${candidate}`,
          };
        }
      } catch (err) {
        debugWarn('tool.navigate.deadEndRecovery.tryCandidate', err);
      }
    }
    return { recovered: false };
  }

  _goalAllowsSensitiveActions() {
    const text = String(this._goal || '').toLowerCase();
    const allowTerms = [
      'confirm', 'i confirm', 'i approve', 'approved', 'yes, proceed',
      'allowed', 'permission granted', 'you may send', 'you may delete',
      'send email', 'delete', 'remove', 'pay', 'purchase', 'checkout', 'transfer',
      'send', 'delete it', 'pay now', 'transfer now', 'buy',
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
      'authentication page',
      'sign-in screen',
      'login screen',
      'auth screen',
    ].some((term) => text.includes(term));
  }

  _shouldSkipInitialSnapshot(goalText = '', currentUrl = '') {
    void goalText;
    void currentUrl;
    return false;
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
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'MAIN',
        func: () => {
          const isVis = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return false;
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
          };
          const pass = Array.from(document.querySelectorAll('input[type="password"], input[name*="pass" i], input[id*="pass" i]'));
          const otp = Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i]'));
          return {
            hasPasswordField: pass.some(isVis),
            hasOtpField: otp.some(isVis),
          };
        },
      });
      const parsed = probe?.result;
      if (parsed && typeof parsed === 'object') {
        hasPasswordField = parsed.hasPasswordField === true;
        hasOtpField = parsed.hasOtpField === true;
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
    this._activePauseKind = String(details.kind || '');
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
    this._activePauseKind = '';
    this._pendingResumeGuidance = '';

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
