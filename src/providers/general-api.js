import { BaseLLMProvider } from './base.js';

const FALLBACK_ARG_KEYS = new Set([
  'action', 'target', 'x', 'y', 'text', 'direction', 'amount', 'value', 'key', 'modifiers', 'button', 'checked', 'confirm',
  'fromx', 'fromy', 'tox', 'toy', 'query', 'url', 'code', 'condition', 'timeoutms', 'pollms', 'idlems',
  'tabid', 'index', 'main', 'files', 'width', 'height', 'duration', 'summary', 'answer', 'reason',
  'maxdepth', 'maxnodes', 'viewportonly', 'casesensitive', 'wholeword', 'maxresults', 'scrolltofirst', 'wrap',
  'id', 'bypasscache', 'active', 'allow_private', 'method', 'headers', 'body', 'since', 'level',
]);

/**
 * z.ai General API Endpoint Provider — GLM-4.5V
 *
 * API: OpenAI-compatible
 * Vision: YES
 * Tools: YES
 * Docs: https://api.z.ai/api/paas/v4/
 */
export class GeneralApiProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'generalapi';
    this.baseUrl = (config.baseUrl || 'https://api.z.ai/api/paas/v4').replace(/\/+$/, '');
    this.model = config.model || 'GLM-4.5V';
    this.supportsVision = true;
    this.supportsTools = true;
    this.lastError = '';
  }

  async chat(messages, tools = [], options = {}) {
    const body = {
      model: this.model,
      messages: this.sanitizeMessages(messages),
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
      stream: false,
    };

    if (this._shouldDisableThinking(options)) {
      body.thinking = { type: 'disabled' };
    }

    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
      body.tool_choice = options.toolChoice || 'auto';
    }

    let response;
    try {
      response = await this._request('/chat/completions', body);
    } catch (err) {
      this.lastError = this._formatError(err);
      const recovered = this.recoverToolUseFailed(err);
      if (recovered) return recovered;
      throw err;
    }

    this.lastError = '';
    const message = this._sanitizeModelMessage(response.choices?.[0]?.message || {});
    const parsedToolCalls = this.parseToolCalls(response);
    const fallbackToolCalls = this._extractFallbackToolCalls(message);
    const repairedToolCalls = this._mergeToolCalls(parsedToolCalls, fallbackToolCalls);
    const contentText = typeof message.content === 'string' ? message.content : '';
    const reasoningText = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    const effectiveText = contentText || (repairedToolCalls.length === 0 ? reasoningText : '');

    return {
      text: effectiveText,
      toolCalls: repairedToolCalls,
      thinking: reasoningText || null,
      usage: response.usage || {},
      raw: response,
    };
  }

  _shouldDisableThinking(options = {}) {
    if (options?.disableThinking === false) return false;
    const model = String(this.model || '').trim().toLowerCase();
    return /^glm[-_]?4\./i.test(model);
  }

  _sanitizeModelMessage(message = {}) {
    if (!message || typeof message !== 'object') return {};
    const out = { ...message };
    if (typeof out.content === 'string') {
      out.content = this._cleanModelText(out.content);
    }
    if (typeof out.reasoning_content === 'string') {
      out.reasoning_content = this._cleanModelText(out.reasoning_content);
    }
    return out;
  }

  _cleanModelText(value) {
    let text = String(value || '');
    if (!text) return '';

    text = text
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/<\/?think>/gi, ' ')
      .replace(/<\|begin_of_box\|>|<\|end_of_box\|>/gi, ' ')
      .replace(/```[\s\S]*?```/g, (chunk) => chunk.replace(/```/g, ' '))
      .replace(/[\uFEFF\u200B\u200C\u200D]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  _mergeToolCalls(parsedToolCalls, fallbackToolCalls) {
    const parsed = Array.isArray(parsedToolCalls) ? parsedToolCalls : [];
    const fallback = Array.isArray(fallbackToolCalls) ? fallbackToolCalls : [];

    if (parsed.length === 0) return fallback;

    const out = [];
    for (const tc of parsed) {
      const name = String(tc?.name || '').trim();
      const args = (tc?.arguments && typeof tc.arguments === 'object') ? { ...tc.arguments } : {};

      if (this._isLikelyCompleteToolCall(name, args) && !tc?.parseError) {
        out.push({ ...tc, arguments: args });
        continue;
      }

      const candidate = fallback.find((ft) => String(ft?.name || '') === name) || fallback[0] || null;
      if (!candidate) {
        out.push({ ...tc, arguments: args });
        continue;
      }

      const repairedArgs = {
        ...(candidate.arguments && typeof candidate.arguments === 'object' ? candidate.arguments : {}),
        ...args,
      };
      out.push({
        ...tc,
        id: tc?.id || candidate.id,
        name: name || candidate.name,
        arguments: repairedArgs,
      });
    }

    if (out.length === 0 && fallback.length > 0) return fallback;
    return out;
  }

  _isLikelyCompleteToolCall(name, args = {}) {
    const n = String(name || '').trim().toLowerCase();
    const hasText = (value) => String(value || '').trim().length > 0;

    if (!n) return false;
    if (n === 'computer') return hasText(args.action);
    if (n === 'navigate' || n === 'open_tab') return hasText(args.url);
    if (n === 'find' || n === 'find_text') return hasText(args.query);
    if (n === 'javascript') return hasText(args.code);
    if (n === 'wait') return args.duration !== undefined;
    if (n === 'wait_for') return hasText(args.condition) || hasText(args.value) || args.target !== undefined;
    if (n === 'done') return hasText(args.summary) || hasText(args.answer);
    if (n === 'fail') return hasText(args.reason);
    return true;
  }

  _extractFallbackToolCalls(message) {
    if (!message || typeof message !== 'object') return [];
    const parts = [];
    if (typeof message.content === 'string') parts.push(message.content);
    if (typeof message.reasoning_content === 'string') parts.push(message.reasoning_content);
    const raw = parts.join('\n');
    if (!raw) return [];

    const detectedTool = this._detectToolName(raw);
    if (!detectedTool) return [];

    const argPairs = this._extractArgPairs(raw);

    const args = {};
    for (const [key, value] of argPairs) {
      args[key] = value;
    }

    if (Object.keys(args).length === 0) {
      if (detectedTool === 'done') {
        const recoveredDone = this._extractLooseDoneArgs(raw);
        if (recoveredDone.summary) args.summary = recoveredDone.summary;
        if (recoveredDone.answer) args.answer = recoveredDone.answer;
      }
      if (detectedTool === 'fail') {
        const recoveredFail = this._extractLooseFailReason(raw);
        if (recoveredFail) args.reason = recoveredFail;
      }
    }

    const normalized = this._mapLegacyToolCall(detectedTool, args, raw);
    if (!normalized) return [];
    if (!this._isValidRecoveredToolCall(normalized.name, normalized.arguments)) return [];

    return [{
      id: `zai_tc_${Date.now()}_0`,
      name: normalized.name,
      arguments: normalized.arguments,
    }];
  }

  _extractArgPairs(raw) {
    const pairs = [];
    const seen = new Set();
    const pushPair = (keyRaw, valueRaw) => {
      const key = this._cleanArgText(keyRaw).toLowerCase();
      if (!key) return;
      if (!FALLBACK_ARG_KEYS.has(key)) return;
      const value = this._coerceArgValue(this._cleanArgText(valueRaw));
      if (value === '') return;
      const dedupeKey = `${key}:${String(value)}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      pairs.push([key, value]);
    };

    const strictRe = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*(?:```[a-z]+)?\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
    let m;
    while ((m = strictRe.exec(raw)) !== null) {
      pushPair(m[1], m[2]);
    }

    // Handles malformed output like: action</arg_key> ... <arg_value>click</arg_value>
    const looseRe = /([A-Za-z_][A-Za-z0-9_]*)\s*<\/arg_key>\s*(?:```[a-z]+)?\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
    while ((m = looseRe.exec(raw)) !== null) {
      pushPair(m[1], m[2]);
    }

    // Last-resort fallback: only if strict/loose extraction found nothing.
    if (pairs.length === 0) {
      const plainValueRe = /([A-Za-z_][A-Za-z0-9_]*)\s*<\/arg_key>\s*(?:```[a-z]+)?\s*([^<\n][\s\S]*?)(?=<\/tool_call>|<arg_key>|<arg_value>|$)/gi;
      while ((m = plainValueRe.exec(raw)) !== null) {
        pushPair(m[1], m[2]);
      }
    }

    return pairs;
  }

  _detectToolName(raw) {
    const tools = [
      'read_page', 'get_page_text', 'find_text_next', 'find_text_prev', 'find_text', 'find',
      'navigate', 'computer', 'javascript', 'wait_for', 'get_network_requests', 'get_console_logs',
      'switch_frame', 'upload_file', 'list_tabs', 'switch_tab', 'open_tab', 'close_tab',
      'resize_window', 'wait', 'done', 'fail',
      'type', 'click', 'scroll', 'hover', 'select', 'form_input', 'key', 'press_key', 'press_hotkey',
    ];
    const re = new RegExp(`\\b(${tools.join('|')})\\b`, 'i');
    const match = raw.match(re);
    return match ? String(match[1]).toLowerCase() : '';
  }

  _mapLegacyToolCall(name, args, raw = '') {
    const direct = new Set([
      'read_page', 'get_page_text', 'find_text_next', 'find_text_prev', 'find_text', 'find',
      'navigate', 'computer', 'javascript', 'wait_for', 'get_network_requests', 'get_console_logs',
      'switch_frame', 'upload_file', 'list_tabs', 'switch_tab', 'open_tab', 'close_tab',
      'resize_window', 'wait', 'done', 'fail',
    ]);
    const normalizedArgs = { ...args };
    if (normalizedArgs.target === undefined && normalizedArgs.id !== undefined) {
      normalizedArgs.target = normalizedArgs.id;
    }

    if (name === 'computer') {
      const inferredAction = this._inferComputerAction(raw, normalizedArgs);
      if (inferredAction && !normalizedArgs.action) normalizedArgs.action = inferredAction;
      if (normalizedArgs.action === 'key' && !normalizedArgs.key) {
        const keyMatch = String(raw).match(/\b(Enter|Tab|Escape|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|F\d{1,2})\b/i);
        if (keyMatch) normalizedArgs.key = keyMatch[1];
      }
    }

    if (direct.has(name)) {
      return { name, arguments: normalizedArgs };
    }

    if (['type', 'click', 'scroll', 'hover', 'select', 'form_input'].includes(name)) {
      return {
        name: 'computer',
        arguments: {
          action: name,
          ...normalizedArgs,
        },
      };
    }

    if (name === 'key' || name === 'press_key' || name === 'press_hotkey') {
      return {
        name: 'computer',
        arguments: {
          action: 'key',
          ...normalizedArgs,
        },
      };
    }

    return null;
  }

  _inferComputerAction(raw, args = {}) {
    const directAction = String(args.action || '').trim().toLowerCase();
    const allowed = new Set(['click', 'type', 'scroll', 'hover', 'select', 'key', 'drag', 'form_input']);
    if (allowed.has(directAction)) return directAction;

    if (args.key !== undefined) return 'key';
    if (args.text !== undefined) return 'type';

    const source = String(raw || '');
    for (const action of allowed) {
      const re = new RegExp(`\\b${action}\\b`, 'i');
      if (re.test(source)) return action;
    }
    return '';
  }

  _cleanArgText(value) {
    return String(value || '')
      .replace(/<\/?think>/gi, ' ')
      .replace(/```[\s\S]*?```/g, (chunk) => chunk.replace(/```/g, ''))
      .replace(/<\/?.*?>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _coerceArgValue(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const lower = text.toLowerCase();
    if (['undefined', 'null', '[undefined]', '[[undefined]]', '[null]', '[[null]]', 'nan'].includes(lower)) return '';
    if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
    if (/^-?\d+$/.test(text)) return Number(text);
    return text;
  }

  _extractLooseDoneArgs(raw) {
    const text = this._cleanModelLikeText(raw);
    if (!text) return { summary: '', answer: '' };

    let summary = '';
    let answer = '';

    const summaryMatch = text.match(/(?:^|\s)summary\s*[:=-]?\s*([\s\S]*?)(?=(?:\sanswer\s*[:=-]?)|$)/i);
    if (summaryMatch?.[1]) summary = summaryMatch[1].trim();

    const answerMatch = text.match(/(?:^|\s)answer\s*[:=-]?\s*([\s\S]*?)$/i);
    if (answerMatch?.[1]) answer = answerMatch[1].trim();

    // Fallback heuristics when explicit markers are missing but the response is clearly final text.
    if (!answer) {
      const sourceIdx = text.toLowerCase().indexOf('source:');
      if (sourceIdx > 0) {
        answer = text.slice(sourceIdx > 120 ? sourceIdx - 120 : 0).trim();
      }
    }
    if (!summary && answer) {
      summary = answer.slice(0, 180).trim();
    }

    return {
      summary: this._finalizeRecoveredText(summary),
      answer: this._finalizeRecoveredText(answer),
    };
  }

  _extractLooseFailReason(raw) {
    const text = this._cleanModelLikeText(raw);
    if (!text) return '';
    const m = text.match(/(?:^|\s)reason\s*[:=-]?\s*([\s\S]*?)$/i);
    if (m?.[1]) return this._finalizeRecoveredText(m[1]);
    return this._finalizeRecoveredText(text.slice(0, 280));
  }

  _cleanModelLikeText(raw) {
    return String(raw || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/<\/?think>/gi, ' ')
      .replace(/<\|begin_of_box\|>|<\|end_of_box\|>/gi, ' ')
      .replace(/<\/?tool_call>/gi, ' ')
      .replace(/<\/?arg_key>/gi, ' ')
      .replace(/<\/?arg_value>/gi, ' ')
      .replace(/```[\s\S]*?```/g, (chunk) => chunk.replace(/```/g, ' '))
      .replace(/\bdone\b(\s+\bdone\b){1,}/gi, ' done ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _finalizeRecoveredText(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const cleaned = text
      .replace(/^[:\-\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/^(undefined|null|nan)$/i.test(cleaned)) return '';
    return cleaned;
  }

  async isAvailable() {
    if (!this.apiKey) {
      this.lastError = 'API key is missing';
      return false;
    }
    try {
      const url = `${this.baseUrl}/models`;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10000);
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: controller.signal,
        });
        if (!resp.ok) {
          const body = await resp.text();
          this.lastError = `HTTP ${resp.status}: ${body.slice(0, 220)}`;
          return false;
        }

        const data = await resp.json().catch(() => null);
        const modelIds = Array.isArray(data?.data)
          ? data.data.map((m) => m?.id).filter(Boolean)
          : [];
        const requestedModel = String(this.model || '').trim().toLowerCase();
        const hasRequestedModel = modelIds.some((id) => String(id).toLowerCase() === requestedModel);
        if (modelIds.length > 0 && requestedModel && !hasRequestedModel) {
          try {
            await this._request('/chat/completions', {
              model: this.model,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              temperature: 0,
              stream: false,
            });
            this.lastError = '';
            return true;
          } catch (probeErr) {
            const preview = modelIds.slice(0, 6).join(', ');
            const probeMessage = probeErr?.providerError?.message || probeErr?.message || '';
            this.lastError = `Модель "${this.model}" недоступна для вашего плана или эндпоинта. Для Coding Plan используйте https://api.z.ai/api/coding/paas/v4. Доступные модели: ${preview}${probeMessage ? `. API: ${String(probeMessage).slice(0, 160)}` : ''}`;
            return false;
          }
        }

        this.lastError = '';
        return true;
      } finally {
        clearTimeout(tid);
      }
    } catch (err) {
      this.lastError = this._formatError(err);
      return false;
    }
  }

  _formatError(err) {
    if (!err) return 'Unknown error';
    if (err.providerError?.message) return String(err.providerError.message).slice(0, 220);
    if (err.message) return String(err.message).slice(0, 220);
    return String(err).slice(0, 220);
  }
}
