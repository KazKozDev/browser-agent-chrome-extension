import {
  REFLECTION_CHAT_SOFT_TIMEOUT_MS,
  REFLECTION_CONFIDENCE_THRESHOLD,
  REFLECTION_MAX_ACTIONS_PER_STEP,
  REFLECTION_MAX_RETRIES,
  REFLECTION_OVERCONFIDENCE_FACTOR,
  REFLECTION_STAGNATION_DECAY_BASE,
} from '../config/constants.js';

const REFLECTION_TOOL = {
  name: 'submit_reflection',
  description: 'Submit structured reflection state before taking an action.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      facts: {
        type: 'array',
        items: { type: 'string' },
      },
      unknowns: {
        type: 'array',
        items: { type: 'string' },
      },
      sufficiency: { type: 'boolean' },
      confidence: { type: 'number' },
      search_query: { type: 'string' },
      summary: { type: 'string' },
      answer: { type: 'string' },
      actions: {
        oneOf: [
          { type: 'null' },
          {
            type: 'array',
            minItems: 1,
            maxItems: REFLECTION_MAX_ACTIONS_PER_STEP,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tool: { type: 'string' },
                args: { type: 'object' },
                expected_outcome: { type: 'string' },
              },
              required: ['tool', 'args'],
            },
          },
        ],
      },
    },
    required: ['facts', 'unknowns', 'sufficiency', 'confidence', 'summary', 'answer', 'actions'],
  },
};

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(Math.max(num, 0), 1);
}

function normalizeStepBudget(budget) {
  const total = Math.max(Number(budget?.total) || 0, 0);
  const used = Math.max(Number(budget?.used) || 0, 0);
  const fallbackRemaining = total > 0 ? Math.max(total - used, 0) : 0;
  const remainingRaw = Number(budget?.remaining);
  const remaining = Number.isFinite(remainingRaw)
    ? Math.max(remainingRaw, 0)
    : fallbackRemaining;

  const urgency = remaining <= 1
    ? 'critical'
    : remaining <= 3
      ? 'high'
      : remaining <= 8
        ? 'medium'
        : 'normal';

  return {
    total,
    used,
    remaining,
    urgency,
    nearLimit: remaining <= 3,
    critical: remaining <= 1,
  };
}

function normalizeStringArray(value, maxItems = 12, maxChars = 280) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    out.push(text.slice(0, maxChars));
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeSearchQuery(value, maxChars = 160) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return text.slice(0, maxChars);
}

function safeJsonParse(text) {
  if (!text) return null;
  const raw = String(text).trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // continue
    }
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = raw.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  return null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const chunk of content) {
      if (typeof chunk === 'string') {
        parts.push(chunk);
        continue;
      }
      if (!chunk || typeof chunk !== 'object') continue;
      if (typeof chunk.text === 'string') {
        parts.push(chunk.text);
      } else if (typeof chunk.content === 'string') {
        parts.push(chunk.content);
      }
    }
    return parts.join('\n').trim();
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return '';
}

function parseJsonFromToolWrapper(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  // submit_reflection({...})
  const fnCall = text.match(/submit_reflection\s*\(\s*({[\s\S]*})\s*\)/i);
  if (fnCall?.[1]) {
    const parsed = safeJsonParse(fnCall[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }

  // <tool_call>{...}</tool_call>
  const toolTag = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (toolTag?.[1]) {
    const wrapped = safeJsonParse(toolTag[1]);
    if (wrapped && typeof wrapped === 'object') {
      if (wrapped.arguments && typeof wrapped.arguments === 'object') return wrapped.arguments;
      if (wrapped.parameters && typeof wrapped.parameters === 'object') return wrapped.parameters;
      return wrapped;
    }
  }

  return null;
}

function parseKeyValueReflectionPayload(rawPayload) {
  const payload = String(rawPayload || '').trim();
  if (!payload) return null;
  if (!/\b(?:facts|unknowns|sufficiency|confidence|next|search_query)\s*=/i.test(payload)) return null;

  const suffMatch = payload.match(/\bsufficiency\s*=\s*(yes|no|true|false)\b/i);
  const confMatch = payload.match(/\bconfidence\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%?/i);
  const nextMatch = payload.match(/\bnext\s*=\s*([a-z_][a-z0-9_]*)\b/i);

  const captureField = (name) => {
    const re = new RegExp(`(?:^|,\\s*)${name}\\s*=\\s*([\\s\\S]*?)(?=(?:,\\s*(?:facts|unknowns|sufficiency|confidence|next|search_query)\\s*=)|$)`, 'i');
    const m = payload.match(re);
    return m?.[1] ? String(m[1]).trim() : '';
  };

  const splitList = (value) => String(value || '')
    .split(/\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const facts = splitList(captureField('facts'));
  const unknowns = splitList(captureField('unknowns'));
  const search_query = normalizeSearchQuery(captureField('search_query'));
  const sufficiency = suffMatch ? ['yes', 'true'].includes(suffMatch[1].toLowerCase()) : false;

  let confidence = 0;
  if (confMatch?.[1]) {
    const num = Number(confMatch[1]);
    if (Number.isFinite(num)) confidence = num > 1 ? num / 100 : num;
  }

  let nextTool = nextMatch?.[1] ? String(nextMatch[1]).toLowerCase() : '';
  if (!nextTool || nextTool === 'none' || nextTool === 'null') {
    nextTool = '';
  }

  const safeNoArgTools = new Set([
    'read_page',
    'get_page_text',
    'extract_structured',
    'tabs_context',
    'save_progress',
  ]);
  const safeDerivedArgTools = new Set(['find', 'find_text']);

  let next_action = null;
  if (!sufficiency) {
    const tool = (
      nextTool &&
      (safeNoArgTools.has(nextTool) || safeDerivedArgTools.has(nextTool))
    ) ? nextTool : 'read_page';
    next_action = { tool, args: {} };
  }
  const actions = next_action ? [next_action] : null;

  return {
    facts,
    unknowns,
    search_query,
    sufficiency,
    confidence,
    summary: '',
    answer: '',
    actions,
    next_action,
  };
}

function parseLegacyReflectionLine(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  if (!/reflect\s*:/i.test(text)) return null;

  const line = text
    .split('\n')
    .map((s) => s.trim())
    .find((s) => /reflect\s*:/i.test(s));
  if (!line) return null;

  const payload = line.replace(/^.*?reflect\s*:\s*/i, '').trim();
  if (!payload) return null;
  return parseKeyValueReflectionPayload(payload);
}

function parseLooseKeyValueReflection(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return null;
  if (!/\bsufficiency\s*=|\bconfidence\s*=|\bnext\s*=/i.test(text)) return null;

  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsed = parseKeyValueReflectionPayload(line.replace(/^reflect\s*:\s*/i, ''));
    if (parsed) return parsed;
  }

  const compact = text.replace(/\s+/g, ' ').trim();
  return parseKeyValueReflectionPayload(compact.replace(/^reflect\s*:\s*/i, ''));
}

function parseReflectionFromResponse(response) {
  const rawMsg = response?.raw?.choices?.[0]?.message || null;

  const argCandidates = [];
  if (Array.isArray(response?.toolCalls)) {
    for (const tc of response.toolCalls) argCandidates.push(tc?.arguments);
  }
  if (Array.isArray(rawMsg?.tool_calls)) {
    for (const tc of rawMsg.tool_calls) argCandidates.push(tc?.function?.arguments);
  }
  if (rawMsg?.function_call?.arguments !== undefined) {
    argCandidates.push(rawMsg.function_call.arguments);
  }

  for (const candidate of argCandidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return { parsed: candidate, rawText: contentToText(response?.text) || '' };
    }
    if (typeof candidate === 'string') {
      const parsedString = safeJsonParse(candidate)
        || parseJsonFromToolWrapper(candidate)
        || parseLegacyReflectionLine(candidate)
        || parseLooseKeyValueReflection(candidate);
      if (parsedString && typeof parsedString === 'object' && !Array.isArray(parsedString)) {
        return { parsed: parsedString, rawText: candidate };
      }
    }
  }

  const textCandidates = [
    contentToText(response?.text),
    contentToText(rawMsg?.content),
    contentToText(rawMsg?.reasoning_content),
  ].filter(Boolean);

  for (const text of textCandidates) {
    const parsed = safeJsonParse(text)
      || parseJsonFromToolWrapper(text)
      || parseLegacyReflectionLine(text)
      || parseLooseKeyValueReflection(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { parsed, rawText: text };
    }
  }

  return {
    parsed: null,
    rawText: textCandidates[0] || '',
  };
}

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return false;
    if (['undefined', 'null', 'nan'].includes(s.toLowerCase())) return false;
    return true;
  }
  return true;
}

function validateNextActionArgs(tool, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'next_action.args must be an object';
  }

  const reqByTool = {
    find: ['query'],
    find_text: ['query'],
    navigate: ['url'],
    open_tab: ['url'],
    http_request: ['url'],
    javascript: ['code'],
    click: ['target'],
    hover: ['target'],
    type: ['target', 'text'],
    select: ['target', 'value'],
    press_key: ['key'],
    notify_connector: ['connectorId', 'message'],
    fail: ['reason'],
  };

  const required = reqByTool[tool] || [];
  for (const key of required) {
    if (!hasValue(args[key])) {
      return `next_action.args.${key} is required for tool "${tool}"`;
    }
  }

  if (tool === 'tabs_context' && args?.action === 'switch_frame') {
    const hasSelector = hasValue(args.main) || hasValue(args.target) || hasValue(args.index);
    if (!hasSelector) {
      return 'next_action.args must include one of: main, target, or index for action "switch_frame"';
    }
  }

  return null;
}

function getRawPlannedActions(raw) {
  if (Array.isArray(raw?.actions)) return raw.actions;
  if (raw?.next_action && typeof raw.next_action === 'object' && !Array.isArray(raw.next_action)) {
    return [raw.next_action];
  }
  return [];
}

/**
 * Patterns for metrics that are structurally unavailable on search/index pages
 * (arXiv, Google Scholar, PubMed, etc. do not expose citation counts in search results).
 * When loop signals are present and the agent keeps listing these as unknowns,
 * the agent will never satisfy sufficiency=true. Strip them to unblock convergence.
 */
const UNAVAILABLE_METRIC_RE = /\b(citation\s*count|citations?|cite[sd]?|altmetric|download\s*count|downloads?|h-index|impact\s*factor|page\s*rank|trending|popularity\s*rank|importance\s*rank(?:ing)?|most\s*cited|highly\s*cited|usage\s*stats?|access\s*count|view\s*count|read\s*count|star\s*count)\b/i;

/**
 * Regex to detect pagination-like link text in find results.
 * Matches: "2", "3", …, "next", ">", "»", "следующая", "далее", "page 2", etc.
 */
const PAGINATION_TEXT_RE = /^[2-9]$|^[1-9]\d+$|^next\b|^>$|^»$|^›$|^следующ|^далее|^page\s*\d|^more\s*results/i;

/**
 * Regex to detect collection/enumeration goals (multi-result tasks).
 * Used to inform the LLM and soften convergence guards.
 */
const COLLECTION_GOAL_RE = /\b(статьи|статей|articles?|papers?|список|list|все\b|all\b|найди\s+все|find\s+all|get\s+all|collect|extract\s+all|каждый|каждая|каждое|every|results?\s+for|перечисл|enumerate)\b/i;

export const reflectionMethods = {
  /**
   * Remove unknowns that describe externally-unavailable metrics.
   * Only fires when loop signals ≥ 1 to avoid suppressing legitimate unknowns on first pass.
   * @param {string[]} unknowns
   * @param {number} loopSignals - sum of _dupCount + _blockedRepeatCount + _serpReadLoopCount
   * @returns {string[]}
   */
  _filterUnresolvableUnknowns(unknowns, loopSignals = 0) {
    if (loopSignals < 1 || !Array.isArray(unknowns) || unknowns.length === 0) return unknowns;
    return unknowns.filter((u) => !UNAVAILABLE_METRIC_RE.test(String(u || '')));
  },

  /**
   * Check whether the goal text describes a collection/enumeration task
   * (e.g. "find articles", "list all papers", "статьи про…").
   * @returns {boolean}
   */
  _isCollectionGoal() {
    const goal = String(this?._goal || '').trim();
    return COLLECTION_GOAL_RE.test(goal);
  },

  /**
   * Scan recent history for `find` results that contain pagination links.
   * Returns the first pagination element found (with agentId and text), or null.
   * @param {number} windowSize - how many history entries to scan backwards
   * @returns {{ agentId: number, text: string } | null}
   */
  _findPaginationInHistory(windowSize = 8) {
    const items = Array.isArray(this?.history) ? this.history : [];
    const start = Math.max(items.length - windowSize, 0);
    for (let i = items.length - 1; i >= start; i--) {
      const h = items[i];
      if (!h || h.type !== 'action' || h.tool !== 'find') continue;
      const result = h.result;
      const hits = Array.isArray(result) ? result : [];
      for (const hit of hits) {
        const text = String(hit?.text || '').trim();
        const role = String(hit?.role || '').toLowerCase();
        const tag = String(hit?.tag || '').toLowerCase();
        if (!text) continue;
        // Only consider links/buttons — not arbitrary text nodes
        if (role !== 'link' && role !== 'button' && tag !== 'a' && tag !== 'button') continue;
        if (PAGINATION_TEXT_RE.test(text)) {
          // For purely numeric text (e.g. "2", "15"), require an actual <a> link.
          // Button/div elements with numeric text are almost never real pagination controls
          // and frequently match currency codes, table values, or form fields.
          const isNumeric = /^\d+$/.test(text);
          if (isNumeric && tag !== 'a' && role !== 'link') continue;
          const agentId = Number(hit?.agentId);
          if (Number.isFinite(agentId)) {
            return { agentId, text };
          }
        }
      }
    }
    return null;
  },

  /**
   * Returns true when a read/observation tool is already hard-blocked for
   * the current URL in _urlToolReadLog.
   * @param {string} tool
   * @returns {boolean}
   */
  _isReadToolBlockedOnCurrentUrl(tool) {
    const t = String(tool || '').trim();
    if (!t) return false;
    const readTools = new Set(['get_page_text', 'extract_structured', 'read_page', 'query_page']);
    if (!readTools.has(t)) return false;
    // Key must include origin+pathname to match the write side in _trackAntiLoopSignals.
    let url;
    try {
      const parsed = new URL(String(this?._lastKnownUrl || ''));
      url = `${parsed.origin}${parsed.pathname}`;
    } catch {
      url = String(this?._lastKnownUrl || '').split('?')[0].split('#')[0];
    }
    if (!url) return false;
    const readLog = this?._urlToolReadLog instanceof Map ? this._urlToolReadLog : null;
    if (!readLog) return false;
    return readLog.has(`${url}|${t}`);
  },

  /**
   * Build adaptive candidate actions based on runtime signals instead of
   * fixed, single-path fallbacks.
   * @param {Set<string>} allowed
   * @param {object} ctx
   * @returns {Array<{tool:string,args:object,score:number,reason:string}>}
   */
  _buildAdaptiveActionCandidates(allowed, ctx = {}) {
    const out = [];
    const factsCount = Math.max(Number(ctx.factsCount || 0), 0);
    const duplicateStreak = Math.max(Number(ctx.duplicateStreak || 0), 0);
    const findTextZeroStreak = Math.max(Number(ctx.findTextZeroStreak || 0), 0);
    const isCollection = !!ctx.isCollection;
    const paginationHit = ctx.paginationHit || null;
    const goalQuery = String(ctx.goalQuery || '').trim();
    const blockedRead = new Set(Array.isArray(ctx.blockedReadTools) ? ctx.blockedReadTools : []);

    const push = (tool, args, score, reason) => {
      if (!allowed.has(tool)) return;
      out.push({ tool, args: args || {}, score: Number(score) || 0, reason: String(reason || '') });
    };

    // 1) If pagination is visible, state-changing click is highest-value move.
    if (paginationHit && allowed.has('computer')) {
      push(
        'computer',
        { action: 'click', target: paginationHit.agentId },
        120 + (isCollection ? 20 : 0) + Math.min(duplicateStreak, 3) * 8,
        'pagination_click',
      );
    }

    // 1b) If recent find() results contain clickable links (search results),
    // suggest clicking the first relevant link to go deeper into detail pages.
    // This is especially important when reads are blocked on the current page.
    if (allowed.has('computer') && duplicateStreak >= 1) {
      const items = Array.isArray(this?.history) ? this.history : [];
      const start = Math.max(items.length - 8, 0);
      for (let i = items.length - 1; i >= start; i--) {
        const h = items[i];
        if (!h || h.type !== 'action' || h.tool !== 'find') continue;
        const hits = Array.isArray(h.result) ? h.result : [];
        for (const hit of hits) {
          const tag = String(hit?.tag || '').toLowerCase();
          const role = String(hit?.role || '').toLowerCase();
          if (tag !== 'a' && role !== 'link') continue;
          const text = String(hit?.text || '').trim();
          if (!text || text.length < 3) continue;
          const agentId = Number(hit?.agentId);
          if (!Number.isFinite(agentId)) continue;
          // Skip pagination-like links (already handled above)
          if (PAGINATION_TEXT_RE.test(text)) continue;
          push(
            'computer',
            { action: 'click', target: agentId },
            110 + Math.min(duplicateStreak, 3) * 6,
            'click_search_result_link',
          );
          break; // only suggest the first relevant link
        }
        if (out.some(c => c.reason === 'click_search_result_link')) break;
      }
    }

    // 2) If we are looping and pagination may exist, ask page for pagination anchors.
    // Only recommend this if we haven't already tried find-pagination and found nothing.
    // When duplicateStreak >= 1 and paginationHit is null, we already tried and got
    // no results — repeating it will only produce DUPLICATE_CALL again.
    const paginationAlreadyTried = duplicateStreak >= 1 && !paginationHit;
    if (allowed.has('find') && !paginationAlreadyTried) {
      push(
        'find',
        { query: 'pagination next page link' },
        85 + (isCollection ? 10 : 0),
        'find_pagination',
      );
    }

    // 3) Read tools are candidates only if not currently blocked for this URL.
    if (!blockedRead.has('extract_structured') && allowed.has('extract_structured')) {
      push(
        'extract_structured',
        { hint: isCollection ? 'search results list with ids/titles/authors/dates' : 'key entities and facts', maxItems: isCollection ? 20 : 12 },
        68 + (isCollection ? 12 : 0) + (factsCount === 0 ? 6 : 0),
        'structured_read',
      );
    }
    if (!blockedRead.has('get_page_text') && allowed.has('get_page_text')) {
      push(
        'get_page_text',
        { scope: 'viewport' },
        60 + (factsCount === 0 ? 6 : 0),
        'text_read',
      );
    }
    if (!blockedRead.has('read_page') && allowed.has('read_page')) {
      push(
        'read_page',
        {},
        52,
        'dom_read',
      );
    }

    // 4) query-based scanning if it is still productive.
    if (allowed.has('find_text') && findTextZeroStreak < 3 && goalQuery) {
      push(
        'find_text',
        { query: goalQuery },
        42 - findTextZeroStreak * 8,
        'targeted_text_scan',
      );
    }

    // 5) Low-priority stabilizers.
    if (allowed.has('tabs_context')) push('tabs_context', { action: 'list' }, 20, 'context_refresh');
    if (allowed.has('save_progress') && factsCount > 0 && duplicateStreak === 0) push('save_progress', { data: { facts_count: factsCount } }, 8, 'memory_checkpoint');

    out.sort((a, b) => b.score - a.score);
    return out;
  },

  /**
   * Pick highest-value adaptive action from current runtime context.
   * @param {Set<string>} allowed
   * @param {object} ctx
   * @returns {{tool:string,args:object}|null}
   */
  _pickAdaptiveAction(allowed, ctx = {}) {
    const candidates = this._buildAdaptiveActionCandidates(allowed, ctx);
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const top = candidates[0];
    return top ? { tool: top.tool, args: top.args || {} } : null;
  },

  _deriveGoalQuery() {
    const goal = String(this?._goal || '').trim();
    if (!goal) return '';

    let q = goal
      .replace(/^task:\s*/i, '')
      .replace(/^(how\s+do\s+you\s+spell|how\s+to\s+spell|find|check|look\s+up)\s+/i, '')
      .replace(/\s+on\s+site\s+.+$/i, '')
      .replace(/\s+on\s+dictionary\.com.*$/i, '')
      .replace(/\s+on\s+dictionary\s*\.?\s*com.*$/i, '')
      .replace(/\s+on\s+merriam[a-z]*\s*\.?\s*com.*$/i, '')
      .replace(/\s+and\s+send.*$/i, '')
      .replace(/\s+send.*$/i, '')
      .trim();

    q = q.replace(/^["'«“„]+|["'»”‟]+$/g, '').trim();
    if (!q) return '';
    if (q.length > 120) return q.slice(0, 120).trim();
    return q;
  },

  _idsLikelyStale() {
    const items = Array.isArray(this?.history) ? this.history : [];
    if (items.length === 0) return false;

    const navTools = new Set(['navigate', 'tabs_create', 'tabs_context']);
    const idRefreshTools = new Set(['read_page', 'find']);

    let lastNavIdx = -1;
    let lastRefreshIdx = -1;

    for (let i = 0; i < items.length; i++) {
      const h = items[i];
      if (!h || h.type !== 'action') continue;
      if (navTools.has(h.tool) && h.result?.success !== false) {
        lastNavIdx = i;
        continue;
      }
      if (idRefreshTools.has(h.tool) && h.result?.success !== false) {
        lastRefreshIdx = i;
      }
    }

    return lastNavIdx >= 0 && lastNavIdx > lastRefreshIdx;
  },

  _estimateProgressRatio(facts = [], unknowns = [], stepBudget = null) {
    const factsList = Array.isArray(facts) ? facts : [];
    const unknownList = Array.isArray(unknowns) ? unknowns : [];

    const subGoals = Array.isArray(this?._subGoals) ? this._subGoals : [];
    const totalSubGoals = subGoals.length;
    const completedSubGoals = subGoals.filter((sg) => String(sg?.status || '') === 'completed').length;
    const subGoalRatio = totalSubGoals > 0
      ? completedSubGoals / totalSubGoals
      : 0;

    // Use a softer denominator so that a single definitive fact (e.g. a currency rate)
    // is not penalised as heavily as a multi-fact research task.
    // With denominator=3 a single fact yields factsRatio≈0.33 instead of 0.125.
    const factsRatio = Math.min(factsList.length / Math.max(Math.min(factsList.length + 2, 8), 1), 1);
    const evidenceRatio = Math.min(factsList.length / Math.max(factsList.length + unknownList.length, 1), 1);
    const toolCalls = Number(this?.metrics?.toolCalls || 0);
    const observationRatio = Math.min(toolCalls / 12, 1);
    const noProgress = Math.max(Number(this?._noProgressStreak || 0), 0);
    const stagnationDrag = Math.min(noProgress / 12, 0.7);
    const budget = normalizeStepBudget(stepBudget);
    const budgetPressure = budget.total > 0
      ? Math.min(budget.used / Math.max(budget.total, 1), 1)
      : Math.min(toolCalls / 20, 1);

    let ratio = 0;
    if (totalSubGoals > 0) {
      ratio = 0.7 * subGoalRatio + 0.2 * evidenceRatio + 0.1 * factsRatio;
    } else {
      ratio = 0.45 * factsRatio + 0.25 * evidenceRatio + 0.2 * observationRatio + 0.1 * budgetPressure;
    }

    ratio *= (1 - stagnationDrag);
    return clampConfidence(ratio);
  },

  _buildReflectionPrompt(step, allowedTools = [], stepBudget = null) {
    // The static schema, rules, and constraints are already in the system prompt.
    // Here we emit ONLY the dynamic delta: step context, budget, and active warnings.
    const tools = allowedTools.map((t) => t.name).join(', ');
    const budget = normalizeStepBudget(stepBudget);

    const lines = [`Reflection checkpoint — step ${step}. Allowed tools: ${tools}.`];
    const pendingVerification = this?._pendingVerification && typeof this._pendingVerification === 'object'
      ? this._pendingVerification
      : null;

    // Budget pressure
    if (budget.total > 0) {
      lines.push(`Budget: ${budget.used}/${budget.total} used, ${budget.remaining} left (${budget.urgency}).`);
      if (budget.critical) {
        lines.push('CRITICAL: 1 step left. Set sufficiency=true with best answer NOW.');
      } else if (budget.nearLimit) {
        lines.push('Near limit: finish with current evidence.');
      }
    }

    // Navigate pageText hint
    const recentNavigateWithText = Array.isArray(this?.history)
      ? this.history
        .slice(-6)
        .reverse()
        .find((h) => h?.type === 'action' && h.tool === 'navigate' && typeof h.result?.pageText === 'string' && h.result.pageText.trim().length > 50)
      : null;
    // loopSignalsNow includes _consecutiveDuplicateCalls so LLM is aware of the real
    // blocked-read streak, not just the single-call _dupCount which resets on any tool change.
    const loopSignalsNow = (
      Math.max(Number(this?._dupCount || 0), 0) +
      Math.max(Number(this?._blockedRepeatCount || 0), 0) +
      Math.max(Number(this?._serpReadLoopCount || 0), 0) +
      Math.max(Number(this?._consecutiveDuplicateCalls || 0), 0)
    );
    // Blocked read tools hint: inform the LLM which tools are exhausted for the current URL.
    // Include find / find_text in the tracked set so repeated find-loops are visible too.
    let currentUrlForPrompt;
    try {
      const parsed = new URL(String(this?._lastKnownUrl || ''));
      currentUrlForPrompt = `${parsed.origin}${parsed.pathname}`;
    } catch {
      currentUrlForPrompt = String(this?._lastKnownUrl || '').split('?')[0].split('#')[0];
    }
    const readLogForPrompt = this?._urlToolReadLog instanceof Map ? this._urlToolReadLog : new Map();
    const primaryReadTools = ['get_page_text', 'extract_structured', 'read_page', 'find', 'find_text'];
    const blockedTools = currentUrlForPrompt
      ? primaryReadTools.filter((t) => readLogForPrompt.has(`${currentUrlForPrompt}|${t}`))
      : [];
    // "All reads blocked" only considers the three heavy tools (find is lighter)
    const heavyReadTools = ['get_page_text', 'extract_structured', 'read_page'];
    const allReadsBlocked = heavyReadTools.every((t) => blockedTools.includes(t));

    if (recentNavigateWithText) {
      lines.push(`navigate() returned pageText (${recentNavigateWithText.result.pageText.trim().slice(0, 80).replace(/\n/g, ' ')}…). Don't re-read this URL.`);
      if (loopSignalsNow >= 2) {
        lines.push(`BLOCKED: ${loopSignalsNow} repeated reads. Set sufficiency=true with current facts.`);
      }
    } else if (loopSignalsNow >= 2) {
      lines.push(`BLOCKED: ${loopSignalsNow} repeated reads. Navigate elsewhere or set sufficiency=true.`);
    }

    // Surface collected facts back to the LLM so it can judge sufficiency itself.
    // Without this, the model doesn't see its own accumulated evidence and keeps
    // requesting more reads even when the answer is already in facts[].
    const prevFacts = Array.isArray(this?._reflectionState?.facts)
      ? this._reflectionState.facts.slice(0, 6)
      : [];

    if (allReadsBlocked) {
      let msg = 'ALL READS EXHAUSTED for this page.';
      if (prevFacts.length > 0) {
        msg += ` Facts: ${prevFacts.map((f, i) => `[${i + 1}] ${f}`).join(' | ')}. Set sufficiency=true with these.`;
      } else {
        msg += ' Navigate elsewhere or fail.';
      }
      lines.push(msg);
    } else if (blockedTools.length > 0) {
      let msg = `Blocked on this page: ${blockedTools.join(', ')}.`;
      if (prevFacts.length > 0) {
        msg += ` Facts: ${prevFacts.map((f, i) => `[${i + 1}] ${f}`).join(' | ')}. If sufficient, set sufficiency=true.`;
      }
      lines.push(msg);
    } else if (prevFacts.length > 0 && loopSignalsNow >= 1) {
      // Even without blocked tools, remind the model of its own evidence when loops start
      lines.push(`Facts: ${prevFacts.map((f, i) => `[${i + 1}] ${f}`).join(' | ')}. If sufficient, set sufficiency=true.`);
    }

    // Find-text zero-result streak
    const findTextZeroStreak = Math.max(Number(this?._consecutiveFindTextZeroCount || 0), 0);
    if (findTextZeroStreak >= 3) {
      lines.push(`find_text: ${findTextZeroStreak}× zero results. Switch to get_page_text/navigate/done.`);
    } else if (findTextZeroStreak >= 2) {
      lines.push(`find_text: ${findTextZeroStreak}× zero results. Try get_page_text or extract_structured.`);
    }

    // Temporal awareness
    const temporalHint = String(this?._temporalHint || '').trim();
    if (temporalHint) lines.push(temporalHint);

    // Pagination awareness: if recent find() results contain pagination links,
    // inform the LLM so it can click through instead of re-reading or finishing early.
    const paginationHit = typeof this._findPaginationInHistory === 'function'
      ? this._findPaginationInHistory(8)
      : null;
    if (paginationHit) {
      const readBlocked = blockedTools.length > 0 || loopSignalsNow >= 2;
      if (readBlocked) {
        lines.push(`PAGINATION: "${paginationHit.text}" [${paginationHit.agentId}] — click for more results.`);
      } else {
        lines.push(`Pagination available: "${paginationHit.text}" [${paginationHit.agentId}].`);
      }
    }

    // Collection task awareness: if the goal asks for multiple items, remind the LLM
    // not to finish with only partial results.
    const isCollection = typeof this._isCollectionGoal === 'function' && this._isCollectionGoal();
    if (isCollection && prevFacts.length > 0 && prevFacts.length < 5) {
      lines.push(`COLLECTION: only ${prevFacts.length} facts. Continue collecting or paginate.`);
    }

    if (pendingVerification) {
      const expected = String(pendingVerification.expectedOutcome || '').trim();
      const action = String(pendingVerification.actionLabel || pendingVerification.tool || '').trim();
      lines.push(
        expected
          ? `VERIFY BEFORE DONE: recent ${action || 'mutating action'} is not verified yet. Confirm this outcome with a read step: ${expected}`
          : `VERIFY BEFORE DONE: recent ${action || 'mutating action'} is not verified yet. Use a read step before done.`,
      );
    }

    lines.push('Return JSON only.');
    return lines.join('\n');
  },

  _normalizeReflectionState(raw, allowedTools = [], stepBudget = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Reflection must be a JSON object' };
    }

    const budget = normalizeStepBudget(stepBudget);
    const allowed = new Set((allowedTools || []).map((t) => t.name));
    const goalText = String(this?._goal || '').toLowerCase();
    const isSpellingGoal = /(how\s+to\s+spell|spelling)/i.test(goalText);
    const searchQuery = normalizeSearchQuery(raw.search_query || this?._reflectionState?.search_query);

    const synthesizeNextAction = (factsList = [], unknownList = []) => {
      const factsText = factsList.join(' ').toLowerCase();
      const unknownText = unknownList.join(' ').toLowerCase();
      const goalQuery = searchQuery || this._deriveGoalQuery();
      const paginationHit = typeof this._findPaginationInHistory === 'function'
        ? this._findPaginationInHistory(8)
        : null;

      const blockedReadTools = [];
      for (const t of ['get_page_text', 'extract_structured', 'read_page']) {
        if (typeof this._isReadToolBlockedOnCurrentUrl === 'function' && this._isReadToolBlockedOnCurrentUrl(t)) {
          blockedReadTools.push(t);
        }
      }

      const adaptive = typeof this._pickAdaptiveAction === 'function'
        ? this._pickAdaptiveAction(allowed, {
          isCollection: typeof this._isCollectionGoal === 'function' && this._isCollectionGoal(),
          paginationHit,
          goalQuery,
          factsCount: Array.isArray(factsList) ? factsList.length : 0,
          duplicateStreak: Math.max(Number(this?._consecutiveDuplicateCalls || 0), 0),
          findTextZeroStreak: Math.max(Number(this?._consecutiveFindTextZeroCount || 0), 0),
          blockedReadTools,
          goalText,
        })
        : null;
      if (adaptive) return adaptive;

      if (isSpellingGoal && allowed.has('find_text')) {
        return { tool: 'find_text', args: { query: goalQuery || 'Correct' } };
      }
      if (
        /product|products|item|cost|price|rating|under\s*\$|cheap|cheapest|headphone|earphones/i.test(`${goalText} ${factsText} ${unknownText}`) &&
        allowed.has('extract_structured')
      ) {
        return { tool: 'extract_structured', args: { hint: 'search results', maxItems: 20 } };
      }
      if (allowed.has('get_page_text')) {
        return {
          tool: 'get_page_text',
          args: { scope: 'viewport' },
        };
      }
      if (allowed.has('read_page')) return { tool: 'read_page', args: {} };
      if (allowed.has('tabs_context')) return { tool: 'tabs_context', args: { action: 'list' } };
      if (allowed.has('extract_structured')) return { tool: 'extract_structured', args: { hint: 'repeating items' } };
      return null;
    };

    const facts = normalizeStringArray(raw.facts, 16, 320);
    // Compute loop signals early so we can filter unknowns before confidence calibration.
    // This prevents the agent from being permanently blocked by metrics that don't exist
    // on the current page (e.g. citation counts on arXiv search results).
    const earlyLoopSignals = (
      Math.max(Number(this?._dupCount || 0), 0) +
      Math.max(Number(this?._blockedRepeatCount || 0), 0) +
      Math.max(Number(this?._serpReadLoopCount || 0), 0) +
      Math.max(Number(this?._consecutiveSaveProgressCount || 0), 0) +
      // Include the execution-layer duplicate streak so the reflection layer
      // can see DUPLICATE_CALL accumulation and trigger convergence sooner.
      Math.max(Number(this?._consecutiveDuplicateCalls || 0), 0)
    );
    const filteredUnknowns = typeof this._filterUnresolvableUnknowns === 'function'
      ? this._filterUnresolvableUnknowns(normalizeStringArray(raw.unknowns, 12, 320), earlyLoopSignals)
      : normalizeStringArray(raw.unknowns, 12, 320);
    const unknowns = filteredUnknowns;
    let sufficiency = raw.sufficiency === true;
    const rawConfidence = clampConfidence(raw.confidence);
    const correctedConfidence = clampConfidence(rawConfidence * REFLECTION_OVERCONFIDENCE_FACTOR);
    const noProgress = Math.max(Number(this?._noProgressStreak || 0), 0);
    const stagnationPenalty = Math.pow(REFLECTION_STAGNATION_DECAY_BASE, noProgress);
    const loopSignals = (
      Math.max(Number(this?._dupCount || 0), 0) +
      Math.max(Number(this?._blockedRepeatCount || 0), 0) +
      Math.max(Number(this?._serpReadLoopCount || 0), 0)
    );
    const loopPenalty = Math.max(0.55, Math.pow(0.9, loopSignals));
    const progressRatio = this._estimateProgressRatio(facts, unknowns, stepBudget);
    const confidence = clampConfidence(
      0.6 * correctedConfidence * stagnationPenalty * loopPenalty +
      0.4 * progressRatio,
    );
    const inProgressConfidence = Math.min(
      Math.max(confidence, facts.length > 0 ? 0.2 : 0),
      REFLECTION_CONFIDENCE_THRESHOLD - 0.01,
    );
    const summary = String(raw.summary || '').trim().slice(0, 500);
    const answer = String(raw.answer || '').trim().slice(0, 5000);
    const rawPlannedActions = getRawPlannedActions(raw).slice(0, REFLECTION_MAX_ACTIONS_PER_STEP);
    // next_action is deprecated — use actions[0] instead. Accept it from legacy responses but don't require it.
    const hasPlannedAction = rawPlannedActions.length > 0;
    const downgradedCompletion = (
      sufficiency &&
      (
        unknowns.length > 0 ||
        confidence < REFLECTION_CONFIDENCE_THRESHOLD ||
        hasPlannedAction
      )
    );
    if (downgradedCompletion) {
      sufficiency = false;
    }

    // ── Confidence override: if the model already has the answer, boost confidence ──
    // Prevents the agent from looping when it has substantive evidence but the
    // stagnation/loop penalties drag confidence below the threshold.
    const hasSubstantiveAnswer = answer.length >= 20 && facts.length >= 1;
    const hasRichEvidence = facts.length >= 3;

    const buildInProgressState = (plannedActions, unknownOverride = null, confidenceOverride = null) => {
      const cappedActions = Array.isArray(plannedActions)
        ? plannedActions.filter(Boolean).slice(0, REFLECTION_MAX_ACTIONS_PER_STEP)
        : [];
      return {
        facts,
        unknowns: Array.isArray(unknownOverride) ? unknownOverride : unknowns,
        sufficiency: false,
        confidence: confidenceOverride ?? Math.min(Math.max(confidence, facts.length > 0 ? 0.2 : 0), REFLECTION_CONFIDENCE_THRESHOLD - 0.01),
        search_query: searchQuery,
        summary,
        answer,
        actions: cappedActions.length > 0 ? cappedActions : null,
      };
    };

    let nextAction = null;
    let actions = null;
    if (!sufficiency) {
      if (rawPlannedActions.length === 0) {
        const synthesized = synthesizeNextAction(facts, unknowns);
        if (synthesized) {
          return {
            ok: true,
            state: buildInProgressState([synthesized]),
          };
        }
        if (downgradedCompletion) {
          if (allowed.has('extract_structured')) {
            nextAction = { tool: 'extract_structured', args: { hint: 'search results' } };
            const argError = validateNextActionArgs(nextAction.tool, nextAction.args);
            if (!argError) {
              return {
                ok: true,
                state: buildInProgressState([nextAction], null, Math.min(confidence, REFLECTION_CONFIDENCE_THRESHOLD - 0.01)),
              };
            }
          }
          if (allowed.has('get_page_text')) {
            nextAction = { tool: 'get_page_text', args: { scope: 'viewport' } };
            return {
              ok: true,
              state: buildInProgressState([nextAction], null, Math.min(confidence, REFLECTION_CONFIDENCE_THRESHOLD - 0.01)),
            };
          }
        }
        return { ok: false, error: 'actions is required when sufficiency=false' };
      }
      const goalQuery = searchQuery || this._deriveGoalQuery();
      const findTextZeroStreakNow = Math.max(Number(this?._consecutiveFindTextZeroCount || 0), 0);
      const duplicateStreakNow = Math.max(Number(this?._consecutiveDuplicateCalls || 0), 0);
      const normalizedActions = [];
      const seenActionSignatures = new Set();
      for (const rawAction of rawPlannedActions) {
        if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
          continue;
        }
        let tool = String(rawAction.tool || '').trim();
        if (!tool) continue;
        let args = rawAction.args;

        // ── Hard guard: if the model repeats a read tool that is already blocked
        // on the current URL, force a strategy switch before execution.
        if (
          duplicateStreakNow >= 1 &&
          typeof this._isReadToolBlockedOnCurrentUrl === 'function' &&
          this._isReadToolBlockedOnCurrentUrl(tool)
        ) {
          const paginationHit = typeof this._findPaginationInHistory === 'function' ? this._findPaginationInHistory(8) : null;
          const blockedReadTools = [];
          for (const t of ['get_page_text', 'extract_structured', 'read_page']) {
            if (typeof this._isReadToolBlockedOnCurrentUrl === 'function' && this._isReadToolBlockedOnCurrentUrl(t)) {
              blockedReadTools.push(t);
            }
          }
          const adaptive = typeof this._pickAdaptiveAction === 'function'
            ? this._pickAdaptiveAction(allowed, {
              isCollection: typeof this._isCollectionGoal === 'function' && this._isCollectionGoal(),
              paginationHit,
              goalQuery,
              factsCount: facts.length,
              duplicateStreak: duplicateStreakNow,
              findTextZeroStreak: findTextZeroStreakNow,
              blockedReadTools,
              goalText,
            })
            : null;
          if (adaptive) {
            tool = adaptive.tool;
            args = adaptive.args;
          }
        }

        // ── Find-text streak guard: block find_text after 3+ consecutive zero results ──
        if (tool === 'find_text' && findTextZeroStreakNow >= 3) {
          if (allowed.has('get_page_text')) {
            tool = 'get_page_text';
            args = { scope: 'full' };
          } else if (allowed.has('extract_structured')) {
            tool = 'extract_structured';
            args = { hint: 'search results' };
          } else if (allowed.has('navigate')) {
            // Let the LLM re-decide where to go
            const synthesized = synthesizeNextAction(facts, unknowns);
            if (synthesized) {
              return { ok: true, state: buildInProgressState([synthesized]) };
            }
          }
        }

        if (tool === 'done') {
          // When the agent plans 'done' with sufficiency=false but is clearly stuck in a
          // read-loop with accumulated evidence, honor the intent and converge rather than
          // redirecting to yet more reads that will immediately be blocked again.
          const loopForcedDone = earlyLoopSignals >= 2 && (
            (facts.length >= 1 && answer.length >= 20) ||
            facts.length >= 2
          );
          if (loopForcedDone) {
            const convergedAnswer = answer || facts.map((f) => `- ${f}`).join('\n');
            return {
              ok: true,
              state: {
                facts,
                unknowns: [],
                sufficiency: true,
                confidence: Math.max(confidence, REFLECTION_CONFIDENCE_THRESHOLD),
                search_query: searchQuery,
                summary: summary || 'Converged from collected evidence (done-guard bypass).',
                answer: convergedAnswer.slice(0, 5000),
                actions: null,
              },
            };
          }
          // Self-heal inconsistent reflection instead of falling into fallback loops.
          if (allowed.has('save_progress')) {
            tool = 'save_progress';
            args = {
              data: {
                inferred_from_reflection: true,
                facts: facts.slice(0, 10),
                unknowns: unknowns.slice(0, 6),
              },
            };
          } else if (allowed.has('extract_structured')) {
            tool = 'extract_structured';
            args = { hint: 'search results' };
          } else if (allowed.has('get_page_text')) {
            tool = 'get_page_text';
            args = { scope: 'viewport' };
          } else if (allowed.has('read_page')) {
            tool = 'read_page';
            args = {};
          } else {
            return { ok: false, error: 'actions[*].tool "done" is invalid when sufficiency=false' };
          }
        }
        if (!allowed.has(tool)) {
          const synthesized = synthesizeNextAction(facts, unknowns);
          if (synthesized) {
            return { ok: true, state: buildInProgressState([synthesized]) };
          }
          return { ok: false, error: `actions[*].tool "${tool}" is not in allowed tools` };
        }
        if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
          return { ok: false, error: 'actions[*].args must be an object' };
        }
        const normalizedArgs = { ...(args || {}) };
        if (tool === 'find' || tool === 'find_text') {
          if (!hasValue(normalizedArgs.query) && hasValue(goalQuery)) {
            normalizedArgs.query = goalQuery;
          }
        }
        if (tool === 'computer' && args?.action === 'type') {
          if (!hasValue(normalizedArgs.text) && hasValue(goalQuery)) {
            normalizedArgs.text = goalQuery;
          }
        }

        const argError = validateNextActionArgs(tool, normalizedArgs);
        if (argError) {
          const synthesized = synthesizeNextAction(facts, unknowns);
          if (synthesized) {
            return { ok: true, state: buildInProgressState([synthesized], null, inProgressConfidence) };
          }
          return { ok: false, error: argError.replace(/^next_action/, 'actions[*]') };
        }

        // Guard against repeated identical actions inside one reflection batch
        // (e.g. read_page > read_page > read_page > read_page), which creates
        // immediate DUPLICATE_CALL loops and burns step budget.
        let actionSignature = '';
        try {
          actionSignature = `${tool}:${JSON.stringify(normalizedArgs)}`;
        } catch {
          actionSignature = `${tool}:__unserializable__`;
        }
        if (seenActionSignatures.has(actionSignature)) {
          continue;
        }
        seenActionSignatures.add(actionSignature);

        // IDs are page-state bound; after navigation they are likely stale.
        if (
          normalizedActions.length === 0 &&
          tool === 'computer' && normalizedArgs.action === 'click' &&
          typeof this._idsLikelyStale === 'function' &&
          this._idsLikelyStale()
        ) {
          const staleUnknowns = normalizeStringArray(
            [...unknowns, 'Element IDs may be stale after navigation; refresh page map before click.'],
            12,
            320,
          );
          const refreshAction = allowed.has('read_page')
            ? { tool: 'read_page', args: {} }
            : (allowed.has('find') ? { tool: 'find', args: { query: 'target button or link' } } : null);
          if (refreshAction) {
            return { ok: true, state: buildInProgressState([refreshAction], staleUnknowns, inProgressConfidence) };
          }
        }

        const expectedOutcome = String(rawAction.expected_outcome || '').trim().slice(0, 240);
        normalizedActions.push({
          tool,
          args: normalizedArgs,
          ...(expectedOutcome ? { expected_outcome: expectedOutcome } : {}),
        });
        if (normalizedActions.length >= REFLECTION_MAX_ACTIONS_PER_STEP) break;
      }

      if (normalizedActions.length === 0) {
        const synthesized = synthesizeNextAction(facts, unknowns);
        if (synthesized) {
          return { ok: true, state: buildInProgressState([synthesized], null, inProgressConfidence) };
        }
        return { ok: false, error: 'actions must contain at least one valid action when sufficiency=false' };
      }

      actions = normalizedActions;
      nextAction = normalizedActions[0] || null;
    } else {
      if (Array.isArray(raw.actions) && raw.actions.length > 0) {
        return { ok: false, error: 'sufficiency=true requires actions to be null or empty' };
      }
      // next_action is deprecated — ignore it when sufficiency=true (no longer required to be null)
      if (!summary && !answer) {
        return { ok: false, error: 'sufficiency=true requires summary or answer' };
      }
      if (unknowns.length > 0) {
        return { ok: false, error: 'sufficiency=true requires unknowns to be empty' };
      }
      if (confidence < REFLECTION_CONFIDENCE_THRESHOLD) {
        return { ok: false, error: `sufficiency=true requires confidence >= ${REFLECTION_CONFIDENCE_THRESHOLD}` };
      }
      // Self-heal: if answer looks like a failure/empty message but facts contain real data,
      // replace the answer with facts so the user gets the actual information.
      const answerLooksEmpty = !answer || /не\s+извлечен|не\s+найден|not\s+found|not\s+extracted|unable\s+to|failed\s+to|could\s+not/i.test(answer);
      if (answerLooksEmpty && facts.length > 0) {
        // Rebuild answer from collected facts
        const rebuiltAnswer = facts.map((f) => `- ${f}`).join('\n');
        // Mutate the local answer variable so the final state uses the rebuilt value
        // (we can't reassign const, so we patch via the return path below)
        return {
          ok: true,
          state: {
            facts,
            unknowns: [],
            sufficiency: true,
            confidence: Math.max(confidence, REFLECTION_CONFIDENCE_THRESHOLD),
            search_query: searchQuery,
            summary: summary || 'Completed with collected evidence.',
            answer: rebuiltAnswer.slice(0, 5000),
            actions: null,
          },
        };
      }
    }

    // Loop-trap convergence: if read tools are stuck in a duplicate/blocked loop
    // but we already have substantive facts, treat the task as done rather than
    // burning all remaining steps on futile retries.
    //
    // Thresholds:
    //   • consecutiveDuplicateCalls ≥ 2 with ≥ 1 fact: converge for single-value lookups
    //     (e.g. currency rate — agent already read the page and has the answer).
    //     Uses the execution-layer streak counter which specifically tracks blocked reads,
    //     not the general loopSignals which can fire for other reasons (stagnation, etc.).
    //   • loopSignals ≥ 2 with ≥ 3 facts: converge quickly (high evidence, clear loop)
    //   • loopSignals ≥ 4 with ≥ 1 fact:  original conservative fallback
    //   • save_progress spin ≥ 3 with ≥ 1 fact: agent is writing notes in circles, converge
    //
    // Exception: when pagination links are available in recent history, the agent
    // can still make progress by clicking to the next page. In that case, suppress
    // the most aggressive convergence rule (consecutiveDupCalls ≥ 2 with only 1 fact)
    // so the LLM has a chance to paginate instead of being force-completed.
    const loopSignalCount = earlyLoopSignals;
    const consecutiveDupCalls = Math.max(Number(this?._consecutiveDuplicateCalls || 0), 0);
    const saveProgressSpin = Math.max(Number(this?._consecutiveSaveProgressCount || 0), 0);
    const hasPagination = typeof this._findPaginationInHistory === 'function'
      ? !!this._findPaginationInHistory(8)
      : false;
    const isCollection = typeof this._isCollectionGoal === 'function' && this._isCollectionGoal();

    // Detect whether recent find() results contain clickable links the agent hasn't
    // visited yet. If so, the agent should click through to detail pages before converging.
    const hasUnvisitedFindLinks = (() => {
      const items = Array.isArray(this?.history) ? this.history : [];
      const visited = this?._visitedUrls instanceof Map ? this._visitedUrls : new Map();
      const start = Math.max(items.length - 8, 0);
      for (let i = items.length - 1; i >= start; i--) {
        const h = items[i];
        if (!h || h.type !== 'action' || h.tool !== 'find') continue;
        const hits = Array.isArray(h.result) ? h.result : [];
        for (const hit of hits) {
          const tag = String(hit?.tag || '').toLowerCase();
          const role = String(hit?.role || '').toLowerCase();
          if (tag !== 'a' && role !== 'link') continue;
          const text = String(hit?.text || '').trim();
          if (!text || text.length < 3) continue;
          // This is a clickable link in search results — agent should visit it
          return true;
        }
      }
      return false;
    })();

    const shouldConverge = (
      // For single-value lookups: converge when reads are stuck and we have ≥ 1 fact.
      // But if pagination is available (and especially for collection tasks), don't
      // force-complete — the agent can click to the next page for more data.
      // Also suppress convergence when find() returned clickable links the agent
      // hasn't visited — the agent should click through to detail pages first.
      //
      // Require ≥ 2 consecutive DUPLICATE_CALLs (not 1) to avoid premature convergence
      // when the agent just needs to navigate to a different page or click a link.
      (!sufficiency && consecutiveDupCalls >= 2 && facts.length >= 1 && !isCollection && !hasPagination && !hasUnvisitedFindLinks) ||
      (!sufficiency && consecutiveDupCalls >= 3 && facts.length >= 1 && !(hasPagination && isCollection) && !hasUnvisitedFindLinks) ||
      (!sufficiency && loopSignalCount >= 2 && facts.length >= 3 && (answer.length > 0 || facts.length >= 3) && !hasPagination && !hasUnvisitedFindLinks) ||
      (!sufficiency && loopSignalCount >= 4 && facts.length >= 1) ||
      (!sufficiency && saveProgressSpin >= 3 && facts.length >= 1)
    );
    if (shouldConverge) {
      const loopAnswer = answer || facts.map((f) => `- ${f}`).join('\n');
      const loopSummary = summary || 'Converged from accumulated evidence (read-loop guard).';
      return {
        ok: true,
        state: {
          facts,
          unknowns: [],
          sufficiency: true,
          confidence: Math.max(confidence, REFLECTION_CONFIDENCE_THRESHOLD),
          search_query: searchQuery,
          summary: loopSummary.slice(0, 500),
          answer: loopAnswer.slice(0, 5000),
          actions: null,
        },
      };
    }

    // Emergency convergence: on the last available step, force best-effort completion
    // when we already have non-empty evidence.
    if (!sufficiency && budget.critical && facts.length > 0) {
      const fallbackSummary = summary || 'Best-effort completion at step limit.';
      const fallbackAnswer = answer || facts.map((f) => `- ${f}`).join('\n');
      return {
        ok: true,
        state: {
          facts,
          unknowns: [],
          sufficiency: true,
          confidence: Math.max(confidence, REFLECTION_CONFIDENCE_THRESHOLD),
          search_query: searchQuery,
          summary: fallbackSummary.slice(0, 500),
          answer: fallbackAnswer.slice(0, 5000),
          actions: null,
        },
      };
    }

    let calibratedConfidence = confidence;
    if (!sufficiency) {
      calibratedConfidence = Math.min(calibratedConfidence, REFLECTION_CONFIDENCE_THRESHOLD - 0.01);
    }
    if (!sufficiency && facts.length > 0) {
      calibratedConfidence = Math.max(calibratedConfidence, 0.2);
    }
    // Do not cap confidence for unknowns that were already stripped as unresolvable.
    // If unknowns remain after filtering, apply the standard cap — but lift it
    // partially when loop signals are high (agent spent many steps, has substantial facts).
    if (unknowns.length > 0) {
      const capValue = (earlyLoopSignals >= 2 && facts.length >= 3) ? 0.82 : 0.74;
      calibratedConfidence = Math.min(calibratedConfidence, capValue);
    }
    if (facts.length === 0) {
      calibratedConfidence = Math.min(calibratedConfidence, 0.4);
    }
    if (sufficiency) {
      calibratedConfidence = Math.max(calibratedConfidence, REFLECTION_CONFIDENCE_THRESHOLD);
    }

    // ── Confidence override: boost when agent has substantive answer ──
    // Prevents stagnation/loop penalties from blocking completion when the agent
    // already has the answer. Only applies when sufficiency=false but evidence is strong.
    if (!sufficiency && hasSubstantiveAnswer && unknowns.length === 0) {
      // Agent has answer + facts + no unknowns → treat as effectively done
      calibratedConfidence = Math.max(calibratedConfidence, REFLECTION_CONFIDENCE_THRESHOLD);
      sufficiency = true;
      actions = null;
    } else if (!sufficiency && hasRichEvidence && unknowns.length === 0 && answer.length > 0) {
      // Rich evidence with answer → boost confidence to threshold
      calibratedConfidence = Math.max(calibratedConfidence, REFLECTION_CONFIDENCE_THRESHOLD);
      sufficiency = true;
      actions = null;
    }

    return {
      ok: true,
      state: {
        facts,
        unknowns,
        sufficiency,
        confidence: calibratedConfidence,
        search_query: searchQuery,
        summary,
        answer,
        actions: sufficiency ? null : actions,
        confidence_components: {
          raw: rawConfidence,
          corrected: correctedConfidence,
          stagnation_penalty: stagnationPenalty,
          loop_penalty: loopPenalty,
          progress_ratio: progressRatio,
          effective: calibratedConfidence,
        },
      },
    };
  },

  _buildReflectionDigest(state, stepBudget = null) {
    const budget = normalizeStepBudget(stepBudget);
    const confidencePct = Math.round(clampConfidence(state?.confidence) * 100);
    const progressPct = Math.round(clampConfidence(state?.confidence_components?.progress_ratio) * 100);
    const stagnationPenalty = Number(state?.confidence_components?.stagnation_penalty);
    const suff = state?.sufficiency ? 'yes' : 'no';
    const facts = Array.isArray(state?.facts) ? state.facts.slice(0, 3).join(' | ') : '';
    const unknowns = Array.isArray(state?.unknowns) ? state.unknowns.slice(0, 2).join(' | ') : '';
    const query = normalizeSearchQuery(state?.search_query);
    const plannedActions = Array.isArray(state?.actions) ? state.actions : [];
    const actionLabel = plannedActions.length > 0
      ? `actions=${plannedActions.map((a) => {
        const tool = String(a?.tool || '?');
        const expected = String(a?.expected_outcome || '').trim();
        return expected ? `${tool}{verify}` : tool;
      }).join('>')}`
      : 'actions=none';
    const budgetText = budget.total > 0 ? `, steps_left=${budget.remaining}/${budget.total}` : '';
    const confMeta = Number.isFinite(stagnationPenalty)
      ? `, progress=${progressPct}%, stagnation_penalty=${stagnationPenalty.toFixed(2)}`
      : '';
    return `reflect: sufficiency=${suff}, confidence=${confidencePct}%${confMeta}, ${actionLabel}${budgetText}${query ? `, search_query=${query}` : ''}${facts ? `, facts=${facts}` : ''}${unknowns ? `, unknowns=${unknowns}` : ''}`;
  },

  _buildBestEffortCompletionFromReflection() {
    const state = this?._reflectionState && typeof this._reflectionState === 'object'
      ? this._reflectionState
      : null;
    if (!state) return null;

    const facts = normalizeStringArray(state.facts, 20, 320);
    const unknowns = normalizeStringArray(state.unknowns, 8, 240);
    const summary = String(state.summary || '').trim().slice(0, 500);
    const answer = String(state.answer || '').trim().slice(0, 5000);
    if (!summary && !answer && facts.length === 0) return null;

    const outSummary = summary || 'Step limit reached; returning best-effort result from collected evidence.';
    const parts = [];
    if (answer) parts.push(answer);
    if (facts.length > 0) {
      parts.push(`Collected findings:\n${facts.map((f) => `- ${f}`).join('\n')}`);
    }
    if (unknowns.length > 0) {
      parts.push(`Potential gaps:\n${unknowns.map((u) => `- ${u}`).join('\n')}`);
    }

    return {
      summary: outSummary,
      answer: parts.join('\n\n').slice(0, 7000),
    };
  },

  _buildFallbackReflectionState(activeTools = [], reason = '') {
    const hasTool = (name) => activeTools.some((t) => t.name === name);
    const goalText = String(this?._goal || '').toLowerCase();
    const goalQuery = normalizeSearchQuery(this?._reflectionState?.search_query) || this._deriveGoalQuery();

    let chosen = 'get_page_text';
    let args = {};
    if (
      hasTool('computer') &&
      typeof this._shouldForceVisionProbe === 'function' &&
      this._shouldForceVisionProbe('read_page')
    ) {
      chosen = 'computer';
      args = { action: 'screenshot' };
    } else if (/(how\s+to\s+spell|spelling)/i.test(goalText) && hasTool('find_text')) {
      chosen = 'find_text';
      args = { query: goalQuery || 'Correct' };
    } else {
      const lastTool = String(this.history.filter((h) => h.type === 'action').slice(-1)[0]?.tool || '');
      // Check _urlToolReadLog to avoid suggesting a read tool that is already hard-blocked
      // for the current URL. Falling back to another read tool on the same URL will also
      // be blocked, creating a loop. Prefer done/navigate when reads are exhausted.
      let currentUrl;
      try {
        const parsed = new URL(String(this?._lastKnownUrl || ''));
        currentUrl = `${parsed.origin}${parsed.pathname}`;
      } catch {
        currentUrl = String(this?._lastKnownUrl || '').split('?')[0].split('#')[0];
      }
      const readLog = this?._urlToolReadLog instanceof Map ? this._urlToolReadLog : new Map();
      const isReadBlocked = (toolName) => currentUrl && readLog.has(`${currentUrl}|${toolName}`);

      if (hasTool('get_page_text') && lastTool !== 'get_page_text' && !isReadBlocked('get_page_text')) {
        chosen = 'get_page_text';
        args = { scope: 'viewport' };
      } else if (hasTool('read_page') && lastTool !== 'read_page' && !isReadBlocked('read_page')) {
        chosen = 'read_page';
        args = {};
      } else if (hasTool('tabs_context') && lastTool !== 'tabs_context') {
        chosen = 'tabs_context';
        args = { action: 'list' };
      } else if (hasTool('computer')) {
        // All read tools are blocked for this URL. Before giving up, check if
        // pagination links are available — clicking to the next page is more
        // productive than force-completing with partial data.
        const paginationHit = typeof this._findPaginationInHistory === 'function'
          ? this._findPaginationInHistory(8)
          : null;
        if (paginationHit) {
          chosen = 'computer';
          args = { action: 'click', target: paginationHit.agentId };
        } else if (hasTool('done')) {
          chosen = 'done';
          args = {};
        } else {
          chosen = activeTools[0]?.name || 'done';
          args = {};
        }
      } else if (hasTool('done')) {
        // All read tools are blocked for this URL — the agent already has the data.
        // Force convergence rather than spinning on blocked reads.
        chosen = 'done';
        args = {};
      } else if (activeTools[0]?.name) {
        chosen = activeTools[0].name;
        args = {};
      }
    }

    return {
      facts: ['Reflection parsing failed; using fallback action to keep task moving.'],
      unknowns: reason ? [String(reason).slice(0, 260)] : ['Need fresh observation to continue.'],
      sufficiency: false,
      confidence: 0.05,
      search_query: goalQuery || '',
      summary: '',
      answer: '',
      actions: [{ tool: chosen, args }],
    };
  },

  async _chatWithReflectionTimeout(messages, tools, options = {}, stage = 'reflection') {
    const configured = Number(this?._reflectionChatSoftTimeoutMs);
    const timeoutMs = Number.isFinite(configured) && configured > 0
      ? Math.min(Math.max(Math.round(configured), 1000), 180000)
      : REFLECTION_CHAT_SOFT_TIMEOUT_MS;
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Reflection ${stage} timed out after ${timeoutMs}ms`);
        err.code = 'REFLECTION_SOFT_TIMEOUT';
        err.timeoutMs = timeoutMs;
        err.stage = stage;
        reject(err);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.provider.chat(messages, tools, options),
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  async _runReflection(step, messages, activeTools = [], stepBudget = null) {
    const prompt = this._buildReflectionPrompt(step, activeTools, stepBudget);
    let lastError = '';
    let lastRaw = '';

    for (let attempt = 0; attempt < REFLECTION_MAX_RETRIES; attempt++) {
      const retrySuffix = attempt === 0
        ? ''
        : '\nPrevious response was invalid JSON or missing required fields. Retry with strict JSON only.';
      const reflectionMessages = this._buildMessagesForLLM([
        ...messages,
        { role: 'user', content: `${prompt}${retrySuffix}` },
      ]);
      const reflectionOptions = { temperature: 0, toolChoice: 'required' };
      const reflectionBudgetCheck = this._precheckTokenBudgetForChat(
        reflectionMessages,
        [REFLECTION_TOOL],
        reflectionOptions,
        { policy: 'fail', label: 'reflection', step },
      );
      if (!reflectionBudgetCheck.ok) {
        return {
          ok: false,
          budgetTerminal: reflectionBudgetCheck.terminal,
          error: reflectionBudgetCheck.reason || 'Token budget pre-check failed for reflection',
        };
      }

      this.metrics.llmCalls += 1;
      let response;
      try {
        response = await this._chatWithReflectionTimeout(
          reflectionMessages,
          [REFLECTION_TOOL],
          reflectionOptions,
          'tool_call',
        );
      } catch (err) {
        if (err?.code === 'REFLECTION_SOFT_TIMEOUT' || err?.code === 'REQUEST_TIMEOUT') {
          lastError = err?.message || 'Reflection request timed out';
          break;
        }
        throw err;
      }
      this._recordUsage(response?.usage);

      let extracted = parseReflectionFromResponse(response);
      lastRaw = extracted.rawText || lastRaw;
      let hasParsedObject = !!(
        extracted.parsed &&
        typeof extracted.parsed === 'object' &&
        !Array.isArray(extracted.parsed)
      );
      let normalized = this._normalizeReflectionState(extracted.parsed, activeTools, stepBudget);
      if (normalized.ok) {
        return {
          ok: true,
          state: normalized.state,
          raw: extracted.rawText || '',
        };
      }

      // Additional local recovery before issuing a second LLM call.
      if (!normalized.ok && extracted.rawText) {
        const localRecovered = parseJsonFromToolWrapper(extracted.rawText)
          || parseLooseKeyValueReflection(extracted.rawText)
          || parseLegacyReflectionLine(extracted.rawText);
        if (localRecovered && typeof localRecovered === 'object' && !Array.isArray(localRecovered)) {
          hasParsedObject = true;
          normalized = this._normalizeReflectionState(localRecovered, activeTools, stepBudget);
          if (normalized.ok) {
            return {
              ok: true,
              state: normalized.state,
              raw: extracted.rawText || '',
            };
          }
        }
      }

      // If we already parsed a structured object but it failed normalization/validation,
      // retry normal reflection on next loop without extra plain-text fallback call.
      if (hasParsedObject) {
        lastError = normalized.error || 'Invalid reflection schema';
        continue;
      }

      // Provider fallback path: ask for strict JSON in plain text (no tools),
      // but only when tool-call parsing failed entirely.
      const plainMessages = this._buildMessagesForLLM([
        ...messages,
        {
          role: 'user',
          content: `${prompt}${retrySuffix}\nReturn the JSON object in assistant text directly. Do not call any tool.`,
        },
      ]);
      const plainOptions = { temperature: 0 };
      const plainBudgetCheck = this._precheckTokenBudgetForChat(
        plainMessages,
        [],
        plainOptions,
        { policy: 'fail', label: 'reflection_plain_fallback', step },
      );
      if (!plainBudgetCheck.ok) {
        return {
          ok: false,
          budgetTerminal: plainBudgetCheck.terminal,
          error: plainBudgetCheck.reason || 'Token budget pre-check failed for reflection fallback',
        };
      }
      this.metrics.llmCalls += 1;
      let plainResponse;
      try {
        plainResponse = await this._chatWithReflectionTimeout(
          plainMessages,
          [],
          plainOptions,
          'plain_fallback',
        );
      } catch (err) {
        if (err?.code === 'REFLECTION_SOFT_TIMEOUT' || err?.code === 'REQUEST_TIMEOUT') {
          lastError = err?.message || 'Reflection plain fallback timed out';
          break;
        }
        throw err;
      }
      this._recordUsage(plainResponse?.usage);

      extracted = parseReflectionFromResponse(plainResponse);
      lastRaw = extracted.rawText || lastRaw;
      normalized = this._normalizeReflectionState(extracted.parsed, activeTools, stepBudget);
      if (normalized.ok) {
        return {
          ok: true,
          state: normalized.state,
          raw: extracted.rawText || '',
        };
      }

      lastError = normalized.error || 'Invalid reflection JSON';
    }

    const fallbackState = this._buildFallbackReflectionState(activeTools, lastError || lastRaw);
    return {
      ok: true,
      state: fallbackState,
      fallback: true,
      error: lastError || 'Reflection retries exhausted',
      raw: lastRaw,
    };
  },
};
