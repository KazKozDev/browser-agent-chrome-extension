import { FireworksProvider } from './fireworks.js';
import { GeneralApiProvider } from './general-api.js';
import { GroqProvider } from './groq.js';
import { OllamaProvider } from './ollama.js';

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
  generalapi: GeneralApiProvider,
  groq: GroqProvider,
  ollama: OllamaProvider,
};

const DEFAULT_CONFIG = {
  primary: 'ollama',
  fallbackOrder: [],
  agentPolicy: {
    replanIntervalSteps: 8,
    replanErrorStreak: 2,
    phaseMinEvidenceScore: 2,
    phaseMinObservations: 1,
    newsMinItems: 3,
    stepMaxTokens: 320,
    planMaxTokens: 256,
    disableThinking: true,
    stepTemperature: 0,
  },
  providers: {
    fireworks: {
      apiKey: '',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/kimi-k2p5',
    },
    generalapi: {
      apiKey: '',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      model: 'GLM-4.5V',
    },
    groq: {
      apiKey: '',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    },
    ollama: {
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3-vl:8b',
      maxTokens: 256,
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      presencePenalty: 1.5,
      repeatPenalty: 1.0,
      numCtx: 16384,
      requestTimeoutMs: 180000,
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

    const legacySiliconFlow = this.config.providers?.siliconflow;
    if (legacySiliconFlow && !this.config.providers?.generalapi) {
      this.config.providers = {
        ...(this.config.providers || {}),
        generalapi: {
          apiKey: legacySiliconFlow.apiKey || '',
          baseUrl: 'https://api.z.ai/api/paas/v4',
          model: legacySiliconFlow.model === 'Qwen/Qwen3-VL-32B-Instruct'
            ? 'GLM-4.5V'
            : (legacySiliconFlow.model || 'GLM-4.5V'),
        },
      };
    }
    if (this.config.primary === 'siliconflow') {
      this.config.primary = 'generalapi';
    }

    // Keep only currently supported providers in config.
    const allowed = new Set(Object.keys(PROVIDER_CLASSES));
    const mergedProviders = { ...DEFAULT_CONFIG.providers, ...(this.config.providers || {}) };
    this.config.providers = Object.fromEntries(
      Object.entries(mergedProviders).filter(([name]) => allowed.has(name)),
    );

    // Normalize provider configs: prevent empty model/baseUrl values from UI edits.
    for (const [name, providerConf] of Object.entries(this.config.providers)) {
      const defaults = DEFAULT_CONFIG.providers[name] || {};
      const currentModel = String(providerConf.model || '').trim();
      if (!currentModel && defaults.model) {
        providerConf.model = defaults.model;
      } else if (currentModel) {
        providerConf.model = currentModel;
      }

      if (typeof providerConf.baseUrl === 'string' || typeof defaults.baseUrl === 'string') {
        const rawUrl = String(providerConf.baseUrl || defaults.baseUrl || '').trim();
        providerConf.baseUrl = rawUrl.replace(/\/+$/, '');
      }
    }

    if (this.config.providers.generalapi) {
      this.config.providers.generalapi.baseUrl = (this.config.providers.generalapi.baseUrl || 'https://api.z.ai/api/paas/v4').replace(/\/+$/, '');
      const currentModel = String(this.config.providers.generalapi.model || '').trim();
      if (!currentModel) {
        this.config.providers.generalapi.model = 'GLM-4.5V';
      } else {
        this.config.providers.generalapi.model = currentModel;
      }
    }

    if (!allowed.has(this.config.primary)) {
      this.config.primary = DEFAULT_CONFIG.primary;
    }

    const incomingPolicy = this.config.agentPolicy || {};
    this.config.agentPolicy = {
      ...DEFAULT_CONFIG.agentPolicy,
      ...(typeof incomingPolicy === 'object' && incomingPolicy ? incomingPolicy : {}),
    };

    // Clamp policy values to safe bounds.
    this.config.agentPolicy.replanIntervalSteps = Math.min(Math.max(Number(this.config.agentPolicy.replanIntervalSteps) || DEFAULT_CONFIG.agentPolicy.replanIntervalSteps, 3), 30);
    this.config.agentPolicy.replanErrorStreak = Math.min(Math.max(Number(this.config.agentPolicy.replanErrorStreak) || DEFAULT_CONFIG.agentPolicy.replanErrorStreak, 1), 6);
    this.config.agentPolicy.phaseMinEvidenceScore = Math.min(Math.max(Number(this.config.agentPolicy.phaseMinEvidenceScore) || DEFAULT_CONFIG.agentPolicy.phaseMinEvidenceScore, 1), 6);
    this.config.agentPolicy.phaseMinObservations = Math.min(Math.max(Number(this.config.agentPolicy.phaseMinObservations) || DEFAULT_CONFIG.agentPolicy.phaseMinObservations, 1), 4);
    this.config.agentPolicy.newsMinItems = Math.min(Math.max(Number(this.config.agentPolicy.newsMinItems) || DEFAULT_CONFIG.agentPolicy.newsMinItems, 2), 8);
    this.config.agentPolicy.stepMaxTokens = Math.min(Math.max(Number(this.config.agentPolicy.stepMaxTokens) || DEFAULT_CONFIG.agentPolicy.stepMaxTokens, 64), 1024);
    this.config.agentPolicy.planMaxTokens = Math.min(Math.max(Number(this.config.agentPolicy.planMaxTokens) || DEFAULT_CONFIG.agentPolicy.planMaxTokens, 64), 1024);
    this.config.agentPolicy.disableThinking = this.config.agentPolicy.disableThinking !== false;
    this.config.agentPolicy.stepTemperature = Math.min(Math.max(Number(this.config.agentPolicy.stepTemperature) || 0, 0), 1);

    if (this.config.providers.ollama) {
      const ollama = this.config.providers.ollama;
      ollama.maxTokens = Math.min(Math.max(Number(ollama.maxTokens) || DEFAULT_CONFIG.providers.ollama.maxTokens, 64), 1024);
      ollama.temperature = Math.min(Math.max(Number(ollama.temperature) || 0, 0), 1);
      ollama.topP = Math.min(Math.max(Number(ollama.topP) || DEFAULT_CONFIG.providers.ollama.topP, 0), 1);
      ollama.topK = Math.min(Math.max(Math.round(Number(ollama.topK) || DEFAULT_CONFIG.providers.ollama.topK), 1), 100);
      ollama.presencePenalty = Math.min(Math.max(Number(ollama.presencePenalty) || DEFAULT_CONFIG.providers.ollama.presencePenalty, 0), 2);
      ollama.repeatPenalty = Math.min(Math.max(Number(ollama.repeatPenalty) || DEFAULT_CONFIG.providers.ollama.repeatPenalty, 0.8), 2);
      ollama.numCtx = Math.min(Math.max(Number(ollama.numCtx) || DEFAULT_CONFIG.providers.ollama.numCtx, 2048), 32768);
      ollama.requestTimeoutMs = Math.min(Math.max(Number(ollama.requestTimeoutMs) || DEFAULT_CONFIG.providers.ollama.requestTimeoutMs, 30000), 600000);
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
      groq: {
        label: 'Llama 4 Maverick',
        pricing: '$0.20 in / $0.60 out',
        costPerMTokenIn: 0.20,
        costPerMTokenOut: 0.60,
        vision: true,
        tools: true,
        signupUrl: 'https://console.groq.com/keys',
        note: 'Fast Groq inference. 17Bx128E MoE, 128K context.',
        tier: 'budget',
      },
      generalapi: {
        label: 'GLM-4.xV',
        pricing: 'Free',
        costPerMTokenIn: 0,
        costPerMTokenOut: 0,
        vision: true,
        tools: true,
        signupUrl: 'https://api.z.ai/',
        note: 'z.ai General API endpoint (OpenAI-compatible). Supports user-selected GLM vision models such as GLM-4.5V / GLM-4.6V-Flash / GLM-4.7-Flash. For coding-only scenarios use https://api.z.ai/api/coding/paas/v4.',
        tier: 'free',
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
