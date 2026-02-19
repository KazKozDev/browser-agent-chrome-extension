import { BaseLLMProvider } from './base.js';

/**
 * Ollama Provider (Local LLM)
 *
 * API: OpenAI-compatible (Ollama ≥0.3)
 * Vision: Depends on model (qwen3-vl, llava, etc.)
 * Tools: Supported with compatible models
 * Price: Free (local compute)
 * Docs: https://github.com/ollama/ollama/blob/main/docs/openai.md
 */
export class OllamaProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'ollama';
    this.baseUrl = config.baseUrl || 'http://localhost:11434/v1';
    this.model = config.model || 'qwen3-vl:8b';
    this.supportsVision = true;
    this.supportsTools = true;
    this.apiKey = 'ollama'; // Ollama doesn't need a key but the header is required
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
      usage: response.usage || {},
      raw: response,
    };
  }

  async isAvailable() {
    try {
      // Check Ollama health endpoint (non-OpenAI)
      const healthUrl = this.baseUrl.replace('/v1', '');
      const resp = await fetch(healthUrl, { method: 'GET' });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available local models.
   */
  async listModels() {
    try {
      const healthUrl = this.baseUrl.replace('/v1', '/api/tags');
      const resp = await fetch(healthUrl);
      const data = await resp.json();
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }
}
