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
    const body = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
      top_p: 0.95,  // Moonshot official recommendation for Kimi K2.5
      top_k: 40,
      presence_penalty: 0,
      frequency_penalty: 0,
      stream: false,
    };

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
