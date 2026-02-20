<p align="center">
  <img src="icons/icon128.png" alt="Browser Agent icon" width="160" />
</p>

# Browser Agent (Beta) — Chrome Extension

[![Release](https://img.shields.io/github/v/release/KazKozDev/browser-agent-chrome-extension?label=release)](https://github.com/KazKozDev/browser-agent-chrome-extension/releases)
[![Status](https://img.shields.io/badge/status-Public%20Beta-orange)](https://github.com/KazKozDev/browser-agent-chrome-extension/releases/tag/v1.0.0)
[![Chrome](https://img.shields.io/badge/chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

AI-powered browser automation for Chrome. Give it a goal — it navigates, clicks, reads pages, calls APIs, and reports back.

## Screenshot

**Query:**  
"Open Wikipedia and find the article about Albert Einstein."

![Browser Agent screenshot](docs/images/screen.png)

*Browser Agent Result: The Albert Einstein Wikipedia page is open, with the article content on the left and the info panel on the right.*

## Features

### Browsing & Navigation
- Open any URL, navigate history, reload pages.
- Open, close, switch and list tabs; agent tabs auto-grouped as "Browser Agent".
- Switch between iframes; Ctrl+F text search with next/previous.

### Page Interaction
- Click, double-click, right-click, triple-click, middle-click.
- Type text, fill forms, select dropdowns, upload files.
- Drag & drop, coordinate clicks, scroll, hover.
- Keyboard shortcuts, hold keys, hotkey combos.

### Page Reading & Inspection
- Accessibility tree reading with element structure.
- Full page text extraction and natural language element search.
- Screenshots with vision-capable providers.
- Browser console logs (errors, warnings, info) and network request monitoring.
- Download queue status.

### External Integrations
- `http_request` — call any REST API directly (Notion, Slack, Airtable, Google Sheets, webhooks). Runs from the extension context — no CORS restrictions.

### Automation & Workflow
- **Plan mode** — agent shows steps before executing; approve or cancel.
- **Shortcuts** — save prompts as `/name` slash commands.
- **Scheduled tasks** — run goals automatically every N minutes/hours via `chrome.alarms`.
- **Background workflows** — task continues even when the side panel is closed.
- **Contextual suggestions** — smart prompt chips based on the current site.
- **Notifications** — desktop alerts on task completion.

### Safety & Permissions
- JavaScript filtered by security rules — no cookies, auth headers, storage access.
- **Per-domain JS permission** — asks before running scripts on new sites.
- **Site blocklist** — blocks navigation to sensitive domains (crypto/payment by default).
- Login, CAPTCHA and sensitive-action detection — agent pauses for manual help.

### Efficiency
- Duplicate tool call detection — blocks repeated identical calls and suggests alternatives.
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
│   ├── groq.js              Groq (Llama 4 Scout)
│   ├── ollama.js            Ollama (local)
│   └── index.js             Provider manager, tier info, config
├── sidepanel/
│   ├── sidepanel.html       UI: chat, settings, history, help, schedule, blocklist
│   ├── sidepanel.js         UI logic, views, rendering, shortcuts
│   └── icons.css            SVG icon sprites (Lucide-style)
└── tools/tools.js           JSON-schema tool definitions for the model
```

## Tools

| Tool | Description |
|---|---|
| `read_page` | Accessibility tree with interactive element IDs |
| `get_page_text` | Full readable text content of the page |
| `find` | Natural-language element search |
| `find_text` | Ctrl+F plain text search with match count |
| `find_text_next` / `find_text_prev` | Navigate search results |
| `navigate` | Open a URL (blocklist-checked) |
| `back` / `forward` / `reload` | Browser history controls |
| `click` / `double_click` / `right_click` / `middle_click` / `triple_click` | Click by element ID |
| `type` | Type text into inputs |
| `scroll` / `hover` / `select` / `form_input` | Page interaction |
| `drag_drop` / `drag_at` | Drag & drop by IDs or coordinates |
| `mouse_move` / `click_at` | Coordinate-based interaction |
| `left_mouse_down` / `left_mouse_up` | Advanced mouse control |
| `press_key` / `hold_key` / `press_hotkey` | Keyboard actions |
| `javascript` | Filtered JS execution in page context |
| `wait_for` / `wait` | Wait for conditions or fixed delay |
| `read_console` | Browser console messages (errors, warnings, logs) |
| `read_network` | Recent network requests and statuses |
| `http_request` | Call any REST API (GET/POST/PUT/DELETE/PATCH) |
| `switch_frame` | Switch to iframe or back to main |
| `upload_file` | Upload files to file inputs |
| `download_status` | Download queue state |
| `list_tabs` / `switch_tab` / `open_tab` / `close_tab` | Tab management |
| `screenshot` | Capture page screenshot (vision providers) |
| `done` / `fail` | Mark task as completed or failed |

## Providers

| Tier | Provider | Model | Pricing (per 1M tokens) |
|---|---|---|---|
| Recommended | Fireworks | Kimi K2.5 | $0.60 in / $3.00 out |
| Budget | SiliconFlow | GLM-4.6V | $0.30 in / $0.90 out |
| Budget | Groq | Llama 4 Scout | $0.11 in / $0.34 out |
| Free | Ollama | Local model | Free |

All providers support vision and tool calling. Provider selection is primary-only (no automatic fallback).

## Install

### Option A: Download ZIP
1. Go to `https://github.com/KazKozDev/browser-agent-chrome-extension`.
2. Click **Code** > **Download ZIP**, extract.
3. Open `chrome://extensions/`, enable **Developer mode**.
4. Click **Load unpacked**, select the folder with `manifest.json`.

### Option B: Clone
```bash
git clone https://github.com/KazKozDev/browser-agent-chrome-extension.git
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

### SiliconFlow (Budget)
1. Get API key at `https://cloud.siliconflow.com/`.
2. Select the Budget tier. Model: `zai-org/GLM-4.6V`.

### Groq (Budget)
1. Get API key at `https://console.groq.com/`.
2. Select the Budget tier. Model: `meta-llama/llama-4-maverick-17b-128e-instruct`.

### Ollama (Free)
1. Install Ollama, run `ollama serve`.
2. Pull a model: `ollama pull qwen3-vl:8b`.
3. Select the Free tier in Settings.

## Permissions

Manifest V3 permissions:
- `activeTab`, `scripting`, `tabs`, `downloads`, `sidePanel`, `storage`, `unlimitedStorage`, `alarms`, `notifications`, `tabGroups`
- Host: `<all_urls>`

## Security

- JavaScript tool blocks `document.cookie`, `localStorage`, `sessionStorage`, `indexedDB`, and `Authorization` header access.
- Per-domain JS approval — agent asks before executing scripts on a new domain.
- Site blocklist — crypto/payment sites blocked by default; custom domains via Blocklist view.
- Sensitive action confirmation — `confirm: true` required for submit/delete/pay actions.
- Login/CAPTCHA detection — agent pauses and waits for manual completion.
- Console and network data collected only on demand.

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
- Issues: `https://github.com/KazKozDev/browser-agent-chrome-extension/issues`

---

If you like this project, please give it a star!

[Artem KK](https://www.linkedin.com/in/kazkozdev/)
