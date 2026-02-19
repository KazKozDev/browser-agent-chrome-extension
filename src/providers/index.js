import { GroqProvider } from './groq.js';
import { OllamaProvider } from './ollama.js';
import { SiliconFlowProvider } from './siliconflow.js';

/**
 * Provider Manager
 *
 * Manages multiple LLM providers.
 * Config is stored in chrome.storage.local.
 *
 * Priority: primary only (no automatic fallback)
 */

const PROVIDER_CLASSES = {
  siliconflow: SiliconFlowProvider,
  groq: GroqProvider,
  ollama: OllamaProvider,
};

const DEFAULT_CONFIG = {
  primary: 'groq',
  fallbackOrder: [],
  providers: {
    siliconflow: {
      apiKey: '',
      baseUrl: 'https://api.siliconflow.com/v1',
      model: 'zai-org/GLM-4.6V',
    },
    groq: {
      apiKey: '',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    },
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3-vl:8b',
    },
  },
};

export class ProviderManager {
  constructor() {
    this.providers = {};
    this.config = { ...DEFAULT_CONFIG };
    this.currentProvider = null;
    this.statusCache = { ts: 0, data: null };
  }

  /**
   * Initialize from chrome.storage
   */
  async init() {
    try {
      const stored = await chrome.storage.local.get('providerConfig');
      if (stored.providerConfig) {
        this.config = { ...DEFAULT_CONFIG, ...stored.providerConfig };
      }
    } catch {
      // Running outside extension context (tests)
    }
    this._sanitizeConfig();
    this._buildProviders();
    this.statusCache = { ts: 0, data: null };
    return this;
  }

  _sanitizeConfig() {
    // Fallbacks disabled by design.
    this.config.fallbackOrder = [];

    // Keep only currently supported providers in config.
    const allowed = new Set(Object.keys(PROVIDER_CLASSES));
    const mergedProviders = { ...DEFAULT_CONFIG.providers, ...(this.config.providers || {}) };
    this.config.providers = Object.fromEntries(
      Object.entries(mergedProviders).filter(([name]) => allowed.has(name)),
    );

    // Migrate SiliconFlow endpoint to .com (some keys are region-bound and fail on .cn).
    if (this.config.providers.siliconflow?.baseUrl === 'https://api.siliconflow.cn/v1') {
      this.config.providers.siliconflow.baseUrl = 'https://api.siliconflow.com/v1';
    }
    if (this.config.providers.siliconflow?.model === 'Qwen/Qwen3-VL-32B-Instruct') {
      this.config.providers.siliconflow.model = 'zai-org/GLM-4.6V';
    }

    if (!allowed.has(this.config.primary)) {
      this.config.primary = DEFAULT_CONFIG.primary;
    }
  }

  _buildProviders() {
    this.providers = {};
    for (const [name, ProviderClass] of Object.entries(PROVIDER_CLASSES)) {
      const provConfig = this.config.providers[name] || {};
      this.providers[name] = new ProviderClass(provConfig);
    }
  }

  /**
   * Get the active primary provider.
   */
  async getProvider() {
    const primaryName = this.config.primary;
    const primary = this.providers[primaryName];
    if (!primary) {
      const err = new Error(`Primary provider "${primaryName}" is not configured`);
      err.code = 'PRIMARY_PROVIDER_MISSING';
      throw err;
    }
    if (primaryName !== 'ollama' && !primary?.apiKey) {
      const err = new Error(`Provider "${primaryName}" is not configured. Add API key in settings.`);
      err.code = 'NO_PROVIDER_AVAILABLE';
      throw err;
    }

    // Do not hard-block by health checks here; APIs can be flaky.
    // Real request errors are surfaced from provider.chat() with details.
    this.currentProvider = primary;
    return primary;
  }

  /**
   * High-level chat — uses active primary provider only.
   */
  async chat(messages, tools = [], options = {}) {
    const provider = await this.getProvider();
    try {
      return await provider.chat(messages, tools, options);
    } catch (err) {
      console.warn(`[ProviderManager] ${provider.name} failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Update provider configuration and persist.
   */
  async updateConfig(newConfig) {
    const next = { ...this.config, ...newConfig };
    if (newConfig.providers) {
      next.providers = { ...this.config.providers, ...newConfig.providers };
    }
    this.config = next;
    this._sanitizeConfig();
    this._buildProviders();
    this.statusCache = { ts: 0, data: null };
    try {
      await chrome.storage.local.set({ providerConfig: this.config });
    } catch {
      // Outside extension context
    }
  }

  /**
   * Get status of all providers.
   */
  async getStatus(options = {}) {
    const force = !!options.force;
    const ttlMs = 15000;
    const now = Date.now();
    if (!force && this.statusCache.data && (now - this.statusCache.ts) < ttlMs) {
      return this.statusCache.data;
    }

    const status = {};
    for (const [name, provider] of Object.entries(this.providers)) {
      const hasKey = name === 'ollama' || !!provider.apiKey;
      let available = false;
      if (hasKey) {
        try {
          available = await provider.isAvailable();
        } catch { /* noop */ }
      }
      status[name] = {
        configured: hasKey,
        available,
        model: provider.model,
        isPrimary: name === this.config.primary,
      };
    }
    this.statusCache = { ts: now, data: status };
    return status;
  }

  /**
   * Reference info for UI: pricing and capabilities.
   */
  static getProviderInfo() {
    return {
      siliconflow: {
        label: 'GLM-4.6V',
        pricing: '$0.30 / $0.90 per 1M tokens',
        vision: true,
        tools: true,
        signupUrl: 'https://cloud.siliconflow.com/',
        note: 'SOTA visual model with native tool calls. 131K context.',
        tier: 'recommended',
      },
      groq: {
        label: 'Llama 4 Scout',
        pricing: '$0.11 / $0.34 per 1M tokens',
        vision: true,
        tools: true,
        signupUrl: 'https://console.groq.com/',
        note: 'Budget option. Vision + tools, fast inference.',
        tier: 'budget',
      },
      ollama: {
        label: 'Ollama',
        pricing: 'Free',
        vision: true,
        tools: true,
        signupUrl: 'https://ollama.ai/',
        note: 'Runs locally. Needs ollama serve + model pull.',
        tier: 'free',
      },
    };
  }
}
