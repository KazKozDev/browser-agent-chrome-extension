import { BaseLLMProvider } from './base.js';

const WARN_THROTTLE_MS = 10000;
const warnTimestamps = new Map();

function debugWarn(context, err) {
  const key = String(context || 'unknown');
  const now = Date.now();
  const last = warnTimestamps.get(key) || 0;
  if (now - last < WARN_THROTTLE_MS) return;
  warnTimestamps.set(key, now);
  const message = err?.message || String(err || 'unknown error');
  console.warn(`[GroqProvider] ${key}: ${message}`);
}

/**
 * Groq Provider (OpenAI-compatible)
 *
 * API: OpenAI-compatible
 * Vision: Native multimodal (model-dependent)
 * Tools: Function calling supported
 * Price: ~$0.11 / 1M input, ~$0.34 / 1M output
 * Docs: https://console.groq.com/
 */
export class GroqProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'groq';
    this.baseUrl = config.baseUrl || 'https://api.groq.com/openai/v1';
    this.model = config.model || 'meta-llama/llama-4-maverick-17b-128e-instruct';
    this.supportsVision = true;
    this.supportsTools = true;
    this.enableThinking = config.enableThinking ?? false;
    // temperature 0.0 — determinism for agentic tasks (Meta + browser-use recommendation)
    this.temperature = config.temperature ?? 0.0;
  }

  async chat(messages, tools = [], options = {}) {
    const body = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
      stream: false,
    };

    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
      body.tool_choice = options.toolChoice || 'auto';
    }

    if (this.enableThinking) {
      body.extra_body = { enable_thinking: true };
    }

    let response;
    try {
      response = await this._request('/chat/completions', body);
    } catch (err) {
      const recovered = this.recoverToolUseFailed(err);
      if (recovered) return recovered;
      throw err;
    }

    const message = response.choices?.[0]?.message || {};
    return {
      text: message.content || '',
      toolCalls: this.parseToolCalls(response),
      thinking: message.reasoning_content || null,
      usage: response.usage || {},
      raw: response,
    };
  }

  async isAvailable() {
    try {
      const url = `${this.baseUrl}/models`;
      const headers = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 10000);
      try {
        const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        return resp.ok;
      } finally {
        clearTimeout(tid);
      }
    } catch (err) {
      debugWarn('isAvailable.requestFailed', err);
      return false;
    }
  }
}
