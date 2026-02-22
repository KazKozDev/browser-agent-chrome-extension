/**
 * Tool Definitions
 *
 * JSON Schema definitions for all browser tools.
 * These are sent to the LLM as function calling tools.
 * Static set — all tools are always included in every request.
 */

export const TOOLS = [

  // ── PAGE READING ───────────────────────────────────────────────────────────

  {
    name: 'read_page',
    description: 'Get a compact accessibility snapshot of the current page. Returns semantic structure and an interactive elements list labeled by [id] (token-efficient, no raw HTML). Use this as the primary way to understand the page.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        maxDepth: { type: 'integer', description: 'Max tree depth (default 15)', default: 15 },
        maxNodes: { type: 'integer', description: 'Max nodes to return (default 500)', default: 500 },
        viewportOnly: { type: 'boolean', description: 'If true, only return elements currently visible in the viewport (faster, fewer tokens). Use when you only need to interact with what is currently on screen.' },
      },
    },
  },
  {
    name: 'get_page_text',
    description: 'Get the raw text content of the page. Use for text-heavy pages like articles, docs, or when you need to read the full content.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },},
    },
  },
  {
    name: 'find',
    description: 'Find interactive elements on the page using a natural language description. Returns matching elements with their agentId (numeric), sorted by relevance. Use the returned agentId number directly as the target parameter in computer() calls. Example: if find returns {agentId: 17, tag: "input"}, then call computer(action="click", target=17).',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        query: {
          type: 'string',
          description: 'Natural language description of the element to find, e.g. "search button", "email input", "sign in link"',
        },
      },
      required: ['thought', 'query'],
    },
  },
  {
    name: 'find_text',
    description: 'Find plain text already present on the current page (Ctrl+F equivalent). Returns count and snippets of matches. This is NOT a site search — it only scans text visible in the loaded DOM. To search ON a website, use its search form via computer(click/type). NOTE: The returned matches do NOT contain agent IDs and CANNOT be clicked directly. Use find or read_page to get element IDs for interaction.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        query: { type: 'string', description: 'Text to search for on the page' },
        caseSensitive: { type: ['boolean', 'string'], description: 'Match case exactly if true' },
        wholeWord: { type: ['boolean', 'string'], description: 'Match whole words only if true' },
        maxResults: { type: 'integer', description: 'Maximum matches to return (default 20)', default: 20 },
        scrollToFirst: { type: ['boolean', 'string'], description: 'Scroll to first match if true (default true)' },
      },
      required: ['thought', 'query'],
    },
  },
  {
    name: 'find_text_next',
    description: 'Jump to the next match from a previous find_text search. Requires an active find_text context (call find_text first).',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        wrap: { type: ['boolean', 'string'], description: 'Wrap around to the first match when reaching the end (default true)' },
      },
    },
  },
  {
    name: 'find_text_prev',
    description: 'Jump to the previous match from a previous find_text search. Requires an active find_text context (call find_text first).',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        wrap: { type: ['boolean', 'string'], description: 'Wrap around to the last match when reaching the start (default true)' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current tab. The image will be sent to the LLM as a vision message for visual understanding. Use when accessibility tree is insufficient (canvas, images, complex layouts).',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },},
    },
  },

  // ── NAVIGATION ─────────────────────────────────────────────────────────────

  {
    name: 'navigate',
    description: 'Navigate to a URL in the current tab. Use full URLs with https://. Use this to open websites before interacting with them.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        url: { type: 'string', description: 'Full http/https URL to navigate to' },
      },
      required: ['thought', 'url'],
    },
  },
  {
    name: 'back',
    description: 'Go back in browser history for the current tab.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },},
    },
  },
  {
    name: 'forward',
    description: 'Go forward in browser history for the current tab.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },},
    },
  },
  {
    name: 'reload',
    description: 'Reload the current tab.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        bypassCache: { type: ['boolean', 'string'], description: 'Set true to bypass HTTP cache' },
      },
    },
  },

  // ── INTERACTION ────────────────────────────────────────────────────────────

  {
    name: 'computer',
    description: 'Perform browser interactions: click, type text, scroll, hover, select dropdown, press keys, drag, or set form values directly. Use action to choose what to do.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        action: {
          type: 'string',
          enum: ['click', 'type', 'scroll', 'hover', 'select', 'key', 'drag', 'form_input'],
          description: 'Action: click=click element, type=type text into input, scroll=scroll page, hover=hover over element, select=pick dropdown option, key=press keyboard key/shortcut, drag=drag from coords to coords, form_input=set checkbox/radio/hidden value directly',
        },
        target: { type: ['integer', 'string'], description: 'Numeric element ID: use [N] from read_page tree or agentId from find results (for click/type/hover/select/form_input). Must be a plain integer, e.g. 17.' },
        x: { type: ['integer', 'string'], description: 'X coordinate for vision fallback (action=click)' },
        y: { type: ['integer', 'string'], description: 'Y coordinate for vision fallback (action=click)' },
        text: { type: 'string', description: 'Text to type verbatim into the focused input (action=type). Always use the exact text from the user task — never shorten or rephrase.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (action=scroll)' },
        amount: { type: 'integer', description: 'Pixels to scroll, default 500 (action=scroll)' },
        value: { type: 'string', description: 'Option value for dropdown (action=select) or value to set (action=form_input)' },
        key: { type: 'string', description: 'Key name: Enter, Tab, Escape, Backspace, ArrowDown, F5, etc. (action=key)' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] },
          description: 'Modifier keys (action=key), e.g. ["Control"] for Ctrl+key',
        },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button, default left (action=click)' },
        checked: { type: 'boolean', description: 'For checkboxes/radios (action=form_input)' },
        confirm: { type: ['boolean', 'string'], description: 'Set true for destructive/payment/send actions (action=click or form_input)' },
        fromX: { type: ['integer', 'string'], description: 'Drag start X viewport coordinate (action=drag)' },
        fromY: { type: ['integer', 'string'], description: 'Drag start Y viewport coordinate (action=drag)' },
        toX: { type: ['integer', 'string'], description: 'Drag end X viewport coordinate (action=drag)' },
        toY: { type: ['integer', 'string'], description: 'Drag end Y viewport coordinate (action=drag)' },
      },
      required: ['thought', 'action'],
    },
  },
  {
    name: 'javascript',
    description: 'Execute JavaScript in the page MAIN context. Returns the result of the last expression. USE THIS as universal fallback when no dedicated tool fits: trigger drag-and-drop (dispatchEvent DragEvent/MouseEvent), manipulate file inputs (DataTransfer), read computed styles, interact with canvas/WebGL, call page-internal APIs, extract data from complex DOM structures, or simulate any browser event. Cookies, localStorage, and sessionStorage are blocked for security.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        code: { type: 'string', description: 'JavaScript code to execute' },
      },
      required: ['thought', 'code'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload one or more synthetic files into a file input element. Provide file content as text or base64.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        target: { type: ['integer', 'string'], description: 'File input element ID (integer or numeric string)' },
        files: {
          type: 'array',
          description: 'Files to upload',
          items: {
            type: 'object',
            properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
              name: { type: 'string', description: 'File name, e.g. report.txt' },
              mimeType: { type: 'string', description: 'MIME type, e.g. text/plain' },
              text: { type: 'string', description: 'Text content for the file' },
              contentBase64: { type: 'string', description: 'Base64 content for binary/text file' },
              lastModified: { type: 'integer', description: 'Unix ms timestamp for file metadata' },
            },
            required: ['thought', 'name'],
          },
        },
      },
      required: ['target', 'files'],
    },
  },
  {
    name: 'switch_frame',
    description: 'Switch interaction context to another iframe (same-origin) or back to main document.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        target: { type: ['integer', 'string'], description: 'Iframe agent ID, name, id, or the string "main"' },
        index: { type: 'integer', description: 'Iframe index in current document (0-based)' },
        main: { type: ['boolean', 'string'], description: 'Set true to return to top-level document' },
      },
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until a condition is true: element appears, URL includes text, page text appears, navigation completes, or network becomes idle.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        condition: {
          type: 'string',
          enum: ['element', 'url_includes', 'text', 'navigation_complete', 'network_idle'],
          description: 'Condition type to wait for',
        },
        target: { type: ['integer', 'string'], description: 'Element ID for condition=element' },
        value: { type: 'string', description: 'Substring for condition=url_includes or condition=text' },
        timeoutMs: { type: 'integer', description: 'Overall timeout in ms (default 10000)', default: 10000 },
        pollMs: { type: 'integer', description: 'Polling interval in ms (default 250)', default: 250 },
        idleMs: { type: 'integer', description: 'Idle window for condition=network_idle (default 1200)', default: 1200 },
      },
      required: ['thought', 'condition'],
    },
  },
  {
    name: 'wait',
    description: 'Wait for a specified duration in milliseconds.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        duration: { type: 'integer', description: 'Milliseconds to wait', default: 1000 },
      },
    },
  },

  // ── TAB MANAGEMENT ─────────────────────────────────────────────────────────

  {
    name: 'list_tabs',
    description: 'List tabs in the current browser window.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },},
    },
  },
  {
    name: 'switch_tab',
    description: 'Switch active tab by tab ID or index.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        tabId: { type: ['integer', 'string'], description: 'Target tab ID' },
        index: { type: ['integer', 'string'], description: 'Target tab index in current window (0-based)' },
      },
    },
  },
  {
    name: 'open_tab',
    description: 'Open a new tab with URL and optionally make it active.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        url: { type: 'string', description: 'URL to open' },
        active: { type: ['boolean', 'string'], description: 'Whether the new tab should be focused (default true)' },
      },
      required: ['thought', 'url'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab by ID. If omitted, closes current tab.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        tabId: { type: ['integer', 'string'], description: 'Tab ID to close (optional)' },
      },
    },
  },

  // ── DIAGNOSTICS ────────────────────────────────────────────────────────────

  {
    name: 'get_console_logs',
    description: 'Read browser console output from the current page — errors, warnings, info, and uncaught exceptions. Useful for debugging page issues.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        since: { type: 'number', description: 'Only return messages with timestamp newer than this (ms since epoch). Default 0 = all captured messages.' },
        level: { type: 'string', enum: ['all', 'error', 'warn', 'info', 'log'], description: 'Filter by level. Default: "error" to focus on problems.' },
      },
    },
  },
  {
    name: 'get_network_requests',
    description: 'Read recent HTTP network requests captured from the current page, with URLs, methods, status codes, and timing. Useful for understanding API calls, debugging failed requests, or finding data endpoints.',
    parameters: {
      type: 'object',
      required: ['thought'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        since: { type: 'integer', description: 'Timestamp to filter requests after (0 = all)', default: 0 },
      },
    },
  },

  // ── UTILITIES ──────────────────────────────────────────────────────────────

  {
    name: 'resize_window',
    description: 'Resize the browser window. Use when a site has responsive breakpoints that change UI layout (e.g. mobile view at width < 768px, tablet at < 1024px).',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        width: { type: 'integer', description: 'Window width in pixels' },
        height: { type: 'integer', description: 'Window height in pixels' },
      },
      required: ['thought', 'width', 'height'],
    },
  },

  // ── EXTERNAL ───────────────────────────────────────────────────────────────

  {
    name: 'http_request',
    description: 'Make an HTTP request to any URL — REST APIs, webhooks, Notion API, Slack, Airtable, Google Sheets, etc. Responses are returned as text or JSON. Use this to read from or write to external services without opening a browser tab.',
    parameters: {
      type: 'object',
      required: ['thought', 'url'],
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        url: { type: 'string', description: 'Full URL including query parameters if needed.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method. Default: GET.' },
        headers: { type: 'object', description: 'HTTP headers as key-value pairs (e.g. { "Authorization": "Bearer TOKEN", "Content-Type": "application/json" }).' },
        body: { description: 'Request body. For JSON APIs pass an object — it will be serialized automatically. For form data pass a string.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds. Default: 15000.' },
        allow_private: { type: 'boolean', description: 'Set true to allow requests to localhost or private IP ranges (e.g. a local Ollama server). Default: false.' },
      },
    },
  },

  // ── COMPLETION ─────────────────────────────────────────────────────────────

  {
    name: 'done',
    description: 'Mark the task as completed successfully. For information tasks, put the extracted answer in the "answer" field with source URL(s).',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        summary: { type: 'string', description: 'Brief summary of what was accomplished (1 sentence)' },
        answer: { type: 'string', description: 'The actual answer/information extracted from the page. Required for information/search tasks. Include the full relevant text and the source URL(s) where it was found.' },
      },
      required: ['thought', 'summary'],
    },
  },
  {
    name: 'fail',
    description: 'Mark the task as failed (cannot be completed).',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning for choosing this action and its expected outcome' },
        reason: { type: 'string', description: 'Why the task failed' },
      },
      required: ['thought', 'reason'],
    },
  },

];

export function getToolByName(name) {
  return TOOLS.find((t) => t.name === name);
}
