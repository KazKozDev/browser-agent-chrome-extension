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
  console.warn(`[OllamaProvider] ${key}: ${message}`);
}

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
    // Qwen3-VL recommended inference params (no_think / fast mode)
    this.temperature = config.temperature ?? 0.7;
    // Lower context window to 8192 to heavily reduce prompt evaluation time and VRAM usage
    this.numCtx = config.numCtx ?? 8192;
    // Increase timeout specifically for local hardware where generation may be slow
    this.requestTimeoutMs = config.requestTimeoutMs || 300000;
  }

  async chat(messages, tools = [], options = {}) {
    const body = {
      model: this.model,
      messages,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
      stream: false,
      // Ollama-specific options: context window + sampling params for Qwen3-VL
      options: {
        num_ctx: this.numCtx,
        top_k: 20,
        top_p: 0.8,
        repeat_penalty: 1.0,
      },
    };

    if (tools.length > 0) {
      body.tools = this.formatTools(tools);
      if (options.toolChoice) {
        body.tool_choice = options.toolChoice;
      }
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
    } catch (err) {
      debugWarn('isAvailable.requestFailed', err);
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
    } catch (err) {
      debugWarn('listModels.requestFailed', err);
      return [];
    }
  }
}
