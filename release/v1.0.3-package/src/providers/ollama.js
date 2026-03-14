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
    // Normalize baseUrl: always ensure it ends with /v1
    const rawBaseUrl = config.baseUrl || 'http://localhost:11434/v1';
    this.baseUrl = rawBaseUrl.endsWith('/v1') ? rawBaseUrl : rawBaseUrl.replace(/\/$/, '') + '/v1';
    this.model = config.model || 'ministral-3:14b';
    this.supportsVision = config.supportsVision ?? false;
    this.supportsTools = true;
    this.apiKey = ''; // Ollama doesn't require an API key
    // Inference params (override per-model if needed)
    this.temperature = config.temperature ?? 0.7;
    // Lower context window to 4096 to heavily reduce prompt evaluation time and VRAM usage
    this.numCtx = config.numCtx ?? 4096;
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

    // Disable thinking mode for Qwen models (reduces latency, avoids <think> tokens)
    if (this.model.toLowerCase().includes('qwen')) {
      body.think = false;
      body.options.thinking = false;
    }

    let response;
    try {
      response = await this._request('/chat/completions', body);
    } catch (err) {
      if (err.status === 403) {
        throw new Error(
          `Ollama returned 403 Forbidden. Base URL is "${this.baseUrl}" — verify Ollama is running and OLLAMA_ORIGINS is configured. Original: ${err.message}`,
        );
      }
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
