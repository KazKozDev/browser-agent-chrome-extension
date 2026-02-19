/**
 * Tool Definitions
 *
 * JSON Schema definitions for all browser tools.
 * These are sent to the LLM as function calling tools.
 */

export const TOOLS = [
  {
    name: 'read_page',
    description: 'Get the accessibility tree of the current page. Returns semantic structure with interactive elements labeled by [id]. Use this as the primary way to understand the page.',
    parameters: {
      type: 'object',
      properties: {
        maxDepth: { type: 'integer', description: 'Max tree depth (default 15)', default: 15 },
        maxNodes: { type: 'integer', description: 'Max nodes to return (default 500)', default: 500 },
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
    description: 'Find plain text on the current page (Ctrl+F style). Returns count and snippets of matches.',
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
    name: 'find_text_next',
    description: 'Go to the next match from the last find_text search (Ctrl+F next).',
    parameters: {
      type: 'object',
      properties: {
        wrap: { type: ['boolean', 'string'], description: 'Wrap to first match after the last one (default true)' },
      },
    },
  },
  {
    name: 'find_text_prev',
    description: 'Go to the previous match from the last find_text search (Ctrl+F previous).',
    parameters: {
      type: 'object',
      properties: {
        wrap: { type: ['boolean', 'string'], description: 'Wrap to last match before the first one (default true)' },
      },
    },
  },
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
        bypassCache: { type: ['boolean', 'string'], description: 'Set true to bypass HTTP cache' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click on an interactive element by its [id] from the accessibility tree.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (the [N] number; integer or numeric string)' },
        confirm: { type: ['boolean', 'string'], description: 'Set true for sensitive actions (submit/delete/pay/send)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'mouse_move',
    description: 'Move mouse cursor to an element center or to absolute viewport coordinates.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (optional if x/y provided)' },
        x: { type: ['integer', 'string'], description: 'Viewport X coordinate' },
        y: { type: ['integer', 'string'], description: 'Viewport Y coordinate' },
      },
    },
  },
  {
    name: 'middle_click',
    description: 'Click the middle mouse button (wheel click) on an element.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID' },
      },
      required: ['target'],
    },
  },
  {
    name: 'triple_click',
    description: 'Triple-click an element (useful for selecting full lines/paragraphs).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID' },
      },
      required: ['target'],
    },
  },
  {
    name: 'left_mouse_down',
    description: 'Press and hold left mouse button on an element or coordinates.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (optional if x/y provided)' },
        x: { type: ['integer', 'string'], description: 'Viewport X coordinate' },
        y: { type: ['integer', 'string'], description: 'Viewport Y coordinate' },
      },
    },
  },
  {
    name: 'left_mouse_up',
    description: 'Release left mouse button at an element or coordinates.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (optional)' },
        x: { type: ['integer', 'string'], description: 'Viewport X coordinate (optional)' },
        y: { type: ['integer', 'string'], description: 'Viewport Y coordinate (optional)' },
      },
    },
  },
  {
    name: 'click_at',
    description: 'Click by absolute viewport coordinates (for canvas/non-DOM controls).',
    parameters: {
      type: 'object',
      properties: {
        x: { type: ['integer', 'string'], description: 'Viewport X coordinate' },
        y: { type: ['integer', 'string'], description: 'Viewport Y coordinate' },
        button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button (default left)' },
        clickCount: { type: 'integer', description: 'Number of clicks (default 1)', default: 1 },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'drag_at',
    description: 'Drag mouse from one viewport coordinate to another.',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: ['integer', 'string'], description: 'Start X coordinate' },
        fromY: { type: ['integer', 'string'], description: 'Start Y coordinate' },
        toX: { type: ['integer', 'string'], description: 'End X coordinate' },
        toY: { type: ['integer', 'string'], description: 'End Y coordinate' },
        steps: { type: 'integer', description: 'Interpolation steps (default 10)', default: 10 },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
  },
  {
    name: 'double_click',
    description: 'Double-click an interactive element by its [id]. Useful for opening items and row activation.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (integer or numeric string)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'right_click',
    description: 'Right-click an element by its [id] to open context menus.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (integer or numeric string)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'drag_drop',
    description: 'Drag source element and drop it on target element.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: ['integer', 'string'], description: 'Source element ID (integer or numeric string)' },
        target: { type: ['integer', 'string'], description: 'Target element ID (integer or numeric string)' },
      },
      required: ['source', 'target'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an input field. Clears existing value first.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID for the input field (integer or numeric string)' },
        text: { type: 'string', description: 'Text to type' },
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
    name: 'hover',
    description: 'Hover over an element to trigger hover effects, tooltips, or dropdown menus.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (integer or numeric string)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'select',
    description: 'Select an option from a dropdown/select element.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID for the select (integer or numeric string)' },
        value: { type: 'string', description: 'Option value to select' },
      },
      required: ['target', 'value'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key. Useful for Enter, Tab, Escape, etc.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name: Enter, Tab, Escape, Backspace, ArrowDown, etc.' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] },
          description: 'Modifier keys to hold',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'hold_key',
    description: 'Hold or release a keyboard modifier key for subsequent actions.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'], description: 'Modifier key' },
        state: {
          type: 'string',
          enum: ['hold', 'release', 'clear'],
          description: 'hold = press/keep, release = release one key, clear = release all held keys',
        },
      },
      required: ['state'],
    },
  },
  {
    name: 'press_hotkey',
    description: 'Press a keyboard shortcut combination (for example Ctrl+L, Ctrl+K, Cmd+Enter).',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Main key in shortcut (for example L, Enter, K)' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] },
          description: 'Modifier keys to hold',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'form_input',
    description: 'Set a form element value directly (checkboxes, radios, hidden fields).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Element agent ID (integer or numeric string)' },
        value: { type: 'string', description: 'Value to set' },
        checked: { type: 'boolean', description: 'For checkboxes/radios' },
        confirm: { type: ['boolean', 'string'], description: 'Set true for sensitive actions (submit/delete/pay/send)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'javascript',
    description: 'Execute JavaScript code in the page MAIN context. Returns the result of the last expression. Use for extracting data, manipulating the DOM, or reading page globals. Access to cookies, localStorage, and sessionStorage is blocked for security.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code to execute' },
      },
      required: ['code'],
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
  {
    name: 'read_console',
    description: 'Read browser console messages (log, warn, error, info). Useful for debugging.',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'Timestamp to filter messages after (0 = all)', default: 0 },
      },
    },
  },
  {
    name: 'read_network',
    description: 'Read recent HTTP network requests with status codes and timing.',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'Timestamp to filter requests after (0 = all)', default: 0 },
      },
    },
  },
  {
    name: 'switch_frame',
    description: 'Switch interaction context to another iframe (same-origin) or back to main document.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'Iframe agent ID, name, id, or the string "main"' },
        index: { type: 'integer', description: 'Iframe index in current document (0-based)' },
        main: { type: ['boolean', 'string'], description: 'Set true to return to top-level document' },
      },
    },
  },
  {
    name: 'upload_file',
    description: 'Upload one or more synthetic files into a file input element. Provide file content as text or base64.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: ['integer', 'string'], description: 'File input element ID (integer or numeric string)' },
        files: {
          type: 'array',
          description: 'Files to upload',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'File name, e.g. report.txt' },
              mimeType: { type: 'string', description: 'MIME type, e.g. text/plain' },
              text: { type: 'string', description: 'Text content for the file' },
              contentBase64: { type: 'string', description: 'Base64 content for binary/text file' },
              lastModified: { type: 'integer', description: 'Unix ms timestamp for file metadata' },
            },
            required: ['name'],
          },
        },
      },
      required: ['target', 'files'],
    },
  },
  {
    name: 'download_status',
    description: 'Read browser download status (recent downloads, progress, and errors).',
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['in_progress', 'complete', 'interrupted', 'any'],
          description: 'Filter by download state (default any)',
        },
        limit: { type: 'integer', description: 'Maximum items to return (default 10)', default: 10 },
      },
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
    name: 'close_tab',
    description: 'Close a tab by ID. If omitted, closes current tab.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: ['integer', 'string'], description: 'Tab ID to close (optional)' },
      },
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
  {
    name: 'wait',
    description: 'Wait for a specified duration in milliseconds.',
    parameters: {
      type: 'object',
      properties: {
        duration: { type: 'integer', description: 'Milliseconds to wait', default: 1000 },
      },
    },
  },
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
