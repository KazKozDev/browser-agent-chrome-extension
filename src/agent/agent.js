/**
 * Agent Loop
 *
 * Core agent that orchestrates: observe → think → act
 * Uses accessibility tree (primary) + screenshot (vision fallback)
 * Communicates with content script for page understanding and actions.
 */

import { TOOLS } from '../tools/tools.js';

const SYSTEM_PROMPT = `You are a browser automation agent. You execute the user's task precisely — nothing more, nothing less.

## Execution Rules
1. Do EXACTLY what was asked. Do not perform extra actions beyond the task.
2. Call done IMMEDIATELY when the task is fulfilled. Do not continue exploring.
3. This is single-task execution, NOT a conversation. Never ask follow-up questions like "What would you like to do next?" — just complete the task and call done.
4. Be efficient: minimize the number of steps. A simple navigation task = navigate + done (2 steps).

## Task Types

### Action tasks (open, click, fill, navigate)
- Execute the action, verify it worked, call done with a brief summary.

### Information tasks (find, search, check, look up, how to, what is, как пишется, найди, проверь)
- You MUST extract the actual answer from the page and include it in the done summary.
- DO NOT just type a query and call done. You must READ the results.
- The workflow is: navigate → search/interact → read_page or get_page_text → extract answer → done(answer).
- Use read_page or get_page_text AFTER the results load to get the actual content.
- Your done summary should contain the ANSWER the user is looking for, not just "searched for X".

### ANTI-PATTERNS (never do this)
- ❌ Type query → screenshot → done "I searched for X" (you didn't provide the answer!)
- ❌ Navigate → done "opened the page" when the task asked to FIND something
- ✅ Type query → read results → done "The answer is: ..."

## How You Work
1. Understand the task from the user message
2. If the task requires interacting with page elements, use read_page first to see the structure
3. Interactive elements are labeled with [id] numbers — use these IDs to target actions
4. Execute actions, verify they worked, then call done with a summary
5. For information tasks, always READ the result page and include the answer

## Tool Usage
- read_page: Primary way to understand page structure. Use BEFORE clicking/typing. Do NOT call it twice in a row without acting in between.
- get_page_text: Get full text content of the page. Use this to extract answers from result pages.
- find: Locate elements by description when you don't know the [id]
- find_text: Search plain text on the page like Ctrl+F when you need exact words/phrases.
- find_text_next/find_text_prev: Move through current text search results after find_text.
- If read_page doesn't give enough info and you have vision capability, use screenshot
- If you're running on a text-only model, rely on read_page and javascript
- hover: Reveal tooltips or dropdown menus before clicking
- navigate: Go to a URL. For tasks like "open site X", just navigate and call done.
- javascript: Inspect DOM or extract data when other tools aren't sufficient
- mouse_move/click_at/drag_at: Use for canvas-like UIs or when no stable element IDs are available.
- hold_key + click: Use for multi-select workflows (Ctrl/Cmd/Shift click behaviors).
- middle_click/triple_click/left_mouse_down/left_mouse_up: Use advanced mouse interactions when needed.
- back/forward/reload: Use browser navigation controls instead of retyping URLs.
- wait_for: Use after actions on dynamic pages (element/text/url/network idle) before the next step.
- list_tabs/switch_tab/open_tab/close_tab: Use for multi-tab workflows.
- switch_frame: Use when content is inside an iframe. Switch back with target="main" or main=true.
- right_click/double_click/drag_drop: Use for advanced pointer interactions.
- press_hotkey: Use keyboard shortcuts (Ctrl/Cmd/Shift/Alt combos).
- upload_file: Use only on file inputs. Provide file content as text or base64.
- download_status: Check if downloads are in progress, completed, or failed.

## Safety Rules
- Never enter passwords, credit card numbers, or sensitive data unless explicitly provided
- Ask before submitting forms with financial implications
- Don't delete data without confirmation
- Don't navigate away from the current task without reason
- Use tool argument "confirm: true" only when user intent for sensitive actions is explicit`;

// Patterns blocked in javascript tool for security
const BLOCKED_JS_PATTERNS = [
  { re: /document\.cookie/i, msg: 'Access to document.cookie is blocked for security' },
  { re: /localStorage\s*[.[]/i, msg: 'Access to localStorage is blocked for security' },
  { re: /sessionStorage\s*[.[]/i, msg: 'Access to sessionStorage is blocked for security' },
  { re: /indexedDB/i, msg: 'Access to indexedDB is blocked for security' },
  { re: /\.setRequestHeader\s*\(\s*['"]Authorization/i, msg: 'Setting auth headers is blocked' },
];

const AUTH_URL_HINT_RE = /(?:^|[/?#._-])(login|log-in|signin|sign-in|auth|authorize|oauth|challenge|verify|captcha)(?:[/?#._-]|$)/i;
const CAPTCHA_HINTS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  "i'm not a robot",
  'i am not a robot',
  'verify you are human',
  'prove you are human',
  'подтвердите, что вы не робот',
  'подтвердите что вы не робот',
  'я не робот',
];
const LOGIN_HINTS = [
  'sign in',
  'signin',
  'log in',
  'login',
  'вход',
  'войти',
  'авторизац',
  'authenticate',
  'verification code',
  'two-factor',
  '2fa',
];
const PASSWORD_HINTS = [
  'password',
  'пароль',
  'passcode',
  'one-time code',
  'одноразовый код',
  'otp',
  'sms code',
];

export class Agent {
  constructor(providerManager, tabId) {
    this.provider = providerManager;
    this.tabId = tabId;
    this.history = [];
    this.maxSteps = 50;
    this.maxConversationMessages = 28;
    this.status = 'idle'; // idle | running | paused_waiting_user | done | failed
    this.onStep = null; // callback(step)
    this.onStatus = null; // callback(status)
    this.onIntervention = null; // callback(details)
    this._aborted = false;
    this._goal = '';
    this.metrics = null;
    this._onTabUpdated = null;
    this._lastKnownUrl = '';
    this._resumeResolver = null;
    this._isWaitingForUser = false;
  }

  /**
   * Check if current provider supports vision (screenshots).
   */
  _providerSupportsVision() {
    return !!this.provider.currentProvider?.supportsVision;
  }

  /**
   * Run the agent loop for a given goal.
   */
  async run(goal) {
    this.status = 'running';
    this._aborted = false;
    this._goal = goal || '';
    this.history = [];
    this._lastKnownUrl = '';
    this.metrics = {
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
      errors: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
    };
    this._notify('running');
    this._startTabWatcher();

    // Enable monitoring in content script
    try {
      await this._sendToContent('startMonitoring', {});
      await this._clearFindTextContext();
    } catch { /* may fail on restricted pages */ }

    // Get current page context for multi-task awareness
    let pageContext = '';
    try {
      const tab = await chrome.tabs.get(this.tabId);
      if (tab?.url && !tab.url.startsWith('chrome://')) {
        pageContext = `\nCurrent page: ${tab.url}` + (tab.title ? ` ("${tab.title}")` : '');
      }
    } catch { /* tab may not exist yet */ }

    // Build task-aware initial message
    const goalLower = (goal || '').toLowerCase();
    const isNavigateOnly = /^(open|go to|navigate|перейди|открой|зайди|покажи)\s/i.test(goal.trim());
    let taskMessage = `Task: ${goal}`;
    if (pageContext) taskMessage += pageContext;
    if (isNavigateOnly) {
      taskMessage += '\n\nThis is a navigation task. Navigate to the URL and call done immediately. Do NOT read the page or perform any other actions.';
    } else {
      taskMessage += '\n\nStart by reading the current page to understand where we are, then take action.';
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: taskMessage },
    ];

    try {
      for (let step = 0; step < this.maxSteps; step++) {
        if (this._aborted) {
          this.status = 'failed';
          this._notify('failed');
          return { success: false, reason: 'Aborted by user', steps: step, metrics: this._finalizeMetrics() };
        }

        try {
          await this._pauseIfManualInterventionNeeded(step, messages);
          if (this._aborted) {
            this.status = 'failed';
            this._notify('failed');
            return { success: false, reason: 'Aborted by user', steps: step, metrics: this._finalizeMetrics() };
          }

          // 1. Ask LLM what to do
          this.metrics.llmCalls += 1;
          // Filter tools based on provider capabilities
          let activeTools = TOOLS;
          if (!this._providerSupportsVision()) {
            activeTools = TOOLS.filter(t => t.name !== 'screenshot');
          }
          const response = await this.provider.chat(messages, activeTools);
          this._recordUsage(response?.usage);

          // 2. Handle text response (thinking out loud)
          if (response.text) {
            this.history.push({ step, type: 'thought', content: response.text });
            this._emitStep({ step, type: 'thought', content: response.text });
          }

          // 3. Handle tool calls
          if (response.toolCalls && response.toolCalls.length > 0) {
            const result = await this._handleToolCalls(step, messages, response);
            if (result) return result; // terminal action (done/fail)
          } else if (response.text) {
            // Pure text response — add to messages and continue
            this._appendMessage(messages, { role: 'assistant', content: response.text });
            this._appendMessage(messages, {
              role: 'user',
              content: 'Please use a tool to take the next action. Call read_page to see the current state, or use another tool.',
            });
          }
        } catch (err) {
          console.error(`[Agent] Step ${step} error:`, err);
          this.metrics.errors += 1;
          this.history.push({ step, type: 'error', error: err.message });
          this._emitStep({ step, type: 'error', error: err.message });

          this._appendMessage(messages, {
            role: 'user',
            content: `Error occurred: ${err.message}. Try a different approach.`,
          });
        }
      }
    } finally {
      this._stopTabWatcher();
      // Disable monitoring in content script
      try {
        await this._sendToContent('stopMonitoring', {});
      } catch { /* noop */ }
    }

    this.status = 'failed';
    this._notify('failed');
    return { success: false, reason: 'Max steps reached', steps: this.maxSteps, metrics: this._finalizeMetrics() };
  }

  /**
   * Handle all tool calls from a single LLM response.
   * Groups them into one assistant message (fixes OpenAI API format).
   */
  async _handleToolCalls(step, messages, response) {
    const toolCalls = response.toolCalls;

    // Build single assistant message with ALL tool_calls
    const assistantToolCalls = toolCalls.map((tc, i) => {
      const normalizedArgs = this._normalizeToolArgs(tc.name, tc.arguments || {});
      return {
        id: tc.id || `call_${step}_${i}_${tc.name}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(normalizedArgs),
        },
        _normalized: normalizedArgs, // internal, stripped before sending
      };
    });

    this._appendMessage(messages, {
      role: 'assistant',
      content: response.text || null,
      tool_calls: assistantToolCalls.map(({ _normalized, ...tc }) => tc),
    });

    // Execute each tool and collect results
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const normalizedArgs = assistantToolCalls[i]._normalized;
      const toolCallId = assistantToolCalls[i].id;

      this.metrics.toolCalls += 1;

      // JS safety check
      if (tc.name === 'javascript') {
        const blocked = this._checkJsSafety(normalizedArgs.code);
        if (blocked) {
          const result = this._makeError('JS_BLOCKED', blocked);
          this.history.push({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
          this._emitStep({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
          this._appendMessage(messages, {
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(result),
          });
          continue;
        }
      }

      const result = await this._executeTool(tc.name, normalizedArgs);

      this.history.push({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });
      this._emitStep({ step, type: 'action', tool: tc.name, args: normalizedArgs, result });

      // Check terminal actions
      if (tc.name === 'done') {
        this.status = 'done';
        this._notify('done');
        return { success: true, summary: normalizedArgs.summary, answer: normalizedArgs.answer || '', steps: step + 1, metrics: this._finalizeMetrics() };
      }
      if (tc.name === 'fail') {
        this.status = 'failed';
        this._notify('failed');
        return { success: false, reason: normalizedArgs.reason, steps: step + 1, metrics: this._finalizeMetrics() };
      }

      // Screenshot → vision integration
      if (tc.name === 'screenshot' && result?.success && result?.imageBase64) {
        this._appendMessage(messages, {
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ success: true, note: 'Screenshot captured and attached as image below.' }),
        });
        // Add the actual image as a vision message
        const currentProvider = this.provider.currentProvider;
        if (currentProvider?.supportsVision) {
          this._appendMessage(messages,
            currentProvider.buildVisionMessage(
              'Here is the screenshot of the current page. Describe what you see and decide the next action.',
              result.imageBase64,
            ),
          );
        } else {
          // Text-only model — don't send image, just note
          this._appendMessage(messages, {
            role: 'user',
            content: 'Screenshot was captured but cannot be displayed (text-only model). Use read_page instead.',
          });
        }
      } else {
        this._appendMessage(messages, {
          role: 'tool',
          tool_call_id: toolCallId,
          content: this._serializeToolResultForLLM(tc.name, result),
        });
      }
    }

    return null; // not terminal
  }

  /**
   * Execute a tool by name.
   */
  async _executeTool(name, args) {
    switch (name) {
      case 'read_page':
        return await this._sendToContent('readPage', {
          maxDepth: Math.min(Math.max(Number(args?.maxDepth) || 12, 1), 12),
          maxNodes: Math.min(Math.max(Number(args?.maxNodes) || 180, 20), 220),
        });

      case 'get_page_text':
        return await this._sendToContent('getPageText', {});

      case 'find':
        return await this._sendToContent('find', { query: args.query });

      case 'find_text':
        return await this._sendToContent('findText', {
          query: args.query,
          caseSensitive: args.caseSensitive === true,
          wholeWord: args.wholeWord === true,
          maxResults: args.maxResults,
          scrollToFirst: args.scrollToFirst !== false,
        });

      case 'find_text_next':
        return await this._sendToContent('findTextNext', {
          wrap: args.wrap !== false,
        });

      case 'find_text_prev':
        return await this._sendToContent('findTextPrev', {
          wrap: args.wrap !== false,
        });

      case 'navigate':
        {
          const validatedUrl = this._validateNavigateUrl(args.url);
          await this._clearFindTextContext();
          await chrome.tabs.update(this.tabId, { url: validatedUrl });
          await this._waitForNavigation();
          // Enable monitoring on new page
          try {
            await this._sendToContent('startMonitoring', {});
          } catch { /* noop */ }
          return { success: true, url: validatedUrl };
        }

      case 'back':
        return await this._navigateHistory('back');

      case 'forward':
        return await this._navigateHistory('forward');

      case 'reload': {
        await this._clearFindTextContext();
        await chrome.tabs.reload(this.tabId, { bypassCache: args.bypassCache === true });
        await this._waitForNavigation();
        return { success: true, description: 'Reloaded current tab' };
      }

      case 'click':
        return await this._sendToContent('executeAction', {
          type: 'click',
          target: args.target,
          params: { confirm: args.confirm === true },
        });

      case 'mouse_move':
        return await this._sendToContent('executeAction', {
          type: 'mouse_move',
          target: args.target,
          params: { x: args.x, y: args.y },
        });

      case 'middle_click':
        return await this._sendToContent('executeAction', {
          type: 'middle_click',
          target: args.target,
          params: {},
        });

      case 'triple_click':
        return await this._sendToContent('executeAction', {
          type: 'triple_click',
          target: args.target,
          params: {},
        });

      case 'left_mouse_down':
        return await this._sendToContent('executeAction', {
          type: 'left_mouse_down',
          target: args.target,
          params: { x: args.x, y: args.y },
        });

      case 'left_mouse_up':
        return await this._sendToContent('executeAction', {
          type: 'left_mouse_up',
          target: args.target,
          params: { x: args.x, y: args.y },
        });

      case 'click_at':
        return await this._sendToContent('executeAction', {
          type: 'click_at',
          target: null,
          params: { x: args.x, y: args.y, button: args.button, clickCount: args.clickCount },
        });

      case 'drag_at':
        return await this._sendToContent('executeAction', {
          type: 'drag_at',
          target: null,
          params: {
            fromX: args.fromX,
            fromY: args.fromY,
            toX: args.toX,
            toY: args.toY,
            steps: args.steps,
          },
        });

      case 'double_click':
        return await this._sendToContent('executeAction', {
          type: 'double_click',
          target: args.target,
          params: {},
        });

      case 'right_click':
        return await this._sendToContent('executeAction', {
          type: 'right_click',
          target: args.target,
          params: {},
        });

      case 'drag_drop':
        return await this._sendToContent('executeAction', {
          type: 'drag_drop',
          target: args.target,
          params: { source: args.source },
        });

      case 'type':
        return await this._sendToContent('executeAction', {
          type: 'type',
          target: args.target,
          params: { text: args.text },
        });

      case 'scroll':
        return await this._sendToContent('executeAction', {
          type: 'scroll',
          target: args.direction,
          params: { amount: args.amount || 500 },
        });

      case 'hover':
        return await this._sendToContent('executeAction', {
          type: 'hover',
          target: args.target,
          params: {},
        });

      case 'select':
        return await this._sendToContent('executeAction', {
          type: 'select',
          target: args.target,
          params: { value: args.value },
        });

      case 'press_key':
        return await this._sendToContent('executeAction', {
          type: 'press_key',
          target: null,
          params: { key: args.key, modifiers: args.modifiers },
        });

      case 'press_hotkey':
        return await this._sendToContent('executeAction', {
          type: 'press_key',
          target: null,
          params: { key: args.key, modifiers: args.modifiers },
        });

      case 'hold_key':
        return await this._sendToContent('executeAction', {
          type: 'hold_key',
          target: args.key || null,
          params: { key: args.key, state: args.state },
        });

      case 'form_input':
        return await this._sendToContent('executeAction', {
          type: 'form_input',
          target: args.target,
          params: { value: args.value, checked: args.checked, confirm: args.confirm === true },
        });

      case 'javascript':
        return await this._executeJavaScriptMainWorld(args.code);

      case 'wait_for':
        return await this._waitForCondition(args);

      case 'read_console':
        return await this._sendToContent('readConsole', { since: args.since || 0 });

      case 'read_network':
        return await this._sendToContent('readNetwork', { since: args.since || 0 });

      case 'switch_frame':
        return await this._sendToContent('executeAction', {
          type: 'switch_frame',
          target: args.target,
          params: { main: args.main === true, index: args.index },
        });

      case 'upload_file':
        return await this._sendToContent('executeAction', {
          type: 'upload_file',
          target: args.target,
          params: { files: args.files || [] },
        });

      case 'download_status':
        return await this._getDownloadStatus(args);

      case 'list_tabs':
        return await this._listTabs();

      case 'switch_tab':
        return await this._switchTab(args);

      case 'open_tab':
        return await this._openTab(args);

      case 'close_tab':
        return await this._closeTab(args);

      case 'screenshot':
        if (!this._providerSupportsVision()) {
          return {
            success: true,
            note: 'Screenshot skipped — text-only model. Use read_page for page structure.',
            fallback: 'read_page',
          };
        }
        return await this._takeScreenshot();

      case 'wait':
        await new Promise((r) => setTimeout(r, args.duration || 1000));
        return { success: true, waited: args.duration || 1000 };

      case 'done':
        return { success: true, summary: args.summary, answer: args.answer || '' };

      case 'fail':
        return { success: false, reason: args.reason };

      default:
        return this._makeError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    }
  }

  /**
   * Send message to content script in the active tab.
   */
  async _sendToContent(action, payload) {
    try {
      const response = await chrome.tabs.sendMessage(this.tabId, { action, payload });
      return response ?? this._makeError('EMPTY_CONTENT_RESPONSE', 'No response from content script');
    } catch (err) {
      const msg = String(err?.message || err);
      const needsInjection =
        msg.includes('Receiving end does not exist') ||
        msg.includes('Could not establish connection');

      if (needsInjection) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: this.tabId },
            files: ['src/content/content.js'],
          });
          const retryResponse = await chrome.tabs.sendMessage(this.tabId, { action, payload });
          return retryResponse ?? this._makeError('EMPTY_CONTENT_RESPONSE', 'No response from content script');
        } catch (injectErr) {
          return this._makeError('CONTENT_SCRIPT_UNAVAILABLE', `Content script injection failed: ${injectErr.message}`);
        }
      }

      return this._makeError('CONTENT_COMMUNICATION_FAILED', `Content script communication failed: ${msg}`);
    }
  }

  /**
   * Take a screenshot of the current tab.
   */
  async _takeScreenshot() {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: 'png',
        quality: 80,
      });
      const base64 = dataUrl.split(',')[1];
      return {
        success: true,
        imageBase64: base64,
        format: 'png',
      };
    } catch (err) {
      return this._makeError('SCREENSHOT_FAILED', `Screenshot failed: ${err.message}`);
    }
  }

  async _executeJavaScriptMainWorld(code) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        world: 'MAIN',
        func: (source) => {
          try {
            // eslint-disable-next-line no-eval
            const value = (0, eval)(source);
            return {
              success: true,
              result: value !== undefined ? String(value).slice(0, 5000) : 'undefined',
            };
          } catch (err) {
            return {
              success: false,
              code: 'JS_EXEC_FAILED',
              error: err?.message || String(err),
            };
          }
        },
        args: [String(code ?? '')],
      });
      return injection?.result || this._makeError('JS_EXEC_FAILED', 'No result from JS execution');
    } catch (err) {
      return this._makeError('JS_EXEC_FAILED', err.message);
    }
  }

  async _navigateHistory(direction) {
    try {
      await this._clearFindTextContext();
      if (direction === 'back') {
        if (typeof chrome.tabs.goBack === 'function') {
          await chrome.tabs.goBack(this.tabId);
        } else {
          await this._executeJavaScriptMainWorld('history.back()');
        }
      } else if (direction === 'forward') {
        if (typeof chrome.tabs.goForward === 'function') {
          await chrome.tabs.goForward(this.tabId);
        } else {
          await this._executeJavaScriptMainWorld('history.forward()');
        }
      } else {
        return this._makeError('INVALID_ACTION', `Unknown history direction: ${direction}`);
      }
      await this._waitForNavigation();
      try {
        await this._sendToContent('startMonitoring', {});
      } catch { /* noop */ }
      return { success: true, direction };
    } catch (err) {
      return this._makeError('HISTORY_NAV_FAILED', err.message, { direction });
    }
  }

  async _waitForCondition(args = {}) {
    const condition = args.condition || 'navigation_complete';
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10000, 100), 120000);
    const pollMs = Math.min(Math.max(Number(args.pollMs) || 250, 50), 5000);
    const startedAt = Date.now();

    if (condition === 'element') {
      const target = args.target;
      const result = await this._sendToContent('waitForElement', {
        agentId: target,
        timeout: timeoutMs,
      });
      if (result?.found) {
        return { success: true, condition, target, waitedMs: Date.now() - startedAt };
      }
      return this._makeError('WAIT_TIMEOUT', `Element [${target}] did not appear in time`, { condition, waitedMs: Date.now() - startedAt });
    }

    if (condition === 'navigation_complete') {
      await this._waitForNavigation(timeoutMs);
      return { success: true, condition, waitedMs: Date.now() - startedAt };
    }

    if (condition === 'url_includes') {
      const needle = String(args.value || '').trim();
      if (!needle) return this._makeError('INVALID_WAIT_ARGUMENTS', 'wait_for(url_includes) requires value');
      while ((Date.now() - startedAt) < timeoutMs) {
        const tab = await chrome.tabs.get(this.tabId);
        const url = String(tab?.url || '');
        if (url.includes(needle)) {
          return { success: true, condition, value: needle, url, waitedMs: Date.now() - startedAt };
        }
        await this._sleep(pollMs);
      }
      return this._makeError('WAIT_TIMEOUT', `URL did not include "${needle}" in time`, { condition, waitedMs: Date.now() - startedAt });
    }

    if (condition === 'text') {
      const needle = String(args.value || '').trim();
      if (!needle) return this._makeError('INVALID_WAIT_ARGUMENTS', 'wait_for(text) requires value');
      const needleNorm = needle.toLowerCase();
      while ((Date.now() - startedAt) < timeoutMs) {
        const page = await this._sendToContent('getPageText', {});
        const haystack = String(page?.text || '').toLowerCase();
        if (haystack.includes(needleNorm)) {
          return { success: true, condition, value: needle, waitedMs: Date.now() - startedAt };
        }
        await this._sleep(pollMs);
      }
      return this._makeError('WAIT_TIMEOUT', `Text "${needle}" did not appear in time`, { condition, waitedMs: Date.now() - startedAt });
    }

    if (condition === 'network_idle') {
      const idleMs = Math.min(Math.max(Number(args.idleMs) || 1200, 200), 30000);
      let since = Date.now();
      let lastActivity = Date.now();

      while ((Date.now() - startedAt) < timeoutMs) {
        const events = await this._sendToContent('readNetwork', { since });
        if (Array.isArray(events) && events.length > 0) {
          const lastTs = events.reduce((acc, e) => Math.max(acc, Number(e.timestamp) || 0), since);
          since = lastTs + 1;
          lastActivity = Date.now();
        }
        if ((Date.now() - lastActivity) >= idleMs) {
          return { success: true, condition, idleMs, waitedMs: Date.now() - startedAt };
        }
        await this._sleep(pollMs);
      }
      return this._makeError('WAIT_TIMEOUT', 'Network did not become idle in time', { condition, waitedMs: Date.now() - startedAt });
    }

    return this._makeError('INVALID_WAIT_CONDITION', `Unsupported wait_for condition: ${condition}`);
  }

  async _listTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return {
      success: true,
      currentTabId: this.tabId,
      tabs: tabs.map((t) => ({
        id: t.id,
        index: t.index,
        active: !!t.active,
        title: t.title || '',
        url: t.url || '',
        pinned: !!t.pinned,
      })),
    };
  }

  async _switchTab(args = {}) {
    let targetTab = null;

    if (args.tabId !== undefined && args.tabId !== null) {
      const id = Number(args.tabId);
      if (Number.isInteger(id)) {
        targetTab = await chrome.tabs.get(id);
      }
    } else if (args.index !== undefined && args.index !== null) {
      const index = Number(args.index);
      if (Number.isInteger(index) && index >= 0) {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        targetTab = tabs.find((t) => t.index === index) || null;
      }
    }

    if (!targetTab?.id) {
      return this._makeError('TAB_NOT_FOUND', 'switch_tab requires a valid tabId or index');
    }

    await chrome.tabs.update(targetTab.id, { active: true });
    this.tabId = targetTab.id;
    try {
      await this._sendToContent('startMonitoring', {});
      await this._clearFindTextContext();
    } catch { /* noop */ }
    return {
      success: true,
      tabId: targetTab.id,
      index: targetTab.index,
      title: targetTab.title || '',
      url: targetTab.url || '',
    };
  }

  async _openTab(args = {}) {
    const url = this._validateNavigateUrl(args.url);
    const active = args.active !== false;
    const tab = await chrome.tabs.create({ url, active });
    if (active && tab?.id) {
      this.tabId = tab.id;
      await this._waitForNavigation();
      try {
        await this._sendToContent('startMonitoring', {});
        await this._clearFindTextContext();
      } catch { /* noop */ }
    }
    return { success: true, tabId: tab?.id, url, active: !!active };
  }

  async _closeTab(args = {}) {
    const tabId = args.tabId !== undefined && args.tabId !== null
      ? Number(args.tabId)
      : this.tabId;
    if (!Number.isInteger(tabId)) {
      return this._makeError('INVALID_TAB_ID', 'close_tab requires a valid tabId');
    }
    await chrome.tabs.remove(tabId);
    if (tabId === this.tabId) {
      const [next] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (next?.id) {
        this.tabId = next.id;
        try {
          await this._sendToContent('startMonitoring', {});
          await this._clearFindTextContext();
        } catch { /* noop */ }
      }
    }
    return { success: true, closedTabId: tabId, currentTabId: this.tabId };
  }

  async _getDownloadStatus(args = {}) {
    if (!chrome.downloads || typeof chrome.downloads.search !== 'function') {
      return this._makeError('DOWNLOADS_API_UNAVAILABLE', 'Downloads API unavailable. Add "downloads" permission in manifest.');
    }

    const state = args.state && args.state !== 'any' ? String(args.state) : undefined;
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const query = { limit };
    if (state) query.state = state;

    const items = await chrome.downloads.search(query);
    return {
      success: true,
      total: items.length,
      downloads: items.map((d) => ({
        id: d.id,
        state: d.state,
        filename: d.filename || '',
        url: d.url || '',
        bytesReceived: d.bytesReceived || 0,
        totalBytes: d.totalBytes || 0,
        error: d.error || '',
        startTime: d.startTime || '',
        endTime: d.endTime || '',
      })),
    };
  }

  async _clearFindTextContext() {
    try {
      await this._sendToContent('clearFindText', {});
    } catch {
      // Best-effort cleanup; ignore failures on restricted pages.
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check JavaScript code for dangerous patterns.
   */
  _checkJsSafety(code) {
    if (!code) return null;
    for (const { re, msg } of BLOCKED_JS_PATTERNS) {
      if (re.test(code)) return msg;
    }
    return null;
  }

  /**
   * Wait for tab navigation to complete.
   */
  _waitForNavigation(timeout = 10000) {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const timer = setTimeout(finish, timeout);
      const listener = (tabId, info) => {
        if (tabId === this.tabId && info.status === 'complete') {
          cleanup();
          setTimeout(finish, 500);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  // ===== Tab URL change watcher =====

  _startTabWatcher() {
    this._onTabUpdated = (tabId, changeInfo) => {
      if (tabId === this.tabId && changeInfo.url) {
        this._lastKnownUrl = changeInfo.url;
        // Re-enable monitoring on the new page after navigation
        this._sendToContent('startMonitoring', {}).catch(() => { });
      }
    };
    chrome.tabs.onUpdated.addListener(this._onTabUpdated);
  }

  _stopTabWatcher() {
    if (this._onTabUpdated) {
      chrome.tabs.onUpdated.removeListener(this._onTabUpdated);
      this._onTabUpdated = null;
    }
  }

  abort() {
    this._aborted = true;
    if (this._resumeResolver) {
      const resolver = this._resumeResolver;
      this._resumeResolver = null;
      resolver(false);
    }
  }

  resume() {
    if (this.status !== 'paused_waiting_user' || !this._resumeResolver) return false;
    const resolver = this._resumeResolver;
    this._resumeResolver = null;
    resolver(true);
    return true;
  }

  _emitStep(step) {
    if (this.onStep) this.onStep(step);
  }

  _notify(status) {
    if (this.onStatus) this.onStatus(status);
  }

  _emitIntervention(details) {
    if (this.onIntervention) this.onIntervention(details);
  }

  _makeError(code, error, details = {}) {
    return { success: false, code, error, ...details };
  }

  _recordUsage(usage) {
    if (!this.metrics || !usage) return;
    const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
    const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
    const total = Number(usage.total_tokens || prompt + completion);
    this.metrics.tokens.prompt += Number.isFinite(prompt) ? prompt : 0;
    this.metrics.tokens.completion += Number.isFinite(completion) ? completion : 0;
    this.metrics.tokens.total += Number.isFinite(total) ? total : 0;
  }

  _appendMessage(messages, message) {
    messages.push(message);
    this._trimMessages(messages);
  }

  /**
   * Trim conversation messages while preserving complete turns.
   * A turn = assistant(tool_calls) + all its tool results (+ optional vision user message).
   * Never splits a turn in the middle.
   */
  _trimMessages(messages) {
    const keepHead = 2; // system + initial user task
    const maxTotal = this.maxConversationMessages;
    if (messages.length <= maxTotal) return;

    let removeEnd = keepHead;
    const target = messages.length - maxTotal;
    let removed = 0;

    while (removed < target && removeEnd < messages.length - 2) {
      const msg = messages[removeEnd];

      if (msg.role === 'assistant' && msg.tool_calls) {
        // Find the end of this turn: assistant + tool results + optional vision
        let groupEnd = removeEnd + 1;
        while (groupEnd < messages.length) {
          const next = messages[groupEnd];
          if (next.role === 'tool') {
            groupEnd++;
          } else if (next.role === 'user' && Array.isArray(next.content)) {
            // Vision message attached to this turn
            groupEnd++;
          } else {
            break;
          }
        }
        const groupSize = groupEnd - removeEnd;
        removed += groupSize;
        removeEnd = groupEnd;
      } else {
        // Single message (user or standalone assistant)
        removed++;
        removeEnd++;
      }
    }

    if (removeEnd > keepHead) {
      messages.splice(keepHead, removeEnd - keepHead);
    }
  }

  _finalizeMetrics() {
    if (!this.metrics) return null;
    this.metrics.finishedAt = Date.now();
    this.metrics.durationMs = this.metrics.finishedAt - this.metrics.startedAt;
    return this.metrics;
  }

  _validateNavigateUrl(url) {
    let raw = String(url || '').trim();
    // Auto-add https:// if LLM sends bare domain (e.g. "gramota.ru")
    if (raw && !raw.includes('://') && !raw.startsWith('about:')) {
      raw = 'https://' + raw;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid URL: "${url}". Use a full http/https URL like https://example.com`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
    }
    return parsed.toString();
  }

  _goalAllowsSensitiveActions() {
    const text = String(this._goal || '').toLowerCase();
    const allowTerms = [
      'confirm', 'i confirm', 'i approve', 'approved', 'yes, proceed',
      'подтверждаю', 'разрешаю', 'одобряю', 'можно отправить', 'можно удалить',
      'send email', 'delete', 'remove', 'pay', 'purchase', 'checkout', 'transfer',
      'отправь', 'удали', 'оплати', 'переведи', 'купи',
    ];
    return allowTerms.some((term) => text.includes(term));
  }

  _goalExplicitlyRequestsAuthPage() {
    const text = String(this._goal || '').toLowerCase();
    return [
      'login page',
      'sign in page',
      'auth page',
      'oauth page',
      'страница входа',
      'страницу входа',
      'экран входа',
      'окно входа',
    ].some((term) => text.includes(term));
  }

  _serializeToolResultForLLM(toolName, result) {
    let safe = result;

    // Never feed base64 blobs into conversation history.
    if (toolName === 'screenshot' && safe?.imageBase64) {
      safe = {
        ...safe,
        imageBase64: `[omitted base64 image, ${safe.imageBase64.length} chars]`,
      };
    }

    // Compress very large read_page payloads before appending to model context.
    if (toolName === 'read_page' && safe?.tree) {
      safe = this._compressReadPageForLLM(safe);
    }

    let serialized = '';
    try {
      serialized = JSON.stringify(safe);
    } catch {
      return JSON.stringify({ error: 'Tool result serialization failed' });
    }

    const maxChars = 10000;
    if (serialized.length <= maxChars) return serialized;
    return JSON.stringify({
      truncated: true,
      originalLength: serialized.length,
      excerpt: serialized.slice(0, maxChars),
    });
  }

  _compressReadPageForLLM(result) {
    const maxNameLen = 60;
    const maxDepth = 10;
    const maxNodes = 180;
    const maxChildren = 20;
    let seen = 0;

    const visit = (node, depth = 0) => {
      if (!node || typeof node !== 'object') return null;
      if (depth > maxDepth || seen >= maxNodes) return null;
      seen++;

      const out = {};
      if (node.id !== undefined) out.id = node.id;
      if (node.role) out.role = node.role;
      if (node.name) out.name = String(node.name).slice(0, maxNameLen);
      if (node.tag) out.tag = node.tag;
      if (node.state) out.state = node.state;

      if (Array.isArray(node.children) && node.children.length > 0) {
        const children = [];
        for (const child of node.children) {
          if (children.length >= maxChildren || seen >= maxNodes) break;
          const c = visit(child, depth + 1);
          if (c) children.push(c);
        }
        if (children.length > 0) out.children = children;
      }

      return out;
    };

    return {
      url: result.url,
      title: result.title,
      interactiveCount: result.interactiveCount,
      nodeCount: result.nodeCount,
      tree: visit(result.tree),
      truncatedForModel: true,
    };
  }

  _containsAny(haystack, terms) {
    if (!haystack) return false;
    return terms.some((t) => haystack.includes(t));
  }

  async _detectManualIntervention() {
    let tab;
    try {
      tab = await chrome.tabs.get(this.tabId);
    } catch {
      return null;
    }

    const url = String(tab?.url || '');
    if (!/^https?:\/\//i.test(url)) return null;
    const title = String(tab?.title || '');
    const source = `${url}\n${title}`.toLowerCase();

    let pageText = '';
    try {
      const page = await this._sendToContent('getPageText', {});
      pageText = String(page?.text || '').toLowerCase().slice(0, 10000);
    } catch {
      // Best effort: some pages are restricted.
    }

    const haystack = `${source}\n${pageText}`;
    const hasCaptcha = this._containsAny(haystack, CAPTCHA_HINTS);
    if (hasCaptcha) {
      return {
        kind: 'captcha',
        url,
        title,
        message: 'CAPTCHA detected. Please solve it manually, then press Resume.',
      };
    }

    const hasAuthUrlHint = AUTH_URL_HINT_RE.test(url) || AUTH_URL_HINT_RE.test(title);
    const hasLoginHint = this._containsAny(haystack, LOGIN_HINTS);
    const hasPasswordHint = this._containsAny(haystack, PASSWORD_HINTS);

    let hasPasswordField = false;
    let hasOtpField = false;
    try {
      const probe = await this._executeJavaScriptMainWorld(`(() => JSON.stringify({
        hasPasswordField: !!document.querySelector('input[type="password"], input[name*="pass" i], input[id*="pass" i]'),
        hasOtpField: !!document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i]')
      }))()`);
      if (probe?.success && typeof probe.result === 'string' && probe.result.startsWith('{')) {
        const parsed = JSON.parse(probe.result);
        hasPasswordField = parsed?.hasPasswordField === true;
        hasOtpField = parsed?.hasOtpField === true;
      }
    } catch {
      // No-op, fallback to URL/title/text heuristics.
    }

    const looksLikeLogin = hasPasswordField || hasOtpField || ((hasAuthUrlHint || hasLoginHint) && hasPasswordHint);
    if (!looksLikeLogin) return null;

    return {
      kind: 'login',
      url,
      title,
      message: 'Login/verification page detected. Please sign in manually, then press Resume.',
    };
  }

  async _pauseIfManualInterventionNeeded(step, messages) {
    if (this._isWaitingForUser || this._aborted) return;
    const details = await this._detectManualIntervention();
    if (!details) return;
    if (details.kind === 'login' && this._goalExplicitlyRequestsAuthPage()) return;

    this._isWaitingForUser = true;
    this.status = 'paused_waiting_user';
    this._notify('paused_waiting_user');

    const pauseStep = {
      step,
      type: 'pause',
      reason: details.message,
      url: details.url,
      kind: details.kind,
    };
    this.history.push(pauseStep);
    this._emitStep(pauseStep);
    this._emitIntervention(details);

    const resumed = await new Promise((resolve) => {
      this._resumeResolver = resolve;
    });
    this._resumeResolver = null;
    this._isWaitingForUser = false;

    if (!resumed || this._aborted) return;

    this.status = 'running';
    this._notify('running');

    this._appendMessage(messages, {
      role: 'user',
      content: 'Manual step has been completed by the user (login/CAPTCHA). Continue the original task from the current page state.',
    });
  }

  _normalizeToolArgs(name, args) {
    const normalized = { ...args };
    const targetTools = new Set([
      'click', 'double_click', 'right_click', 'middle_click', 'triple_click',
      'left_mouse_down', 'left_mouse_up', 'mouse_move',
      'type', 'select', 'form_input', 'hover', 'upload_file',
    ]);
    if (targetTools.has(name) && typeof normalized.target === 'string') {
      const trimmed = normalized.target.trim();
      if (/^\d+$/.test(trimmed)) {
        normalized.target = Number(trimmed);
      }
    }
    if (name === 'drag_drop') {
      if (typeof normalized.source === 'string' && /^\d+$/.test(normalized.source.trim())) {
        normalized.source = Number(normalized.source.trim());
      }
      if (typeof normalized.target === 'string' && /^\d+$/.test(normalized.target.trim())) {
        normalized.target = Number(normalized.target.trim());
      }
    }
    if (name === 'mouse_move' || name === 'left_mouse_down' || name === 'left_mouse_up') {
      if (typeof normalized.x === 'string' && /^-?\d+$/.test(normalized.x.trim())) {
        normalized.x = Number(normalized.x.trim());
      }
      if (typeof normalized.y === 'string' && /^-?\d+$/.test(normalized.y.trim())) {
        normalized.y = Number(normalized.y.trim());
      }
    }
    if (name === 'click_at') {
      for (const key of ['x', 'y', 'clickCount']) {
        if (typeof normalized[key] === 'string' && /^-?\d+$/.test(normalized[key].trim())) {
          normalized[key] = Number(normalized[key].trim());
        }
      }
      const button = String(normalized.button || 'left').trim().toLowerCase();
      normalized.button = ['left', 'middle', 'right'].includes(button) ? button : 'left';
      normalized.clickCount = Math.min(Math.max(Number(normalized.clickCount) || 1, 1), 3);
    }
    if (name === 'drag_at') {
      for (const key of ['fromX', 'fromY', 'toX', 'toY', 'steps']) {
        if (typeof normalized[key] === 'string' && /^-?\d+$/.test(normalized[key].trim())) {
          normalized[key] = Number(normalized[key].trim());
        }
      }
      normalized.steps = Math.min(Math.max(Number(normalized.steps) || 10, 1), 60);
    }
    if (name === 'switch_tab' || name === 'close_tab') {
      if (typeof normalized.tabId === 'string' && /^\d+$/.test(normalized.tabId.trim())) {
        normalized.tabId = Number(normalized.tabId.trim());
      }
      if (typeof normalized.index === 'string' && /^\d+$/.test(normalized.index.trim())) {
        normalized.index = Number(normalized.index.trim());
      }
    }
    if (name === 'switch_frame') {
      if (typeof normalized.main === 'string') {
        normalized.main = this._normalizeBoolean(normalized.main);
      }
      if (typeof normalized.index === 'string' && /^\d+$/.test(normalized.index.trim())) {
        normalized.index = Number(normalized.index.trim());
      }
      if (typeof normalized.target === 'string') {
        normalized.target = normalized.target.trim();
      }
    }
    if (name === 'reload' || name === 'open_tab') {
      if (normalized.bypassCache !== undefined) {
        normalized.bypassCache = this._normalizeBoolean(normalized.bypassCache);
      }
      if (normalized.active !== undefined) {
        normalized.active = this._normalizeBoolean(normalized.active);
      }
    }
    if ((name === 'click' || name === 'form_input') && normalized.confirm === undefined) {
      normalized.confirm = this._goalAllowsSensitiveActions();
    }
    if (name === 'click' || name === 'form_input') {
      normalized.confirm = this._normalizeBoolean(normalized.confirm);
    }
    if (name === 'navigate' && typeof normalized.url === 'string') {
      normalized.url = normalized.url.trim();
    }
    if (name === 'find_text') {
      if (typeof normalized.query === 'string') {
        normalized.query = normalized.query.trim();
      }
      normalized.caseSensitive = this._normalizeBoolean(normalized.caseSensitive);
      normalized.wholeWord = this._normalizeBoolean(normalized.wholeWord);
      if (normalized.scrollToFirst === undefined) {
        normalized.scrollToFirst = true;
      } else {
        normalized.scrollToFirst = this._normalizeBoolean(normalized.scrollToFirst);
      }
      normalized.maxResults = Math.min(Math.max(Number(normalized.maxResults) || 20, 1), 200);
    }
    if (name === 'find_text_next' || name === 'find_text_prev') {
      if (normalized.wrap === undefined) {
        normalized.wrap = true;
      } else {
        normalized.wrap = this._normalizeBoolean(normalized.wrap);
      }
    }
    if (name === 'open_tab' && typeof normalized.url === 'string') {
      normalized.url = normalized.url.trim();
      if (normalized.active === undefined) normalized.active = true;
    }
    if (name === 'wait') {
      normalized.duration = Math.min(Math.max(Number(normalized.duration) || 1000, 50), 60000);
    }
    if (name === 'wait_for') {
      const rawCond = String(normalized.condition || normalized.kind || normalized.waitFor || '').trim().toLowerCase();
      const condMap = {
        element: 'element',
        element_visible: 'element',
        url: 'url_includes',
        url_includes: 'url_includes',
        text: 'text',
        text_includes: 'text',
        navigation: 'navigation_complete',
        navigation_complete: 'navigation_complete',
        network_idle: 'network_idle',
        idle: 'network_idle',
      };
      normalized.condition = condMap[rawCond] || rawCond || 'navigation_complete';
      if (typeof normalized.target === 'string' && /^\d+$/.test(normalized.target.trim())) {
        normalized.target = Number(normalized.target.trim());
      }
      if (typeof normalized.value === 'string') normalized.value = normalized.value.trim();
      normalized.timeoutMs = Math.min(Math.max(Number(normalized.timeoutMs) || 10000, 100), 120000);
      normalized.pollMs = Math.min(Math.max(Number(normalized.pollMs) || 250, 50), 5000);
      normalized.idleMs = Math.min(Math.max(Number(normalized.idleMs) || 1200, 200), 30000);
    }
    if (name === 'download_status') {
      const state = String(normalized.state || 'any').trim().toLowerCase();
      normalized.state = ['in_progress', 'complete', 'interrupted', 'any'].includes(state) ? state : 'any';
      normalized.limit = Math.min(Math.max(Number(normalized.limit) || 10, 1), 50);
    }
    if (name === 'press_hotkey') {
      normalized.key = String(normalized.key || '').trim();
      normalized.modifiers = Array.isArray(normalized.modifiers)
        ? normalized.modifiers.filter((m) => ['Control', 'Shift', 'Alt', 'Meta'].includes(m))
        : [];
      if (normalized.key.includes('+') && normalized.modifiers.length === 0) {
        const parts = normalized.key.split('+').map((p) => p.trim()).filter(Boolean);
        const mappedMods = [];
        const keyAliases = {
          ctrl: 'Control',
          control: 'Control',
          shift: 'Shift',
          alt: 'Alt',
          option: 'Alt',
          meta: 'Meta',
          cmd: 'Meta',
          command: 'Meta',
        };
        for (let i = 0; i < parts.length - 1; i++) {
          const mod = keyAliases[parts[i].toLowerCase()];
          if (mod && !mappedMods.includes(mod)) mappedMods.push(mod);
        }
        normalized.key = parts[parts.length - 1] || normalized.key;
        normalized.modifiers = mappedMods;
      }
    }
    if (name === 'hold_key') {
      const keyAliases = {
        ctrl: 'Control',
        control: 'Control',
        shift: 'Shift',
        alt: 'Alt',
        option: 'Alt',
        meta: 'Meta',
        cmd: 'Meta',
        command: 'Meta',
      };
      const rawKey = String(normalized.key || '').trim();
      normalized.key = keyAliases[rawKey.toLowerCase()] || rawKey;
      const state = String(normalized.state || 'hold').trim().toLowerCase();
      normalized.state = ['hold', 'release', 'clear'].includes(state) ? state : 'hold';
      if (normalized.state !== 'clear' && !['Control', 'Shift', 'Alt', 'Meta'].includes(normalized.key)) {
        normalized.key = 'Control';
      }
    }
    if (name === 'upload_file') {
      normalized.files = Array.isArray(normalized.files) ? normalized.files : [];
    }
    return normalized;
  }

  _normalizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'n', 'off', ''].includes(v)) return false;
    }
    return false;
  }
}
