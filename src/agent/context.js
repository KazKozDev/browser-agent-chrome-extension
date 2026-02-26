const HISTORY_SUMMARY_MAX_CHARS = 5000;
const HISTORY_SUMMARY_BATCH_MAX_CHARS = 3500;
const HISTORY_SUMMARY_TRIGGER_PENDING_CHARS = 1200;
const HISTORY_SUMMARY_TRIGGER_PENDING_CHUNKS = 2;
const HISTORY_RAG_MAX_ENTRIES = 24;
const HISTORY_RAG_ENTRY_MAX_CHARS = 320;
const HISTORY_RAG_EMBEDDING_DIM = 96;
const HISTORY_RAG_QUERY_TOP_K = 4;
const HISTORY_RAG_MIN_SCORE = 0.08;
const HISTORY_KEEP_VISION_MESSAGES = 2;
const HISTORY_VISION_SUMMARY_MAX_CHARS = 280;

function tokenizeForEmbedding(text, maxTokens = 120) {
  const src = String(text || '').toLowerCase();
  if (!src) return [];
  let tokens = [];
  try {
    tokens = src.match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  } catch {
    tokens = src.match(/[a-z0-9_-]{2,}/g) || [];
  }
  if (tokens.length > maxTokens) {
    return tokens.slice(0, maxTokens);
  }
  return tokens;
}

function hashToken(token) {
  let hash = 2166136261;
  const input = String(token || '');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildHashedEmbedding(text, dim = HISTORY_RAG_EMBEDDING_DIM) {
  const size = Math.max(Number(dim) || HISTORY_RAG_EMBEDDING_DIM, 16);
  const vec = new Float32Array(size);
  const tokens = tokenizeForEmbedding(text, 160);
  for (const token of tokens) {
    const h = hashToken(token);
    const idx = h % size;
    const sign = ((h >>> 1) & 1) === 0 ? 1 : -1;
    const weight = 1 + Math.min(token.length, 12) / 12;
    vec[idx] += sign * weight;
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-8) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return Array.from(vec);
}

function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += Number(a[i] || 0) * Number(b[i] || 0);
  if (!Number.isFinite(dot)) return 0;
  return dot;
}

function lexicalOverlapScore(queryText, docText) {
  const qTokens = tokenizeForEmbedding(queryText, 80);
  const dTokens = tokenizeForEmbedding(docText, 120);
  if (qTokens.length === 0 || dTokens.length === 0) return 0;
  const q = new Set(qTokens);
  let overlap = 0;
  for (const token of dTokens) {
    if (q.has(token)) overlap += 1;
  }
  return overlap / Math.max(q.size, 1);
}

function safeJsonParse(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      return null;
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function contentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (item && typeof item === 'object') {
        if (typeof item.text === 'string') parts.push(item.text);
        else if (typeof item.content === 'string') parts.push(item.content);
      }
    }
    return parts.join('\n').trim();
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim();
    if (typeof content.content === 'string') return content.content.trim();
  }
  return '';
}

function isVisionContent(content) {
  return Array.isArray(content) && content.some((item) => item?.type === 'image_url');
}

function extractVisionPromptSummary(content, maxChars = HISTORY_VISION_SUMMARY_MAX_CHARS) {
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((item) => item && typeof item === 'object' && item.type === 'text')
    .map((item) => String(item.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  let compact = text
    .replace(/^Here is the screenshot of the current page\.?/i, '')
    .replace(/\bDescribe what you see and decide the next action\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) compact = text;
  if (compact.length > maxChars) {
    compact = `${compact.slice(0, maxChars).trim()}...`;
  }
  return compact;
}

function normalizeHistorySummaryState(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const running = String(base.running || '').trim().slice(0, HISTORY_SUMMARY_MAX_CHARS);
  const pending = Array.isArray(base.pending)
    ? base.pending.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 30)
    : [];
  const ragEntries = Array.isArray(base.ragEntries)
    ? base.ragEntries
      .map((entry) => {
        const text = String(entry?.text || '').trim().replace(/\s+/g, ' ').slice(0, HISTORY_RAG_ENTRY_MAX_CHARS);
        if (!text) return null;
        const id = Number(entry?.id);
        const step = Number(entry?.step);
        return {
          id: Number.isFinite(id) && id > 0 ? Math.floor(id) : null,
          step: Number.isFinite(step) ? Math.floor(step) : null,
          source: String(entry?.source || 'evicted').trim().slice(0, 40) || 'evicted',
          text,
          createdAt: Number.isFinite(Number(entry?.createdAt)) ? Number(entry.createdAt) : 0,
        };
      })
      .filter(Boolean)
      .slice(-HISTORY_RAG_MAX_ENTRIES)
    : [];
  let ragNextId = Number(base.ragNextId);
  if (!Number.isFinite(ragNextId) || ragNextId <= 0) {
    const maxId = ragEntries.reduce((max, item) => Math.max(max, Number(item?.id) || 0), 0);
    ragNextId = maxId + 1;
  }
  return {
    running,
    pending,
    ragEntries,
    ragNextId,
    evictedMessages: Number.isFinite(Number(base.evictedMessages)) ? Number(base.evictedMessages) : 0,
    evictedChars: Number.isFinite(Number(base.evictedChars)) ? Number(base.evictedChars) : 0,
    summarizedChunks: Number.isFinite(Number(base.summarizedChunks)) ? Number(base.summarizedChunks) : 0,
    summarizedMessages: Number.isFinite(Number(base.summarizedMessages)) ? Number(base.summarizedMessages) : 0,
    updatedAt: Number.isFinite(Number(base.updatedAt)) ? Number(base.updatedAt) : 0,
  };
}

export const contextMethods = {
  _estimateUsageCostUsd(promptTokens = 0, completionTokens = 0) {
    const manager = this?.provider;
    const getInfo = manager?.constructor?.getProviderInfo;
    if (typeof getInfo !== 'function') return 0;
    const providerId = String(manager?.config?.primary || this?.metrics?.providerId || '').trim().toLowerCase();
    if (!providerId) return 0;
    const infoMap = getInfo();
    const info = infoMap && typeof infoMap === 'object' ? infoMap[providerId] : null;
    const inRate = Number(info?.costPerMTokenIn || 0);
    const outRate = Number(info?.costPerMTokenOut || 0);
    if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || (inRate <= 0 && outRate <= 0)) return 0;
    const promptCost = (Math.max(Number(promptTokens) || 0, 0) / 1_000_000) * Math.max(inRate, 0);
    const completionCost = (Math.max(Number(completionTokens) || 0, 0) / 1_000_000) * Math.max(outRate, 0);
    return Math.max(promptCost + completionCost, 0);
  },

  _recordUsage(usage) {
    if (!this.metrics || !usage) return;
    if (!this.metrics.tokens || typeof this.metrics.tokens !== 'object') {
      this.metrics.tokens = { prompt: 0, completion: 0, total: 0 };
    }
    const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
    const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
    const total = Number(usage.total_tokens || prompt + completion);
    this.metrics.tokens.prompt += Number.isFinite(prompt) ? prompt : 0;
    this.metrics.tokens.completion += Number.isFinite(completion) ? completion : 0;
    this.metrics.tokens.total += Number.isFinite(total) ? total : 0;

    const estimated = this._estimateUsageCostUsd(prompt, completion);
    if (!this.metrics.cost || typeof this.metrics.cost !== 'object') {
      this.metrics.cost = { estimatedUsd: 0 };
    }
    this.metrics.cost.estimatedUsd = Number(this.metrics.cost.estimatedUsd || 0) + estimated;
    const manager = this?.provider;
    const providerId = String(manager?.config?.primary || this?.metrics?.providerId || '').trim().toLowerCase();
    if (providerId) this.metrics.cost.provider = providerId;
  },

  _estimateTextTokens(text = '') {
    const normalized = String(text || '');
    if (!normalized) return 0;
    // Fast approximation: ~4 chars/token for mixed natural-language + JSON payloads.
    return Math.max(Math.ceil(normalized.length / 4), 1);
  },

  _estimateMessageTokens(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let total = 0;
    for (const msg of messages) {
      total += 4; // per-message framing overhead
      if (!msg || typeof msg !== 'object') continue;
      total += this._estimateTextTokens(msg.role || '');
      if (typeof msg.content === 'string') {
        total += this._estimateTextTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (typeof item === 'string') {
            total += this._estimateTextTokens(item);
            continue;
          }
          if (!item || typeof item !== 'object') continue;
          if (item.type === 'text') {
            total += this._estimateTextTokens(item.text || '');
          } else if (item.type === 'image_url') {
            // Vision payloads are expensive; use a conservative fixed estimate.
            total += 220;
          } else {
            total += this._estimateTextTokens(JSON.stringify(item));
          }
        }
      } else if (msg.content && typeof msg.content === 'object') {
        try {
          total += this._estimateTextTokens(JSON.stringify(msg.content));
        } catch {
          total += 24;
        }
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fnName = String(tc?.function?.name || tc?.name || '');
          total += this._estimateTextTokens(fnName);
          const fnArgs = tc?.function?.arguments;
          if (typeof fnArgs === 'string') total += this._estimateTextTokens(fnArgs);
          else if (fnArgs && typeof fnArgs === 'object') {
            try {
              total += this._estimateTextTokens(JSON.stringify(fnArgs));
            } catch {
              total += 18;
            }
          }
        }
      }
    }
    return Math.max(total, 0);
  },

  _estimateToolSchemaTokens(tools = []) {
    if (!Array.isArray(tools) || tools.length === 0) return 0;
    try {
      return this._estimateTextTokens(JSON.stringify(tools));
    } catch {
      return Math.max(tools.length * 50, 0);
    }
  },

  _estimateExpectedOutputTokens(options = {}, tools = []) {
    const explicitMax = Number(options?.max_tokens ?? options?.maxTokens ?? options?.output_tokens);
    if (Number.isFinite(explicitMax) && explicitMax > 0) {
      return Math.min(Math.max(Math.floor(explicitMax), 64), 4096);
    }
    const providerMax = Number(this?.provider?.currentProvider?.maxTokens || 0);
    if (Number.isFinite(providerMax) && providerMax > 0) {
      return Math.min(Math.max(Math.floor(providerMax * 0.2), 96), 1600);
    }
    // Conservative defaults: tool-required calls usually emit compact JSON.
    if (Array.isArray(tools) && tools.length > 0) {
      return options?.toolChoice === 'required' ? 320 : 420;
    }
    return 600;
  },

  _estimateChatTokenUsage(messages = [], tools = [], options = {}) {
    const inputTokens = this._estimateMessageTokens(messages) + this._estimateToolSchemaTokens(tools) + 16;
    const outputTokens = this._estimateExpectedOutputTokens(options, tools);
    return {
      inputTokens: Math.max(Math.floor(inputTokens), 0),
      outputTokens: Math.max(Math.floor(outputTokens), 0),
      totalTokens: Math.max(Math.floor(inputTokens + outputTokens), 0),
    };
  },

  _precheckTokenBudgetForChat(messages = [], tools = [], options = {}, meta = {}) {
    if (this._budgetLimitsBypassed) {
      return { ok: true, reason: 'budget_limits_bypassed' };
    }

    const tokenLimit = Math.max(Number(this?._resourceBudgets?.maxTotalTokens) || 0, 0);
    if (tokenLimit <= 0) {
      return { ok: true, reason: 'no_token_limit' };
    }
    const usedTokens = Math.max(Number(this?.metrics?.tokens?.total || 0), 0);
    const remainingTokens = Math.max(tokenLimit - usedTokens, 0);
    const estimate = this._estimateChatTokenUsage(messages, tools, options);
    if (estimate.totalTokens <= remainingTokens) {
      return { ok: true, estimate, remainingTokens };
    }

    const label = String(meta?.label || 'llm_request').trim() || 'llm_request';
    const reason = `Token budget pre-check blocked ${label}: estimated request ${estimate.totalTokens} exceeds remaining budget ${remainingTokens} (used ${usedTokens}/${tokenLimit}).`;
    const policy = String(meta?.policy || 'fail');
    if (policy === 'skip') {
      return {
        ok: false,
        skipped: true,
        reason,
        estimate,
        remainingTokens,
        tokenLimit,
        usedTokens,
      };
    }

    if (this.metrics?.budgets && typeof this.metrics.budgets === 'object') {
      this.metrics.budgets.exceeded = {
        kind: 'tokens_preflight',
        label,
        estimate,
        usedTokens,
        remainingTokens,
        limit: tokenLimit,
      };
    }

    const step = Math.max(Number(meta?.step) || 0, 0);
    const bestEffort = this._buildBestEffortCompletionFromReflection?.();
    const hasPartial = !!(bestEffort?.summary || bestEffort?.answer);
    const terminal = this._buildTerminalResult({
      success: false,
      status: 'timeout',
      partialStatus: hasPartial ? 'partial' : 'timeout',
      reason,
      summary: bestEffort?.summary || '',
      answer: bestEffort?.answer || '',
      steps: step,
      suggestion: 'Reduce context size or increase token budget before retrying.',
    });
    return {
      ok: false,
      reason,
      estimate,
      remainingTokens,
      tokenLimit,
      usedTokens,
      terminal,
    };
  },

  _hasScratchpadData() {
    return this._scratchpad && typeof this._scratchpad === 'object' && Object.keys(this._scratchpad).length > 0;
  },

  _buildTaskStateSystemMessage() {
    const objective = this._goal || 'Unknown';
    const steps = this.metrics ? (this.metrics.toolCalls || 0) : 0;

    let facts = 'None yet (use the save_progress tool to retain important data here)';
    if (this._hasScratchpadData()) {
      try {
        const serialized = JSON.stringify(this._scratchpad);
        facts = serialized.length > 4000 ? serialized.slice(0, 4000) + '...[truncated]' : serialized;
      } catch {
        facts = '[Serialization Error]';
      }
    }

    let subGoals = 'No explicit sub-goals detected.';
    if (typeof this._buildSubGoalTrackerText === 'function') {
      try {
        subGoals = this._buildSubGoalTrackerText(6);
      } catch {
        subGoals = 'Sub-goal tracker unavailable due to serialization error.';
      }
    }

    let historySummary = 'None yet.';
    if (typeof this._getHistorySummaryForState === 'function') {
      try {
        historySummary = this._getHistorySummaryForState(2000) || 'None yet.';
      } catch {
        historySummary = 'History summary unavailable due to serialization error.';
      }
    }
    let retrievedHistory = 'None yet.';
    if (typeof this._getRetrievedHistoryForState === 'function') {
      try {
        retrievedHistory = this._getRetrievedHistoryForState(1200, HISTORY_RAG_QUERY_TOP_K) || 'None yet.';
      } catch {
        retrievedHistory = 'Retrieval memory unavailable due to serialization error.';
      }
    }

    return {
      role: 'system',
      content: `[TASK STATE TRACKER]\nObjective: ${objective}\nCompleted steps: ${steps}\nSub-goals:\n${subGoals}\nCompressed history summary:\n${historySummary}\nRelevant archived memory (semantic retrieval):\n${retrievedHistory}\nCollected facts:\n${facts}`,
    };
  },

  _buildMessagesForLLM(messages) {
    const stateMessage = this._buildTaskStateSystemMessage();
    if (!stateMessage) return messages;
    if (messages.length <= 1) return [...messages, stateMessage];
    return [messages[0], stateMessage, ...messages.slice(1)];
  },

  _appendMessage(messages, message) {
    messages.push(message);
    this._compressHistory(messages);
    this._trimMessages(messages);
  },

  _ensureHistorySummaryState() {
    this._historySummary = normalizeHistorySummaryState(this._historySummary);
    return this._historySummary;
  },

  _getHistorySummaryForState(maxChars = 2000) {
    const state = this._ensureHistorySummaryState();
    const cap = Math.max(Number(maxChars) || 2000, 200);
    return String(state.running || '').slice(0, cap);
  },

  _buildHistoryRetrievalQuery() {
    const parts = [String(this._goal || '')];
    const reflection = this._reflectionState && typeof this._reflectionState === 'object' ? this._reflectionState : null;
    if (reflection) {
      if (Array.isArray(reflection.unknowns) && reflection.unknowns.length > 0) {
        parts.push(`Unknowns: ${reflection.unknowns.slice(0, 6).join('; ')}`);
      }
      if (Array.isArray(reflection.facts) && reflection.facts.length > 0) {
        parts.push(`Known facts: ${reflection.facts.slice(0, 6).join('; ')}`);
      }
    }
    if (this._hasScratchpadData()) {
      try {
        parts.push(`Scratchpad keys: ${Object.keys(this._scratchpad || {}).slice(0, 20).join(', ')}`);
      } catch {
        // ignore
      }
    }
    if (Array.isArray(this.history) && this.history.length > 0) {
      const recent = this.history.slice(-6).map((entry) => {
        const tool = String(entry?.tool || entry?.type || '');
        const reason = String(entry?.reason || entry?.error || entry?.content || '').replace(/\s+/g, ' ').slice(0, 140);
        if (!tool && !reason) return '';
        return `${tool}: ${reason}`.trim();
      }).filter(Boolean);
      if (recent.length > 0) parts.push(`Recent actions: ${recent.join(' | ')}`);
    }
    return parts.filter(Boolean).join('\n').slice(0, 2200);
  },

  _indexHistoryChunkForRetrieval(chunk, meta = {}) {
    const state = this._ensureHistorySummaryState();
    const source = String(meta?.source || 'evicted').trim().slice(0, 40) || 'evicted';
    const stepRaw = Number(meta?.step);
    const step = Number.isFinite(stepRaw) ? Math.floor(stepRaw) : null;

    const rawText = String(chunk || '').trim();
    if (!rawText) return;
    const lines = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^\[reflection omitted\]$/i.test(line))
      .slice(0, 10);
    if (lines.length === 0) return;

    const condensed = lines.join(' | ').replace(/\s+/g, ' ').slice(0, HISTORY_RAG_ENTRY_MAX_CHARS);
    if (!condensed) return;
    const fingerprint = condensed.toLowerCase();
    const duplicate = (state.ragEntries || []).some((entry) => String(entry?.text || '').toLowerCase() === fingerprint);
    if (duplicate) return;

    const nextId = Number.isFinite(Number(state.ragNextId)) && Number(state.ragNextId) > 0
      ? Math.floor(Number(state.ragNextId))
      : 1;
    state.ragNextId = nextId + 1;
    state.ragEntries.push({
      id: nextId,
      step,
      source,
      text: condensed,
      createdAt: Date.now(),
    });
    if (state.ragEntries.length > HISTORY_RAG_MAX_ENTRIES) {
      state.ragEntries = state.ragEntries.slice(-HISTORY_RAG_MAX_ENTRIES);
    }
  },

  _retrieveRelevantHistory(limit = HISTORY_RAG_QUERY_TOP_K, maxChars = 1200) {
    const state = this._ensureHistorySummaryState();
    const entries = Array.isArray(state.ragEntries) ? state.ragEntries : [];
    if (entries.length === 0) return [];

    const query = this._buildHistoryRetrievalQuery();
    if (!query.trim()) return [];
    const queryEmbedding = buildHashedEmbedding(query, HISTORY_RAG_EMBEDDING_DIM);

    const scored = entries
      .map((entry) => {
        const text = String(entry?.text || '').trim();
        if (!text) return null;
        const emb = buildHashedEmbedding(text, HISTORY_RAG_EMBEDDING_DIM);
        const semantic = cosineSimilarity(queryEmbedding, emb);
        const lexical = lexicalOverlapScore(query, text);
        const score = (0.75 * semantic) + (0.25 * lexical);
        return {
          entry,
          score: Number.isFinite(score) ? score : 0,
        };
      })
      .filter((item) => item && item.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return [];

    const out = [];
    const cap = Math.max(Number(maxChars) || 1200, 200);
    const topK = Math.max(Number(limit) || HISTORY_RAG_QUERY_TOP_K, 1);
    let usedChars = 0;
    for (const item of scored) {
      if (out.length >= topK) break;
      if (item.score < HISTORY_RAG_MIN_SCORE && out.length > 0) break;
      const step = Number(item.entry?.step);
      const stepLabel = Number.isFinite(step) && step >= 0 ? `step ${step}` : 'archived';
      const source = String(item.entry?.source || 'evicted').slice(0, 20);
      const line = `- (${stepLabel}, ${source}, score=${item.score.toFixed(2)}) ${String(item.entry?.text || '').slice(0, HISTORY_RAG_ENTRY_MAX_CHARS)}`;
      if (usedChars + line.length > cap && out.length > 0) break;
      usedChars += line.length + 1;
      out.push(line);
    }
    return out;
  },

  _getRetrievedHistoryForState(maxChars = 1200, limit = HISTORY_RAG_QUERY_TOP_K) {
    const lines = this._retrieveRelevantHistory(limit, maxChars);
    if (!Array.isArray(lines) || lines.length === 0) return '';
    return lines.join('\n').slice(0, Math.max(Number(maxChars) || 1200, 200));
  },

  _formatMessageForHistorySummary(msg = {}) {
    const role = String(msg?.role || 'unknown');
    if (role === 'assistant') {
      const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (hasToolCalls) {
        const tools = msg.tool_calls.map((tc) => String(tc?.function?.name || tc?.name || '?')).slice(0, 4).join(', ');
        return `assistant(tool_calls): ${tools}`;
      }
      const text = content.trim().replace(/\s+/g, ' ');
      return text ? `assistant: ${text.slice(0, 240)}` : 'assistant: [empty]';
    }
    if (role === 'tool') {
      const body = String(msg?.content || '').trim().replace(/\s+/g, ' ');
      return `tool: ${body.slice(0, 320)}`;
    }
    if (role === 'user') {
      if (Array.isArray(msg?.content)) return 'user: [vision message omitted]';
      const text = String(msg?.content || '').trim().replace(/\s+/g, ' ');
      return `user: ${text.slice(0, 240)}`;
    }
    const text = String(msg?.content || '').trim().replace(/\s+/g, ' ');
    return `${role}: ${text.slice(0, 220)}`;
  },

  _captureEvictedMessagesForSummary(evictedMessages = []) {
    if (!Array.isArray(evictedMessages) || evictedMessages.length === 0) return;
    let state = this._ensureHistorySummaryState();
    const lines = evictedMessages
      .map((msg) => this._formatMessageForHistorySummary(msg))
      .filter(Boolean);
    if (lines.length === 0) return;

    const chunk = lines.join('\n').slice(0, HISTORY_SUMMARY_BATCH_MAX_CHARS);
    if (!chunk) return;
    state.pending.push(chunk);
    const latestStep = Number(this?.history?.[this.history.length - 1]?.step);
    this._indexHistoryChunkForRetrieval(chunk, {
      source: 'evicted_turn',
      step: Number.isFinite(latestStep) ? latestStep : null,
    });
    state = this._ensureHistorySummaryState();
    if (state.pending.length > 30) {
      state.pending = state.pending.slice(-30);
    }
    state.evictedMessages += evictedMessages.length;
    state.evictedChars += chunk.length;
  },

  async _maybeSummarizeHistory(_messages = [], step = 0, force = false) {
    let state = this._ensureHistorySummaryState();
    if (!Array.isArray(state.pending) || state.pending.length === 0) return { summarized: false, reason: 'no_pending_chunks' };

    const pendingChars = state.pending.reduce((sum, item) => sum + String(item || '').length, 0);
    const shouldRun = force ||
      state.pending.length >= HISTORY_SUMMARY_TRIGGER_PENDING_CHUNKS ||
      pendingChars >= HISTORY_SUMMARY_TRIGGER_PENDING_CHARS;
    if (!shouldRun) {
      return { summarized: false, reason: 'below_threshold' };
    }

    const chunks = [];
    let usedChars = 0;
    while (state.pending.length > 0 && chunks.length < 3) {
      const next = String(state.pending[0] || '');
      if (!next) {
        state.pending.shift();
        continue;
      }
      if (chunks.length > 0 && usedChars + next.length > HISTORY_SUMMARY_BATCH_MAX_CHARS) break;
      chunks.push(next);
      usedChars += next.length;
      state.pending.shift();
    }
    if (chunks.length === 0) return { summarized: false, reason: 'empty_batch' };

    const previousSummary = String(state.running || '');
    const batchText = chunks.join('\n---\n').slice(0, HISTORY_SUMMARY_BATCH_MAX_CHARS);
    const fallbackSummary = [previousSummary, `Step ${step}: ${batchText}`]
      .filter(Boolean)
      .join('\n')
      .slice(-HISTORY_SUMMARY_MAX_CHARS);

    let mergedSummary = '';
    const canUseLLM = typeof this?.provider?.chat === 'function';
    if (canUseLLM) {
      const precheck = this._precheckTokenBudgetForChat(
        this._buildMessagesForLLM([
          {
            role: 'system',
            content: 'You compress browseagent history. Return strict JSON: {"summary": "..."} only. Keep concrete facts, blockers, URLs, decisions, and unresolved unknowns. Max 1200 chars.',
          },
          {
            role: 'user',
            content: `Objective: ${String(this._goal || '').slice(0, 500)}\nExisting summary:\n${previousSummary || '[none]'}\n\nNew evicted chunk:\n${batchText}\n\nUpdate the running summary without losing prior critical facts.`,
          },
        ]),
        [],
        { temperature: 0 },
        { policy: 'skip', label: 'history_summary', step },
      );
      if (!precheck.ok) {
        state = this._ensureHistorySummaryState();
        state.pending = [...chunks, ...(Array.isArray(state.pending) ? state.pending : [])].slice(0, 30);
        return { summarized: false, reason: 'budget_predicted_exceed' };
      }
      try {
        if (this.metrics && Number.isFinite(Number(this.metrics.llmCalls))) {
          this.metrics.llmCalls += 1;
        }
        const response = await this.provider.chat(
          this._buildMessagesForLLM([
            {
              role: 'system',
              content: 'You compress browseagent history. Return strict JSON: {"summary": "..."} only. Keep concrete facts, blockers, URLs, decisions, and unresolved unknowns. Max 1200 chars.',
            },
            {
              role: 'user',
              content: `Objective: ${String(this._goal || '').slice(0, 500)}\nExisting summary:\n${previousSummary || '[none]'}\n\nNew evicted chunk:\n${batchText}\n\nUpdate the running summary without losing prior critical facts.`,
            },
          ]),
          [],
          { temperature: 0 },
        );
        this._recordUsage(response?.usage);

        const rawText = contentToText(response?.text)
          || contentToText(response?.raw?.choices?.[0]?.message?.content)
          || '';
        const parsed = safeJsonParse(rawText);
        const candidate = parsed && typeof parsed.summary === 'string'
          ? parsed.summary
          : rawText;
        mergedSummary = String(candidate || '').trim();
      } catch {
        mergedSummary = '';
      }
    }

    if (!mergedSummary) {
      mergedSummary = fallbackSummary;
    }
    // _buildMessagesForLLM() may re-normalize history summary object,
    // so re-acquire the current state reference before writing.
    state = this._ensureHistorySummaryState();
    mergedSummary = mergedSummary.replace(/\s+\n/g, '\n').trim();
    if (mergedSummary.length > HISTORY_SUMMARY_MAX_CHARS) {
      mergedSummary = mergedSummary.slice(-HISTORY_SUMMARY_MAX_CHARS);
    }
    state.running = mergedSummary;
    this._indexHistoryChunkForRetrieval(mergedSummary, {
      source: 'running_summary',
      step,
    });
    state = this._ensureHistorySummaryState();
    state.summarizedChunks += chunks.length;
    state.summarizedMessages += chunks.reduce((sum, c) => sum + Math.max(c.split('\n').length, 1), 0);
    state.updatedAt = Date.now();
    return { summarized: true, consumedChunks: chunks.length };
  },

  _compressHistory(messages) {
    if (messages.length <= 4) return;

    let assistantTurns = 0;
    let keptVisionMessages = 0;
    // Iterate from newest to oldest
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        if (
          assistantTurns >= 3 &&
          typeof msg.content === 'string' &&
          msg.content.startsWith('[REFLECTION]')
        ) {
          msg.content = '[reflection omitted]';
        }
        assistantTurns++;
        continue;
      }

      // Keep only the N newest vision messages. Older screenshots are replaced with compact summaries
      // to reduce token costs while preserving useful context.
      if (msg.role === 'user' && isVisionContent(msg.content)) {
        keptVisionMessages += 1;
        const shouldOmit = keptVisionMessages > HISTORY_KEEP_VISION_MESSAGES || assistantTurns >= 2;
        if (shouldOmit) {
          const summary = extractVisionPromptSummary(msg.content);
          const compact = summary
            ? `Screenshot omitted from history to save context. Snapshot summary: ${summary}`
            : 'Screenshot omitted from history to save context. Snapshot already analyzed.';
          msg.content = compact;
          const stepRaw = Number(this?.history?.[this.history.length - 1]?.step);
          this._indexHistoryChunkForRetrieval(compact, {
            source: 'vision_summary',
            step: Number.isFinite(stepRaw) ? Math.floor(stepRaw) : null,
          });
        }
        continue;
      }
    }
  },

  /**
   * Trim conversation messages while preserving complete turns.
   * A turn = assistant(tool_calls) + all its tool results (+ optional vision user message).
   * Never splits a turn in the middle.
   */
  _trimMessages(messages) {
    const keepHead = 2; // system + initial user task
    const maxTotal = this.maxConversationMessages;
    if (messages.length <= maxTotal) return;

    let removeEnd = keepHead;
    const target = messages.length - maxTotal;
    let removed = 0;

    while (removed < target && removeEnd < messages.length - 2) {
      const msg = messages[removeEnd];

      if (msg.role === 'assistant' && msg.tool_calls) {
        // Find the end of this turn: assistant + tool results + optional vision
        let groupEnd = removeEnd + 1;
        while (groupEnd < messages.length) {
          const next = messages[groupEnd];
          if (next.role === 'tool') {
            groupEnd++;
          } else if (next.role === 'user' && Array.isArray(next.content)) {
            // Vision message attached to this turn
            groupEnd++;
          } else {
            break;
          }
        }
        const groupSize = groupEnd - removeEnd;
        removed += groupSize;
        removeEnd = groupEnd;
      } else {
        // Single message (user or standalone assistant)
        removed++;
        removeEnd++;
      }
    }

    if (removeEnd > keepHead) {
      const evicted = messages.slice(keepHead, removeEnd);
      this._captureEvictedMessagesForSummary(evicted);
      messages.splice(keepHead, removeEnd - keepHead);
    }
  },

  _finalizeMetrics() {
    if (!this.metrics) return null;
    this.metrics.finishedAt = Date.now();
    this.metrics.durationMs = this.metrics.finishedAt - this.metrics.startedAt;
    const normTotal = Number(this.metrics?.normalization?.total || 0);
    const normChanged = Number(this.metrics?.normalization?.changed || 0);
    const invalidTotal = Number(this.metrics?.invalidActions?.total || 0);
    const invalidRepeated = Number(this.metrics?.invalidActions?.repeated || 0);
    const doneAttempts = Number(this.metrics?.completion?.doneAttempts || 0);
    const doneRejected = Number(this.metrics?.completion?.rejectedNoSubstance || 0);
    const stepLimitFailed = Number(this.metrics?.stepLimit?.failed || 0);
    this.metrics.rates = {
      distortedQueryShare: normTotal > 0 ? normChanged / normTotal : 0,
      repeatedInvalidActionShare: invalidTotal > 0 ? invalidRepeated / invalidTotal : 0,
      doneWithoutSubstantiveFactsShare: doneAttempts > 0 ? doneRejected / doneAttempts : 0,
      stepLimitFailShare: stepLimitFailed > 0 ? 1 : 0,
    };
    const alerts = [];
    if (this.metrics.rates.distortedQueryShare > 0.2) {
      alerts.push({
        code: 'HIGH_QUERY_DISTORTION',
        severity: 'warning',
        message: 'High ratio of changed user queries after normalization.',
      });
    }
    if (this.metrics.rates.repeatedInvalidActionShare > 0.3) {
      alerts.push({
        code: 'INVALID_ACTION_LOOP_RISK',
        severity: 'warning',
        message: 'Repeated invalid actions are occurring too frequently.',
      });
    }
    if (this.metrics.rates.doneWithoutSubstantiveFactsShare > 0.1) {
      alerts.push({
        code: 'EMPTY_DONE_RISK',
        severity: 'warning',
        message: 'High ratio of done attempts rejected for missing substantive facts.',
      });
    }
    if (this.metrics.rates.stepLimitFailShare > 0) {
      alerts.push({
        code: 'STEP_LIMIT_FAIL',
        severity: 'error',
        message: 'Task failed by step limit before verified completion.',
      });
    }
    this.metrics.alerts = alerts;
    return this.metrics;
  },

  _serializeToolResultForLLM(toolName, result) {
    let safe = result;

    // Never feed base64 blobs into conversation history.
    if (toolName === 'screenshot' && safe?.imageBase64) {
      safe = {
        ...safe,
        imageBase64: `[omitted base64 image, ${safe.imageBase64.length} chars]`,
      };
    }

    // Compress very large read_page payloads before appending to model context.
    if (toolName === 'read_page' && safe?.tree) {
      safe = this._compressReadPageForLLM(safe);
    }

    // Keep structured extraction compact and deterministic for reflection.
    if (toolName === 'extract_structured' && safe && Array.isArray(safe.items)) {
      const compactItems = safe.items.slice(0, 20).map((item) => ({
        title: String(item?.title || '').slice(0, 220),
        price_value: Number.isFinite(Number(item?.price_value)) ? Number(item.price_value) : null,
        price_currency: String(item?.price_currency || '').slice(0, 4),
        rating_value: Number.isFinite(Number(item?.rating_value)) ? Number(item.rating_value) : null,
        rating_count: Number.isFinite(Number(item?.rating_count)) ? Number(item.rating_count) : null,
        url: String(item?.url || '').slice(0, 260),
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
      }));
      safe = {
        success: safe.success !== false,
        page_url: safe.page_url || safe.url || this._lastKnownUrl || '',
        title: String(safe.title || '').slice(0, 180),
        count: Number(safe.count || compactItems.length),
        returned: compactItems.length,
        items: compactItems,
        compactedForModel: true,
      };
    }

    // Inject current URL into every tool result so the model always knows where it is.
    // Skip tools that already return url in their result.
    const hasUrl = safe && (safe.url || safe.pageUrl || safe.finalUrl);
    if (!hasUrl && this._lastKnownUrl) {
      safe = { ...safe, _currentUrl: this._lastKnownUrl };
    }

    let serialized = '';
    try {
      serialized = JSON.stringify(safe);
    } catch {
      return JSON.stringify({ error: 'Tool result serialization failed' });
    }

    const maxChars = 10000;
    if (serialized.length <= maxChars) return serialized;
    return JSON.stringify({
      truncated: true,
      originalLength: serialized.length,
      excerpt: serialized.slice(0, maxChars),
    });
  },

  _compressReadPageForLLM(result) {
    const maxNameLen = 60;
    const maxDepth = 10;
    const maxNodes = 180;
    const maxChildren = 20;
    let seen = 0;

    const visit = (node, depth = 0) => {
      if (!node || typeof node !== 'object') return null;
      if (depth > maxDepth || seen >= maxNodes) return null;
      seen++;

      const out = {};
      if (node.id !== undefined) out.id = node.id;
      if (node.role) out.role = node.role;
      if (node.name) out.name = String(node.name).slice(0, maxNameLen);
      if (node.tag) out.tag = node.tag;
      if (node.state) out.state = node.state;

      if (Array.isArray(node.children) && node.children.length > 0) {
        const children = [];
        for (const child of node.children) {
          if (children.length >= maxChildren || seen >= maxNodes) break;
          const c = visit(child, depth + 1);
          if (c) children.push(c);
        }
        if (children.length > 0) out.children = children;
      }

      return out;
    };

    return {
      url: result.url,
      title: result.title,
      interactiveCount: result.interactiveCount,
      nodeCount: result.nodeCount,
      tree: visit(result.tree),
      truncatedForModel: true,
    };
  },
};
