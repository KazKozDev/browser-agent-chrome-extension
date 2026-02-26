/**
 * Tool Definitions
 *
 * JSON Schema definitions for all browser tools.
 * These are sent to the LLM as function calling tools.
 */

export const TOOLS = [
  // ── Page Understanding ──────────────────────────────────────────
  {
    name: 'read_page',
    description: 'Get the accessibility tree of the current page. Returns semantic structure with interactive elements labeled by [id]. Use this as the primary way to understand the page.',
    parameters: {
      type: 'object',
      properties: {
        maxDepth: { type: 'integer', description: 'Max tree depth (default 15)', default: 15 },
        maxNodes: { type: 'integer', description: 'Max nodes to return (default 500)', default: 500 },
        viewportOnly: { type: ['boolean', 'string'], description: 'If true, only returns elements visible in the current viewport' },
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
    name: 'screenshot',
    description: 'Take a screenshot of the current tab. By default adds Set-of-Mark overlays (numbered boxes) matching agent IDs to improve visual grounding.',
    parameters: {
      type: 'object',
      properties: {
        som: {
          type: ['boolean', 'string'],
          description: 'Enable Set-of-Mark numbered overlays (default true). Set false for raw screenshot.',
        },
        maxMarks: {
          type: 'integer',
          description: 'Maximum overlay marks to render (default 24, max 80).',
        },
      },
    },
  },

  // ── Navigation ──────────────────────────────────────────────────
  {
    name: 'navigate',
    description: 'Navigate to a URL. Use full URLs with https://.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http/https URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'back',
    description: 'Go back in browser history for the current tab.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'forward',
    description: 'Go forward in browser history for the current tab.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'reload',
    description: 'Reload the current tab.',
    parameters: {
      type: 'object',
      properties: {
        bypassCache: { type: ['boolean', 'string'], description: 'If true, bypass browser cache while reloading.' },
      },
    },
  },

  // ── Interaction ─────────────────────────────────────────────────
  {
    name: 'click',
    description: 'Click on one or multiple interactive elements by their [id]. To click multiple elements in sequence, pass an array of IDs.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string', 'array'], items: { type: ['integer', 'string'] }, description: 'Element agent ID (the [N] number), or array of IDs' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
        clickCount: { type: 'integer', description: 'Number of clicks: 1 (single), 2 (double), 3 (triple). Default 1.' },
        confirm: { type: ['boolean', 'string'], description: 'Set true for sensitive actions (submit/delete/pay/send)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'type',
    description: 'Type text into one or multiple input fields. Pass arrays for target and text to fill multiple fields at once. Clears existing value first. Set enter=true to submit the form after typing.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string', 'array'], items: { type: ['integer', 'string'] }, description: 'Element agent ID for the input field, or array of IDs' },
        text: { type: ['string', 'array'], items: { type: 'string' }, description: 'Text to type, or array of texts' },
        enter: { type: ['boolean', 'string'], description: 'If true, press Enter after typing to submit the form' },
      },
      required: ['target', 'text'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page up or down.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        amount: { type: 'integer', description: 'Pixels to scroll (default 500)', default: 500 },
      },
      required: ['direction'],
    },
  },
  {
    name: 'select',
    description: 'Select an option from a dropdown/select element.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID for the select' },
        value: { type: 'string', description: 'Option value to select' },
      },
      required: ['target', 'value'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element to trigger hover effects, tooltips, or dropdown menus.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID' },
      },
      required: ['target'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key or shortcut. Useful for Enter, Tab, Escape, Ctrl+A, etc.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name: Enter, Tab, Escape, Backspace, ArrowDown, etc.' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] },
          description: 'Modifier keys to hold (e.g. ["Control"] for Ctrl+key)',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until a condition is true: element appears, URL includes text, page text appears, navigation completes, or network becomes idle.',
    parameters: {
      type: 'object',
      properties: {
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
      required: ['condition'],
    },
  },

  // ── Tabs ────────────────────────────────────────────────────────
  {
    name: 'open_tab',
    description: 'Open a new tab with URL and optionally make it active.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        active: { type: ['boolean', 'string'], description: 'Whether the new tab should be focused (default true)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_tabs',
    description: 'List tabs in the current browser window.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'switch_tab',
    description: 'Switch active tab by tab ID or index.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: ['integer', 'string'], description: 'Target tab ID' },
        index: { type: ['integer', 'string'], description: 'Target tab index in current window (0-based)' },
      },
    },
  },
  {
    name: 'close_tab',
    description: 'Close a tab by tab ID, or close the current tab when tabId is omitted.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: ['integer', 'string'], description: 'Tab ID to close. Defaults to current tab.' },
      },
    },
  },
  {
    name: 'switch_frame',
    description: 'Switch active iframe context for subsequent page tools. Use main=true to return to the top document.',
    parameters: {
      type: 'object',
      properties: {
        main: { type: ['boolean', 'string'], description: 'If true, switch to the top/main document.' },
        target: { type: ['integer', 'string'], description: 'Iframe target by agent [id] or frame label string.' },
        index: { type: ['integer', 'string'], description: '0-based index of accessible iframe in discovery order.' },
      },
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
    description: 'Mark the task as completed successfully. For information tasks, put the extracted answer in the "answer" field.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was accomplished (1 sentence)' },
        answer: { type: 'string', description: 'The actual answer/information extracted from the page. Required for information/search tasks. Include the full relevant text.' },
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
        reason: { type: 'string', description: 'Why the task failed' },
      },
      required: ['reason'],
    },
  },
];

export function getToolByName(name) {
  return TOOLS.find((t) => t.name === name);
}
