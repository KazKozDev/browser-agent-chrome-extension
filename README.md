# Browser Agent (Beta) — Chrome Extension

Public Beta.

AI-powered browser automation inside Chrome Side Panel: navigate sites, interact with page elements, and extract data using natural-language goals.

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

### Page understanding
- `read_page`
- `get_page_text`
- `find`
- `find_text`
- `find_text_next`
- `find_text_prev`

### Navigation
- `navigate`
- `back`
- `forward`
- `reload`

### Interaction (element-based)
- `click`
- `double_click`
- `right_click`
- `middle_click`
- `triple_click`
- `drag_drop`
- `type`
- `scroll`
- `hover`
- `select`
- `form_input`

### Interaction (coordinate/pointer)
- `mouse_move`
- `left_mouse_down`
- `left_mouse_up`
- `click_at`
- `drag_at`

### Keyboard
- `press_key`
- `press_hotkey`
- `hold_key`

### Advanced browser control
- `wait`
- `wait_for`
- `switch_frame`
- `list_tabs`
- `switch_tab`
- `open_tab`
- `close_tab`
- `upload_file`
- `download_status`

### Diagnostics
- `read_console`
- `read_network`
- `screenshot`
- `javascript` (security-filtered)

### Terminal
- `done`
- `fail`

## Providers (Current)

| Provider | Model | Pricing | Vision | Tools | Tier |
|---|---|---|---|---|---|
| SiliconFlow | GLM-4.6V | $0.30 / $0.90 per 1M tokens | Yes | Yes | Recommended |
| Groq | Llama 4 Scout | $0.11 / $0.34 per 1M tokens | Yes | Yes | Budget |
| Ollama | Local model (`qwen3-vl:8b` default) | Free | Yes | Yes | Free |

Notes:
- Provider selection is primary-only (automatic fallback is disabled).
- Default primary provider: `groq`.

## Install (Developer Mode)

1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository folder (the folder that contains `manifest.json`).
5. Open extension side panel.
6. In Settings, configure provider API key/model.
7. Enter a goal and run.

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
