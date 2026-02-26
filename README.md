<p align="center">
  <img src="icons/icon128.png" alt="BrowseAgent icon" width="160" />
</p>

# BrowseAgent (Beta) — Chrome Extension

[![Release](https://img.shields.io/github/v/release/KazKozDev/browseagent-chrome-extension?label=release)](https://github.com/KazKozDev/browseagent-chrome-extension/releases)
[![Status](https://img.shields.io/badge/status-Public%20Beta-orange)](https://github.com/KazKozDev/browseagent-chrome-extension/releases/tag/v1.0.2)
[![Chrome](https://img.shields.io/badge/chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

AI-powered browser automation for Chrome. Give it a goal — it navigates, clicks, reads pages, calls APIs, and reports back.

Latest stable build: **v1.0.2**

## Screenshot

**Query:**  
"Open Wikipedia and find the article about Albert Einstein."

![BrowseAgent screenshot](docs/images/screen.png)

*BrowseAgent Result: The Albert Einstein Wikipedia page is open, with the article content on the left and the info panel on the right.*

## Features

### Browsing & Navigation
- Open any URL and navigate back/forward/reload.
- Open, list, switch and close tabs; agent tabs auto-grouped as "BrowseAgent".
- Switch between main document and iframes (`switch_frame`).
- Restore previously captured page state via snapshots (URL/cookies/scroll).

### Page Interaction
- Click (left/right/middle, single/double/triple).
- Type into single or multiple fields in one call.
- Select dropdown options, hover elements, scroll, press keys with modifiers.

### Page Reading & Inspection
- Accessibility tree reading with element structure.
- Full page text extraction (full/viewport/selector).
- Structured extraction (`extract_structured`) for repeated lists/cards.
- Natural-language element search (`find`) and Ctrl+F-style search (`find_text`).
- Screenshots with optional Set-of-Mark overlays (vision-capable providers).

### External Integrations
- `http_request` — call any REST API directly (Notion, Slack, Airtable, Google Sheets, webhooks). Runs from the extension context — no CORS restrictions.
- `notify_connector` — send messages/results to connected integrations during execution.

### Automation & Workflow
- **Plan mode** — agent shows steps before executing; approve or cancel.
- **Scheduled tasks** — run goals automatically every N minutes/hours via `chrome.alarms`.
- **Background workflows** — task continues even when the side panel is closed.
- **Recoverable sessions** — interrupted runs can be resumed from persisted checkpoint state.
- **Connections view** — integrations, task output routing toggles, and masked diagnostics.
- **Notifications** — desktop alerts on task completion (route-aware).

### Safety & Permissions
- **Site blocklist** — UI-managed denylist + network-level DNR blocking (crypto/payment defaults included).
- **Tracker & ad blocker** — optional DNR ruleset applied during runs.
- Login, CAPTCHA and sensitive-action detection — agent pauses for manual help.

### Efficiency
- Duplicate and semantic-repeat detection — blocks repeated identical/low-signal loops and suggests alternatives.
- SERP loop guard — forces exit from search-result loops to target pages.
- Early token burn-rate guard — pauses before budget exhaustion to avoid dead-end runs.
- Result banner with metrics: steps, time, errors, duplicates.
- Task history with performance data (steps, duration, errors).

## Architecture

```
src/
├── agent/agent.js           Core loop, tool execution, safety, dedup detection
├── background/service-worker.js  Orchestration, lifecycle, alarms, background workflows
├── content/content.js       Accessibility tree, DOM actions, find/monitoring
├── providers/
│   ├── base.js              Base provider class (OpenAI-compatible)
│   ├── fireworks.js         Fireworks (Kimi K2.5)
│   ├── siliconflow.js       SiliconFlow (GLM-4.6V)
│   ├── xai.js               xAI (Grok 4.1 Fast)
│   ├── ollama.js            Ollama (local)
│   └── index.js             Provider manager, tier info, config
├── sidepanel/
│   ├── sidepanel.html       UI: Task, Queue, History, Skills, Connections, Settings
│   ├── sidepanel.js         UI logic, views, rendering, shortcuts
│   └── icons.css            SVG icon sprites (Lucide-style)
└── tools/tools.js           JSON-schema tool definitions for the model
```

## Tools

| Tool | Description |
|---|---|
| `read_page` | Accessibility tree with interactive element IDs |
| `get_page_text` | Page text extraction: `full` / `viewport` / `selector` |
| `extract_structured` | Structured extraction from repeated cards/results |
| `find` | Natural-language element search |
| `find_text` | Ctrl+F-style text search with snippets |
| `screenshot` | Capture screenshot (optional Set-of-Mark overlays) |
| `navigate` | Open URL (blocklist-checked) |
| `back` | Browser history back |
| `forward` | Browser history forward |
| `reload` | Reload active tab |
| `click` | Click element IDs (single/double/triple, left/right/middle) |
| `type` | Type text into one or multiple fields |
| `scroll` | Scroll page up/down |
| `select` | Select dropdown option |
| `hover` | Hover over element |
| `press_key` | Press key with optional modifiers |
| `wait_for` | Wait for element/text/url/navigation/network-idle condition |
| `open_tab` | Open new tab |
| `list_tabs` | List tabs in current window |
| `switch_tab` | Switch active tab by ID/index |
| `close_tab` | Close active tab or tab by ID |
| `switch_frame` | Switch to main document or iframe by id/name/index |
| `restore_snapshot` | Roll back state snapshot (URL/cookies/scroll) |
| `http_request` | HTTP request to external APIs/webhooks |
| `notify_connector` | Send message to a configured connector |
| `done` | Mark task complete |
| `save_progress` | Persist intermediate task memory |
| `fail` | Mark task failed |

## Providers

| Tier | Provider | Model | Pricing (per 1M tokens) |
|---|---|---|---|
| Recommended | Fireworks | Kimi K2.5 | $0.60 in / $3.00 out |
| Budget | xAI | Grok 4.1 Fast (`grok-4-1-fast-non-reasoning`) | See xAI pricing |
| Free | Ollama | Local model | Free |

All providers support vision and tool calling. Provider selection is primary-only (no automatic fallback).
`siliconflow` is implemented in code/config for compatibility, but not shown as a card in the current Settings UI.

## Install

### Option A: Download ZIP
1. Go to `https://github.com/KazKozDev/browseagent-chrome-extension`.
2. Click **Code** > **Download ZIP**, extract.
3. Open `chrome://extensions/`, enable **Developer mode**.
4. Click **Load unpacked**, select the folder with `manifest.json`.

### Option B: Clone
```bash
git clone https://github.com/KazKozDev/browseagent-chrome-extension.git
```
Then load unpacked in `chrome://extensions/`.

### First Run
1. Open the extension side panel.
2. Go to Settings, pick a tier, enter API key.
3. Click **Test** to verify connection.
4. Enter a goal and run.

## Provider Setup

### Fireworks (Recommended)
1. Get API key at `https://fireworks.ai/`.
2. Select the Recommended tier in Settings.
3. Model: `accounts/fireworks/models/kimi-k2p5`.

### xAI (Budget)
1. Get API key at `https://console.x.ai/`.
2. Select the Budget tier. Model: `grok-4-1-fast-non-reasoning`.
3. API base URL: `https://api.x.ai/v1`.

Quick API check:
```bash
curl https://api.x.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -d '{
    "messages": [
      {
        "role": "user",
        "content": "What is the meaning of life, the universe, and everything?"
      }
    ],
    "model": "grok-4-1-fast-non-reasoning",
    "stream": false,
    "temperature": 0.7
  }'
```

### Ollama (Free)
1. Install Ollama, run `ollama serve`.
2. Pull a model: `ollama pull qwen3-vl:8b`.
3. Select the Free tier in Settings.

### SiliconFlow (Advanced)
- Provider class exists in code and stored configs are supported.
- The current Settings UI does not render a SiliconFlow card; setup requires manual config editing in extension storage.

## Permissions

Manifest V3 permissions:
- `activeTab`, `scripting`, `tabs`, `downloads`, `sidePanel`, `storage`, `cookies`, `unlimitedStorage`, `alarms`, `notifications`, `tabGroups`, `declarativeNetRequest`
- Host permissions: `<all_urls>`, `http://*/*`, `https://*/*`

## Security

- Site blocklist — crypto/payment sites blocked by default; custom domains via Blocklist view.
- Sensitive action confirmation — `confirm: true` required for submit/delete/pay actions.
- Login/CAPTCHA detection — agent pauses and waits for manual completion.
- Console and network data collected only on demand.

## Privacy

- Privacy policy: [PRIVACY.md](PRIVACY.md)

## Troubleshooting

- **429 rate limit**: wait for TPM/RPM reset or shorten prompts.
- **400 tool_use_failed**: invalid tool arguments; retry with correct types.
- **Agent loops too long**: use a more specific goal; check history metrics for inefficiency.
- **Login/CAPTCHA**: complete manually, then click Resume.

## Known Limitations

- Some cross-origin iframes cannot be controlled due to browser security.
- Anti-bot protected pages may block automated flows.
- Dynamic pages can invalidate cached element IDs after navigation/re-render.
- Ollama performance depends on local hardware and model size.

## Support

- Email: `kazkozdev@gmail.com`
- Issues: `https://github.com/KazKozDev/browseagent-chrome-extension/issues`

---

If you like this project, please give it a star!

[Artem KK](https://www.linkedin.com/in/kazkozdev/)
