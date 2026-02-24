/**
 * Base LLM Provider Interface
 * All providers implement this.
 */
const RETRY_MAX_ATTEMPTS_429 = 4;
const RETRY_MIN_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 10000;
const RECOVERED_TEXT_MAX_CHARS = 3000;
const TOOL_CALL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class BaseLLMProvider {
  constructor(config = {}) {
    this.name = 'base';
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || '';
    this.model = config.model || '';
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature ?? 0.3;
    this.requestTimeoutMs = config.requestTimeoutMs || 120000;
    this.supportsVision = false;
    this.supportsTools = false;
  }

  /**
   * Send a chat completion request with optional vision and tools.
   * @param {Array} messages - [{role, content}] where content can include images
   * @param {Array} tools - Tool definitions for function calling
   * @param {Object} options - Additional options
   * @returns {Object} {text, toolCalls, usage}
   */
  async chat(messages, tools = [], options = {}) {
    throw new Error('chat() must be implemented by provider');
  }

  /**
   * Check if the provider is available and configured.
   * @returns {boolean}
   */
  async isAvailable() {
    throw new Error('isAvailable() must be implemented');
  }

  /**
   * Build a message with image content (base64 screenshot).
   * @param {string} text - Text prompt
   * @param {string} imageBase64 - Base64-encoded image (without data: prefix)
   * @param {string} mimeType - Image MIME type
   * @returns {Object} Message object in provider's format
   */
  buildVisionMessage(text, imageBase64, mimeType = 'image/png') {
    return {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${imageBase64}`,
          },
        },
        {
          type: 'text',
          text: text,
        },
      ],
    };
  }

  /**
   * Format tools into provider-specific format.
   * Default: OpenAI function calling format.
   */
  formatTools(tools) {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Parse tool calls from response.
   */
  parseToolCalls(response) {
    const message = response.choices?.[0]?.message;
    if (!message?.tool_calls) return [];
    return message.tool_calls.map((tc) => {
      const rawArgs = tc?.function?.arguments ?? {};
      try {
        let parsedArgs = {};
        if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
          parsedArgs = rawArgs;
        } else if (typeof rawArgs === 'string') {
          parsedArgs = JSON.parse(rawArgs || '{}');
        } else {
          parsedArgs = {};
        }
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: parsedArgs,
        };
      } catch (err) {
        void err;
        return {
          id: tc.id,
          name: tc.function?.name || 'unknown',
          arguments: {},
          parseError: 'Invalid tool arguments JSON',
        };
      }
    });
  }

  /**
   * Make HTTP request to the API with timeout and retry.
   */
  async _request(endpoint, body, attempt = 0) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

    if (!resp.ok) {
      const errText = await resp.text();
      if (resp.status === 429 && attempt < RETRY_MAX_ATTEMPTS_429) {
        const waitMs = this._extractRetryDelayMs(resp, errText, attempt);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this._request(endpoint, body, attempt + 1);
      }
      const err = new Error(`${this.name} API error ${resp.status}: ${errText}`);
      err.status = resp.status;
      err.code = resp.status === 429 ? 'RATE_LIMIT_EXCEEDED' : 'PROVIDER_HTTP_ERROR';
      try {
        const parsed = JSON.parse(errText);
        const providerErr = parsed?.error;
        if (providerErr && typeof providerErr === 'object') {
          err.providerError = providerErr;
          if (providerErr.code === 'tool_use_failed') {
            err.code = 'TOOL_USE_FAILED';
          } else if (typeof providerErr.code === 'string') {
            err.providerCode = providerErr.code;
          }
        }
      } catch (err) {
        void err;
        // Non-JSON error body
      }
      throw err;
    }

      return await resp.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(
          `${this.name} API request timed out after ${this.requestTimeoutMs}ms`,
        );
        timeoutErr.code = 'REQUEST_TIMEOUT';
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  _extractRetryDelayMs(resp, errText, attempt) {
    const retryAfterHeader = resp.headers.get('retry-after');
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.max(seconds * 1000, RETRY_MIN_DELAY_MS), RETRY_MAX_DELAY_MS);
      }
    }

    const match = String(errText).match(/try again in\s+([\d.]+)\s*(ms|s)/i);
    if (match) {
      const val = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (Number.isFinite(val)) {
        const ms = unit === 's' ? val * 1000 : val;
        return Math.min(Math.max(ms, RETRY_MIN_DELAY_MS), RETRY_MAX_DELAY_MS);
      }
    }

    // Fallback: bounded exponential backoff.
    return Math.min(1000 * (2 ** attempt), RETRY_MAX_DELAY_MS);
  }

  _isValidRecoveredToolCall(name, args) {
    if (typeof name !== 'string' || !TOOL_CALL_NAME_RE.test(name)) return false;
    if (!isPlainObject(args)) return false;
    return true;
  }

  recoverToolUseFailed(err) {
    if (!err || err.code !== 'TOOL_USE_FAILED') return null;
    const failedGeneration = err.providerError?.failed_generation;
    if (!failedGeneration) return null;

    const raw = String(failedGeneration).trim();

    // Try to parse structured tool calls produced by the model.
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        const toolCalls = calls
          .filter((c) => c && typeof c.name === 'string')
          .map((c, idx) => ({
            id: `recovered_${Date.now()}_${idx}`,
            name: c.name,
            arguments: (c.parameters && typeof c.parameters === 'object') ? c.parameters : {},
          }))
          .filter((c) => this._isValidRecoveredToolCall(c.name, c.arguments));

        if (toolCalls.length > 0) {
          return {
            text: '',
            toolCalls,
            usage: {},
            raw: {
              recovered: true,
              reason: 'tool_use_failed',
            },
          };
        }
      } catch (err) {
        void err;
        // fall through to text recovery
      }
    }

    // If model produced plain text instead of a tool call, return it as assistant text.
    return {
      text: raw.slice(0, RECOVERED_TEXT_MAX_CHARS),
      toolCalls: [],
      usage: {},
      raw: {
        recovered: true,
        reason: 'tool_use_failed',
      },
    };
  }
}
