/**
 * Content Script
 *
 * Injected into every page. Handles:
 * 1. Accessibility Tree extraction (primary page understanding)
 * 2. DOM actions (click, type, scroll, hover, form input)
 * 3. Console & network monitoring (on-demand)
 * 4. Natural language element search with relevance scoring
 *
 * Communicates with background service worker via chrome.runtime messages.
 */

(() => {
  'use strict';

  const ACTION_ERROR = {
    ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
    INVALID_ACTION: 'INVALID_ACTION',
    INVALID_TARGET: 'INVALID_TARGET',
    CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
    JS_EXEC_FAILED: 'JS_EXEC_FAILED',
  };

  function makeError(code, message, details = {}) {
    return { success: false, code, error: message, ...details };
  }

  function getElementRole(el) {
    const ariaRole = el.getAttribute('role');
    if (ariaRole) return ariaRole;

    const tag = el.tagName.toLowerCase();
    const roleMap = {
      a: 'link', button: 'button', input: 'textbox',
      select: 'combobox', textarea: 'textbox', img: 'image',
      h1: 'heading', h2: 'heading', h3: 'heading',
      h4: 'heading', h5: 'heading', h6: 'heading',
      nav: 'navigation', main: 'main', aside: 'complementary',
      form: 'form', table: 'table', ul: 'list', ol: 'list',
      li: 'listitem', dialog: 'dialog', details: 'group',
      summary: 'button',
    };

    if (tag === 'input') {
      const type = el.type?.toLowerCase() || 'text';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return roleMap[tag] || null;
  }

  function isElementVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'BODY' || el.tagName === 'HTML') return true;

    const view = el.ownerDocument?.defaultView || window;
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number.parseFloat(cs.opacity || '1') === 0) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (el.getClientRects().length === 0) return false;
    return true;
  }

  function safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }

  let activeDocument = document;
  let activeFrameLabel = 'main';
  const heldModifiers = new Set();

  function getActiveDocument() {
    return activeDocument || document;
  }

  function resetFrameContext() {
    activeDocument = document;
    activeFrameLabel = 'main';
    heldModifiers.clear();
    clearFindTextState();
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(String(value));
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function normalizeModifier(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'ctrl' || raw === 'control') return 'Control';
    if (raw === 'shift') return 'Shift';
    if (raw === 'alt' || raw === 'option') return 'Alt';
    if (raw === 'meta' || raw === 'cmd' || raw === 'command') return 'Meta';
    return null;
  }

  function collectModifiers(extra = []) {
    const set = new Set(heldModifiers);
    if (Array.isArray(extra)) {
      for (const m of extra) {
        const normalized = normalizeModifier(m);
        if (normalized) set.add(normalized);
      }
    }
    return set;
  }

  function modifierFlags(extra = []) {
    const set = collectModifiers(extra);
    return {
      ctrlKey: set.has('Control'),
      shiftKey: set.has('Shift'),
      altKey: set.has('Alt'),
      metaKey: set.has('Meta'),
    };
  }

  function clearFindTextState() {
    if (typeof findTextState === 'object') {
      findTextState.query = '';
      findTextState.caseSensitive = false;
      findTextState.wholeWord = false;
      findTextState.matches = [];
      findTextState.count = 0;
      findTextState.currentIndex = -1;
      findTextState.frame = activeFrameLabel;
      findTextState.docRef = null;
      findTextState.url = '';
    }
    clearTextHighlights();
  }

  let findAgentSeed = 0;
  function ensureAgentId(el) {
    const existing = el.getAttribute('data-agent-id');
    if (existing && /^\d+$/.test(existing)) return Number(existing);

    if (findAgentSeed === 0) {
      getActiveDocument().querySelectorAll('[data-agent-id]').forEach((node) => {
        const n = Number(node.getAttribute('data-agent-id'));
        if (Number.isFinite(n)) findAgentSeed = Math.max(findAgentSeed, n);
      });
    }

    findAgentSeed += 1;
    el.setAttribute('data-agent-id', String(findAgentSeed));
    return findAgentSeed;
  }

  function setTextLikeValue(el, value) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLInputElement
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
      const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeValueSetter) {
        nativeValueSetter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value,
      }));
      return true;
    }

    return false;
  }

  function isSensitiveElement(el) {
    const text = (
      `${el.innerText || ''} ${(el.value || '')} ${el.getAttribute('aria-label') || ''}`
    ).toLowerCase();
    const keywords = [
      'delete', 'remove', 'pay', 'purchase', 'checkout', 'order', 'send', 'transfer',
      'удал', 'оплат', 'покуп', 'заказ', 'отправ', 'перевод',
    ];
    return keywords.some((k) => text.includes(k));
  }

  // ===== ACCESSIBILITY TREE EXTRACTION =====

  function extractAccessibilityTree(options = {}) {
    const activeDoc = getActiveDocument();
    const activeView = activeDoc.defaultView || window;
    const maxDepth = options.maxDepth || 15;
    const maxNodes = options.maxNodes || 500;
    const viewportOnly = options.viewportOnly === true;
    let nodeCount = 0;
    // Continue from global seed to keep IDs unique for findByDescription
    const startSeed = findAgentSeed;
    let interactiveId = findAgentSeed;

    // Use textContent (no layout reflow) and cap traversal output size
    function getAccessibleName(el) {
      const label = el.getAttribute('aria-label')
        || el.getAttribute('alt')
        || el.getAttribute('title')
        || el.getAttribute('placeholder');
      if (label) return label;

      // textContent is layout-free (faster than innerText)
      const raw = el.textContent;
      if (!raw) return '';
      // Limit to first 120 chars of raw, then normalize whitespace
      return raw.slice(0, 120).replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    // Defer expensive getComputedStyle check until fast checks fail
    function isInteractive(el) {
      const tag = el.tagName.toLowerCase();
      if (['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
      if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return true;
      if (el.onclick || el.getAttribute('onclick')) return true;
      if (el.tabIndex >= 0) return true;
      // Expensive — only reached if nothing else matched
      try {
        if (getComputedStyle(el).cursor === 'pointer') return true;
      } catch { /* detached node */ }
      return false;
    }

    function getState(el) {
      const state = {};
      if (el.disabled) state.disabled = true;
      if (el.checked) state.checked = true;
      if (el.selected) state.selected = true;
      if (el.getAttribute('aria-expanded') === 'true') state.expanded = true;
      if (el.getAttribute('aria-selected') === 'true') state.selected = true;
      if (el.required) state.required = true;
      if (el.readOnly) state.readonly = true;
      const rawValue = 'value' in el ? el.value : undefined;
      if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
        state.value = String(rawValue).slice(0, 100);
      }
      return Object.keys(state).length > 0 ? state : null;
    }

    function traverse(el, depth = 0) {
      if (nodeCount >= maxNodes || depth > maxDepth) return null;
      if (!el || el.nodeType !== 1) return null;
      if (!isElementVisible(el)) return null;

      if (viewportOnly) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > (window.innerHeight || document.documentElement.clientHeight) ||
          rect.right < 0 || rect.left > (window.innerWidth || document.documentElement.clientWidth)) {
          return null;
        }
      }

      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'meta', 'link'].includes(tag)) return null;

      // Iframe detection — report presence without traversing cross-origin DOM
      if (tag === 'iframe') {
        nodeCount++;
        interactiveId++;
        const rect = el.getBoundingClientRect();
        el.setAttribute('data-agent-id', String(interactiveId));
        const iframeNode = {
          id: interactiveId,
          tag: 'iframe',
          role: 'iframe',
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
        };
        const iframeName = el.title || el.getAttribute('aria-label') || '';
        if (iframeName) iframeNode.name = iframeName;
        iframeNode.src = el.src || '';
        try {
          const iframeDoc = el.contentDocument;
          if (iframeDoc) {
            iframeNode.accessible = true;
            if (iframeDoc.title) iframeNode.name = iframeDoc.title;
          }
        } catch {
          iframeNode.accessible = false;
        }
        return iframeNode;
      }

      const role = getElementRole(el);
      const interactive = isInteractive(el);
      const name = getAccessibleName(el);

      // Recurse children
      const children = [];
      for (const child of el.children) {
        const node = traverse(child, depth + 1);
        if (node) children.push(node);
      }

      // Skip non-semantic containers with no role and one child (flatten)
      if (!role && !interactive && !name && children.length === 1) {
        return children[0];
      }

      // Skip empty non-interactive nodes
      if (!role && !interactive && !name && children.length === 0) {
        return null;
      }

      nodeCount++;
      const node = {};

      if (interactive) {
        interactiveId++;
        node.id = interactiveId;
        const rect = el.getBoundingClientRect();
        node.rect = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        };
        el.setAttribute('data-agent-id', interactiveId);
      }

      if (role) node.role = role;
      if (name) node.name = name;
      if (tag) node.tag = tag;

      const state = getState(el);
      if (state) node.state = state;

      if (children.length > 0) node.children = children;

      return node;
    }

    const tree = traverse(activeDoc.body);
    // Persist highest ID globally for subsequent reads
    findAgentSeed = interactiveId;

    // Include scroll position and page dimensions in output
    const docEl = activeDoc.documentElement;
    return {
      url: activeView.location.href,
      title: activeDoc.title,
      tree: tree,
      interactiveCount: interactiveId - startSeed,
      nodeCount: nodeCount,
      frame: activeFrameLabel,
      scroll: {
        x: Math.round(activeView.scrollX),
        y: Math.round(activeView.scrollY),
        maxX: Math.round(docEl.scrollWidth - docEl.clientWidth),
        maxY: Math.round(docEl.scrollHeight - docEl.clientHeight),
        pct: docEl.scrollHeight > docEl.clientHeight
          ? Math.round((activeView.scrollY / (docEl.scrollHeight - docEl.clientHeight)) * 100)
          : 0,
      },
      viewport: { w: docEl.clientWidth, h: docEl.clientHeight },
    };
  }

  // ===== GET PAGE TEXT =====

  function getPageText() {
    const activeDoc = getActiveDocument();
    const activeView = activeDoc.defaultView || window;
    const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'HEADER', 'ASIDE']);
    const maxChars = 15000;
    let collected = '';
    const walker = activeDoc.createTreeWalker(activeDoc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        const role = parent.getAttribute('role');
        if (role === 'banner' || role === 'navigation') return NodeFilter.FILTER_REJECT;
        if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
        const value = node.nodeValue?.trim();
        if (!value) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      const value = walker.currentNode.nodeValue.trim();
      if (!value) continue;
      const next = `${collected}\n${value}`;
      if (next.length > maxChars) {
        collected = next.slice(0, maxChars);
        break;
      }
      collected = next;
    }

    const text = collected
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return {
      url: activeView.location.href,
      title: activeDoc.title,
      text,
      charCount: text.length,
      frame: activeFrameLabel,
    };
  }

  // ===== DOM ACTIONS =====

  function findElementById(agentId) {
    return getActiveDocument().querySelector(`[data-agent-id="${agentId}"]`);
  }

  // Wait for element to appear on dynamic pages before acting
  function waitForElement(agentId, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const el = findElementById(agentId);
      if (el) return resolve(el);

      const interval = 200;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += interval;
        const found = findElementById(agentId);
        if (found || elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(found || null);
        }
      }, interval);
    });
  }

  function fireMouse(el, type, overrides = {}) {
    const rect = el.getBoundingClientRect();
    const extraModifiers = Array.isArray(overrides.modifiers) ? overrides.modifiers : [];
    const { modifiers, ...rest } = overrides;
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: el.ownerDocument?.defaultView || window,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
      ...modifierFlags(extraModifiers),
      ...rest,
    });
    el.dispatchEvent(event);
  }

  function executeAction(action) {
    if (!action || typeof action !== 'object') {
      return makeError(ACTION_ERROR.INVALID_ACTION, 'Action payload must be an object');
    }
    const { type, target, params = {} } = action;

    switch (type) {
      case 'click': {
        const el = findElementById(target);
        if (!el) return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, { target });
        if (isSensitiveElement(el) && !params?.confirm) {
          return makeError(
            ACTION_ERROR.CONFIRMATION_REQUIRED,
            `Element [${target}] appears sensitive. Repeat action with confirm=true.`,
            { target },
          );
        }
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const btnName = (params?.button || 'left').toLowerCase();
        const btnCode = btnName === 'right' ? 2 : btnName === 'middle' ? 1 : 0;
        const btnMask = btnName === 'right' ? 2 : btnName === 'middle' ? 4 : 1;
        const count = Math.min(Math.max(Number(params?.clickCount) || 1, 1), 3);

        if (btnName === 'right') {
          // Right-click: mousedown → mouseup → contextmenu
          fireMouse(el, 'mousedown', { button: btnCode, buttons: btnMask });
          fireMouse(el, 'mouseup', { button: btnCode, buttons: btnMask });
          fireMouse(el, 'contextmenu', { button: btnCode, buttons: btnMask });
          return { success: true, description: `Right-clicked [${target}]` };
        }
        if (btnName === 'middle') {
          // Middle-click: mousedown → mouseup → auxclick
          fireMouse(el, 'mousedown', { button: btnCode, buttons: btnMask, detail: 1 });
          fireMouse(el, 'mouseup', { button: btnCode, buttons: 0, detail: 1 });
          fireMouse(el, 'auxclick', { button: btnCode, buttons: 0, detail: 1 });
          return { success: true, description: `Middle-clicked [${target}]` };
        }
        // Left click (single / double / triple)
        for (let i = 1; i <= count; i++) {
          fireMouse(el, 'mousedown', { detail: i, button: 0, buttons: 1 });
          fireMouse(el, 'mouseup', { detail: i, button: 0, buttons: 0 });
          fireMouse(el, 'click', { detail: i, button: 0, buttons: 0 });
          if (i === 2) fireMouse(el, 'dblclick', { detail: 2, button: 0, buttons: 0 });
        }
        if (count === 1 && heldModifiers.size === 0) {
          el.click();
        }
        const clickDesc = count === 1 ? 'Clicked' : count === 2 ? 'Double-clicked' : 'Triple-clicked';
        return { success: true, description: `${clickDesc} [${target}]` };
      }

      case 'type': {
        const el = findElementById(target);
        if (!el) return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, { target });
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();

        const text = String(params?.text ?? '');
        if (!setTextLikeValue(el, text)) {
          return makeError(ACTION_ERROR.INVALID_TARGET, `Element [${target}] is not a text input`, { target });
        }

        const pressEnter = toBooleanLoose(params?.enter);
        if (pressEnter) {
          const keydownEvent = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
          el.dispatchEvent(keydownEvent);
          const keypressEvent = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
          el.dispatchEvent(keypressEvent);
          const keyupEvent = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true });
          el.dispatchEvent(keyupEvent);

          const form = el.closest('form');
          if (form) {
            const submitBtn = form.querySelector('[type="submit"], button:not([type="button"])');
            if (submitBtn) {
              submitBtn.click();
            } else {
              try { form.submit(); } catch (_) { /* ignore */ }
            }
          }
        }

        return {
          success: true,
          description: `Typed "${params.text}" into [${target}]${pressEnter ? ' and pressed Enter' : ''}`
        };
      }

      case 'scroll': {
        const amount = params?.amount || 500;
        const dir = target === 'up' ? -amount : amount;
        const view = getActiveDocument().defaultView || window;
        view.scrollBy({ top: dir, behavior: 'smooth' });
        return { success: true, description: `Scrolled ${target} ${amount}px` };
      }

      case 'hover': {
        const el = findElementById(target);
        if (!el) return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, { target });
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { success: true, description: `Hovered [${target}]` };
      }

      case 'select': {
        const el = findElementById(target);
        if (!el) return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, { target });
        const value = String(params?.value ?? '');
        if (el instanceof HTMLSelectElement) {
          el.value = value;
        } else if (!setTextLikeValue(el, value)) {
          return makeError(ACTION_ERROR.INVALID_TARGET, `Element [${target}] is not selectable`, { target });
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, description: `Selected "${params.value}" in [${target}]` };
      }

      case 'press_key': {
        const activeDoc = getActiveDocument();
        const keyTarget = target || activeDoc.activeElement || activeDoc.body;
        const el = typeof keyTarget === 'number' ? findElementById(keyTarget) : activeDoc.activeElement;
        const flags = modifierFlags(params.modifiers);
        const dispatchEl = el || activeDoc.body;

        const keydownEvent = new KeyboardEvent('keydown', {
          key: params.key,
          code: params.key,
          bubbles: true,
          cancelable: true,
          ...flags,
        });
        dispatchEl.dispatchEvent(keydownEvent);

        // keypress is required for form submission in many frameworks (e.g. Google Search)
        const keypressEvent = new KeyboardEvent('keypress', {
          key: params.key,
          code: params.key,
          bubbles: true,
          cancelable: true,
          ...flags,
        });
        dispatchEl.dispatchEvent(keypressEvent);

        const keyupEvent = new KeyboardEvent('keyup', {
          key: params.key,
          code: params.key,
          bubbles: true,
          ...flags,
        });
        dispatchEl.dispatchEvent(keyupEvent);

        // For Enter: also try form.submit() if the active element is inside a form
        // This handles React/modern apps that don't respond to synthetic key events
        if ((params.key === 'Enter' || params.key === 'Return') && dispatchEl !== activeDoc.body) {
          const form = dispatchEl.closest('form');
          if (form) {
            // Find and click the submit button first (more compatible than form.submit())
            const submitBtn = form.querySelector('[type="submit"], button:not([type="button"])');
            if (submitBtn) {
              submitBtn.click();
            } else {
              try { form.submit(); } catch (_) { /* ignore */ }
            }
          }
        }

        return { success: true, description: `Pressed ${params.key}` };
      }

      default:
        return makeError(ACTION_ERROR.INVALID_ACTION, `Unknown action type: ${type}`, { type });
    }
  }

  // ===== JAVASCRIPT EXECUTION =====

  // Use Function() instead of eval() to avoid local closure access
  function executeJavaScript(code) {
    try {
      const fn = new Function(code);
      const result = fn();
      return {
        success: true,
        result: result !== undefined ? String(result).slice(0, 5000) : 'undefined',
      };
    } catch (err) {
      return makeError(ACTION_ERROR.JS_EXEC_FAILED, err.message);
    }
  }

  // ===== CONSOLE MONITORING (on-demand) =====

  const consoleMessages = [];
  const MAX_CONSOLE = 100;
  let monitoringEnabled = false;

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };

  function interceptConsole() {
    ['log', 'warn', 'error', 'info'].forEach((level) => {
      console[level] = (...args) => {
        if (monitoringEnabled) {
          consoleMessages.push({
            level,
            message: args.map((a) => (typeof a === 'object' ? safeStringify(a) : String(a))).join(' '),
            timestamp: Date.now(),
          });
          if (consoleMessages.length > MAX_CONSOLE) consoleMessages.shift();
        }
        originalConsole[level](...args);
      };
    });

    window.addEventListener('error', (e) => {
      if (monitoringEnabled) {
        consoleMessages.push({
          level: 'error',
          message: `Uncaught: ${e.message} at ${e.filename}:${e.lineno}`,
          timestamp: Date.now(),
        });
      }
    });
  }

  function getConsoleMessages(since = 0) {
    return consoleMessages.filter((m) => m.timestamp > since);
  }

  // ===== NETWORK MONITORING (on-demand) =====

  const networkRequests = [];
  const MAX_NETWORK = 50;

  function interceptNetwork() {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      const method = args[1]?.method || 'GET';
      const startTime = Date.now();

      try {
        const response = await originalFetch(...args);
        if (monitoringEnabled) {
          networkRequests.push({
            url, method,
            status: response.status,
            duration: Date.now() - startTime,
            timestamp: startTime,
          });
          if (networkRequests.length > MAX_NETWORK) networkRequests.shift();
        }
        return response;
      } catch (err) {
        if (monitoringEnabled) {
          networkRequests.push({
            url, method,
            status: 0,
            error: err.message,
            duration: Date.now() - startTime,
            timestamp: startTime,
          });
        }
        throw err;
      }
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this._agentMethod = method;
      this._agentUrl = url;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const startTime = Date.now();
      this.addEventListener('loadend', () => {
        if (monitoringEnabled) {
          networkRequests.push({
            url: this._agentUrl,
            method: this._agentMethod,
            status: this.status,
            duration: Date.now() - startTime,
            timestamp: startTime,
          });
          if (networkRequests.length > MAX_NETWORK) networkRequests.shift();
        }
      });
      return origSend.apply(this, arguments);
    };
  }

  function getNetworkRequests(since = 0) {
    return networkRequests.filter((r) => r.timestamp > since);
  }

  // ===== FIND ELEMENT BY DESCRIPTION (with relevance scoring) =====

  function findByDescription(query) {
    const activeDoc = getActiveDocument();
    query = String(query || '').toLowerCase().trim();
    if (!query) return [];
    const queryWords = query.split(/\s+/).filter(Boolean);
    const candidates = [];

    const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]';
    activeDoc.querySelectorAll(selector).forEach((el) => {
      if (!isElementVisible(el)) return;
      const text = (
        (el.innerText || '') +
        ' ' + (el.getAttribute('aria-label') || '') +
        ' ' + (el.getAttribute('placeholder') || '') +
        ' ' + (el.getAttribute('title') || '') +
        ' ' + (el.getAttribute('alt') || '') +
        ' ' + (el.getAttribute('name') || '') +
        ' ' + (el.getAttribute('id') || '') +
        ' ' + (typeof el.className === 'string' ? el.className : '')
      ).toLowerCase();

      // Score-based matching
      let score = 0;

      // Exact full query match
      if (text.includes(query)) {
        score += 10;
      }

      // Word overlap scoring
      const matchedWords = queryWords.filter((w) => text.includes(w));
      if (matchedWords.length === 0) return;
      score += (matchedWords.length / queryWords.length) * 5;

      // Bonus for word-boundary matches
      for (const w of matchedWords) {
        try {
          if (new RegExp(`\\b${w}\\b`).test(text)) {
            score += 1;
          }
        } catch { /* regex-unsafe word, skip bonus */ }
      }

      // Bonus for shorter text (more specific match is better)
      score += Math.max(0, 3 - text.length / 100);

      const rect = el.getBoundingClientRect();
      const agentId = ensureAgentId(el);
      candidates.push({
        agentId,
        tag: el.tagName.toLowerCase(),
        text: el.innerText?.trim().slice(0, 60),
        role: getElementRole(el),
        score: Math.round(score * 100) / 100,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    });

    // Sort by relevance score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 10);
  }

  function isWordBoundaryChar(ch) {
    return !ch || /[\s.,!?;:()[\]{}"'`~@#$%^&*+=<>/\\|-]/.test(ch);
  }

  const findTextState = {
    query: '',
    caseSensitive: false,
    wholeWord: false,
    matches: [],
    count: 0,
    currentIndex: -1,
    frame: 'main',
    docRef: null,
    url: '',
  };

  let textHighlightLayer = null;
  let textHighlightDoc = null;

  function ensureTextHighlightLayer(doc) {
    if (textHighlightLayer && textHighlightDoc === doc && textHighlightLayer.isConnected) {
      return textHighlightLayer;
    }
    clearTextHighlights();
    const layer = doc.createElement('div');
    layer.setAttribute('data-agent-text-highlight-layer', '1');
    layer.style.position = 'fixed';
    layer.style.left = '0';
    layer.style.top = '0';
    layer.style.width = '100%';
    layer.style.height = '100%';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '2147483647';
    (doc.documentElement || doc.body).appendChild(layer);
    textHighlightLayer = layer;
    textHighlightDoc = doc;
    return layer;
  }

  function clearTextHighlights() {
    if (textHighlightLayer && textHighlightLayer.isConnected) {
      textHighlightLayer.remove();
    }
    textHighlightLayer = null;
    textHighlightDoc = null;
  }

  function renderTextHighlights(doc, matches, currentIndex) {
    if (!doc || !Array.isArray(matches) || matches.length === 0) {
      clearTextHighlights();
      return;
    }
    const layer = ensureTextHighlightLayer(doc);
    layer.innerHTML = '';

    const maxRender = Math.min(matches.length, 120);
    for (let i = 0; i < maxRender; i++) {
      const match = matches[i];
      if (!match?.node) continue;
      try {
        const range = doc.createRange();
        range.setStart(match.node, match.start);
        range.setEnd(match.node, match.end);
        const rects = range.getClientRects();
        for (const rect of rects) {
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;
          const box = doc.createElement('div');
          box.style.position = 'fixed';
          box.style.left = `${Math.round(rect.left)}px`;
          box.style.top = `${Math.round(rect.top)}px`;
          box.style.width = `${Math.max(1, Math.round(rect.width))}px`;
          box.style.height = `${Math.max(1, Math.round(rect.height))}px`;
          box.style.borderRadius = '2px';
          if (i === currentIndex) {
            box.style.background = 'rgba(255, 106, 0, 0.45)';
            box.style.outline = '1px solid rgba(255, 106, 0, 0.9)';
          } else {
            box.style.background = 'rgba(255, 230, 120, 0.35)';
            box.style.outline = '1px solid rgba(255, 230, 120, 0.65)';
          }
          layer.appendChild(box);
        }
      } catch {
        // Ignore stale/invalid ranges.
      }
    }
  }

  function toBooleanLoose(value, defaultValue = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'n', 'off', ''].includes(v)) return false;
    }
    return defaultValue;
  }

  function buildTextMatch(node, idx, queryLength, doc) {
    const raw = node.nodeValue || '';
    const start = Math.max(0, idx - 40);
    const end = Math.min(raw.length, idx + queryLength + 40);
    const context = raw.slice(start, end).replace(/\s+/g, ' ').trim();
    const parent = node.parentElement;
    let rect = null;
    try {
      const range = doc.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + queryLength);
      const r = range.getBoundingClientRect();
      rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    } catch {
      rect = null;
    }

    return {
      node,
      start: idx,
      end: idx + queryLength,
      element: parent || null,
      context,
      tag: parent?.tagName?.toLowerCase() || '',
      rect,
    };
  }

  function scanTextMatches(doc, query, options = {}) {
    const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
    const caseSensitive = !!options.caseSensitive;
    const wholeWord = !!options.wholeWord;
    const maxStore = Math.min(Math.max(Number(options.maxStore) || 5000, 1), 10000);

    const needle = caseSensitive ? query : query.toLowerCase();
    const matches = [];
    let totalMatches = 0;

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
        const value = node.nodeValue;
        if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const raw = node.nodeValue || '';
      const haystack = caseSensitive ? raw : raw.toLowerCase();
      let pos = 0;

      while (pos <= haystack.length - needle.length) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1) break;

        let ok = true;
        if (wholeWord) {
          const before = raw[idx - 1] || '';
          const after = raw[idx + query.length] || '';
          ok = isWordBoundaryChar(before) && isWordBoundaryChar(after);
        }

        if (ok) {
          totalMatches += 1;
          if (matches.length < maxStore) {
            matches.push(buildTextMatch(node, idx, query.length, doc));
          }
        }

        pos = idx + Math.max(1, needle.length);
      }
    }

    return { matches, totalMatches };
  }

  function scrollToTextMatch(doc, match) {
    if (!match || !match.node) return;
    try {
      const range = doc.createRange();
      range.setStart(match.node, match.start);
      range.setEnd(match.node, match.end);
      const r = range.getBoundingClientRect();
      if (r && Number.isFinite(r.top)) {
        const view = doc.defaultView || window;
        const targetY = (view.scrollY || 0) + r.top - (view.innerHeight * 0.35);
        view.scrollTo({ top: Math.max(0, targetY), behavior: 'instant' });
      } else if (match.element) {
        match.element.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    } catch {
      if (match.element) {
        try { match.element.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch { /* noop */ }
      }
    }
  }

  function toPublicMatch(match, index) {
    return {
      index,
      context: match.context,
      tag: match.tag,
      rect: match.rect,
    };
  }

  function findTextOnPage(payload = {}) {
    const activeDoc = getActiveDocument();
    const activeView = activeDoc.defaultView || window;
    const query = String(payload.query || '').trim();
    if (!query) {
      return makeError(ACTION_ERROR.INVALID_ACTION, 'find_text requires non-empty query');
    }

    const caseSensitive = toBooleanLoose(payload.caseSensitive, false);
    const wholeWord = toBooleanLoose(payload.wholeWord, false);
    const maxResults = Math.min(Math.max(Number(payload.maxResults) || 20, 1), 200);
    const scrollToFirst = toBooleanLoose(payload.scrollToFirst, true);

    const { matches: allMatches, totalMatches } = scanTextMatches(activeDoc, query, {
      caseSensitive,
      wholeWord,
      maxStore: 5000,
    });

    findTextState.query = query;
    findTextState.caseSensitive = caseSensitive;
    findTextState.wholeWord = wholeWord;
    findTextState.matches = allMatches;
    findTextState.count = totalMatches;
    findTextState.currentIndex = allMatches.length > 0 ? 0 : -1;
    findTextState.frame = activeFrameLabel;
    findTextState.docRef = activeDoc;
    findTextState.url = activeView.location.href;

    if (scrollToFirst && findTextState.currentIndex >= 0) {
      scrollToTextMatch(activeDoc, allMatches[findTextState.currentIndex]);
    }
    renderTextHighlights(activeDoc, allMatches, findTextState.currentIndex);

    const outMatches = allMatches
      .slice(0, maxResults)
      .map((m, i) => toPublicMatch(m, i + 1));

    return {
      success: true,
      query,
      found: totalMatches > 0,
      count: totalMatches,
      returned: outMatches.length,
      truncated: totalMatches > outMatches.length,
      caseSensitive,
      wholeWord,
      frame: activeFrameLabel,
      url: activeView.location.href,
      title: activeDoc.title,
      currentIndex: findTextState.currentIndex >= 0 ? (findTextState.currentIndex + 1) : 0,
      matches: outMatches,
    };
  }

  function findTextStepOnPage(direction, payload = {}) {
    const activeDoc = getActiveDocument();
    const activeView = activeDoc.defaultView || window;
    const wrap = toBooleanLoose(payload.wrap, true);

    if (
      !findTextState.query ||
      findTextState.matches.length === 0 ||
      findTextState.docRef !== activeDoc ||
      findTextState.frame !== activeFrameLabel ||
      findTextState.url !== activeView.location.href
    ) {
      clearFindTextState();
      return makeError(
        ACTION_ERROR.INVALID_ACTION,
        'No active text search context. Call find_text first in this frame.',
      );
    }

    let next = findTextState.currentIndex + direction;
    let wrapped = false;

    if (next < 0 || next >= findTextState.matches.length) {
      if (!wrap) {
        return {
          success: false,
          query: findTextState.query,
          count: findTextState.count,
          currentIndex: findTextState.currentIndex + 1,
          reason: 'Reached boundary and wrap=false',
        };
      }
      wrapped = true;
      next = next < 0 ? findTextState.matches.length - 1 : 0;
    }

    findTextState.currentIndex = next;
    const match = findTextState.matches[next];
    scrollToTextMatch(activeDoc, match);
    renderTextHighlights(activeDoc, findTextState.matches, findTextState.currentIndex);

    return {
      success: true,
      query: findTextState.query,
      count: findTextState.count,
      currentIndex: next + 1,
      wrapped,
      frame: activeFrameLabel,
      url: activeView.location.href,
      title: activeDoc.title,
      match: toPublicMatch(match, next + 1),
    };
  }

  // ===== INIT =====
  const RUNTIME_STATE_KEY = '__browserAgentRuntimeState';
  const runtimeState = globalThis[RUNTIME_STATE_KEY] || (globalThis[RUNTIME_STATE_KEY] = {
    initialized: false,
    listenerInstalled: false,
  });

  if (!runtimeState.initialized) {
    interceptConsole();
    interceptNetwork();
    runtimeState.initialized = true;
  }

  // ===== MESSAGE HANDLER =====

  function onRuntimeMessage(msg, sender, sendResponse) {
    const { action, payload } = msg;

    try {
      switch (action) {
        case 'readPage':
          sendResponse(extractAccessibilityTree(payload));
          break;
        case 'getPageText':
          sendResponse(getPageText());
          break;
        case 'executeAction':
          sendResponse(executeAction(payload));
          break;
        case 'waitForElement': {
          const timeout = payload?.timeout || 3000;
          waitForElement(payload?.agentId, timeout).then((el) => {
            sendResponse(el
              ? { success: true, found: true, agentId: payload.agentId }
              : { success: false, found: false, agentId: payload.agentId }
            );
          });
          break;
        }
        case 'executeJS':
          sendResponse(executeJavaScript(payload?.code || ''));
          break;
        case 'readConsole':
          sendResponse(getConsoleMessages(payload?.since || 0));
          break;
        case 'readNetwork':
          sendResponse(getNetworkRequests(payload?.since || 0));
          break;
        case 'find':
          sendResponse(findByDescription(payload?.query));
          break;
        case 'findText':
          sendResponse(findTextOnPage(payload));
          break;
        case 'findTextNext':
          sendResponse(findTextStepOnPage(1, payload));
          break;
        case 'findTextPrev':
          sendResponse(findTextStepOnPage(-1, payload));
          break;
        case 'clearFindText':
          clearFindTextState();
          sendResponse({ success: true });
          break;
        case 'getPageInfo':
          {
            const activeDoc = getActiveDocument();
            const activeView = activeDoc.defaultView || window;
            sendResponse({
              url: activeView.location.href,
              title: activeDoc.title,
              readyState: activeDoc.readyState,
              frame: activeFrameLabel,
            });
          }
          break;
        case 'startMonitoring':
          monitoringEnabled = true;
          consoleMessages.length = 0;
          networkRequests.length = 0;
          sendResponse({ success: true });
          break;
        case 'stopMonitoring':
          monitoringEnabled = false;
          sendResponse({ success: true });
          break;
        case 'resetAgentIds':
          document.querySelectorAll('[data-agent-id]').forEach((node) => {
            node.removeAttribute('data-agent-id');
          });
          findAgentSeed = 0;
          resetFrameContext();
          sendResponse({ success: true });
          break;
        default:
          sendResponse(makeError(ACTION_ERROR.INVALID_ACTION, `Unknown action: ${action}`, { action }));
      }
    } catch (err) {
      sendResponse(makeError('CONTENT_HANDLER_FAILED', err.message));
    }

    return true;
  }

  if (!runtimeState.listenerInstalled) {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    runtimeState.listenerInstalled = true;
  }

})(); // end IIFE
