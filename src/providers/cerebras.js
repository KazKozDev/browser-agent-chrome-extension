import { BaseLLMProvider } from './base.js';

/**
 * Cerebras Provider — GLM-4.7 (Fast fallback, text-only)
 *
 * API: OpenAI-compatible
 * Vision: NO — text-only + accessibility tree
 * Tools: YES — best-in-class tool-calling
 * Speed: 673 tokens/sec (fastest)
 * Price: ~$0.40 / 1M input, ~$1.50 / 1M output
 * Docs: https://cloud.cerebras.ai/
 */
export class CerebrasProvider extends BaseLLMProvider {
    constructor(config = {}) {
        super(config);
        this.name = 'cerebras';
        this.baseUrl = config.baseUrl || 'https://api.cerebras.ai/v1';
        this.model = config.model || 'glm-4.7';
        this.supportsVision = false; // text-only
        this.supportsTools = true;
    }

    async chat(messages, tools = [], options = {}) {
        // Filter vision content from messages for text-only model
        const cleanMessages = messages.map((msg) => {
            if (Array.isArray(msg.content)) {
                const textParts = msg.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join('\n');
                return { ...msg, content: textParts || '[image content not available for text-only model]' };
            }
            return msg;
        });

        const body = {
            model: this.model,
            messages: cleanMessages,
            max_tokens: options.maxTokens || this.maxTokens,
            temperature: options.temperature ?? this.temperature,
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
        } catch {
            return false;
        }
    }
}
