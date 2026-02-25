import { FireworksProvider } from './fireworks.js';
import { GroqProvider } from './groq.js';
import { OllamaProvider } from './ollama.js';
import { SiliconFlowProvider } from './siliconflow.js';
import { XAIProvider } from './xai.js';

/**
 * Provider Manager
 *
 * Manages multiple LLM providers.
 * Config is stored in chrome.storage.local.
 *
 * Priority: primary only (no automatic fallback)
 */

const PROVIDER_CLASSES = {
  fireworks: FireworksProvider,
  siliconflow: SiliconFlowProvider,
  xai: XAIProvider,
  groq: GroqProvider,
  ollama: OllamaProvider,
};

const DEFAULT_CONFIG = {
  primary: 'ollama',
  fallbackOrder: [],
  providers: {
    fireworks: {
      apiKey: '',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/kimi-k2p5',
    },
    siliconflow: {
      apiKey: '',
      baseUrl: 'https://api.siliconflow.com/v1',
      model: 'zai-org/GLM-4.6V',
    },
    xai: {
      apiKey: '',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4-1-fast-non-reasoning',
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

const WARN_THROTTLE_MS = 10000;
const warnTimestamps = new Map();

function debugWarn(context, err) {
  const key = String(context || 'unknown');
  const now = Date.now();
  const last = warnTimestamps.get(key) || 0;
  if (now - last < WARN_THROTTLE_MS) return;
  warnTimestamps.set(key, now);
  const message = err?.message || String(err || 'unknown error');
  console.warn(`[ProviderManager] ${key}: ${message}`);
}

function shouldLogStorageWarning() {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.local;
}

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
    } catch (err) {
      if (shouldLogStorageWarning()) {
        debugWarn('init.loadProviderConfig', err);
      }
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
    if (this.config.providers.groq?.model === 'meta-llama/llama-4-maverick-17b-128e-instruct') {
      this.config.providers.groq.model = 'meta-llama/llama-4-scout-17b-16e-instruct';
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
    } catch (err) {
      if (shouldLogStorageWarning()) {
        debugWarn('updateConfig.persistProviderConfig', err);
      }
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
        } catch (err) {
          debugWarn(`getStatus.isAvailable.${name}`, err);
        }
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
      fireworks: {
        label: 'Kimi K2.5',
        pricing: '$0.60 in / $3.00 out',
        costPerMTokenIn: 0.60,
        costPerMTokenOut: 3.00,
        vision: true,
        tools: true,
        signupUrl: 'https://fireworks.ai/account/api-keys',
        note: 'Flagship agentic model with thinking mode. 262K context.',
        tier: 'recommended',
      },
      xai: {
        label: 'Grok 4.1 Fast',
        pricing: 'See xAI pricing',
        costPerMTokenIn: 0,
        costPerMTokenOut: 0,
        vision: true,
        tools: true,
        signupUrl: 'https://console.x.ai/',
        note: 'Model: grok-4-1-fast-non-reasoning. API base: https://api.x.ai/v1.',
        tier: 'budget',
      },
      ollama: {
        label: 'Ollama',
        pricing: 'Free',
        costPerMTokenIn: 0,
        costPerMTokenOut: 0,
        vision: true,
        tools: true,
        signupUrl: 'https://ollama.ai/',
        note: 'Fully private, no API key needed. Requires Ollama serve + model pull.',
        tier: 'free',
      },
    };
  }
}
