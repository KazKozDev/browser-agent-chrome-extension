import { BaseLLMProvider } from './base.js';

/**
 * SiliconFlow Provider — GLM-4.6V (Primary recommended)
 *
 * API: OpenAI-compatible
 * Vision: YES — native multimodal, GUI-agent trained
 * Tools: YES — OpenAI-style function calling
 * Price: ~$0.30 / $0.90 per 1M tokens (in/out)
 * Docs: https://cloud.siliconflow.com/
 */
export class SiliconFlowProvider extends BaseLLMProvider {
    constructor(config = {}) {
        super(config);
        this.name = 'siliconflow';
        this.baseUrl = config.baseUrl || 'https://api.siliconflow.com/v1';
        this.model = config.model || 'zai-org/GLM-4.6V';
        this.supportsVision = true;
        this.supportsTools = true;
        this.lastError = '';
        this._preferredBaseUrl = null;
    }

    _getPrimaryBaseUrl() {
        return this._preferredBaseUrl || this.baseUrl;
    }

    async _requestAtBaseUrl(baseUrl, endpoint, body, attempt = 0) {
        const url = `${baseUrl}${endpoint}`;
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

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
                if (resp.status === 429 && attempt < 4) {
                    const waitMs = this._extractRetryDelayMs(resp, errText, attempt);
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    return this._requestAtBaseUrl(baseUrl, endpoint, body, attempt + 1);
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
                } catch (parseErr) {
                    void parseErr;
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

        let response;
        const primaryBaseUrl = this._getPrimaryBaseUrl();
        try {
            response = await this._requestAtBaseUrl(primaryBaseUrl, '/chat/completions', body);
        } catch (err) {
            this.lastError = this._formatError(err);
            const altBaseUrl = this._getAlternateBaseUrl(primaryBaseUrl);
            if (!altBaseUrl || !this._shouldTryAlternateHost(err)) {
                const recovered = this.recoverToolUseFailed(err);
                if (recovered) return recovered;
                throw err;
            }
            try {
                response = await this._requestAtBaseUrl(altBaseUrl, '/chat/completions', body);
                this._preferredBaseUrl = altBaseUrl;
            } catch (retryErr) {
                const recovered = this.recoverToolUseFailed(retryErr) || this.recoverToolUseFailed(err);
                if (recovered) return recovered;
                throw retryErr;
            }
        }
        this.lastError = '';
        const message = response.choices?.[0]?.message || {};
        const parsedToolCalls = this.parseToolCalls(response);
        const fallbackToolCalls = parsedToolCalls.length > 0
            ? parsedToolCalls
            : this._extractReasoningToolCalls(message);
        return {
            text: message.content || '',
            toolCalls: fallbackToolCalls,
            usage: response.usage || {},
            raw: response,
        };
    }

    _extractReasoningToolCalls(message) {
        if (!message || typeof message !== 'object') return [];

        const rawReasoning = typeof message.reasoning_content === 'string'
            ? message.reasoning_content
            : '';
        if (!rawReasoning) return [];

        const chunks = [];
        const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
        let m;
        while ((m = tagRe.exec(rawReasoning)) !== null) {
            chunks.push(m[1]);
        }
        if (chunks.length === 0 && /^[\[{]/.test(rawReasoning.trim())) {
            // Some variants return raw JSON without tags.
            chunks.push(rawReasoning.trim());
        }

        const calls = [];
        for (const chunk of chunks) {
            const parsed = this._parseReasoningToolChunk(chunk);
            if (!parsed || !this._isValidRecoveredToolCall(parsed.name, parsed.arguments)) continue;
            calls.push({
                id: `sf_tc_${Date.now()}_${calls.length}`,
                name: parsed.name,
                arguments: parsed.arguments || {},
            });
        }
        return calls;
    }

    _parseReasoningToolChunk(chunk) {
        if (!chunk) return null;
        let obj;
        try {
            obj = JSON.parse(chunk);
        } catch (err) {
            void err;
            return null;
        }

        const name = typeof obj.name === 'string' ? obj.name : null;
        if (!name) return null;

        let args = obj.arguments ?? obj.parameters ?? {};
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            } catch (err) {
                void err;
                args = {};
            }
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            args = {};
        }
        return { name, arguments: args };
    }

    async isAvailable() {
        if (!this.apiKey) {
            this.lastError = 'API key is missing';
            return false;
        }

        const primaryBaseUrl = this._getPrimaryBaseUrl();
        const primary = await this._checkModels(primaryBaseUrl);
        if (primary.ok) {
            this.lastError = '';
            return true;
        }

        const altBaseUrl = this._getAlternateBaseUrl(primaryBaseUrl);
        if (!altBaseUrl) {
            this.lastError = primary.error;
            return false;
        }

        const secondary = await this._checkModels(altBaseUrl);
        if (secondary.ok) {
            this._preferredBaseUrl = altBaseUrl;
            this.lastError = '';
            return true;
        }

        this.lastError = secondary.error || primary.error || 'SiliconFlow unavailable';
        return false;
    }

    async _checkModels(baseUrl) {
        try {
            const url = `${baseUrl}/models`;
            const headers = { Authorization: `Bearer ${this.apiKey}` };
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 10000);
            try {
                const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
                if (!resp.ok) {
                    const body = await resp.text();
                    return {
                        ok: false,
                        error: `HTTP ${resp.status}: ${body.slice(0, 220)}`,
                    };
                }

                const data = await resp.json().catch(() => null);
                const models = Array.isArray(data?.data)
                    ? data.data.map((m) => m?.id).filter(Boolean)
                    : [];
                if (models.length > 0 && !models.includes(this.model)) {
                    return {
                        ok: false,
                        error: `Model "${this.model}" is not available for this API key`,
                    };
                }
                return { ok: true };
            } finally {
                clearTimeout(tid);
            }
        } catch (err) {
            return { ok: false, error: this._formatError(err) };
        }
    }

    _shouldTryAlternateHost(err) {
        if (!err) return false;
        if (err.code === 'TOOL_USE_FAILED') return false;
        if (err.code === 'REQUEST_TIMEOUT') return true;
        if (!err.status) return true;
        return err.status !== 429;
    }

    _getAlternateBaseUrl(baseUrl) {
        if (typeof baseUrl !== 'string') return null;
        if (baseUrl.includes('api.siliconflow.com')) {
            return baseUrl.replace('api.siliconflow.com', 'api.siliconflow.cn');
        }
        if (baseUrl.includes('api.siliconflow.cn')) {
            return baseUrl.replace('api.siliconflow.cn', 'api.siliconflow.com');
        }
        return null;
    }

    _formatError(err) {
        if (!err) return 'Unknown error';
        if (err.providerError?.message) return String(err.providerError.message).slice(0, 220);
        if (err.message) return String(err.message).slice(0, 220);
        return String(err).slice(0, 220);
    }
}
