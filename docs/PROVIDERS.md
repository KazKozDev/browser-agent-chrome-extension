# Provider Setup

BrowseAgent supports several LLM providers through an OpenAI-compatible interface.
Configure your provider in the extension **Settings** panel.

---

## Recommended: Z.AI

Best balance of capability and cost for browser automation tasks.

1. Get an API key at [z.ai](https://z.ai/).
2. In **Settings**, select the **Recommended** tier.
3. Set model: `glm-4.6v`
4. Set base URL: `https://api.z.ai/api/paas/v4`

---

## Budget: xAI (Grok)

Good choice for cost-sensitive or high-volume usage.

1. Get an API key at [console.x.ai](https://console.x.ai/).
2. In **Settings**, select the **Budget** tier.
3. Set model: `grok-4-1-fast-non-reasoning`
4. Set base URL: `https://api.x.ai/v1`

---

## Free / Local: Ollama

Runs entirely on your machine — no API key required, no data sent to external servers.

1. Install Ollama from [ollama.com](https://ollama.com/) and start it:
   ```bash
   ollama serve
   ```
2. Pull a vision-capable model:
   ```bash
   ollama pull qwen3-vl:8b
   ```
3. In **Settings**, select the **Free** tier.
4. Set base URL: `http://localhost:11434` (default)

> **Note:** Performance depends on local hardware. A GPU with ≥8 GB VRAM is recommended for comfortable use.

---

## Advanced / Optional: Fireworks

Available in code and config for compatibility with existing setups. Not shown in the default Settings UI but fully functional if configured manually in the provider config.

---

## Testing Your Setup

After entering credentials, click **Test** in the Settings panel. BrowseAgent will send a minimal probe request to verify connectivity and model availability before you run any tasks.

---

## Choosing a Model

| Provider | Model | Notes |
|---|---|---|
| Z.AI | `glm-4.6v` | Vision + tool-calling, recommended default |
| xAI | `grok-4-1-fast-non-reasoning` | Fast, cost-efficient |
| Ollama | `qwen3-vl:8b` | Local, privacy-friendly |

For complex multi-step tasks, prefer vision-capable models — they allow BrowseAgent to use screenshots as a fallback when the accessibility tree is incomplete.