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
    // Qwen3-VL defaults for agentic no-think mode (less repetition, better tool discipline)
    this.temperature = config.temperature ?? 0.7;
    this.topP = config.topP ?? 0.8;
    this.topK = config.topK ?? 20;
    this.presencePenalty = config.presencePenalty ?? 1.5;
    this.repeatPenalty = config.repeatPenalty ?? 1.0;
    this.numCtx = config.numCtx ?? 16384;
    this.maxTokens = config.maxTokens ?? 256;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 180000;
  }

  async chat(messages, tools = [], options = {}) {
    // Thinking mode keeps wider sampling, no-think mode uses anti-repetition defaults.
    const thinkingEnabled = options?.disableThinking === true ? false : !!options.thinking;
    const temperature = thinkingEnabled ? 1.0 : (options.temperature ?? this.temperature);
    const topP = options.topP ?? (thinkingEnabled ? 0.95 : this.topP);
    const topK = options.topK ?? (thinkingEnabled ? 20 : this.topK);
    const presencePenalty = options.presencePenalty ?? (thinkingEnabled ? 0.0 : this.presencePenalty);
    const repeatPenalty = options.repeatPenalty ?? this.repeatPenalty;
    const numCtx = thinkingEnabled ? 32768 : this.numCtx;
    const maxTokens = options.maxTokens || this.maxTokens;

    const body = {
      model: this.model,
      messages: this.sanitizeMessages(messages),
      max_tokens: maxTokens,
      temperature,
      stream: false,
      // Ollama native think parameter (Ollama ≥0.7, Qwen3-VL supported)
      think: thinkingEnabled,
      // Ollama-specific options: context window + sampling params for Qwen3-VL
      options: {
        num_ctx: numCtx,
        top_k: topK,
        top_p: topP,
        presence_penalty: presencePenalty,
        repeat_penalty: repeatPenalty,
        num_predict: maxTokens,
      },
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
    const contentText = typeof message.content === 'string' ? message.content.trim() : '';
    const thinkingText = typeof message.thinking === 'string' ? message.thinking.trim() : '';
    const reasoningText = typeof message.reasoning === 'string'
      ? message.reasoning.trim()
      : (typeof message.reasoning_content === 'string' ? message.reasoning_content.trim() : '');
    const effectiveText = contentText || reasoningText;
    return {
      text: effectiveText,
      toolCalls: this.parseToolCalls(response),
      // message.thinking is populated when think=true (Ollama ≥0.7)
      thinking: thinkingText || reasoningText || null,
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
