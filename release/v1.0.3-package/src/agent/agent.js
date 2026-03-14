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
  PAGE_TEXT_EXTRACTION_THRESHOLD,
  RATE_LIMIT_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_MAX_MS,
  RATE_LIMIT_MAX_RETRIES,
  REFLECTION_CHAT_SOFT_TIMEOUT_MS,
  REFLECTION_CONFIDENCE_THRESHOLD,
  REFLECTION_MAX_ACTIONS_PER_STEP,
  SNAPSHOT_MAX_ITEMS,
} from '../config/constants.js';
import {
  QWEN3VL_OLLAMA_SYSTEM_ADDENDUM,
  XAI_GROK_FAST_SYSTEM_ADDENDUM,
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
];
const LOGIN_HINTS = [
  'sign in',
  'signin',
  'log in',
  'login',
  'authenticate',
  'verification code',
  'two-factor',
  '2fa',
];
const PASSWORD_HINTS = [
  'password',
  'passcode',
  'one-time code',
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
  'tabs_context',
  'read_console',
  'read_network',
]);

/**
 * Resolve a compound tool+action into a granular action name for comparisons.
 * For compound tools (computer, navigate, tabs_context), returns the specific action.
 * For simple tools, returns the tool name itself.
 *
 * Can accept either (toolName, args) or a history entry object.
 */
function resolveAction(toolOrEntry, args) {
  const tool = typeof toolOrEntry === 'string' ? toolOrEntry : String(toolOrEntry?.tool || '');
  const a = String(
    (args?.action) ||
    (typeof toolOrEntry === 'object' ? toolOrEntry?.args?.action : '') ||
    ''
  ).trim();
  if (tool === 'computer' && a) return a; // click, type, scroll, hover, select, press_key, screenshot, wait_for
  if (tool === 'tabs_context') {
    if (a === 'switch') return 'switch_tab';
    if (a === 'close') return 'close_tab';
    if (a === 'switch_frame') return 'switch_frame';
    return 'list_tabs';
  }
  if (tool === 'navigate') {
    if (a === 'back') return 'back';
    if (a === 'forward') return 'forward';
    if (a === 'reload') return 'reload';
    return 'navigate';
  }
  return tool;
}

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
  'JS_BLOCKED',
  'JS_DOMAIN_BLOCKED',
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
const SEMANTIC_REPEAT_WINDOW = 6;
const SERP_READ_LOOP_THRESHOLD = 3;
const EARLY_TOKEN_BURN_MIN_STEP = 3;
const EARLY_TOKEN_BURN_RATIO = 0.68;
const EARLY_TOKEN_PROJECTION_RATIO = 1.2;
const MAX_DEAD_END_RECOVERY_ATTEMPTS = 2;

// ===== ANTI-LOOPING: Consecutive Empty / Duplicate Call Thresholds =====
// If the agent receives empty (zero-signal) results N times in a row, force a strategy switch.
const CONSECUTIVE_EMPTY_WARN_THRESHOLD = 2;    // warn + flush plan + inject system nudge
const CONSECUTIVE_EMPTY_FAIL_THRESHOLD = 4;    // hard fail-fast
// If the agent keeps triggering DUPLICATE_CALL, escalate progressively.
// Thresholds are set high enough to allow the agent to recover by clicking
// through to detail pages from search results before force-terminating.
const CONSECUTIVE_DUPLICATE_WARN_THRESHOLD = 2; // second DUPLICATE_CALL → flush plan + strong nudge
const CONSECUTIVE_DUPLICATE_FORCE_THRESHOLD = 3; // third → auto-inject fallback action
const CONSECUTIVE_DUPLICATE_FAIL_THRESHOLD = 5;  // fifth → fail-fast

// ===== ADAPTIVE STEP LIMIT =====
// Complexity tiers for adaptive maxSteps calculation.
// Simple tasks (navigate/open) → 8 steps
// Medium tasks (find/search/check) → 20 steps
// Complex tasks (multi-step, fill forms, extract) → 50 steps (default)
const ADAPTIVE_STEPS_SIMPLE = 8;
const ADAPTIVE_STEPS_MEDIUM = 20;
const ADAPTIVE_STEPS_COMPLEX = AGENT_MAX_STEPS; // 50

/**
 * Compute adaptive maxSteps based on goal complexity.
 * Analyzes the goal text for complexity signals:
 *  - Simple: pure navigation (open/go to/visit) with no extra intent
 *  - Medium: single-intent info lookup (find/search/check/what is)
 *  - Complex: multi-step, form filling, extraction, multi-part goals
 *
 * @param {string} goalText
 * @returns {number} recommended maxSteps
 */
function computeAdaptiveMaxSteps(goalText) {
  const text = String(goalText || '').trim().toLowerCase();
  if (!text) return ADAPTIVE_STEPS_COMPLEX;

  // Count action verbs — more verbs = more complex
  const actionVerbs = (text.match(/\b(open|go|navigate|visit|find|search|check|look up|get|read|extract|fill|type|click|submit|download|upload|send|create|delete|update|compare|list|collect|monitor|schedule|login|sign in|register)\b/g) || []);
  const verbCount = actionVerbs.length;

  // Multi-part indicators: "and", "then", "also", commas, semicolons
  const multiPartSignals = (text.match(/\b(and then|after that|also|additionally|furthermore)\b|[,;]/g) || []).length;

  // Form/interaction signals
  const hasFormIntent = /\b(fill|type|enter|input|submit|login|sign in|register|checkout|pay|purchase)\b/.test(text);

  // Extraction/collection signals
  const hasExtractionIntent = /\b(extract|collect|list all|find all|get all|scrape|monitor|compare|table|spreadsheet)\b/.test(text);

  // Pure navigation: "open X", "go to X", "navigate to X", "visit X"
  const isPureNavigation = /^(open|go to|navigate to|visit|show)\s+\S/.test(text) && verbCount <= 1 && multiPartSignals === 0;

  if (isPureNavigation) {
    return ADAPTIVE_STEPS_SIMPLE;
  }

  // Complex: multi-part, form filling, extraction
  if (multiPartSignals >= 2 || hasFormIntent || hasExtractionIntent || verbCount >= 4) {
    return ADAPTIVE_STEPS_COMPLEX;
  }

  // Medium: single-intent info lookup
  if (verbCount <= 2 && multiPartSignals <= 1) {
    return ADAPTIVE_STEPS_MEDIUM;
  }

  return ADAPTIVE_STEPS_COMPLEX;
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
    this._pendingResumeGuidance = '';
    this._activePauseKind = '';
    this._isWaitingForUser = false;
    // Plan mode
    this.planMode = false;
    this.onPlan = null;
    this._planApprovalResolver = null;
    this._pendingIntervention = null;
    this._pendingPlanText = '';
    this._approvedPlanText = '';
    // Per-domain JS permission
    this.trustedJsDomains = new Set();
    this._jsDomainResolver = null;
    this._jsDomainDenied = false;
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
    this._pendingVerification = null;
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
    this._pendingJsDomain = '';
    this._resourceBudgets = {
      maxWallClockMs: AGENT_MAX_WALL_CLOCK_MS,
      maxTotalTokens: AGENT_MAX_TOTAL_TOKENS,
      maxEstimatedCostUsd: AGENT_MAX_ESTIMATED_COST_USD,
    };
    this._budgetLimitsBypassed = false;
    this._reflectionChatSoftTimeoutMs = REFLECTION_CHAT_SOFT_TIMEOUT_MS;
    // Cache for page reads — must be initialized here so it's available when
    // _handleToolCalls is called directly (e.g. in tests) without going through run().
    this._pageReadCache = new Map();
    // ── Temporal awareness ──
    // Tracks whether the goal references a future/barely-started time period.
    this._temporalHint = '';
    // ── Find-text zero-result streak ──
    // Counts consecutive find_text calls returning 0 results to force strategy pivot.
    this._consecutiveFindTextZeroCount = 0;
    // ── Plan/Execute/Evaluate cycle ──
    // Tracks the last plan's "signature" to detect unchanged plans across reflections.
    this._lastPlanSignature = '';
    this._unchangedPlanCount = 0;
    // ── Save-progress spin detection ──
    // Counts consecutive save_progress calls with no URL change or real action in between.
    // When ≥ 3: the agent is writing notes in circles without taking new actions.
    // Exposed to _normalizeReflectionState as a loop signal to trigger convergence.
    this._consecutiveSaveProgressCount = 0;
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

    // ── Adaptive step limit ──────────────────────────────────────────────────
    // Compute maxSteps based on goal complexity unless explicitly overridden.
    // This reduces LLM calls and cost for simple tasks by 60-80%.
    if (options?.maxSteps !== undefined && options.maxSteps !== null) {
      const overrideSteps = Math.min(Math.max(Number(options.maxSteps) || AGENT_MAX_STEPS, 1), AGENT_MAX_STEPS);
      this.maxSteps = overrideSteps;
    } else if (!hasResumeState) {
      // Only apply adaptive limit on fresh runs (not resumed sessions)
      const adaptiveSteps = computeAdaptiveMaxSteps(this._goal);
      if (adaptiveSteps < this.maxSteps) {
        console.log(`[Agent] Adaptive maxSteps: ${adaptiveSteps} (goal: "${this._goal.slice(0, 60)}")`);
        this.maxSteps = adaptiveSteps;
      }
    }

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
    this._pendingVerification = null;
    this._lastFindHits = [];
    this._lastFindTextMiss = null;
    this._lastPageTextSignature = '';
    // Cache: { key → result } for get_page_text and read_page, invalidated on mutation/navigation.
    // Prevents the model from paying the cost of repeated identical reads on the same page.
    this._pageReadCache = new Map(); // key = `${tool}:${url}:${scope||'full'}:${selector||''}`
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
    this._pendingJsDomain = '';
    this._budgetLimitsBypassed = false;
    // ── Temporal awareness ──
    this._temporalHint = '';
    // ── Find-text zero-result streak ──
    this._consecutiveFindTextZeroCount = 0;
    // ── Anti-looping: consecutive empty results & duplicate call streak ──
    this._consecutiveEmptyResults = 0;        // incremented on any zero-signal tool result
    this._consecutiveDuplicateCalls = 0;      // incremented on each DUPLICATE_CALL error
    this._urlToolReadLog = new Map();          // Map<"url|tool" → stepNumber>: hard-blocks re-reads
    this._consecutiveSaveProgressCount = 0;   // incremented when save_progress repeats without URL/action change
    // ── Plan/Execute/Evaluate cycle ──
    this._lastPlanSignature = '';
    this._unchangedPlanCount = 0;
    // Deferred plan queue: when reflection produces multiple actions, they are
    // stashed here and consumed one-per-step WITHOUT re-calling the LLM.
    // The queue is invalidated on navigation, tool failure, or abort signals.
    this._planQueue = [];           // Array<{tool, args, fromStep}> — remaining queued plan actions
    this._planStepStart = -1;       // step index when this plan was created
    this._planCreatedAtUrl = '';    // URL at the time the plan was created; used to detect stale agentIds

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
      this._activePauseKind = String(resumeState.activePauseKind || '');
      this._pendingPlanText = String(resumeState.pendingPlanText || '');
      this._approvedPlanText = String(resumeState.approvedPlanText || '');
      try {
        this._pendingIntervention = resumeState.pendingIntervention && typeof resumeState.pendingIntervention === 'object'
          ? JSON.parse(JSON.stringify(resumeState.pendingIntervention))
          : null;
      } catch {
        this._pendingIntervention = null;
      }
      const restoredNotifyCalls = Number(resumeState.notifyConnectorCalls);
      if (Number.isFinite(restoredNotifyCalls) && restoredNotifyCalls > 0) {
        this._notifyConnectorCalls = Math.min(Math.max(restoredNotifyCalls, 0), 3);
      }
      if (resumeState.reflectionState && typeof resumeState.reflectionState === 'object' && !Array.isArray(resumeState.reflectionState)) {
        this._reflectionState = resumeState.reflectionState;
      }
      if (resumeState.pendingVerification && typeof resumeState.pendingVerification === 'object' && !Array.isArray(resumeState.pendingVerification)) {
        this._pendingVerification = resumeState.pendingVerification;
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
      const stored = await chrome.storage.local.get(['customBlockedDomains', 'trustedJsDomains']);
      if (Array.isArray(stored.customBlockedDomains)) {
        for (const d of stored.customBlockedDomains) {
          const domain = normalizeBlockedDomain(d);
          if (!domain) continue;
          this.blockedDomains.add(domain);
        }
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

    if (hasResumeState && String(resumeState.status || '') === 'paused_waiting_user' && this._pendingIntervention) {
      const interventionType = String(this._pendingIntervention.type || '');
      if (interventionType === 'planApproval') {
        const approved = await this._pauseForPlanApproval(
          this._pendingIntervention.plan || this._pendingPlanText,
          { message: this._pendingIntervention.message || '' },
        );
        if (!approved || this._aborted) {
          this._stopTabWatcher();
          try {
            await this._sendToContent('stopMonitoring', {});
          } catch (err) {
            debugWarn('run.stopMonitoring.recoveredPlanCancelled', err);
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

    // ── Temporal awareness: warn about future/barely-started date ranges ──
    this._temporalHint = this._buildTemporalAwarenessHint(goalText);
    if (this._temporalHint) {
      taskMessage += `\n\n${this._temporalHint}`;
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
          viewportOnly: true,
        });
        if (snap && !snap.code) {
          // Use compact interactive-refs mode for the initial snapshot (Snapshot+Refs pattern)
          snap._readMode = 'compact';
          const compactRefs = this._buildInteractiveRefsFromReadPage(snap);
          const snapText = JSON.stringify(compactRefs);
          const boundedText = `<page_content>\n${snapText.length > 8000 ? snapText.slice(0, 8000) : snapText}\n</page_content>`;
          // Inject as a synthetic assistant+tool exchange so the model sees it as prior context
          const syntheticCallId = 'call_auto_readpage';
          this._appendMessage(messages, {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: syntheticCallId,
              type: 'function',
              function: { name: 'read_page', arguments: '{"mode":"compact"}' },
            }],
          });
          this._appendMessage(messages, {
            role: 'tool',
            tool_call_id: syntheticCallId,
            content: boundedText,
          });
          this.history.push({ step: -1, type: 'action', tool: 'read_page', args: { mode: 'compact' }, result: snap });
          this._emitStep({ step: -1, type: 'action', tool: 'read_page', args: { mode: 'compact' }, result: snap });
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

          // Filter tools based on provider capabilities and task context
          let activeTools = this._getActiveToolsForStep(step);
          const stepBudget = {
            total: this.maxSteps,
            used: Math.max(step - stepStart, 0),
            remaining: Math.max(maxStepExclusive - step, 0),
          };

          // ── Deferred Plan Execution ──────────────────────────────────────────
          // If a previous reflection produced multiple queued actions, consume
          // them directly WITHOUT calling the LLM (saves API tokens).
          //
          // Optimization: batch consecutive parallel-safe (read-only) actions
          // from the front of the queue into a single _handleToolCalls call.
          // They will execute concurrently via Promise.all in _handleToolCalls.
          if (this._planQueue.length > 0) {
            // ── Stale agentId guard ──────────────────────────────────────────────
            // If the URL changed since the plan was created, any queued computer(click/hover)
            // actions reference agentIds from the old page and will fail with ELEMENT_NOT_FOUND.
            // Flush the queue proactively so the agent re-reflects on the new page.
            const planUrl = String(this._planCreatedAtUrl || '');
            const currentUrl = String(this._lastKnownUrl || '');
            if (planUrl && currentUrl && planUrl !== currentUrl) {
              const nextAction = this._planQueue[0];
              const nextTool = String(nextAction?.tool || '');
              const nextAction_ = nextAction?.args?.action || '';
              const usesAgentId = (
                nextTool === 'computer' &&
                ['click', 'hover', 'type', 'select'].includes(String(nextAction_))
              );
              if (usesAgentId) {
                console.log(
                  `[Agent] Step ${step}: flushing ${this._planQueue.length} queued actions — ` +
                  `URL changed from "${planUrl}" to "${currentUrl}", agentIds are stale.`
                );
                this._planQueue = [];
                this._planCreatedAtUrl = '';
                // Fall through to re-reflect
              }
            }
          }

          if (this._planQueue.length > 0) {
            // Collect leading parallel-safe actions from the queue
            const batchActions = [];
            while (
              this._planQueue.length > 0 &&
              PARALLEL_SAFE_TOOLS.has(this._planQueue[0].tool) &&
              batchActions.length < 4 // cap batch size to avoid overwhelming the model context
            ) {
              batchActions.push(this._planQueue.shift());
            }

            // If no parallel-safe actions at front, take the first action (mutating)
            if (batchActions.length === 0) {
              batchActions.push(this._planQueue.shift());
            }

            const batchLabel = batchActions.length > 1
              ? `${batchActions.length} parallel reads [${batchActions.map(a => a.tool).join(', ')}]`
              : batchActions[0].tool;
            this._emitStep({
              step, type: 'thought',
              content: `[PLAN_EXEC] Executing ${batchLabel} (${this._planQueue.length} remaining in plan)`,
            });

            const syntheticCached = {
              text: null,
              toolCalls: batchActions.map((a, idx) => ({
                id: `plan_${step}_${idx}`,
                name: a.tool,
                arguments: a.args,
                meta: { expected_outcome: a.expected_outcome },
              })),
            };
            const cachedResult = await this._handleToolCalls(step, messages, syntheticCached, stepBudget);
            if (cachedResult) return cachedResult;
            // Evaluate if the plan should be invalidated before consuming the next step
            const lastAct = this.history.filter(h => h.type === 'action').slice(-1)[0];
            if (lastAct?.result?.success === false) {
              // Only flush the plan queue when a MUTATING action fails.
              // Read-only failures (empty results) don't invalidate the remaining plan.
              const failedTool = String(lastAct?.tool || '');
              const isReadOnlyTool = PARALLEL_SAFE_TOOLS.has(failedTool);
              if (!isReadOnlyTool) {
                this._planQueue = [];
                this._planCreatedAtUrl = '';
                console.log(`[Agent] Plan invalidated at step ${step}: mutating tool ${failedTool} failed.`);
              } else {
                console.log(`[Agent] Step ${step}: read-only tool ${failedTool} returned empty — keeping plan queue (${this._planQueue.length} remaining).`);
              }
            }
            continue; // next iteration: either consume more from queue or re-reflect
          }

          // ── Fast-path: skip reflection for predictable post-navigation reads ──
          // After a successful navigate, the next action is almost always
          // get_page_text or read_page. Skip the reflection LLM call and
          // execute directly — saves one full LLM round-trip per navigation.
          const fastPathAction = this._tryFastPathAction(step);
          if (fastPathAction) {
            this._emitStep({
              step, type: 'thought',
              content: `[FAST_PATH] Skipping reflection: ${fastPathAction.tool} (post-navigation read)`,
            });
            const fastPathResponse = {
              text: null,
              toolCalls: [{ id: `fast_${step}_0`, name: fastPathAction.tool, arguments: fastPathAction.args }],
            };
            const fastResult = await this._handleToolCalls(step, messages, fastPathResponse, stepBudget);
            if (fastResult) return fastResult;
            continue;
          }

          // 1) REFLECT: mandatory reasoning pass — only when queue is empty
          // Emit a "thinking" event before the LLM call so the UI shows activity
          // immediately instead of appearing frozen during long reflection calls.
          this._emitStep({
            step,
            type: 'thinking',
            content: `[REFLECT] Step ${step}: reasoning about next action…`,
            startedAt: Date.now(),
          });
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
            : [];
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

          // ── Plan/Execute/Evaluate: detect unchanged plans ─────────────────
          // Compute a fingerprint of the current plan to detect when the LLM
          // keeps proposing the same ineffective strategy (e.g. find_text with
          // minor regex variations on the same page).
          {
            const planSig = normalizedPlannedActions
              .map(a => {
                const tool = String(a.tool || '');
                // For find/find_text, normalize query to detect minor variations
                const query = String(a.args?.query || '').trim().toLowerCase()
                  .replace(/[^a-z0-9а-яё ]/gi, '') // strip regex chars
                  .replace(/\s+/g, ' ')
                  .trim();
                const url = String(a.args?.url || '').trim().toLowerCase();
                if (query) return `${tool}:${query.slice(0, 50)}`;
                if (url) return `${tool}:${url.slice(0, 80)}`;
                return tool;
              })
              .join('|');

            if (planSig === this._lastPlanSignature) {
              this._unchangedPlanCount += 1;
            } else {
              this._lastPlanSignature = planSig;
              this._unchangedPlanCount = 0;
            }

            if (this._unchangedPlanCount >= 3) {
              // The LLM is stuck proposing the same plan — force a different approach
              const pivotMsg = `PLAN STAGNATION DETECTED: You have proposed the same plan ${this._unchangedPlanCount + 1} times in a row (${planSig.slice(0, 100)}). `
                + 'This approach is NOT working. You MUST fundamentally change your strategy: '
                + '(1) Navigate to a completely different URL/source. '
                + '(2) Use a different tool than what you have been using. '
                + '(3) If the information cannot be found, report what you have and call done. '
                + 'Repeating the same tools with the same intent is forbidden at this point.';
              this._appendMessage(messages, { role: 'user', content: pivotMsg });
              this._noProgressStreak += 1;
              this._planQueue = [];
              this._planCreatedAtUrl = '';
              this._unchangedPlanCount = 0;
              this._lastPlanSignature = '';
              // Force reflection to re-evaluate with the new nudge
              continue;
            }
          }

          // ── Plan-Queue Population ─────────────────────────────────────────
          // Strategy:
          //  • All leading parallel-safe (read-only) tools → execute as one batch now
          //  • First mutating action → execute now
          //  • Remaining actions → stash in _planQueue (no LLM call needed next step)
          //
          // Navigation actions always flush the queue (page state will change).
          const NAV_TOOLS = new Set(['navigate', 'tabs_create', 'tabs_context']);
          const MUTATING_STOP_TOOLS = new Set(['done', 'fail', 'restore_snapshot', ...NAV_TOOLS]);

          // Split into: immediate parallel-safe prefix, then first non-parallel tail
          let immediateActions = [];
          let queueActions = [];
          let hitMutating = false;

          for (const a of normalizedPlannedActions) {
            if (hitMutating) {
              queueActions.push(a);
            } else if (PARALLEL_SAFE_TOOLS.has(a.tool)) {
              immediateActions.push(a);
            } else {
              // Navigation after reads: if we already have read actions queued,
              // defer the navigate to the next step so the agent can process
              // read results before destroying the page context.
              if (NAV_TOOLS.has(a.tool) && immediateActions.length > 0) {
                queueActions.push(a);
                hitMutating = true;
                break;
              }
              // First mutating action: include in immediate batch, then queue the rest
              immediateActions.push(a);
              hitMutating = true;
              // Navigation ends the entire plan; don't queue anything after it
              if (MUTATING_STOP_TOOLS.has(a.tool)) {
                break;
              }
            }
          }

          // Store remaining plan actions for later steps
          if (queueActions.length > 0) {
            this._planQueue = queueActions.map(a => ({
              tool: a.tool,
              args: a.args,
              expected_outcome: a.expected_outcome,
            }));
            this._planStepStart = step;
            // Record the URL at plan creation so we can detect stale agentIds later.
            this._planCreatedAtUrl = String(this._lastKnownUrl || '');
            console.log(`[Agent] Step ${step}: queued ${this._planQueue.length} deferred plan actions (saves ${this._planQueue.length} LLM calls).`);
          } else {
            this._planQueue = [];
            this._planCreatedAtUrl = '';
          }

          const syntheticResponse = {
            text: null,
            toolCalls: immediateActions.map((action, idx) => ({
              id: `reflect_${step}_${idx}`,
              name: action.tool,
              arguments: action.args || {},
              meta: { expected_outcome: action.expected_outcome },
            })),
          };
          this._reflectionNoActionStreak = 0;
          const result = await this._handleToolCalls(step, messages, syntheticResponse, stepBudget);
          if (result) return result; // terminal action (done/fail)

          // If the immediate batch contained a navigation, flush the queue —
          // the page state changed and queued element IDs are now stale.
          const lastAct2 = this.history.filter(h => h.type === 'action').slice(-1)[0];
          if (lastAct2 && NAV_TOOLS.has(lastAct2.tool) && lastAct2.result?.success !== false) {
            if (this._planQueue.length > 0) {
              console.log(`[Agent] Step ${step}: flushing ${this._planQueue.length} queued actions due to navigation.`);
              this._planQueue = [];
              this._planCreatedAtUrl = '';
            }
          }
        } catch (err) {
          console.error(`[Agent] Step ${step} error:`, err);
          this.metrics.errors += 1;
          this.history.push({ step, type: 'error', error: err.message });
          this._emitStep({ step, type: 'error', error: err.message });
          // Always flush the deferred plan on any exception — the plan may be stale
          if (this._planQueue.length > 0) {
            console.log(`[Agent] Step ${step}: flushing ${this._planQueue.length} queued plan actions due to error.`);
            this._planQueue = [];
            this._planCreatedAtUrl = '';
          }

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
        _meta: tc?.meta && typeof tc.meta === 'object' ? { ...tc.meta } : {},
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
      const actionMeta = assistantToolCalls[i]._meta || {};

      this.metrics.toolCalls += 1;

      // Duplicate tool call detection — skip terminal tools (done/fail)
      let isDuplicate = false;
      let duplicateNudge = '';
      let duplicateHint = null;
      let duplicateSource = '';
      if (tc.name !== 'done' && tc.name !== 'fail') {
        const toolKey = tc.name + ':' + JSON.stringify(normalizedArgs);
        if (toolKey === this._lastToolKey) {
          this._dupCount += 1;

          // Special case for scroll: if the page actually moved on the previous scroll,
          // allow repeating — scrolling while content is advancing is valid behavior.
          if (tc.name === 'scroll') {
            const prevScroll = this.history
              .filter((h) => h.type === 'action' && h.tool === 'scroll')
              .slice(-1)[0];
            if (prevScroll?.result?.moved === true) {
              this._dupCount = 0; // page moved — allow next scroll
            } else if (this._dupCount >= 1) {
              isDuplicate = true;
              this.metrics.duplicateToolCalls += 1;
              duplicateSource = 'exact_scroll_repeat_without_movement';
              duplicateNudge = 'Scroll did not move the page. The page is likely at the bottom or content is not scrollable. Use press_key with "End" to reach the bottom, or try a different tool.';
              duplicateHint = {
                strategy: 'change_tool_or_args',
                nextTool: 'press_key',
                args: { key: 'End' },
                avoidRepeat: true,
              };
            }
          } else if (this._dupCount >= 1) {
            isDuplicate = true;
            duplicateSource = 'exact_tool_args_repeat';
            duplicateNudge = `You already called ${tc.name} with the same arguments ${this._dupCount + 1} times. The result will not change. Try a DIFFERENT tool or approach. For example: use find_text to search for specific content, get_page_text to read the full page, or navigate to a different URL.`;
            duplicateHint = this._pickSafeBlockedFallback(tc.name, normalizedArgs, {
              strategy: 'change_tool_or_args',
              nextTool: tc.name === 'find' || tc.name === 'find_text' ? 'navigate' : 'read_page',
              args: {},
              avoidRepeat: true,
            });
          }
        } else {
          this._lastToolKey = toolKey;
          this._dupCount = 0;
        }

        // Adaptive loop detection for read-only vacillation.
        // Be conservative: trigger only on low-signal stagnation on the same page,
        // and avoid blocking productive find/find_text exploration.
        if (!isDuplicate && ['save_progress', 'get_page_text', 'read_page', 'find', 'find_text'].includes(tc.name)) {
          const recentActions = this.history.filter((h) => h.type === 'action').slice(-6);
          if (recentActions.length >= 5) {
            const samePageKey = this._urlLoopKey(this._lastKnownUrl, true);
            const samePageOnly = recentActions.every((h) => {
              const itemUrl = this._extractActionUrl(h) || this._lastKnownUrl;
              const itemKey = this._urlLoopKey(itemUrl, true);
              return !samePageKey || !itemKey || itemKey === samePageKey;
            });
            const readOnlyActions = recentActions.filter((h) => ['save_progress', 'get_page_text', 'read_page', 'find', 'find_text'].includes(h.tool));
            const saveProgressCount = readOnlyActions.filter((h) => h.tool === 'save_progress').length;
            const hasHighSignal = readOnlyActions.some((h) => this._isHighSignalObservation(h));

            // Only classify as loop when there is sustained low-signal behavior,
            // including repeated save_progress checkpoints, on the same page.
            if (samePageOnly && readOnlyActions.length >= 5 && saveProgressCount >= 2 && !hasHighSignal) {
              isDuplicate = true;
              this.metrics.duplicateToolCalls += 1;
              duplicateSource = 'adaptive_read_only_low_signal_loop';
              duplicateNudge = 'Low-signal read-only loop detected on the same page. Switch to a state-changing action (pagination click, open result, or new URL) instead of repeating reads/save_progress.';
              duplicateHint = this._isLikelySerpUrl(this._lastKnownUrl)
                ? {
                  strategy: 'break_read_only_loop',
                  nextTool: 'find',
                  args: { query: 'pagination next page link' },
                  avoidRepeat: true,
                }
                : {
                  strategy: 'break_read_only_loop',
                  nextTool: 'tabs_context',
                  args: { action: 'list' },
                  avoidRepeat: true,
                };
            }
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
                duplicateSource = 'cyclic_ababa_pattern';
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
          // Hard-block re-reading the same URL with the same observation tool
          // when the page hasn't changed since the last successful read.
          const reReadBlock = this._checkUrlToolReRead(tc.name, normalizedArgs);
          if (reReadBlock) {
            isDuplicate = true;
            this.metrics.duplicateToolCalls += 1;
            duplicateSource = 'url_tool_reread_hard_block';
            duplicateNudge = reReadBlock.reason || reReadBlock.error;
            duplicateHint = reReadBlock.hint || {
              strategy: 'change_strategy',
              nextTool: 'navigate',
              args: {},
              avoidRepeat: true,
            };
          }
        }

        if (!isDuplicate) {
          const semanticRepeat = this._detectSemanticRepeat(tc.name, normalizedArgs);
          if (semanticRepeat?.repeated) {
            isDuplicate = true;
            this.metrics.duplicateToolCalls += 1;
            duplicateSource = 'semantic_repeat_detector';
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
            duplicateSource = 'serp_read_loop_guard';
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
      let preActionSnapshot = null;
      if (isDuplicate) {
        console.warn(
          `[Agent][LoopDiag] DUPLICATE_CALL prepared: step=${step}, tool=${tc.name}, source=${duplicateSource || 'unknown'}, `
          + `url=${String(this._lastKnownUrl || '')}, dupCount=${this._dupCount}, hintNextTool=${String(duplicateHint?.nextTool || '')}`
        );
        result = this._makeError('DUPLICATE_CALL', duplicateNudge, {
          hint: duplicateHint || this._pickSafeBlockedFallback(tc.name, normalizedArgs, {
            strategy: 'change_tool_or_args',
            nextTool: tc.name === 'find' || tc.name === 'find_text' ? 'navigate' : 'read_page',
            args: {},
            avoidRepeat: true,
          }),
          retryable: false,
        });
      } else if (isJsBlocked) {
        const errType = jsBlockReason.includes('permitted') ? 'JS_DOMAIN_BLOCKED' : 'JS_BLOCKED';
        result = this._makeError(errType, jsBlockReason);
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
        const newUrl = String(observedUrl);
        if (newUrl !== this._lastKnownUrl) {
          // URL changed → page context changed, cached reads and dup-detection are stale
          this._pageReadCache.clear();
          this._lastToolKey = '';
          this._dupCount = 0;
          // Reset find_text zero-result streak — new page, new chance
          this._consecutiveFindTextZeroCount = 0;
          // Reset anti-looping counters — new page breaks the dead-end
          this._consecutiveEmptyResults = 0;
          this._consecutiveDuplicateCalls = 0;
          this._consecutiveSaveProgressCount = 0;
          // Clear URL-tool read log — the new page has different content even if
          // the base URL (without query params) is the same (e.g. pagination:
          // /search?start=0 vs /search?start=50). Without this, paginated pages
          // are falsely blocked as DUPLICATE_CALL because _urlToolReadLog keys
          // strip query params.
          if (this._urlToolReadLog instanceof Map) this._urlToolReadLog.clear();
        }
        this._lastKnownUrl = newUrl;

        // ── Opt 4: Cache navigate's pageText as get_page_text result ──
        // When navigate() returns pageText, pre-populate the page-read cache so
        // any subsequent get_page_text call on the same URL returns cached data
        // instead of making a redundant content-script round-trip.
        if (tc.name === 'navigate' && result?.success !== false) {
          const navPageText = String(result?.pageText || '').trim();
          if (navPageText.length > 100) {
            const cacheKey = `get_page_text:${newUrl}:full:`;
            const cachedResult = {
              success: true,
              text: navPageText,
              charCount: navPageText.length,
              url: newUrl,
              title: String(result?.pageTitle || ''),
              fromNavigateCache: true,
            };
            this._pageReadCache.set(cacheKey, cachedResult);
          }
        }
      }
      // Mutating actions (click, type, form_input, etc.) may change page DOM
      // even without a URL change → flush the cache so next get_page_text re-reads
      const isMutation = (
        (tc.name === 'computer' && ['click', 'type', 'press_key', 'select', 'hover'].includes(normalizedArgs?.action)) ||
        tc.name === 'form_input' ||
        tc.name === 'javascript'
      );
      if (isMutation && result?.success !== false && this._pageReadCache.size > 0) {
        this._pageReadCache.clear();
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
      if (['navigate', 'tabs_create', 'tabs_context'].includes(tc.name) && result?.success) {
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
          // ── Find-text zero-result streak tracking ──
          this._consecutiveFindTextZeroCount += 1;
          if (this._consecutiveFindTextZeroCount >= 3) {
            // Force a strategy pivot — inject a strong nudge into the conversation
            const pivotMsg = `STRATEGY PIVOT REQUIRED: ${this._consecutiveFindTextZeroCount} consecutive find_text calls returned 0 results. `
              + 'The content you are looking for does NOT exist on this page with these queries. '
              + 'You MUST change your approach NOW: navigate to a different URL, use get_page_text to read actual page content, '
              + 'try extract_structured, or reformulate your strategy entirely. '
              + 'Do NOT call find_text again with a minor regex variation — it will not work.';
            this._appendMessage(messages, { role: 'user', content: pivotMsg });
            // Also flush any queued plan — the plan is clearly ineffective
            if (this._planQueue.length > 0) {
              console.log(`[Agent] Step ${step}: flushing ${this._planQueue.length} queued plan actions due to find_text zero-result streak (${this._consecutiveFindTextZeroCount}).`);
              this._planQueue = [];
              this._planCreatedAtUrl = '';
            }
          }
        } else {
          this._lastFindTextMiss = null;
          this._consecutiveFindTextZeroCount = 0; // Reset on successful find
        }
      }
      if (tc.name === 'extract_structured') {
        this._rememberSerpCandidateUrls(result);
      }

      if (typeof this._updatePendingVerificationAfterAction === 'function') {
        this._updatePendingVerificationAfterAction(step, tc.name, normalizedArgs, actionMeta, result);
      }
      if (
        tc.name !== 'done' &&
        tc.name !== 'fail' &&
        this._pendingVerification &&
        this._pendingVerification.step === step &&
        this._pendingVerification.tool === String(tc.name || '').trim() &&
        result?.success !== false
      ) {
        this._appendMessage(messages, {
          role: 'user',
          content: this._pendingVerification.expectedOutcome
            ? `Action executed. Do not assume success yet. Verify that ${this._pendingVerification.expectedOutcome} before continuing or calling done.`
            : 'Action executed. Do not assume success yet. Verify the resulting page state before continuing or calling done.',
        });
      }

      // Track tool failure streaks (excluding terminal tools)
      if (tc.name !== 'done' && tc.name !== 'fail') {
        if (result?.success === false) {
          this._toolFailStreak += 1;
        } else {
          this._toolFailStreak = 0;
        }
        // Track last type failure for empty-submit detection
        if (tc.name === 'computer' && tc.args?.action === 'type') {
          this._lastTypeFailed = result?.success === false;
        }
      }

      // ── Anti-looping: track consecutive empty results & duplicate call streaks ──
      if (tc.name !== 'done' && tc.name !== 'fail') {
        const antiLoop = this._trackAntiLoopSignals(tc.name, result);
        if (antiLoop.forceStrategySwitch || antiLoop.forceFail) {
          console.warn(
            `[Agent][LoopDiag] anti-loop escalation: step=${step}, tool=${tc.name}, `
            + `emptyStreak=${antiLoop.emptyStreak}, duplicateStreak=${antiLoop.duplicateStreak}, `
            + `forceStrategySwitch=${antiLoop.forceStrategySwitch}, forceFail=${antiLoop.forceFail}, `
            + `resultCode=${String(result?.code || '')}`
          );
        }
        if (antiLoop.forceFail) {
          // Unrecoverable loop — terminate immediately
          this.status = 'failed';
          this._notify('failed');
          return this._buildTerminalResult({
            success: false,
            status: 'stuck',
            reason: antiLoop.systemMessage,
            steps: step + 1,
          });
        }
        if (antiLoop.forceStrategySwitch) {
          // Flush queued plan — current approach is clearly broken
          if (Array.isArray(this._planQueue) && this._planQueue.length > 0) {
            console.log(`[Agent] Step ${step}: flushing ${this._planQueue.length} queued plan actions due to anti-loop signal (empty=${antiLoop.emptyStreak}, dup=${antiLoop.duplicateStreak}).`);
            this._planQueue = [];
            this._planCreatedAtUrl = '';
          }
          this._appendMessage(messages, {
            role: 'user',
            content: `[SYSTEM] ${antiLoop.systemMessage}`,
          });
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
            const verification = this._validateDoneVerification();
            if (!verification.ok) {
              result = {
                success: false,
                code: 'DONE_VERIFICATION_REQUIRED',
                reason: verification.reason,
                error: verification.reason,
                hint: verification.hint,
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
      if (tc.name === 'computer' && tc.args?.action === 'screenshot' && result?.success && result?.imageBase64) {
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
        // If the result came from cache (page hasn't changed), nudge the model to act
        if (result?.cached && (tc.name === 'get_page_text' || tc.name === 'read_page')) {
          this._appendMessage(messages, {
            role: 'user',
            content: `[SYSTEM] This result is IDENTICAL to a previous read of the same page — the page has NOT changed. Do NOT call ${tc.name} again. You already have this content. Act on it: click a link, type in a field, navigate to a result URL, or call done/fail.`,
          });
        }

        // When a DUPLICATE_CALL carries a specific hint, inject it explicitly.
        // This makes the redirect concrete rather than leaving the LLM to parse the error JSON.
        if (result?.code === 'DUPLICATE_CALL') {
          const hint = result?.hint;
          const hintTool = String(hint?.nextTool || '').trim();
          console.warn(
            `[Agent][LoopDiag] DUPLICATE_CALL hint injection: tool=${tc.name}, `
            + `hintNextTool=${hintTool || 'none'}, hintStrategy=${String(hint?.strategy || '')}`
          );
          if (hintTool && hintTool !== tc.name) {
            this._appendMessage(messages, {
              role: 'user',
              content: `[SYSTEM] Do NOT call "${tc.name}" again — the result will not change. `
                + `You MUST use "${hintTool}" as the next action instead. `
                + (hint?.message ? hint.message + ' ' : '')
                + 'If you already have enough facts to answer the goal, set sufficiency=true and call done.',
            });
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
   * Extract relevant information from large page text via a focused secondary LLM call.
   * Returns a concise, goal-relevant excerpt instead of dumping the full text into context.
   * Falls back to null on any error so the caller can truncate instead.
   */
  async _extractFromLargePageText(text, goal) {
    // Use reflection unknowns as extraction hints for more targeted extraction
    const unknowns = Array.isArray(this._reflectionState?.unknowns)
      ? this._reflectionState.unknowns.slice(0, 5).join('; ')
      : '';
    const hintLine = unknowns
      ? `\nSpecifically look for: ${unknowns}`
      : '';

    const extractMessages = [
      {
        role: 'system',
        content: 'You are a precise information extractor. Given a goal and raw page text, extract ONLY the facts directly relevant to the goal. Return a concise, factual response (max 2000 chars). Preserve exact values: prices, names, dates, numbers, URLs. Do not add commentary or reformatting.',
      },
      {
        role: 'user',
        content: `Goal: ${String(goal || '').slice(0, 400)}${hintLine}\n\nPage text (${text.length} chars):\n<page_content>\n${text.slice(0, 30000)}\n</page_content>\n\nExtract only what is relevant to the goal:`,
      },
    ];
    this.metrics.llmCalls += 1;
    const response = await this.provider.chat(extractMessages, []);
    this._recordUsage(response?.usage);
    const extracted = response?.text ? String(response.text).trim() : null;
    return extracted && extracted.length > 10 ? extracted.slice(0, 3000) : null;
  }

  /**
   * Execute a tool by name.
   */
  async _executeTool(name, args) {
    switch (name) {
      case 'read_page':
        {
          const mode = String(args?.mode || 'compact');
          const isCompact = mode !== 'full';
          const goalText = String(this._goal || '').toLowerCase();
          const formLikeGoal = /(fill|form|login|sign\s?in|signup|register|input|enter|type)/i.test(goalText);
          const extractionLikeGoal = /(extract|read|collect|news|result|table|list|price|product|find)/i.test(goalText);

          // Compact mode: viewport-only with reduced node count (Snapshot+Refs pattern).
          // Full mode: full tree depth/breadth for when hierarchy matters.
          const defaultMaxDepth = isCompact ? 8 : (formLikeGoal ? 9 : 12);
          const defaultMaxNodes = isCompact ? 80 : (formLikeGoal ? 130 : (extractionLikeGoal ? 210 : 180));
          const useViewportOnly = isCompact ? true : (formLikeGoal ? true : undefined);

          // ── Page-read cache ──────────────────────────────────────────────
          const rpSelector = String(args?.selector || '');
          const rpCacheKey = `read_page:${mode}:${this._lastKnownUrl}:${rpSelector}`;
          if (this._pageReadCache.has(rpCacheKey)) {
            const cached = this._pageReadCache.get(rpCacheKey);
            return { ...cached, cached: true, cacheNote: 'Accessibility tree unchanged since last read — returning cached result.' };
          }

          const result = await this._sendToContent('readPage', {
            maxDepth: Math.min(Math.max(Number(args?.maxDepth) || defaultMaxDepth, 1), 12),
            maxNodes: Math.min(Math.max(Number(args?.maxNodes) || defaultMaxNodes, 20), 260),
            viewportOnly: useViewportOnly,
          });
          if (result && result.success !== false && this._isSparseAccessibilityTreeResult(result)) {
            result.sparseAx = true;
            result.sparseAxReason = 'Low interactive density in AX tree; consider screenshot-based probing.';
          }
          if (result && result.success !== false) {
            // Tag result with resolved mode so _serializeToolResultForLLM applies the right compressor.
            result._readMode = mode;
            this._pageReadCache.set(rpCacheKey, result);
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

          // ── Page-read cache ──────────────────────────────────────────────
          // Return cached result if the page hasn't changed since the last identical call.
          const cacheKey = `get_page_text:${currentUrl}:${scope || 'full'}:${selector || ''}`;
          if (this._pageReadCache.has(cacheKey)) {
            const cached = this._pageReadCache.get(cacheKey);
            return { ...cached, cached: true, cacheNote: 'Page text unchanged since last read — returning cached result.' };
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

          // ── Empty-text fallback ───────────────────────────────────────────
          // When the content script returns charCount=0, two root causes are possible:
          //   (a) The page is still rendering JS-loaded content (async/lazy data).
          //   (b) The structured extractor filtered out all text (non-semantic layout).
          // Case (b) is now handled in content.js (rawFallback path), but if both
          // content-script paths still return empty, inject JS to extract innerText.
          if (result && result.success !== false && !(result.text) && !(result.rawFallback)) {
            try {
              // Wait up to 1.5s for dynamic content to finish rendering, then retry.
              await this._sendToContent('waitForDomSettle', { timeoutMs: 1500, quietMs: 300 });
              const retried = await this._sendToContent('getPageText', { scope, selector, maxChars });
              if (retried?.text) {
                result = retried;
              }
            } catch (err) {
              debugWarn('tool.getPageText.settleRetry', err);
            }

            // If still empty after settle+retry, extract raw innerText via scripting API.
            if (!(result?.text)) {
              try {
                const jsResult = await this._executeJavaScriptMainWorld(
                  '(function(){try{var t=(document.body||document.documentElement).innerText||"";return t.trim().slice(0,14000)}catch(e){return ""}})()',
                );
                const raw = typeof jsResult?.result === 'string' ? jsResult.result.trim() : '';
                if (raw.length > 20) {
                  result = {
                    ...(result || {}),
                    text: raw,
                    charCount: raw.length,
                    jsTextFallback: true,
                    jsTextFallbackNote: 'Content-script extraction yielded empty; raw innerText extracted via executeScript. May include nav/footer boilerplate.',
                  };
                }
              } catch (err) {
                debugWarn('tool.getPageText.jsTextFallback', err);
              }
            }
          }

          // Large-page extraction: if text exceeds threshold, make a focused secondary LLM call
          // to pull out only what’s relevant to the current goal instead of flooding the context.
          if (result?.text && result.text.length > PAGE_TEXT_EXTRACTION_THRESHOLD) {
            try {
              const extracted = await this._extractFromLargePageText(result.text, this._goal);
              if (extracted) {
                result = {
                  ...result,
                  text: extracted,
                  originalLength: result.text.length,
                  extractedForContext: true,
                  extractionNote: `Page text was ${result.text.length} chars; relevant excerpt extracted via focused LLM sub-call to avoid context overflow.`,
                };
              } else {
                // Extraction call returned empty — fall back to hard truncation.
                result = { ...result, text: result.text.slice(0, PAGE_TEXT_EXTRACTION_THRESHOLD), truncatedForContext: true, originalLength: result.text.length };
              }
            } catch (err) {
              debugWarn('tool.getPageText.extractFromLargePageText', err);
              // Non-fatal: fall back to hard truncation.
              result = { ...result, text: result.text.slice(0, PAGE_TEXT_EXTRACTION_THRESHOLD), truncatedForContext: true, originalLength: result.text.length };
            }
          }

          // Populate cache for subsequent identical calls on this page
          if (result?.text) {
            this._pageReadCache.set(cacheKey, result);
          }
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
          // Sub-actions: back, forward, reload
          const navAction = String(args.action || 'go').trim().toLowerCase();
          if (navAction === 'back') return await this._navigateHistory('back');
          if (navAction === 'forward') return await this._navigateHistory('forward');
          if (navAction === 'reload') return await this._reloadTab(args);
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
          // Detect redirect — warn the model if final URL differs from requested.
          // Same-domain path redirects (e.g. /search → /) are also flagged so the
          // agent knows it landed on a different page than intended.
          const result = { success: true, url: validatedUrl };
          try {
            const tab = await chrome.tabs.get(this.tabId);
            const finalUrl = tab?.url || '';
            if (finalUrl && finalUrl !== validatedUrl) {
              result.redirected = true;
              result.finalUrl = finalUrl;
              let reqPathname = '';
              let finalPathname = '';
              try {
                reqPathname = new URL(validatedUrl).pathname;
                finalPathname = new URL(finalUrl).pathname;
              } catch { /* ignore parse errors */ }
              const reqHost = (() => { try { return new URL(validatedUrl).hostname; } catch { return ''; } })();
              const finalHost = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
              if (reqHost !== finalHost) {
                // Cross-domain redirect
                result.warning = `Site redirected you to ${finalUrl} instead of ${validatedUrl}. You are NOT on the requested page. Adapt: try a direct search URL (e.g. site.com/search?q=...) or use a different site.`;
              } else if (reqPathname !== finalPathname) {
                // Same-domain but different path redirect (e.g. /search → /)
                result.warning = `Page redirected within the same site: requested "${reqPathname}" but landed on "${finalPathname}" (${finalUrl}). You are NOT on the page you requested. Try a different URL pattern or navigate directly to the target path.`;
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



      case 'computer':
        {
          const cAction = String(args.action || '').trim();
          switch (cAction) {
            case 'click': {
              const targets = Array.isArray(args.target) ? args.target : [args.target];
              let clickResult = null;
              for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                const normalizedTarget = Number(t);
                if (!Number.isFinite(normalizedTarget) || normalizedTarget <= 0) {
                  const findHitId = this._pickClickTargetFromFindHits(t);
                  if (findHitId !== null && findHitId !== undefined) {
                    clickResult = await this._sendToContent('executeAction', {
                      type: 'click',
                      target: findHitId,
                      params: { confirm: args.confirm === true, button: args.button, clickCount: args.clickCount },
                    });
                    if (clickResult?.success !== false) {
                      clickResult.autocorrectedTarget = { from: t, to: findHitId };
                      continue;
                    }
                  }
                  return this._makeError(
                    'INVALID_TARGET',
                    `Invalid click target "${String(t)}". Use find/read_page first and pass a valid positive [id].`,
                    {
                      target: t,
                      hint: {
                        strategy: 'refresh_targets',
                        nextTool: 'find',
                        args: { query: 'search field or submit button' },
                        avoidRepeat: true,
                      },
                    },
                  );
                }
                clickResult = await this._sendToContent('executeAction', {
                  type: 'click',
                  target: normalizedTarget,
                  params: { confirm: args.confirm === true, button: args.button, clickCount: args.clickCount },
                });
                if (clickResult?.success === false && (clickResult.code === 'INVALID_TARGET' || clickResult.code === 'ELEMENT_NOT_FOUND')) {
                  if (i === 0) {
                    const findHitId = this._pickClickTargetFromFindHits(t);
                    if (findHitId !== null && findHitId !== undefined && findHitId !== t) {
                      const retry = await this._sendToContent('executeAction', {
                        type: 'click',
                        target: findHitId,
                        params: { confirm: args.confirm === true, button: args.button, clickCount: args.clickCount },
                      });
                      if (retry?.success !== false) {
                        retry.autocorrectedTarget = { from: t, to: findHitId };
                        clickResult = retry;
                      }
                    }
                  }
                  break;
                }
              }
              return targets.length > 1 ? { success: true, description: `Clicked ${targets.length} elements` } : clickResult;
            }
            case 'type': {
              const targets = Array.isArray(args.target) ? args.target : [args.target];
              const texts = Array.isArray(args.text) ? args.text : [args.text ?? ''];
              let typeResult = null;
              for (let i = 0; i < targets.length; i++) {
                const t = targets[i];
                const normalizedTarget = Number(t);
                const text = String(texts[Math.min(i, texts.length - 1)] ?? '');
                if (!Number.isFinite(normalizedTarget) || normalizedTarget <= 0) {
                  const findHitId = this._pickTypeTargetFromFindHits?.(t) ?? this._pickClickTargetFromFindHits(t);
                  if (findHitId !== null && findHitId !== undefined) {
                    typeResult = await this._sendToContent('executeAction', {
                      type: 'type',
                      target: findHitId,
                      params: { text, enter: args.enter === true },
                    });
                    if (typeResult?.success !== false) {
                      typeResult.autocorrectedTarget = { from: t, to: findHitId };
                      continue;
                    }
                  }
                  return this._makeError(
                    'INVALID_TARGET',
                    `Invalid type target "${String(t)}". Use find/read_page first and pass a valid positive [id].`,
                    {
                      target: t,
                      hint: {
                        strategy: 'refresh_targets',
                        nextTool: 'find',
                        args: { query: 'text input or search field' },
                        avoidRepeat: true,
                      },
                    },
                  );
                }
                typeResult = await this._sendToContent('executeAction', {
                  type: 'type',
                  target: normalizedTarget,
                  params: { text, enter: args.enter === true },
                });
                if (typeResult?.success === false) {
                  if (i === 0) {
                    const findHitId = this._pickClickTargetFromFindHits(t);
                    if (findHitId !== null && findHitId !== undefined && findHitId !== t) {
                      const retry = await this._sendToContent('executeAction', {
                        type: 'type',
                        target: findHitId,
                        params: { text, enter: args.enter === true },
                      });
                      if (retry?.success !== false) {
                        retry.autocorrectedTarget = { from: t, to: findHitId };
                        typeResult = retry;
                      }
                    }
                  }
                  if (typeResult?.success === false) {
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
            case 'screenshot':
              if (!this._providerSupportsVision()) {
                return {
                  success: true,
                  note: 'Screenshot skipped — text-only model. Use read_page for page structure.',
                  fallback: 'read_page',
                };
              }
              return await this._takeScreenshot(args);
            case 'wait_for':
              return await this._waitForCondition(args);
            default:
              return this._makeError('INVALID_ACTION', `Unknown computer action: "${cAction}". Valid: click, type, scroll, hover, select, press_key, screenshot, wait_for.`);
          }
        }

      case 'form_input':
        return await this._executeFormInput(args);

      case 'javascript':
        return await this._executeJavaScriptMainWorld(args.code);

      case 'http_request':
        return await this._httpRequest(args);

      case 'notify_connector':
        return await this._notifyConnector(args);

      case 'tabs_create':
        return await this._openTab(args);

      case 'tabs_context':
        {
          const tabAction = String(args.action || 'list').trim().toLowerCase();
          switch (tabAction) {
            case 'list':
              return await this._listTabs();
            case 'switch':
              return await this._switchTab(args);
            case 'close':
              return await this._closeTab(args);
            case 'switch_frame':
              return await this._switchFrame(args);
            default:
              return this._makeError('INVALID_ACTION', `Unknown tabs_context action: "${tabAction}". Valid: list, switch, close, switch_frame.`);
          }
        }

      case 'read_console':
        return await this._sendToContent('readConsole', { since: args.since || 0 });

      case 'read_network':
        return await this._sendToContent('readNetwork', { since: args.since || 0 });

      case 'resize_window':
        return await this._resizeWindow(args);

      case 'restore_snapshot':
        return await this._restoreStateSnapshot(args);

      case 'forward':
        return await this._navigateHistory('forward');

      case 'reload':
        return await this._reloadTab(args);

      case 'close_tab':
        return await this._closeTab(args);

      case 'switch_frame':
        return await this._switchFrame(args);

      case 'screenshot':
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
      const wantSom = this._normalizeBoolean(args?.som) !== false;
      const maxMarks = Math.min(Math.max(Number(args?.maxMarks) || 24, 4), 80);
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
      if (ctx && overlayMarks.length > 0) {
        const scaleX = width / bitmap.width;
        const scaleY = height / bitmap.height;
        this._drawSomOverlay(ctx, overlayMarks, scaleX, scaleY, width, height);
      }

      const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
      const buffer = await resizedBlob.arrayBuffer();

      const chunks = [];
      const arr = new Uint8Array(buffer);
      for (let i = 0; i < arr.length; i += 1024) {
        chunks.push(String.fromCharCode.apply(null, arr.subarray(i, i + 1024)));
      }
      const base64 = btoa(chunks.join(''));
      const summarizedSom = this._summarizeSomForPrompt({
        markCount: overlayMarks.length,
        marks: overlayMarks,
      });

      return {
        success: true,
        imageBase64: base64,
        format: 'jpeg',
        som: wantSom ? {
          enabled: true,
          markCount: overlayMarks.length,
          marks: overlayMarks.slice(0, 12),
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

  /**
   * Compute a cropped screenshot rect that tightly wraps all SoM marks with padding.
   * Returns {x, y, w, h, reason:'som_bounds'} or null if no valid bounds.
   */
  _resolveScreenshotCropRect(screenW, screenH, marks, options = {}, hasSom = false) {
    if (!hasSom || !Array.isArray(marks) || marks.length === 0) return null;
    const padding = Math.round(Math.min(screenW, screenH) * 0.08); // ~8% padding

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const mark of marks) {
      const x = Number(mark?.x) || 0;
      const y = Number(mark?.y) || 0;
      const w = Math.max(Number(mark?.w) || 0, 1);
      const h = Math.max(Number(mark?.h) || 0, 1);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }
    if (!Number.isFinite(minX)) return null;

    const x = Math.max(0, Math.round(minX - padding));
    const y = Math.max(0, Math.round(minY - padding));
    const right = Math.min(screenW, Math.round(maxX + padding));
    const bottom = Math.min(screenH, Math.round(maxY + padding));
    const w = right - x;
    const h = bottom - y;
    if (w <= 0 || h <= 0) return null;
    // Only return a crop if it's meaningfully smaller than the full screen
    if (w >= screenW && h >= screenH) return null;
    return { x, y, w, h, reason: 'som_bounds' };
  }

  /**
   * Scale down (width, height) to satisfy maxWidth, maxHeight, and maxPixels constraints.
   * Returns {width, height} rounded to integers. Never upscales.
   */
  _fitScreenshotDimensions(width, height, constraints = {}) {
    let w = Math.max(Number(width) || 0, 1);
    let h = Math.max(Number(height) || 0, 1);
    const maxW = constraints.maxWidth || Infinity;
    const maxH = constraints.maxHeight || Infinity;
    const maxPx = constraints.maxPixels || Infinity;

    // Scale to fit maxWidth
    if (w > maxW) {
      const scale = maxW / w;
      w = maxW;
      h = Math.round(h * scale);
    }
    // Scale to fit maxHeight
    if (h > maxH) {
      const scale = maxH / h;
      h = maxH;
      w = Math.round(w * scale);
    }
    // Scale to fit maxPixels
    const pixels = w * h;
    if (pixels > maxPx) {
      const scale = Math.sqrt(maxPx / pixels);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    return { width: Math.max(w, 1), height: Math.max(h, 1) };
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

  async _executeFormInput(args) {
    const target = args.target;
    const code = `(() => {
      const el = document.querySelector('[data-agent-id="${target}"]');
      if (!el) return { success: false, code: 'ELEMENT_NOT_FOUND', reason: 'Element not found' };
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        const checked = ${JSON.stringify(args.checked)} !== undefined ? !!${JSON.stringify(args.checked)} : !el.checked;
        el.checked = checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true, description: type + ' set to ' + checked, checked };
      }
      if (tag === 'input' && (type === 'range' || type === 'number' || type === 'date' || type === 'time' || type === 'datetime-local' || type === 'month' || type === 'week' || type === 'color')) {
        const val = ${JSON.stringify(String(args.value ?? ''))};
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, description: type + ' value set to ' + val };
      }
      if (tag === 'select') {
        el.value = ${JSON.stringify(String(args.value ?? ''))};
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, description: 'select value set to ' + el.value };
      }
      return { success: false, code: 'INVALID_TARGET', reason: 'Element is not a supported form input type' };
    })()`;
    return await this._executeJavaScriptMainWorld(code);
  }

  async _resizeWindow(args) {
    const width = Math.min(Math.max(Number(args.width) || 1280, 320), 3840);
    const height = Math.min(Math.max(Number(args.height) || 800, 200), 2160);
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (!tab?.windowId) {
        return this._makeError('NO_WINDOW', 'Cannot determine window for resize');
      }
      await chrome.windows.update(tab.windowId, { width, height });
      return { success: true, width, height, description: `Window resized to ${width}x${height}` };
    } catch (err) {
      return this._makeError('RESIZE_FAILED', String(err?.message || err));
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
            return {
              success: true,
              result: value !== undefined ? String(value).slice(0, 5000) : 'undefined',
            };
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
    if (resolveAction(safeTool, args) === 'click' && this._normalizeBoolean(args.confirm) === true) {
      return 'confirmed_click';
    }
    if (resolveAction(safeTool, args) === 'type' && this._normalizeBoolean(args.enter) === true) {
      return 'type_submit_enter';
    }
    if (resolveAction(safeTool, args) === 'press_key') {
      const key = String(args.key || '').trim().toLowerCase();
      if (key === 'enter' || key === 'return') return 'press_enter';
    }
    if (safeTool === 'javascript') {
      const code = String(args.code || '');
      if (/(submit|delete|remove|checkout|purchase|pay|transfer|confirm|save\s*changes?|account)/i.test(code)) {
        return 'javascript_risky_pattern';
      }
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
    this._pendingIntervention = null;
    this._pendingPlanText = '';
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
      this._pendingJsDomain = '';
      resolver(false);
    }
  }

  approvePlan() {
    if (this._planApprovalResolver) {
      this._approvedPlanText = String(this._pendingPlanText || '').trim();
      this._pendingPlanText = '';
      this._pendingIntervention = null;
      this._activePauseKind = '';
      this.status = 'running';
      this._notify('running');
      const resolver = this._planApprovalResolver;
      this._planApprovalResolver = null;
      resolver(true);
    }
  }

  /** Pause and ask the user whether JavaScript is allowed on the given domain. */
  async _waitForJsDomainApproval(domain) {
    this._activePauseKind = 'js_domain_permission';
    this._pendingJsDomain = String(domain || '').trim().toLowerCase();
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
    const normalizedDomain = String(domain || this._pendingJsDomain || '').trim().toLowerCase();
    if (normalizedDomain) {
      this.trustedJsDomains.add(normalizedDomain);
      // Persist trust for this session's storage
      try {
        chrome.storage.local.get('trustedJsDomains').then(({ trustedJsDomains: stored = [] }) => {
          const updated = Array.from(new Set([...stored, normalizedDomain]));
          chrome.storage.local.set({ trustedJsDomains: updated });
        }).catch(() => { });
      } catch (err) {
        debugWarn('jsDomain.persistTrustedDomain', err);
      }
    }
    if (this._jsDomainResolver) {
      const resolver = this._jsDomainResolver;
      this._jsDomainResolver = null;
      this._activePauseKind = '';
      this._pendingJsDomain = '';
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
      this._activePauseKind = '';
      this._pendingJsDomain = '';
      this.status = 'running';
      this._notify('running');
      resolver(false);
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

    // JS domain permission pause: "Resume" should act as explicit allow.
    if (this._jsDomainResolver && this._activePauseKind === 'js_domain_permission') {
      this.allowJsDomain(this._pendingJsDomain);
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
   * Pause execution and wait for explicit user approval of the generated plan.
   */
  async _pauseForPlanApproval(planText, options = {}) {
    const plan = String(planText || '').trim() || 'Could not generate plan.';
    const details = {
      type: 'planApproval',
      kind: 'plan_approval',
      goal: String(this._goal || ''),
      plan,
      message: String(options.message || 'Review the execution plan. Approve it to continue, or stop the task.'),
    };

    this._pendingPlanText = plan;
    this._pendingIntervention = details;
    this._activePauseKind = 'plan_approval';
    this.status = 'paused_waiting_user';
    this._notify('paused_waiting_user');
    this._emitIntervention(details);

    const approved = await new Promise((resolve) => {
      this._planApprovalResolver = resolve;
    });
    this._planApprovalResolver = null;

    if (!approved || this._aborted) {
      this._pendingPlanText = '';
      this._pendingIntervention = null;
      this._activePauseKind = '';
      return false;
    }

    if (!this._approvedPlanText) {
      this._approvedPlanText = plan;
    }
    return true;
  }

  /**
   * Generate a plain-text plan and wait for user approval before executing.
   */
  async _generateAndWaitForPlan(goal) {
    const planMessages = [
      { role: 'system', content: 'You are a browser automation planner. Return only a numbered list of 3-7 concise, concrete browser steps for the task. Be specific (navigate/click/type/read). Do not call tools and do not add explanations.' },
      { role: 'user', content: `Task: ${goal}\n\nList your step-by-step plan.` },
    ];
    let plan = 'Could not generate plan.';
    try {
      this.metrics.llmCalls += 1;
      const response = await this.provider.chat(planMessages, []);
      this._recordUsage(response?.usage);
      plan = String(response?.text || '').trim() || 'Could not generate plan.';
    } catch (err) {
      plan = `Plan generation failed: ${err.message}`;
    }
    return this._pauseForPlanApproval(plan);
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
      case 'JS_BLOCKED':
      case 'JS_DOMAIN_BLOCKED':
        return {
          strategy: 'fallback_non_js_tool',
          nextTool: 'read_page',
          args: {},
          avoidRepeat: true,
          message: 'Use read_page/get_page_text/find instead of javascript.',
        };
      case 'CONFIRMATION_REQUIRED':
        return {
          strategy: 'retry_with_confirmation',
          nextTool: 'computer',
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
            nextTool: 'computer',
            args: { key: 'Enter' },
            avoidRepeat: true,
            message: 'Action relies on blocked javascript: link; try keyboard submit or javascript tool fallback.',
          };
        }
        // For read-tool duplicates, do NOT suggest another read tool on the same URL —
        // it will also be blocked. Instead, push the agent toward completion or navigation.
        if (tool === 'get_page_text' || tool === 'read_page' || tool === 'query_page' || tool === 'extract_structured') {
          return {
            strategy: 'converge_or_navigate',
            nextTool: 'done',
            args: {},
            avoidRepeat: true,
            message: 'You already read this page. If you have enough facts, call done. Otherwise navigate to a different URL.',
          };
        }
        return {
          strategy: 'change_strategy',
          nextTool: tool === 'find_text' ? 'get_page_text' : 'navigate',
          args: {},
          avoidRepeat: true,
          message: 'Do not repeat the same invalid action. Use an alternative tool or navigate elsewhere.',
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
    const hasQuery = ['q', 'query', 'p', 'text', 'k'].some((key) => {
      const value = String(parsed.searchParams.get(key) || '').trim();
      return value.length > 0;
    });
    // Only flag known general-purpose search engines as SERPs.
    // Thematic sites (gramota.ru, stackoverflow.com, etc.) with /search?q=... are NOT SERPs —
    // they are the target pages the agent should read, not avoid.
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
    return onSearchHost && hasQuery;
  }

  _isSerpReadOnlyTool(tool) {
    return new Set([
      'read_page',
      'get_page_text',
      'find_text',
      'find',
      'extract_structured',
      // screenshot is now within computer
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
      // screenshot is now within computer
      'save_progress',
    ]);
    if (!guardedTools.has(toolName)) return { repeated: false };

    const currentPageKey = this._urlLoopKey(this._lastKnownUrl, true);

    // URL-aware window: find the index of the last navigation to the current URL.
    // Only count repeats since we arrived at this URL — prevents false positives
    // when the agent legitimately re-reads the same tool on a different page.
    const allActions = this.history.filter((item) => item?.type === 'action');
    let windowStart = Math.max(0, allActions.length - SEMANTIC_REPEAT_WINDOW);
    if (currentPageKey) {
      // Find the last navigation action that brought us to the current URL
      for (let i = allActions.length - 1; i >= 0; i--) {
        const item = allActions[i];
        const isNav = item.tool === 'navigate' || item.tool === 'tabs_create' ||
          (item.tool === 'tabs_context' && item.args?.action === 'switch');
        if (isNav && item.result?.success !== false) {
          const navUrl = this._urlLoopKey(this._extractActionUrl(item) || '', false);
          const curUrl = this._urlLoopKey(this._lastKnownUrl, false);
          if (navUrl && curUrl && navUrl === curUrl) {
            // Start window from after this navigation
            windowStart = i + 1;
            break;
          }
        }
      }
    }
    const recent = allActions.slice(windowStart);

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
      resolveAction(toolName, args) === 'screenshot' ||
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
      if ((['navigate', 'tabs_create'].includes(itemTool) || resolveAction(item) === 'click' || resolveAction(item) === 'switch_tab') && item.result?.success !== false) {
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
    if (tool === 'computer' && ['click', 'type', 'select', 'hover'].includes(args?.action)) {
      return `target:${String(safeArgs.target ?? '')}`;
    }
    // Top-level interaction tools — normalize by target only (ignore clickCount etc.)
    if (['click', 'type', 'hover', 'select'].includes(tool)) {
      return `target:${String(safeArgs.target ?? '')}`;
    }
    if (tool === 'find_text') {
      return `query:${String(safeArgs.query || '').trim().toLowerCase()}`;
    }
    if (tool === 'navigate' || tool === 'tabs_create') {
      return `url:${String(safeArgs.url || '').trim().toLowerCase()}`;
    }
    return JSON.stringify(safeArgs);
  }

  _isSameActionIntent(tool, leftArgs = {}, rightArgs = {}) {
    return this._buildActionIntentKey(tool, leftArgs) === this._buildActionIntentKey(tool, rightArgs);
  }

  _pickSafeBlockedFallback(tool, args = {}, hint = null) {
    const currentTool = String(tool || '').trim();
    const safeHint = hint && typeof hint === 'object' && !Array.isArray(hint) ? { ...hint } : {};
    const suggestedTool = String(safeHint.nextTool || '').trim();
    const suggestedArgs = safeHint.args && typeof safeHint.args === 'object' ? safeHint.args : {};
    const repeatsSame = (
      safeHint.avoidRepeat === true &&
      (
        suggestedTool === currentTool ||
        this._isSameActionIntent(currentTool, args || {}, suggestedArgs)
      )
    );
    if (suggestedTool && !repeatsSame) {
      return {
        strategy: String(safeHint.strategy || 'fallback_after_block'),
        nextTool: suggestedTool,
        args: suggestedArgs,
        avoidRepeat: true,
      };
    }

    // For read-observation tools, do NOT chain to another read tool on the same URL —
    // all of them will be blocked by _checkUrlToolReRead. Push toward convergence instead.
    if (currentTool === 'read_page' || currentTool === 'get_page_text' ||
      currentTool === 'query_page' || currentTool === 'extract_structured') {
      return {
        strategy: 'converge_or_navigate',
        nextTool: 'done',
        args: {},
        avoidRepeat: true,
        message: 'You already read this page. If you have enough facts, call done. Otherwise navigate to a different URL.',
      };
    }
    return {
      strategy: 'change_strategy',
      nextTool: currentTool === 'navigate' ? 'get_page_text' : 'navigate',
      args: currentTool === 'navigate' ? { scope: 'viewport' } : {},
      avoidRepeat: true,
    };
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

    const fallbackHint = this._pickSafeBlockedFallback(tool, args, result.hint);

    this._lastBlockedAction = {
      tool,
      args: args && typeof args === 'object' ? { ...args } : {},
      hint: fallbackHint,
      code: String(result.code || ''),
    };

    if (this._blockedRepeatCount >= 2) {
      const hasFallback = this._hasViableFallbackHint(tool, fallbackHint, result.code);
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
            nextTool: fallbackHint?.nextTool || 'navigate',
            args: fallbackHint?.args || {},
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
      case 'computer': // scroll, wait_for, etc.
        return true;
      default:
        return false;
    }
  }

  // ===== ANTI-LOOPING: Empty Result / Duplicate Call Detection =====

  /**
   * Returns true when the tool result contains zero useful signal
   * (empty text, zero items, failed query, etc.).
   * This is stricter than _isLowSignalObservation — it only fires on
   * truly empty / zero-result responses, not merely low-quality ones.
   */
  _isEmptyToolResult(tool, result) {
    if (!result) return true;
    if (result.success === false) return true;
    switch (tool) {
      case 'get_page_text':
        return !result.text || String(result.text || '').trim().length < 50;
      case 'extract_structured':
        return Number(result.count || 0) === 0;
      case 'find_text':
        return result.found === false || Number(result.count || 0) === 0;
      case 'find':
        return !Array.isArray(result) || result.length === 0;
      case 'read_page':
        return Number(result.nodeCount || result.count || 0) === 0;
      case 'query_page':
        return !result.answer || String(result.answer || '').trim().length < 10;
      default:
        return false;
    }
  }

  /**
   * Track consecutive empty results and consecutive DUPLICATE_CALL errors.
   * Must be called after every tool execution in the main loop.
   *
   * Returns an object:
   *   { emptyStreak, duplicateStreak, forceStrategySwitch, forceFail, systemMessage }
   *
   * When forceStrategySwitch is true, the caller should inject `systemMessage`
   * into the LLM conversation AND flush the plan queue.
   * When forceFail is true, the caller should terminate the run.
   */
  _trackAntiLoopSignals(tool, result) {
    const out = {
      emptyStreak: 0,
      duplicateStreak: 0,
      forceStrategySwitch: false,
      forceFail: false,
      systemMessage: '',
    };

    // ── Track DUPLICATE_CALL streak ──
    // Note: save_progress is a note-taking tool, not a real strategy change.
    // It must NOT reset the duplicate streak — otherwise the agent can escape
    // forceFail by interleaving save_progress between repeated blocked reads.
    // ACTION_LOOP_GUARD is a direct escalation of DUPLICATE_CALL — treat it the same
    // so the consecutive counter keeps climbing and convergence triggers on schedule.
    if (result?.code === 'DUPLICATE_CALL' || result?.code === 'ACTION_LOOP_GUARD') {
      this._consecutiveDuplicateCalls += 1;
      out.duplicateStreak = this._consecutiveDuplicateCalls;
    } else if (tool !== 'save_progress') {
      this._consecutiveDuplicateCalls = 0;
    }

    // ── Track save_progress spin ──
    // save_progress is a note-taking tool, not a progress-making action.
    // When it's called repeatedly with no intervening navigation/mutation, the agent
    // is spinning: it keeps summarising existing knowledge without taking new steps.
    if (tool === 'save_progress' && result?.success !== false) {
      this._consecutiveSaveProgressCount = (this._consecutiveSaveProgressCount || 0) + 1;
    } else if (!['save_progress', 'done', 'fail'].includes(tool)) {
      // Any real action (navigate, read, click, etc.) resets the spin counter.
      this._consecutiveSaveProgressCount = 0;
    }
    out.saveProgressSpin = Math.max(Number(this._consecutiveSaveProgressCount || 0), 0);
    if (out.saveProgressSpin >= 3) {
      out.forceStrategySwitch = true;
      out.systemMessage = (
        out.systemMessage ||
        `SAVE-PROGRESS SPIN DETECTED (${out.saveProgressSpin} consecutive calls). `
        + 'save_progress is a memory tool, NOT a progress action. '
        + 'You MUST take a concrete next step: navigate to a new URL, call extract_structured, or '
        + 'set sufficiency=true with the facts you already have and call done. '
        + 'Do NOT call save_progress again until you have gathered new evidence.'
      );
    }

    // ── Track consecutive empty results (across all observation tools) ──
    const observationTools = new Set([
      'get_page_text', 'extract_structured', 'find_text', 'find',
      'read_page', 'query_page',
    ]);
    if (observationTools.has(tool)) {
      if (this._isEmptyToolResult(tool, result)) {
        this._consecutiveEmptyResults += 1;
      } else {
        this._consecutiveEmptyResults = 0;
      }
      out.emptyStreak = this._consecutiveEmptyResults;
    }

    // ── Record this URL+tool pair so we can hard-block future identical reads ──
    // Key includes origin+pathname so different paths on the same domain are distinct.
    if (observationTools.has(tool) && result?.success !== false && !this._isEmptyToolResult(tool, result)) {
      let url;
      try {
        const parsed = new URL(String(this._lastKnownUrl || ''));
        url = `${parsed.origin}${parsed.pathname}`;
      } catch {
        url = String(this._lastKnownUrl || '').split('?')[0].split('#')[0];
      }
      if (url) {
        this._urlToolReadLog.set(`${url}|${tool}`, this.metrics?.toolCalls || 0);
      }
    }

    // ── Decide escalation ──

    // Duplicate-call escalation
    if (this._consecutiveDuplicateCalls >= CONSECUTIVE_DUPLICATE_FAIL_THRESHOLD) {
      out.forceFail = true;
      out.systemMessage = `FATAL: ${this._consecutiveDuplicateCalls} consecutive DUPLICATE_CALL errors. `
        + 'The agent is stuck in an unbreakable loop repeating the same action. Terminating.';
      return out;
    }
    if (this._consecutiveDuplicateCalls >= CONSECUTIVE_DUPLICATE_FORCE_THRESHOLD) {
      out.forceStrategySwitch = true;
      const fallback = this._pickSafeBlockedFallback(tool, result?.hint?.args || {}, result?.hint);
      out.systemMessage = `CRITICAL LOOP: ${this._consecutiveDuplicateCalls} consecutive DUPLICATE_CALL errors. `
        + `You are blindly repeating "${tool}" despite being told the result will not change. `
        + `You MUST immediately execute: ${fallback.nextTool}(${JSON.stringify(fallback.args)}) `
        + 'or call fail. Do NOT call the same tool again.';
      return out;
    }
    if (this._consecutiveDuplicateCalls >= CONSECUTIVE_DUPLICATE_WARN_THRESHOLD) {
      out.forceStrategySwitch = true;
      out.systemMessage = `WARNING: DUPLICATE_CALL received for "${tool}". `
        + 'Repeating the same action will NOT produce different results. '
        + 'Switch to a fundamentally different tool or navigate to a different URL. '
        + 'If you have already collected enough information, call done.';
      return out;
    }

    // Empty-result escalation
    if (this._consecutiveEmptyResults >= CONSECUTIVE_EMPTY_FAIL_THRESHOLD) {
      out.forceFail = true;
      out.systemMessage = `FATAL: ${this._consecutiveEmptyResults} consecutive empty/zero-result tool calls. `
        + 'The current page or strategy yields no useful data. Terminating to avoid wasting resources.';
      return out;
    }
    if (this._consecutiveEmptyResults >= CONSECUTIVE_EMPTY_WARN_THRESHOLD) {
      out.forceStrategySwitch = true;
      out.systemMessage = `STRATEGY CHANGE REQUIRED: ${this._consecutiveEmptyResults} consecutive tool calls returned empty/zero results. `
        + 'The information you are looking for is NOT available via your current approach. '
        + 'You MUST immediately try ONE of: '
        + '1) Navigate to a completely different URL; '
        + '2) Use a different tool (e.g. extract_structured, javascript, navigate); '
        + '3) If no viable path remains, call fail with an explicit reason. '
        + 'Do NOT repeat the same observation tool.';
      return out;
    }

    return out;
  }

  /**
   * Check whether the agent has already successfully read this URL
   * with the same tool. If so, return a hard-block DUPLICATE_CALL result
   * to prevent wasting a step on an identical re-read.
   * Returns null if the read is allowed.
   */
  _checkUrlToolReRead(tool, args) {
    const observationTools = new Set([
      'get_page_text', 'extract_structured', 'read_page', 'query_page',
    ]);
    if (!observationTools.has(tool)) return null;
    // Include the URL path in the key so that different paths on the same domain
    // (e.g. "/" vs "/poisk") are treated as distinct pages. Query params and
    // fragments are still stripped so paginated variants don't create false misses.
    let url;
    try {
      const parsed = new URL(String(this._lastKnownUrl || ''));
      url = `${parsed.origin}${parsed.pathname}`;
    } catch {
      url = String(this._lastKnownUrl || '').split('?')[0].split('#')[0];
    }
    if (!url) return null;
    const key = `${url}|${tool}`;
    if (!this._urlToolReadLog.has(key)) return null;

    // Allow re-read if the page might have changed (mutation happened since last read)
    if (this._pageReadCache.size === 0) return null;

    const fallback = this._pickSafeBlockedFallback(tool, args || {});
    return this._makeError('DUPLICATE_CALL',
      `You already successfully called "${tool}" on this URL and got a non-empty result. `
      + 'The page has NOT changed since then. Do NOT re-read — act on the data you already have: '
      + 'click a link, navigate elsewhere, or call done/fail.',
      {
        hint: fallback,
        retryable: false,
      },
    );
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
      'tabs_create',
      'tabs_context',
      'computer',
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
    const actions = Array.isArray(reflectionState?.actions) ? reflectionState.actions : [];
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
    const summaryText = String(reflectionState.summary || '').trim();
    const answerText = String(reflectionState.answer || '').trim();
    const hasDirectAnswer = !!summaryText || !!answerText;
    if (!hasDirectAnswer && facts.length < 2) return null;

    const signals = this._collectHumanGuidanceSignals(reflectionState, stepBudget);
    const confidence = Number(signals.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < HUMAN_GUIDANCE_NEAR_CONFIDENCE_MIN) return null;

    const pressure =
      signals.noProgress >= NO_PROGRESS_WARN_THRESHOLD ||
      signals.dupSignals > 0 ||
      signals.reflectionNoActionStreak >= COMPLETION_REJECT_WARN_THRESHOLD;
    if (!pressure || !signals.mostlyLowSignal) return null;
    if (
      unknowns.length > 0 &&
      !hasDirectAnswer &&
      signals.dupSignals < 2 &&
      signals.noProgress < NO_PROGRESS_WARN_THRESHOLD + 1
    ) {
      return null;
    }

    const summary = summaryText
      || 'Task completed from consistent evidence on the current page.';
    const answer = answerText
      || facts.map((f) => `- ${f}`).join('\n');

    const prematureCheck = this._checkPrematureDone({ summary, answer });
    if (!prematureCheck?.ok) return null;
    const quality = this._validateDoneQuality(summary, answer);
    if (!quality?.ok) return null;
    const verification = this._validateDoneVerification();
    if (!verification?.ok) return null;
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
    if (nextTool === 'done' || nextTool === 'fail') return false;
    if (nextTool === 'computer') return false; // computer includes screenshot

    const recent = this.history
      .slice(-8)
      .filter((h) => h?.type === 'action');
    const hasRecentScreenshot = recent.some((h) => resolveAction(h) === 'screenshot');
    if (hasRecentScreenshot) return false;

    const sparseSensitiveTools = new Set(['read_page', 'find', 'computer', 'click', 'type', 'select', 'hover']);
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
    ]);
    const filtered = words.filter((w) => w.length > 2 && !stopWords.has(w));
    const base = filtered.length >= 3 ? filtered : words;
    const compact = base.slice(0, 4).join(' ').trim();
    if (!compact) return '';
    if (compact === text) return '';
    return compact.slice(0, 140);
  }

  _shouldAvoidJavascriptForGoal() {
    const blockedHintTool = String(this?._lastBlockedAction?.hint?.nextTool || '').trim().toLowerCase();
    if (blockedHintTool === 'javascript') return false;
    if (Number(this._noProgressStreak || 0) >= NO_PROGRESS_WARN_THRESHOLD) return false;
    const goal = String(this._goal || '').toLowerCase();
    const infoLike = /(search|find|lookup|look up|spelling)/i.test(goal);
    return infoLike && Number(this._toolFailStreak || 0) < 2;
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

    if (resolveAction(tool, args) === 'click') {
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

    if (tool === 'javascript' && this._shouldAvoidJavascriptForGoal()) {
      return { tool: 'read_page', args: {} };
    }

    if (this._shouldForceVisionProbe(tool)) {
      return { tool: 'computer', args: { action: 'screenshot' } };
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

  /**
   * Fast-path optimization: skip reflection for predictable post-navigation reads.
   *
   * After a successful navigate/tabs_create, the next action is almost always
   * get_page_text or read_page. We can skip the reflection LLM call and execute
   * directly — saves one full LLM round-trip per navigation step.
   *
   * Conditions for fast-path:
   *  1. Last action was a successful navigate/tabs_create
   *  2. No page text was returned with the navigate result (otherwise model already has it)
   *  3. No pending reflection state (fresh start or after navigation)
   *  4. Not a navigate-only task (those call done immediately)
   *  5. Not in plan mode (plan mode needs reflection for approval)
   *
   * @param {number} step - current step index
   * @returns {{ tool: string, args: object } | null} fast-path action or null
   */
  /**
   * Context-aware tool pruning: return only the tools relevant for the current step.
   * Reduces token cost by 200–600 tokens/call by excluding irrelevant tool schemas.
   *
   * Always included: core read/nav/action tools.
   * Conditionally included based on context:
   *   - computer(screenshot): only when provider supports vision
   *   - notify_connector: only when connectors are connected
   *   - restore_snapshot: only when snapshots exist
   *   - javascript: only when JS domain is trusted or no domain check needed
   *   - read_console/read_network: only for debug-like goals
   *   - http_request: only for API/external-request goals
   *   - save_progress: only for complex/long tasks
   */
  _getActiveToolsForStep(step) {
    const goalText = String(this._goal || '').toLowerCase();
    const hasConnectors = Array.isArray(this._connectedConnectorIds) && this._connectedConnectorIds.length > 0;
    const hasSnapshots = Array.isArray(this._stateSnapshots) && this._stateSnapshots.length > 0;
    const supportsVision = this._providerSupportsVision();
    const isDebugGoal = /\b(console|network|debug|error|log|xhr|fetch|request)\b/.test(goalText);
    const isApiGoal = /\b(api|http|request|endpoint|webhook|json|rest)\b/.test(goalText);
    const isComplexTask = this.maxSteps > 8; // medium/complex tasks get save_progress

    return TOOLS.filter((tool) => {
      const name = tool.name;
      // Always include core tools
      if (['read_page', 'get_page_text', 'extract_structured', 'find', 'find_text',
        'navigate', 'tabs_create', 'tabs_context', 'computer', 'form_input',
        'done', 'fail'].includes(name)) {
        // For computer tool: if no vision support, still include it (for click/type/scroll)
        return true;
      }
      // Conditionally include based on context
      if (name === 'notify_connector') return hasConnectors;
      if (name === 'restore_snapshot') return hasSnapshots;
      if (name === 'javascript') return this.trustedJsDomains.size > 0 || step > 3;
      if (name === 'read_console') return isDebugGoal;
      if (name === 'read_network') return isDebugGoal;
      if (name === 'http_request') return isApiGoal;
      if (name === 'save_progress') return isComplexTask;
      if (name === 'resize_window') return false; // rarely needed
      // Include everything else by default
      return true;
    });
  }

  _tryFastPathAction(step) {
    // Only apply on step > 0 (first step always needs reflection for context)
    if (step <= 0) return null;
    // Don't apply in plan mode
    if (this.planMode) return null;
    // Don't apply for navigate-only tasks
    if (this._isNavigateOnly) return null;
    // Don't apply if there's already a reflection state with planned actions
    if (this._reflectionState?.actions?.length > 0) return null;

    const recentActions = this.history.filter(h => h?.type === 'action');
    if (recentActions.length === 0) return null;

    const lastAction = recentActions[recentActions.length - 1];
    if (!lastAction) return null;

    // Check if last action was a successful navigation
    const isNavigation = (
      lastAction.tool === 'navigate' ||
      lastAction.tool === 'tabs_create' ||
      (lastAction.tool === 'tabs_context' && lastAction.args?.action === 'switch')
    );
    if (!isNavigation) return null;
    if (lastAction.result?.success === false) return null;

    // If navigate already returned pageText, model has the content — no fast-path needed
    if (lastAction.result?.pageText && String(lastAction.result.pageText).length > 200) return null;

    // Check that we haven't already read the page after this navigation
    const lastNavIdx = recentActions.lastIndexOf(lastAction);
    const actionsAfterNav = recentActions.slice(lastNavIdx + 1);
    const alreadyRead = actionsAfterNav.some(a =>
      ['get_page_text', 'read_page', 'extract_structured', 'find', 'find_text'].includes(a.tool)
    );
    if (alreadyRead) return null;

    // Determine best fast-path tool based on goal type
    const goalText = String(this._goal || '').toLowerCase();
    const isFormLike = /(fill|form|login|sign\s?in|signup|register|input|enter|type)/i.test(goalText);
    const isExtractionLike = /(extract|collect|list|table|price|product|news|article)/i.test(goalText);

    if (isFormLike) {
      // For form tasks, read_page gives element IDs needed for interaction
      return { tool: 'read_page', args: { maxDepth: 9, maxNodes: 130 } };
    }
    if (isExtractionLike) {
      // For extraction tasks, get_page_text is faster and more complete
      return { tool: 'get_page_text', args: { scope: 'full' } };
    }
    // Default: get_page_text for info tasks
    return { tool: 'get_page_text', args: { scope: 'full' } };
  }

  /**
   * Temporal awareness: analyze the goal for date/time references and compare
   * with the current date. Returns a hint string if the requested period is
   * in the future or has barely started, so the agent can set realistic
   * expectations instead of exhausting all steps searching for non-existent content.
   */
  _buildTemporalAwarenessHint(goalText) {
    const text = String(goalText || '').trim().toLowerCase();
    if (!text) return '';
    const now = new Date();

    // Month name maps (English + Russian)
    const MONTHS_EN = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
      jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const MONTHS_RU = {
      'январь': 0, 'января': 0, 'январе': 0,
      'февраль': 1, 'февраля': 1, 'феврале': 1,
      'март': 2, 'марта': 2, 'марте': 2,
      'апрель': 3, 'апреля': 3, 'апреле': 3,
      'май': 4, 'мая': 4, 'мае': 4,
      'июнь': 5, 'июня': 5, 'июне': 5,
      'июль': 6, 'июля': 6, 'июле': 6,
      'август': 7, 'августа': 7, 'августе': 7,
      'сентябрь': 8, 'сентября': 8, 'сентябре': 8,
      'октябрь': 9, 'октября': 9, 'октябре': 9,
      'ноябрь': 10, 'ноября': 10, 'ноябре': 10,
      'декабрь': 11, 'декабря': 11, 'декабре': 11,
    };

    const allMonths = { ...MONTHS_EN, ...MONTHS_RU };
    const monthPatterns = Object.keys(allMonths).sort((a, b) => b.length - a.length).join('|');
    const yearMonthRe = new RegExp(`(${monthPatterns})\\s+(\\d{4})`, 'i');
    const yearOnlyRe = /\b(20\d{2})\b/;

    let targetYear = null;
    let targetMonth = null;

    // Try "month year" pattern first (e.g. "march 2026", "март 2026")
    const ym = text.match(yearMonthRe);
    if (ym) {
      const monthKey = ym[1].toLowerCase();
      targetMonth = allMonths[monthKey] ?? null;
      targetYear = parseInt(ym[2], 10);
    }

    if (targetYear === null) {
      const yo = text.match(yearOnlyRe);
      if (yo) targetYear = parseInt(yo[1], 10);
    }

    if (targetYear === null) return '';

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed
    const currentDay = now.getDate();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Fully future year
    if (targetYear > currentYear) {
      return `TEMPORAL WARNING: The requested period (${targetYear}) is in the future. Today is ${dateStr}. Content for this period does not exist yet. Inform the user immediately and call done — do NOT spend steps searching.`;
    }

    // Past year — no issue
    if (targetYear < currentYear) return '';

    // Same year — check month
    if (targetMonth !== null) {
      if (targetMonth > currentMonth) {
        const futureMonthName = Object.entries(MONTHS_EN).find(([, v]) => v === targetMonth)?.[0] || '';
        return `TEMPORAL WARNING: The requested month (${futureMonthName} ${targetYear}) has not started yet. Today is ${dateStr}. Content for this period does not exist yet. Inform the user immediately and call done.`;
      }
      if (targetMonth === currentMonth && currentDay <= 3) {
        const currentMonthName = Object.entries(MONTHS_EN).find(([, v]) => v === currentMonth)?.[0] || '';
        return `TEMPORAL NOTE: The requested month (${currentMonthName} ${targetYear}) has just started — today is only ${dateStr} (day ${currentDay}). Very little content may exist for this period. Adjust your search strategy: look for content announced/published on the last ${currentDay} day(s) rather than a full month's results. If only a few results are found, that is expected — report what is available and explain why the results are limited.`;
      }
    }

    return '';
  }

  _buildSystemPrompt() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const datePrefix = `Today's date: ${dateStr}.\n\n`;
    if (this._isOllamaQwen3VL()) {
      return `${datePrefix}${SYSTEM_PROMPT}${QWEN3VL_OLLAMA_SYSTEM_ADDENDUM}`;
    }
    if (this._isXAIGrok()) {
      return `${datePrefix}${SYSTEM_PROMPT}${XAI_GROK_FAST_SYSTEM_ADDENDUM}`;
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

  _isXAIGrok() {
    const primary = this.provider?.config?.primary;
    if (primary !== 'xai') return false;
    const configuredModel = this.provider?.config?.providers?.xai?.model;
    const runtimeModel = this.provider?.providers?.xai?.model;
    const model = String(configuredModel || runtimeModel || '').toLowerCase();
    return /grok[-_]?4[-_]?1/.test(model);
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
      'send email', 'delete', 'remove', 'pay', 'purchase', 'checkout', 'transfer',
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
    ].some((term) => text.includes(term));
  }

  _shouldSkipInitialSnapshot(goalText = '', currentUrl = '') {
    const url = String(currentUrl || this._lastKnownUrl || '').trim();
    if (!url) return false;

    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }

    const heavyHosts = [
      'keep.google.com',
      'docs.google.com',
      'mail.google.com',
      'calendar.google.com',
      'notion.so',
      'www.notion.so',
      'figma.com',
      'www.figma.com',
    ];
    const isHeavyHost = heavyHosts.some((item) => host === item || host.endsWith(`.${item}`));
    if (!isHeavyHost) return false;

    const goal = String(goalText || this._goal || '').toLowerCase().trim();
    if (!goal) return false;

    const genericTokens = new Set(['www', 'com', 'ru', 'net', 'org', 'io', 'co', 'app', 'dev', 'google']);
    const hostTokens = host
      .split('.')
      .map((p) => p.trim())
      .filter((p) => p.length >= 3)
      .filter((p) => !genericTokens.has(p));
    if (hostTokens.some((token) => goal.includes(token))) {
      return false;
    }

    const hasExternalSiteCue = (
      /https?:\/\//i.test(goal) ||
      /\b(?:on)\s+site/i.test(goal) ||
      /\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(goal) ||
      /(?:^|\s)[a-z0-9-]+\s+com(?:\s|$)/i.test(goal)
    );
    return hasExternalSiteCue;
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
