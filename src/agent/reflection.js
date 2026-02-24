import {
  REFLECTION_CONFIDENCE_THRESHOLD,
  REFLECTION_MAX_RETRIES,
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
      summary: { type: 'string' },
      answer: { type: 'string' },
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
    required: ['facts', 'unknowns', 'sufficiency', 'confidence', 'summary', 'answer', 'next_action'],
  },
};

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(Math.max(num, 0), 1);
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
  if (!/\b(?:facts|unknowns|sufficiency|confidence|next)\s*=/i.test(payload)) return null;

  const suffMatch = payload.match(/\bsufficiency\s*=\s*(yes|no|true|false)\b/i);
  const confMatch = payload.match(/\bconfidence\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*%?/i);
  const nextMatch = payload.match(/\bnext\s*=\s*([a-z_][a-z0-9_]*)\b/i);

  const captureField = (name) => {
    const re = new RegExp(`(?:^|,\\s*)${name}\\s*=\\s*([\\s\\S]*?)(?=(?:,\\s*(?:facts|unknowns|sufficiency|confidence|next)\\s*=)|$)`, 'i');
    const m = payload.match(re);
    return m?.[1] ? String(m[1]).trim() : '';
  };

  const splitList = (value) => String(value || '')
    .split(/\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const facts = splitList(captureField('facts'));
  const unknowns = splitList(captureField('unknowns'));
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

  return {
    facts,
    unknowns,
    sufficiency,
    confidence,
    summary: '',
    answer: '',
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

  return null;
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

  _buildReflectionPrompt(step, allowedTools = []) {
    const tools = allowedTools.map((t) => t.name).join(', ');
    return [
      `Reflection checkpoint for step ${step}.`,
      'Think before you act. Return ONLY strict JSON (no prose, no markdown).',
      'Schema:',
      '{',
      '  "facts": ["..."],',
      '  "unknowns": ["..."],',
      '  "sufficiency": false,',
      '  "confidence": 0.0,',
      '  "summary": "",',
      '  "answer": "",',
      '  "next_action": {"tool": "", "args": {}}',
      '}',
      `Allowed tools: ${tools}`,
      `Stopping rule: if confidence >= ${REFLECTION_CONFIDENCE_THRESHOLD} and requested subgoals are covered, set sufficiency=true and set next_action to null.`,
      'If sufficiency=false, next_action is required and must be exactly one allowed tool call.',
      'If sufficiency=false, next_action.tool MUST NOT be "done".',
      'If sufficiency=true, unknowns must be empty and confidence must be >= stopping threshold.',
      'Confidence rubric: 0.5=partial/weak evidence, 0.8=direct answer from target page, 0.95=multiple consistent direct findings.',
      'Never keep confidence at 0 after a successful observation that produced relevant facts.',
      'If constraints are already satisfied by collected evidence (for example enough items found with required filters), set sufficiency=true and next_action=null.',
      'next_action.args must include all required parameters for the chosen tool (for example: find.query, type.target+text, navigate.url).',
      'Do not output anything except the JSON object.',
    ].join('\n');
  },

  _normalizeReflectionState(raw, allowedTools = []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: 'Reflection must be a JSON object' };
    }

    const allowed = new Set((allowedTools || []).map((t) => t.name));
    const currentUrl = String(this?._lastKnownUrl || '').toLowerCase();
    const goalText = String(this?._goal || '').toLowerCase();
    const isAmazonSearch = /amazon\./i.test(currentUrl) && /\/s\?/.test(currentUrl);
    const isSpellingGoal = /(как\s+пишется|как\s+правильно|spelling)/i.test(goalText);

    const synthesizeNextAction = (factsList = [], unknownList = []) => {
      const factsText = factsList.join(' ').toLowerCase();
      const unknownText = unknownList.join(' ').toLowerCase();
      const goalQuery = this._deriveGoalQuery();

      if (isAmazonSearch && allowed.has('extract_structured')) {
        return { tool: 'extract_structured', args: { hint: 'product cards', maxItems: 24 } };
      }
      if (isSpellingGoal && allowed.has('find_text')) {
        return { tool: 'find_text', args: { query: goalQuery || 'Правильно' } };
      }
      if (
        /product|products|товар|цена|price|rating|under\s*\$|cheap|cheapest|headphone|науш/i.test(`${goalText} ${factsText} ${unknownText}`) &&
        allowed.has('extract_structured')
      ) {
        return { tool: 'extract_structured', args: { hint: 'product cards', maxItems: 20 } };
      }
      if (allowed.has('get_page_text')) {
        return {
          tool: 'get_page_text',
          args: isAmazonSearch
            ? { scope: 'selector', selector: 'div.s-result-item[data-asin], div[data-component-type="s-search-result"]' }
            : { scope: 'viewport' },
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
    const confidence = clampConfidence(raw.confidence);
    const summary = String(raw.summary || '').trim().slice(0, 500);
    const answer = String(raw.answer || '').trim().slice(0, 5000);
    const downgradedCompletion = (
      sufficiency &&
      (
        unknowns.length > 0 ||
        confidence < REFLECTION_CONFIDENCE_THRESHOLD ||
        (raw.next_action !== null && raw.next_action !== undefined)
      )
    );
    if (downgradedCompletion) {
      sufficiency = false;
    }

    let nextAction = null;
    if (!sufficiency) {
      if (!raw.next_action || typeof raw.next_action !== 'object' || Array.isArray(raw.next_action)) {
        const synthesized = synthesizeNextAction(facts, unknowns);
        if (synthesized) {
          return {
            ok: true,
            state: {
              facts,
              unknowns,
              sufficiency: false,
              confidence: Math.min(Math.max(confidence, facts.length > 0 ? 0.2 : 0), REFLECTION_CONFIDENCE_THRESHOLD - 0.01),
              summary,
              answer,
              next_action: synthesized,
            },
          };
        }
        if (downgradedCompletion) {
          if (allowed.has('extract_structured')) {
            nextAction = { tool: 'extract_structured', args: { hint: 'product cards' } };
            const argError = validateNextActionArgs(nextAction.tool, nextAction.args);
            if (!argError) {
              return {
                ok: true,
                state: {
                  facts,
                  unknowns,
                  sufficiency: false,
                  confidence: Math.min(confidence, REFLECTION_CONFIDENCE_THRESHOLD - 0.01),
                  summary,
                  answer,
                  next_action: nextAction,
                },
              };
            }
          }
          if (allowed.has('get_page_text')) {
            nextAction = { tool: 'get_page_text', args: { scope: 'viewport' } };
            return {
              ok: true,
              state: {
                facts,
                unknowns,
                sufficiency: false,
                confidence: Math.min(confidence, REFLECTION_CONFIDENCE_THRESHOLD - 0.01),
                summary,
                answer,
                next_action: nextAction,
              },
            };
          }
        }
        return { ok: false, error: 'next_action is required when sufficiency=false' };
      }
      let tool = String(raw.next_action.tool || '').trim();
      if (!tool) {
        return { ok: false, error: 'next_action.tool is required when sufficiency=false' };
      }
      let args = raw.next_action.args;
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
          args = { hint: 'product cards' };
        } else if (allowed.has('get_page_text')) {
          tool = 'get_page_text';
          args = { scope: 'viewport' };
        } else if (allowed.has('read_page')) {
          tool = 'read_page';
          args = {};
        } else {
          return { ok: false, error: 'next_action.tool "done" is invalid when sufficiency=false' };
        }
      }
      if (!allowed.has(tool)) {
        const synthesized = synthesizeNextAction(facts, unknowns);
        if (synthesized) {
          nextAction = synthesized;
          return {
            ok: true,
            state: {
              facts,
              unknowns,
              sufficiency: false,
              confidence: Math.min(Math.max(confidence, facts.length > 0 ? 0.2 : 0), REFLECTION_CONFIDENCE_THRESHOLD - 0.01),
              summary,
              answer,
              next_action: nextAction,
            },
          };
        }
        return { ok: false, error: `next_action.tool "${tool}" is not in allowed tools` };
      }
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        return { ok: false, error: 'next_action.args must be an object' };
      }
      const normalizedArgs = { ...(args || {}) };
      const goalQuery = this._deriveGoalQuery();
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
          return {
            ok: true,
            state: {
              facts,
              unknowns,
              sufficiency: false,
              confidence: Math.min(Math.max(confidence, facts.length > 0 ? 0.2 : 0), REFLECTION_CONFIDENCE_THRESHOLD - 0.01),
              summary,
              answer,
              next_action: synthesized,
            },
          };
        }
        return { ok: false, error: argError };
      }
      nextAction = { tool, args: normalizedArgs };
    } else {
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

    return {
      ok: true,
      state: {
        facts,
        unknowns,
        sufficiency,
        confidence: calibratedConfidence,
        summary,
        answer,
        next_action: nextAction,
      },
    };
  },

  _buildReflectionDigest(state) {
    const confidencePct = Math.round(clampConfidence(state?.confidence) * 100);
    const suff = state?.sufficiency ? 'yes' : 'no';
    const facts = Array.isArray(state?.facts) ? state.facts.slice(0, 3).join(' | ') : '';
    const unknowns = Array.isArray(state?.unknowns) ? state.unknowns.slice(0, 2).join(' | ') : '';
    const nextTool = state?.next_action?.tool ? `next=${state.next_action.tool}` : 'next=none';
    return `reflect: sufficiency=${suff}, confidence=${confidencePct}%, ${nextTool}${facts ? `, facts=${facts}` : ''}${unknowns ? `, unknowns=${unknowns}` : ''}`;
  },

  _buildFallbackReflectionState(activeTools = [], reason = '') {
    const hasTool = (name) => activeTools.some((t) => t.name === name);
    const currentUrl = String(this?._lastKnownUrl || '').toLowerCase();
    const goalText = String(this?._goal || '').toLowerCase();
    const isAmazonSearch = /amazon\./i.test(currentUrl) && /\/s\?/.test(currentUrl);
    const goalQuery = this._deriveGoalQuery();

    let chosen = 'get_page_text';
    let args = {};
    if (
      hasTool('screenshot') &&
      typeof this._shouldForceVisionProbe === 'function' &&
      this._shouldForceVisionProbe('read_page')
    ) {
      chosen = 'screenshot';
      args = {};
    } else if (isAmazonSearch && hasTool('extract_structured')) {
      chosen = 'extract_structured';
      args = { hint: 'product cards', maxItems: 24 };
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
      summary: '',
      answer: '',
      next_action: { tool: chosen, args },
    };
  },

  async _runReflection(step, messages, activeTools = []) {
    const prompt = this._buildReflectionPrompt(step, activeTools);
    let lastError = '';
    let lastRaw = '';

    for (let attempt = 0; attempt < REFLECTION_MAX_RETRIES; attempt++) {
      const retrySuffix = attempt === 0
        ? ''
        : '\nPrevious response was invalid JSON or missing required fields. Retry with strict JSON only.';

      this.metrics.llmCalls += 1;
      const response = await this.provider.chat(
        this._buildMessagesForLLM([
          ...messages,
          { role: 'user', content: `${prompt}${retrySuffix}` },
        ]),
        [REFLECTION_TOOL],
        { temperature: 0, toolChoice: 'required' },
      );
      this._recordUsage(response?.usage);

      let extracted = parseReflectionFromResponse(response);
      lastRaw = extracted.rawText || lastRaw;
      let normalized = this._normalizeReflectionState(extracted.parsed, activeTools);
      if (normalized.ok) {
        return {
          ok: true,
          state: normalized.state,
          raw: extracted.rawText || '',
        };
      }

      // Provider fallback path: ask for strict JSON in plain text (no tools),
      // because some models/providers emit empty or non-standard tool-call payloads.
      this.metrics.llmCalls += 1;
      const plainResponse = await this.provider.chat(
        this._buildMessagesForLLM([
          ...messages,
          {
            role: 'user',
            content: `${prompt}${retrySuffix}\nReturn the JSON object in assistant text directly. Do not call any tool.`,
          },
        ]),
        [],
        { temperature: 0 },
      );
      this._recordUsage(plainResponse?.usage);

      extracted = parseReflectionFromResponse(plainResponse);
      lastRaw = extracted.rawText || lastRaw;
      normalized = this._normalizeReflectionState(extracted.parsed, activeTools);
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
