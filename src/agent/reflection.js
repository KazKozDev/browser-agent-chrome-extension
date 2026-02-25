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
              },
              required: ['tool', 'args'],
            },
          },
        ],
      },
      next_action: {
        oneOf: [
          { type: 'null' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              tool: { type: 'string' },
              args: { type: 'object' },
            },
            required: ['tool', 'args'],
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
    'list_tabs',
    'scroll',
    'back',
    'forward',
    'reload',
    'close_tab',
    'wait_for',
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

  if (tool === 'switch_frame') {
    const hasSelector = hasValue(args.main) || hasValue(args.target) || hasValue(args.index);
    if (!hasSelector) {
      return 'next_action.args must include one of: main, target, or index for tool "switch_frame"';
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

export const reflectionMethods = {
  _deriveGoalQuery() {
    const goal = String(this?._goal || '').trim();
    if (!goal) return '';

    let q = goal
      .replace(/^task:\s*/i, '')
      .replace(/^(как\s+пишется|как\s+правильно\s+пишется|найди|проверь|узнай)\s+/i, '')
      .replace(/\s+на\s+сайте\s+.+$/i, '')
      .replace(/\s+на\s+gramota\.ru.*$/i, '')
      .replace(/\s+на\s+gramota\s*\.?\s*ru.*$/i, '')
      .replace(/\s+на\s+грамот[аеы]?\s*\.?\s*ру.*$/i, '')
      .replace(/\s+и\s+отправь.*$/i, '')
      .replace(/\s+отправь.*$/i, '')
      .trim();

    q = q.replace(/^["'«“„]+|["'»”‟]+$/g, '').trim();
    if (!q) return '';
    if (q.length > 120) return q.slice(0, 120).trim();
    return q;
  },

  _idsLikelyStale() {
    const items = Array.isArray(this?.history) ? this.history : [];
    if (items.length === 0) return false;

    const navTools = new Set(['navigate', 'back', 'forward', 'reload', 'open_tab', 'switch_tab', 'close_tab', 'switch_frame']);
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

    const factsRatio = Math.min(factsList.length / 8, 1);
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
    const tools = allowedTools.map((t) => t.name).join(', ');
    const budget = normalizeStepBudget(stepBudget);
    const lastAction = Array.isArray(this?.history)
      ? this.history
        .slice()
        .reverse()
        .find((h) => h?.type === 'action' && h.tool !== 'done' && h.tool !== 'fail')
      : null;
    const budgetLines = budget.total > 0
      ? [
        `Step budget: used=${budget.used}, remaining=${budget.remaining}, total=${budget.total}, urgency=${budget.urgency}.`,
        'Hard limit rule: if remaining is critically low, prioritize finishing with the best verified answer rather than starting broad new exploration.',
      ]
      : [];
    const navigateHintLines = (
      lastAction?.tool === 'navigate' &&
      typeof lastAction?.result?.pageText === 'string' &&
      lastAction.result.pageText.trim().length > 0
    )
      ? [
        'NOTE: The last navigate() already returned pageText.',
        'Do NOT call get_page_text immediately if that text already answers the current subgoal.',
      ]
      : [];
    return [
      `Reflection checkpoint for step ${step}.`,
      'Think before you act. Return ONLY strict JSON (no prose, no markdown).',
      'Schema:',
      '{',
      '  "facts": ["..."],',
      '  "unknowns": ["..."],',
      '  "sufficiency": false,',
      '  "confidence": 0.0,',
      '  "search_query": "",',
      '  "summary": "",',
      '  "answer": "",',
      '  "actions": [{"tool": "", "args": {}}],',
      '  "next_action": null',
      '}',
      `Allowed tools: ${tools}`,
      ...budgetLines,
      ...navigateHintLines,
      `Stopping rule: if confidence >= ${REFLECTION_CONFIDENCE_THRESHOLD} and requested subgoals are covered, set sufficiency=true and set actions to null.`,
      `If sufficiency=false, actions is required and must contain 1-${REFLECTION_MAX_ACTIONS_PER_STEP} allowed tool calls.`,
      'If sufficiency=false, every actions[i].tool MUST NOT be "done".',
      'If sufficiency=true, unknowns must be empty and confidence must be >= stopping threshold.',
      'When remaining<=3: avoid long detours and prefer evidence consolidation.',
      'When remaining<=1 and you already have concrete facts: set sufficiency=true with the best available answer.',
      'Confidence rubric: 0.5=partial/weak evidence, 0.8=direct answer from target page, 0.95=multiple consistent direct findings.',
      'Never keep confidence at 0 after a successful observation that produced relevant facts.',
      'If constraints are already satisfied by collected evidence (for example enough items found with required filters), set sufficiency=true and actions=null.',
      'Do not repeat the same tool with the same args unless page state changed.',
      'If current page is a search-results page and repeated reads did not add evidence, the next action must LEAVE the SERP (open/click/navigate to a result).',
      'If one query failed repeatedly, reformulate the query or switch source instead of repeating it.',
      'Set search_query to a concise query string when the task involves search/find/spelling lookup.',
      'For backward compatibility, also mirror the first action in next_action when sufficiency=false; otherwise next_action=null.',
      'Each actions[i].args must include all required parameters for the chosen tool (for example: find.query, type.target+text, navigate.url).',
      'Do not output anything except the JSON object.',
    ].join('\n');
  },

  _normalizeReflectionState(raw, allowedTools = [], stepBudget = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Reflection must be a JSON object' };
    }

    const budget = normalizeStepBudget(stepBudget);
    const allowed = new Set((allowedTools || []).map((t) => t.name));
    const goalText = String(this?._goal || '').toLowerCase();
    const isSpellingGoal = /(как\s+пишется|как\s+правильно|spelling)/i.test(goalText);
    const searchQuery = normalizeSearchQuery(raw.search_query || this?._reflectionState?.search_query);

    const synthesizeNextAction = (factsList = [], unknownList = []) => {
      const factsText = factsList.join(' ').toLowerCase();
      const unknownText = unknownList.join(' ').toLowerCase();
      const goalQuery = searchQuery || this._deriveGoalQuery();

      if (isSpellingGoal && allowed.has('find_text')) {
        return { tool: 'find_text', args: { query: goalQuery || 'Правильно' } };
      }
      if (
        /product|products|товар|цена|price|rating|under\s*\$|cheap|cheapest|headphone|науш/i.test(`${goalText} ${factsText} ${unknownText}`) &&
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
      if (allowed.has('list_tabs')) return { tool: 'list_tabs', args: {} };
      if (allowed.has('extract_structured')) return { tool: 'extract_structured', args: { hint: 'repeating items' } };
      return null;
    };

    const facts = normalizeStringArray(raw.facts, 16, 320);
    const unknowns = normalizeStringArray(raw.unknowns, 12, 320);
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
    const hasPlannedAction = (
      rawPlannedActions.length > 0 ||
      (raw.next_action !== null && raw.next_action !== undefined)
    );
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
        next_action: cappedActions[0] || null,
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
      const normalizedActions = [];
      for (const rawAction of rawPlannedActions) {
        if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
          continue;
        }
        let tool = String(rawAction.tool || '').trim();
        if (!tool) continue;
        let args = rawAction.args;
        if (tool === 'done') {
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
        if (tool === 'type') {
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

        // IDs are page-state bound; after navigation they are likely stale.
        if (
          normalizedActions.length === 0 &&
          tool === 'click' &&
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

        normalizedActions.push({ tool, args: normalizedArgs });
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
      if (raw.next_action !== null && raw.next_action !== undefined) {
        return { ok: false, error: 'sufficiency=true requires next_action to be null' };
      }
      if (!summary && !answer) {
        return { ok: false, error: 'sufficiency=true requires summary or answer' };
      }
      if (unknowns.length > 0) {
        return { ok: false, error: 'sufficiency=true requires unknowns to be empty' };
      }
      if (confidence < REFLECTION_CONFIDENCE_THRESHOLD) {
        return { ok: false, error: `sufficiency=true requires confidence >= ${REFLECTION_CONFIDENCE_THRESHOLD}` };
      }
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
          next_action: null,
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
    if (unknowns.length > 0) {
      calibratedConfidence = Math.min(calibratedConfidence, 0.74);
    }
    if (facts.length === 0) {
      calibratedConfidence = Math.min(calibratedConfidence, 0.4);
    }
    if (sufficiency) {
      calibratedConfidence = Math.max(calibratedConfidence, REFLECTION_CONFIDENCE_THRESHOLD);
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
        next_action: nextAction,
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
    const plannedActions = Array.isArray(state?.actions)
      ? state.actions
      : (state?.next_action ? [state.next_action] : []);
    const actionLabel = plannedActions.length > 0
      ? `actions=${plannedActions.map((a) => String(a?.tool || '?')).join('>')}`
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
      hasTool('screenshot') &&
      typeof this._shouldForceVisionProbe === 'function' &&
      this._shouldForceVisionProbe('read_page')
    ) {
      chosen = 'screenshot';
      args = {};
    } else if (/(как\s+пишется|как\s+правильно|spelling)/i.test(goalText) && hasTool('find_text')) {
      chosen = 'find_text';
      args = { query: goalQuery || 'Правильно' };
    } else if (hasTool('get_page_text')) {
      chosen = 'get_page_text';
      args = { scope: 'viewport' };
    } else if (hasTool('read_page')) {
      chosen = 'read_page';
      args = {};
    } else if (hasTool('list_tabs')) {
      chosen = 'list_tabs';
      args = {};
    } else if (activeTools[0]?.name) {
      chosen = activeTools[0].name;
      args = {};
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
      next_action: { tool: chosen, args },
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
