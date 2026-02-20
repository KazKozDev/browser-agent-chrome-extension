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
    description: 'Get the raw text content of the page. Use for text-heavy pages like articles, docs, or when you need to read the full content.',
    parameters: {
      type: 'object',
      properties: {},
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
    description: 'Take a screenshot of the current tab. The image will be sent to the LLM as a vision message for visual understanding.',
    parameters: {
      type: 'object',
      properties: {},
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

  // ── Interaction ─────────────────────────────────────────────────
  {
    name: 'click',
    description: 'Click on an interactive element by its [id]. Supports left/right/middle button and single/double/triple click via optional params.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (the [N] number)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left)' },
        clickCount: { type: 'integer', description: 'Number of clicks: 1 (single), 2 (double), 3 (triple). Default 1.' },
        confirm: { type: ['boolean', 'string'], description: 'Set true for sensitive actions (submit/delete/pay/send)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an input field. Clears existing value first. Set enter=true to submit the form after typing.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID for the input field' },
        text: { type: 'string', description: 'Text to type' },
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

  // ── JavaScript (universal fallback) ─────────────────────────────
  {
    name: 'javascript',
    description: 'Execute JavaScript in the page context. Universal fallback for any action not covered by other tools: DOM manipulation, drag-and-drop, file uploads, form control, reading console/network, etc. Access to cookies, localStorage, and sessionStorage is blocked.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute. Returns the result of the last expression.' },
      },
      required: ['code'],
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
