import { BaseLLMProvider } from './base.js';

/**
 * Fireworks AI Provider — Kimi K2.5 (Primary recommended)
 *
 * API: OpenAI-compatible
 * Vision: YES — native multimodal (unified vision + text)
 * Tools: YES — function calling supported
 * Think: YES — controllable reasoning mode
 * Price: $0.60/1M uncached input · $0.10/1M cached input · $3.00/1M output
 * Docs: https://fireworks.ai/models/fireworks/kimi-k2p5
 */
export class FireworksProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'fireworks';
    this.baseUrl = config.baseUrl || 'https://api.fireworks.ai/inference/v1';
    this.model = config.model || 'accounts/fireworks/models/kimi-k2p5';
    this.supportsVision = true;
    this.supportsTools = true;
    this.temperature = config.temperature ?? 0.6;
    this.maxTokens = config.maxTokens || 32768;
    this.requestTimeoutMs = config.requestTimeoutMs || 300000; // Allow Kimi to "think" without timing out
    this.lastError = '';
  }

  async chat(messages, tools = [], options = {}) {
    const maxTokens = options.maxTokens || this.maxTokens;
    // Fireworks requires stream=true when max_tokens > 4096
    const useStream = maxTokens > 4096;

    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: options.temperature ?? this.temperature,
      top_p: 0.95,  // Moonshot official recommendation for Kimi K2.5
      top_k: 40,
      presence_penalty: 0,
      frequency_penalty: 0,
      stream: useStream,
    };

    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
      body.tool_choice = options.toolChoice || 'auto';
    }

    let response;
    try {
      if (useStream) {
        response = await this._requestStreaming('/chat/completions', body);
      } else {
        response = await this._request('/chat/completions', body);
      }
    } catch (err) {
      this.lastError = this._formatError(err);
      const recovered = this.recoverToolUseFailed(err);
      if (recovered) return recovered;
      throw err;
    }

    this.lastError = '';
    const message = response.choices?.[0]?.message || {};
    return {
      text: message.content || '',
      toolCalls: this.parseToolCalls(response),
      thinking: message.reasoning_content || null,
      usage: response.usage || {},
      raw: response,
    };
  }

  /**
   * Streaming request that accumulates SSE chunks into a single response object,
   * required by Fireworks when max_tokens > 4096.
   */
  async _requestStreaming(endpoint, body) {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        const e = new Error(`fireworks API request timed out after ${this.requestTimeoutMs}ms`);
        e.code = 'REQUEST_TIMEOUT';
        throw e;
      }
      throw err;
    }

    if (!resp.ok) {
      clearTimeout(timeoutId);
      const errText = await resp.text();
      const err = new Error(`${this.name} API error ${resp.status}: ${errText}`);
      err.status = resp.status;
      err.code = 'PROVIDER_HTTP_ERROR';
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.error && typeof parsed.error === 'object') {
          err.providerError = parsed.error;
        }
      } catch (_) { /* non-JSON */ }
      throw err;
    }

    // Accumulate SSE chunks
    let textContent = '';
    let reasoningContent = '';
    const toolCallsMap = {};  // index → {id, name, arguments string}
    let usageData = {};
    let lastChunk = null;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const chunk = JSON.parse(trimmed.slice(6));
            lastChunk = chunk;
            if (chunk.usage) usageData = chunk.usage;
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) textContent += delta.content;
            if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsMap[idx]) {
                  toolCallsMap[idx] = { id: tc.id || '', name: '', arguments: '' };
                }
                if (tc.id) toolCallsMap[idx].id = tc.id;
                if (tc.function?.name) toolCallsMap[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
              }
            }
          } catch (_) { /* skip malformed chunk */ }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }

    // Reconstruct a standard response object
    const toolCallsList = Object.values(toolCallsMap).map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));

    const message = {
      role: 'assistant',
      content: textContent || null,
      reasoning_content: reasoningContent || null,
      tool_calls: toolCallsList.length > 0 ? toolCallsList : undefined,
    };

    return {
      choices: [{ message, finish_reason: lastChunk?.choices?.[0]?.finish_reason || 'stop' }],
      usage: usageData,
    };
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
