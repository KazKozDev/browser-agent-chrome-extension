/**
 * Tool Definitions
 *
 * JSON Schema definitions for all browser tools.
 * These are sent to the LLM as function calling tools.
 *
 * Architecture follows Anthropic's Claude-in-Chrome pattern:
 * unified `computer` tool for all interaction actions,
 * consolidated `navigate` and `tabs_context` tools.
 */

export const TOOLS = [
  // ── Reading & Navigation ────────────────────────────────────────

  {
    name: 'read_page',
    description: 'Get the accessibility tree of the current page. Returns interactive elements labeled by [id]. Use this as the primary way to understand the page.\n\n• mode="compact" (default): viewport-only, flat list of interactive elements — fastest, uses ~7× less context.\n• mode="full": complete accessibility tree — use only when you need non-interactive structure or deep nesting.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['compact', 'full'],
          description: '"compact" (default): flat list of interactive elements only, viewport-only — much smaller context footprint. "full": complete accessibility tree — request explicitly when you need non-interactive nodes or hierarchy.',
          default: 'compact',
        },
        maxDepth: { type: 'integer', description: 'Max tree depth for full mode (default 12)', default: 12 },
        maxNodes: { type: 'integer', description: 'Max nodes to return for full mode (default 500)', default: 500 },
      },
    },
  },
  {
    name: 'get_page_text',
    description: 'Get text content from the page. Supports full-page, viewport-only, or CSS-selector scoped extraction.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['full', 'viewport', 'selector'],
          description: 'Extraction scope: full page (default), only visible viewport, or specific CSS selector.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector used when scope=selector (e.g. ".result-item, article").',
        },
        maxChars: {
          type: 'integer',
          description: 'Maximum number of characters to return (default 15000, max 50000).',
        },
      },
    },
  },
  {
    name: 'extract_structured',
    description: 'Extract repeated content blocks (products/results/cards) into structured JSON objects with fields like title, price, rating, and url.',
    parameters: {
      type: 'object',
      properties: {
        hint: {
          type: 'string',
          description: 'Optional hint for target list type, e.g. "item cards", "search results", "table rows".',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector for list item roots. If omitted, heuristics are used.',
        },
        maxItems: {
          type: 'integer',
          description: 'Maximum number of extracted items (default 30, max 100).',
        },
      },
    },
  },
  {
    name: 'find',
    description: 'Find interactive elements on the page using a natural language description. Returns matching elements with their agent IDs, sorted by relevance.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of the element to find, e.g. "search button", "email input", "sign in link"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_text',
    description: 'Find plain text on the current page (Ctrl+F style). Returns count and snippets of matches. NOTE: The returned matches do NOT contain agent IDs and CANNOT be clicked directly. Use find or read_page to get element IDs for interaction.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for on the page' },
        caseSensitive: { type: ['boolean', 'string'], description: 'Match case exactly if true' },
        wholeWord: { type: ['boolean', 'string'], description: 'Match whole words only if true' },
        maxResults: { type: 'integer', description: 'Maximum matches to return (default 20)', default: 20 },
        scrollToFirst: { type: ['boolean', 'string'], description: 'Scroll to first match if true (default true)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate to a URL, or go back/forward/reload in browser history. Default action is "go" (navigate to URL). Use action="back", "forward", or "reload" for history navigation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['go', 'back', 'forward', 'reload'],
          description: 'Navigation action: "go" (default, navigate to URL), "back" (browser back), "forward" (browser forward), "reload" (reload page).',
        },
        url: { type: 'string', description: 'Full http/https URL to navigate to (required when action="go").' },
        bypassCache: { type: ['boolean', 'string'], description: 'If true, bypass browser cache when action="reload".' },
      },
    },
  },

  // ── Interaction & Automation ────────────────────────────────────

  {
    name: 'computer',
    description: 'Unified interaction tool for mouse, keyboard, and screen actions. Specify the action parameter to choose the operation: click, type, scroll, hover, select, press_key, screenshot, or wait_for.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'type', 'scroll', 'hover', 'select', 'press_key', 'screenshot', 'wait_for'],
          description: 'The interaction action to perform.',
        },
        // click / type / hover / select — target element
        target: {
          type: ['integer', 'string', 'array'],
          items: { type: ['integer', 'string'] },
          description: 'Element agent ID (the [N] number), or array of IDs for batch click/type.',
        },
        // click params
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click (default left).' },
        clickCount: { type: 'integer', description: 'Number of clicks: 1 (single), 2 (double), 3 (triple). Default 1.' },
        confirm: { type: ['boolean', 'string'], description: 'Set true for sensitive click actions (submit/delete/pay/send).' },
        // type params
        text: { type: ['string', 'array'], items: { type: 'string' }, description: 'Text to type, or array of texts for batch type.' },
        enter: { type: ['boolean', 'string'], description: 'If true, press Enter after typing to submit the form.' },
        // scroll params
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
        amount: { type: 'integer', description: 'Pixels to scroll (default 500).', default: 500 },
        // select params
        value: { type: 'string', description: 'Option value to select (action=select), or substring for wait_for condition=url_includes/text.' },
        // press_key params
        key: { type: 'string', description: 'Key name: Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, etc.' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] },
          description: 'Modifier keys to hold (e.g. ["Control"] for Ctrl+key).',
        },
        // screenshot params
        som: { type: ['boolean', 'string'], description: 'Enable Set-of-Mark numbered overlays (default true). Set false for raw screenshot.' },
        maxMarks: { type: 'integer', description: 'Maximum overlay marks to render (default 24, max 80).' },
        // wait_for params
        condition: {
          type: 'string',
          enum: ['element', 'url_includes', 'text', 'navigation_complete', 'network_idle'],
          description: 'Condition type to wait for (action=wait_for).',
        },
        timeoutMs: { type: 'integer', description: 'Overall timeout in ms for wait_for (default 10000).', default: 10000 },
        pollMs: { type: 'integer', description: 'Polling interval in ms for wait_for (default 250).', default: 250 },
        idleMs: { type: 'integer', description: 'Idle window for condition=network_idle (default 1200).', default: 1200 },
      },
      required: ['action'],
    },
  },
  {
    name: 'form_input',
    description: 'Set the value of any form element directly: checkbox, radio, range, color, date, file input. More direct than computer(action=type) for non-text inputs.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID of the form element.' },
        value: { type: 'string', description: 'Value to set (for text, range, date, color, file inputs).' },
        checked: { type: ['boolean', 'string'], description: 'Checked state (for checkboxes and radio buttons).' },
      },
      required: ['target'],
    },
  },
  {
    name: 'javascript',
    description: 'Execute JavaScript in the page context. Universal fallback for any action not covered by other tools: DOM manipulation, drag-and-drop, file uploads, form control, etc. Access to cookies, localStorage, and sessionStorage is blocked.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Returns the result of the last expression.' },
      },
      required: ['code'],
    },
  },

  // ── Tab Management ──────────────────────────────────────────────

  {
    name: 'tabs_create',
    description: 'Open a new tab with URL and optionally make it active.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open.' },
        active: { type: ['boolean', 'string'], description: 'Whether the new tab should be focused (default true).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'tabs_context',
    description: 'Manage browser tabs: list all tabs (default), switch to a tab, close a tab, or switch iframe context. Use the action parameter to choose the operation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'switch', 'close', 'switch_frame'],
          description: 'Tab action: "list" (default, list all tabs), "switch" (switch to tab), "close" (close tab), "switch_frame" (switch iframe context).',
        },
        // switch / close params
        tabId: { type: ['integer', 'string'], description: 'Target tab ID for switch/close.' },
        index: { type: ['integer', 'string'], description: 'Target tab index (0-based) for switch, or iframe index for switch_frame.' },
        // switch_frame params
        main: { type: ['boolean', 'string'], description: 'If true, switch to the top/main document (action=switch_frame).' },
        target: { type: ['integer', 'string'], description: 'Iframe target by agent [id] or frame label (action=switch_frame).' },
      },
    },
  },

  // ── Debug & Monitoring ──────────────────────────────────────────

  {
    name: 'read_console',
    description: 'Read browser console output (logs, warnings, errors) since a given timestamp. Useful for debugging JS errors or reading app-level log output.',
    parameters: {
      type: 'object',
      properties: {
        since: {
          type: 'number',
          description: 'Unix timestamp in ms. Only return entries after this time. Default: 0 (all).',
        },
      },
    },
  },
  {
    name: 'read_network',
    description: 'Read intercepted network requests and responses (fetch/XHR) since a given timestamp. Useful for verifying API calls or reading response data.',
    parameters: {
      type: 'object',
      properties: {
        since: {
          type: 'number',
          description: 'Unix timestamp in ms. Only return entries after this time. Default: 0 (all).',
        },
      },
    },
  },

  // ── Utilities ───────────────────────────────────────────────────

  {
    name: 'resize_window',
    description: 'Resize the browser window to specified dimensions. Useful for testing responsive layouts or ensuring elements are visible.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'integer', description: 'Window width in pixels.' },
        height: { type: 'integer', description: 'Window height in pixels.' },
      },
      required: ['width', 'height'],
    },
  },
  {
    name: 'restore_snapshot',
    description: 'Restore a previously captured browser state snapshot (URL, cookies, scroll position). Use after risky actions when the page state needs rollback.',
    parameters: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string', description: 'Snapshot ID to restore. If omitted, restores latest snapshot.' },
        index: { type: ['integer', 'string'], description: 'Relative index from latest snapshot: 0 = latest, 1 = previous, etc.' },
        restoreUrl: { type: ['boolean', 'string'], description: 'Whether to restore URL/navigation state (default true).' },
        restoreCookies: { type: ['boolean', 'string'], description: 'Whether to restore cookies for the snapshot URL (default true).' },
        restoreScroll: { type: ['boolean', 'string'], description: 'Whether to restore scroll position (default true).' },
      },
    },
  },

  // ── External ────────────────────────────────────────────────────

  {
    name: 'forward',
    description: 'Navigate forward in the browser history (equivalent to pressing the Forward button).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'reload',
    description: 'Reload the current page. Use bypassCache=true to force a hard reload.',
    parameters: {
      type: 'object',
      properties: {
        bypassCache: { type: 'boolean', description: 'If true, bypasses the cache (hard reload). Default: false.' },
      },
    },
  },
  {
    name: 'close_tab',
    description: 'Close the current browser tab. The agent switches to the next available active tab.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'integer', description: 'Tab ID to close. Defaults to the current tab.' },
      },
    },
  },
  {
    name: 'switch_frame',
    description: 'Switch the agent context to an iframe on the page. Use target to specify a frame by selector or agentId.',
    parameters: {
      type: 'object',
      properties: {
        target: { description: 'Frame selector, agentId, or index to switch to.' },
        main: { type: 'boolean', description: 'If true, switch back to the main frame.' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current browser tab. Optionally includes SoM (Set-of-Marks) visual overlays for interactive elements.',
    parameters: {
      type: 'object',
      properties: {
        som: { type: 'boolean', description: 'Include Set-of-Marks overlays. Default: true.' },
        maxMarks: { type: 'integer', description: 'Maximum number of SoM marks to overlay. Default: 24.' },
      },
    },
  },

  {
    name: 'http_request',
    description: 'Make an HTTP request to any URL — REST APIs, webhooks, Notion, Slack, etc. Returns text or JSON. Use to interact with external services without opening a tab.',
    parameters: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Full URL including query parameters if needed.' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method. Default: GET.' },
        headers: { type: 'object', description: 'HTTP headers as key-value pairs (e.g. { "Authorization": "Bearer TOKEN" }).' },
        body: { description: 'Request body. For JSON APIs pass an object; for form data pass a string.' },
        timeout: { type: 'number', description: 'Timeout in milliseconds. Default: 15000.' },
        allow_private: { type: 'boolean', description: 'Set true to allow requests to localhost/private IPs. Default: false.' },
      },
    },
  },
  {
    name: 'notify_connector',
    description: 'Send a message to a connected integration (telegram, notion, slack, discord, airtable, sheets, email, or custom webhook) during task execution.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: 'Connected integration ID, e.g. "telegram", "notion", "slack".' },
        message: { type: 'string', description: 'Message text/content to deliver to the connector.' },
      },
      required: ['connectorId', 'message'],
    },
  },

  // ── Completion ──────────────────────────────────────────────────

  {
    name: 'done',
    description: 'Mark the task as completed successfully. For information tasks, put the extracted answer in the "answer" field. For research/collection tasks (news, articles, reviews, lists), provide comprehensive details — not just titles or headlines.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what was accomplished and how information was gathered (2-3 sentences).' },
        answer: { type: 'string', description: 'Detailed answer with all extracted information. For research/news/collection tasks: include titles, dates, sources, key details, and a brief description of each item. Aim for comprehensive coverage — give context and substance, not just headlines or one-liners.' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'save_progress',
    description: 'Save intermediate findings into persistent task scratchpad memory so they remain available across future steps.',
    parameters: {
      type: 'object',
      properties: {
        data: { description: 'Any JSON-serializable object to merge into accumulated progress.' },
      },
      required: ['data'],
    },
  },
  {
    name: 'fail',
    description: 'Mark the task as failed (cannot be completed).',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the task failed.' },
      },
      required: ['reason'],
    },
  },
];

export function getToolByName(name) {
  return TOOLS.find((t) => t.name === name);
}
