<p align="center">
  <img src="icons/icon128.png" alt="Browser Agent icon" width="160" />
</p>

# Browser Agent (Beta) — Chrome Extension

[![Release](https://img.shields.io/github/v/release/KazKozDev/browser-agent-chrome-extension?label=release)](https://github.com/KazKozDev/browser-agent-chrome-extension/releases)
[![Status](https://img.shields.io/badge/status-Public%20Beta-orange)](https://github.com/KazKozDev/browser-agent-chrome-extension/releases/tag/v1.0.0)
[![Chrome](https://img.shields.io/badge/chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Public Beta.

A Claude-like browser agent extension for Chrome, focused on cost-efficient automation.

## Screenshot

**Query (for screenshot):**  
"Open Wikipedia and find the article about Albert Einstein. Show the main article on the left and the info panel on the right."

![Browser Agent screenshot](docs/images/screen.png)

*Browser Agent Result: The Albert Einstein Wikipedia page is open, with the article content on the left and the info panel on the right.*

## What It Does

- Executes browser tasks step-by-step with an agent loop (`observe -> think -> act`).
- Uses accessibility-tree reading as the primary page understanding method.
- Supports advanced DOM and mouse interactions, keyboard shortcuts, tab/frame control, uploads, and downloads status.
- Extracts text/data from pages (`read_page`, `get_page_text`, `find_text`, `javascript`).
- Pauses automatically on login/CAPTCHA and waits for manual `Resume`.

## Architecture

- `src/sidepanel/*`
  - UI: chat, history, settings, help, provider config.
- `src/background/service-worker.js`
  - Orchestration, agent lifecycle, provider config, keep-alive.
- `src/agent/agent.js`
  - Core loop, tool execution, argument normalization, safety checks.
- `src/content/content.js`
  - Accessibility tree extraction, DOM actions, find/find_text, monitoring.
- `src/providers/*`
  - OpenAI-compatible provider implementations.
- `src/tools/tools.js`
  - JSON-schema tool definitions exposed to the model.

## Tools (Current)

| Tool | What it does |
|---|---|
| `read_page` | Reads the accessibility tree with interactive element IDs. |
| `get_page_text` | Extracts readable text content from the current page. |
| `find` | Finds likely interactive elements from a natural-language query. |
| `find_text` | Searches plain text on the page (Ctrl+F style). |
| `find_text_next` | Moves to the next result from the current text search. |
| `find_text_prev` | Moves to the previous result from the current text search. |
| `navigate` | Opens a target URL in the current tab. |
| `back` | Goes back in current tab history. |
| `forward` | Goes forward in current tab history. |
| `reload` | Reloads the current tab. |
| `click` | Clicks an element by agent ID. |
| `double_click` | Double-clicks an element by agent ID. |
| `right_click` | Right-clicks an element by agent ID. |
| `middle_click` | Middle-clicks an element by agent ID. |
| `triple_click` | Triple-clicks an element by agent ID. |
| `drag_drop` | Drags one element and drops it on another by IDs. |
| `type` | Types text into an input or editable field. |
| `scroll` | Scrolls the page up or down. |
| `hover` | Moves pointer over an element to trigger hover states. |
| `select` | Selects an option in a `<select>` element. |
| `form_input` | Sets form values directly (including checkbox/radio). |
| `mouse_move` | Moves pointer to an element or viewport coordinates. |
| `left_mouse_down` | Presses and holds left mouse button. |
| `left_mouse_up` | Releases left mouse button. |
| `click_at` | Clicks at viewport coordinates. |
| `drag_at` | Performs coordinate-based drag from point A to B. |
| `press_key` | Presses a keyboard key (for example Enter, Tab, Esc). |
| `hold_key` | Holds/releases modifier keys (Ctrl, Shift, Alt, Meta). |
| `press_hotkey` | Sends keyboard shortcut combinations. |
| `javascript` | Executes filtered JS in page context for extraction/actions. |
| `wait_for` | Waits for conditions like element, URL, text, or network idle. |
| `read_console` | Reads recent browser console messages. |
| `read_network` | Reads recent network requests and statuses. |
| `switch_frame` | Switches interaction context to iframe or back to main frame. |
| `upload_file` | Uploads synthetic files to file input controls. |
| `download_status` | Returns current/recent browser download states. |
| `list_tabs` | Lists tabs in the current browser window. |
| `switch_tab` | Switches active tab by tab ID or index. |
| `open_tab` | Opens a new tab with a URL. |
| `close_tab` | Closes a specific tab or the current tab. |
| `screenshot` | Captures a screenshot for visual understanding. |
| `wait` | Sleeps for a fixed duration. |
| `done` | Marks the task as completed. |
| `fail` | Marks the task as failed with a reason. |

## Providers (Current)

| Provider | Model | Pricing | Vision | Tools | Tier |
|---|---|---|---|---|---|
| SiliconFlow | GLM-4.6V | $0.30 / $0.90 per 1M tokens | Yes | Yes | Recommended |
| Groq | Llama 4 Scout | $0.11 / $0.34 per 1M tokens | Yes | Yes | Budget |
| Ollama | Local model (`qwen3-vl:8b` default) | Free | Yes | Yes | Free |

Notes:
- Provider selection is primary-only (automatic fallback is disabled).
- Default primary provider: `groq`.

## Download and Local Installation

### Option A: Download ZIP (No Git)
1. Open `https://github.com/KazKozDev/browser-agent-chrome-extension`.
2. Click `Code` -> `Download ZIP` (GitHub generates this archive automatically; no separate ZIP upload is required).
3. Extract the ZIP archive.
4. Open `chrome://extensions/`.
5. Enable `Developer mode`.
6. Click `Load unpacked`.
7. Select the extracted folder that contains `manifest.json`.

### Option B: Clone with Git
1. Run: `git clone https://github.com/KazKozDev/browser-agent-chrome-extension.git`
2. Open `chrome://extensions/`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the cloned folder.

## Install (Developer Mode)

1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository folder (the folder that contains `manifest.json`).
5. Open extension side panel.
6. In Settings, configure provider API key/model.
7. Enter a goal and run.

## Provider Setup

### SiliconFlow (Recommended)
1. Create API key at `https://cloud.siliconflow.com/`.
2. In Settings, choose the Recommended tier.
3. Set API key and keep model `zai-org/GLM-4.6V`.
4. Click `Test Connection`.

### Groq (Budget)
1. Create API key at `https://console.groq.com/`.
2. In Settings, choose the Budget tier.
3. Set API key and keep model `meta-llama/llama-4-scout-17b-16e-instruct`.
4. Click `Test Connection`.

### Ollama (Free)
1. Install Ollama locally.
2. Start server: `ollama serve`.
3. Pull model: `ollama pull qwen3-vl:8b`.
4. In Settings, choose the Free tier and test connection.

## Manifest / Permissions

Manifest V3 (`manifest.json`) with:
- `name`: `Browser Agent (Beta)`
- `version`: `1.0.0`
- `description`: starts with `Public Beta`

Declared permissions currently used:
- `activeTab`, `scripting`, `tabs`, `downloads`, `sidePanel`, `storage`, `alarms`
- host access: `http://*/*`, `https://*/*`

## Security and Safety

- Sensitive actions use confirmation logic.
- JavaScript tool blocks high-risk storage/cookie patterns.
- Console/network collection is on-demand.
- Login/CAPTCHA flow uses manual pause/resume.

## Troubleshooting

- `429 rate_limit_exceeded`: reduce retries, shorten prompts/context, or wait for TPM/RPM reset.
- `400 tool_use_failed`: usually invalid tool arguments; re-run with correct parameter types.
- "Connected" then runtime error: provider health check passed, but chat/tool call failed due to payload or limits.
- Agent loops too long / max steps: use a more specific goal and ask for fewer actions per run.
- Login/CAPTCHA pages: complete verification manually, then click `Resume`.

## Known Limitations

- Some cross-origin iframes cannot be fully controlled due to browser security.
- Anti-bot protected pages may block automated flows.
- Dynamic pages can invalidate cached element IDs after navigation/re-render.
- Local/Ollama performance depends on machine resources and model size.

## Support

- Email: `kazkozdev@gmail.com`
- Issues: `https://github.com/KazKozDev/browser-agent-chrome-extension/issues`

---

If you like this project, please give it a star ⭐

For questions, feedback, or support, reach out to:

[Artem KK](https://www.linkedin.com/in/kazkozdev/)

## Project Structure

```
.
├── manifest.json
├── icons/
├── _locales/
├── src/
│   ├── agent/
│   │   └── agent.js
│   ├── background/
│   │   └── service-worker.js
│   ├── content/
│   │   └── content.js
│   ├── providers/
│   │   ├── base.js
│   │   ├── groq.js
│   │   ├── ollama.js
│   │   ├── siliconflow.js
│   │   └── index.js
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.js
│   │   └── icons.css
│   └── tools/
│       └── tools.js
└── README.md
```
