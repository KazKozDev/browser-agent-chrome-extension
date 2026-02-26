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
    const out = details && typeof details === 'object' ? { ...details } : {};
    const reason = String(out.reason || out.error || message || 'Unknown error');
    const retryable = typeof out.retryable === 'boolean' ? out.retryable : false;
    const hint = Object.prototype.hasOwnProperty.call(out, 'hint') ? out.hint : null;
    delete out.reason;
    delete out.error;
    delete out.retryable;
    return {
      success: false,
      code: String(code || ACTION_ERROR.INVALID_ACTION),
      reason,
      error: reason,
      hint,
      retryable,
      ...out,
    };
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
    clearAgentElementIndex();
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
  const agentElementIndex = new Map();

  function indexAgentElement(agentId, el) {
    const id = Number(agentId);
    if (!Number.isInteger(id) || id <= 0 || !el) return;
    agentElementIndex.set(id, el);
  }

  function clearAgentElementIndex() {
    agentElementIndex.clear();
  }

  function ensureAgentId(el) {
    const existing = el.getAttribute('data-agent-id');
    if (existing && /^\d+$/.test(existing)) {
      const id = Number(existing);
      if (id > findAgentSeed) findAgentSeed = id;
      indexAgentElement(id, el);
      return id;
    }

    findAgentSeed += 1;
    el.setAttribute('data-agent-id', String(findAgentSeed));
    indexAgentElement(findAgentSeed, el);
    return findAgentSeed;
  }

  function setTextLikeValue(el, value) {
    if (el instanceof HTMLInputElement) {
      const inputType = String(el.type || 'text').toLowerCase();
      const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
      if (!textTypes.has(inputType)) return false;
      const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeValueSetter) {
        nativeValueSetter.call(el, value);
      } else {
        el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (el instanceof HTMLTextAreaElement) {
      const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
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
      'delete', 'remove', 'pay', 'purchase', 'checkout', 'order', 'send', 'transfer'
    ];
    return keywords.some((k) => text.includes(k));
  }

  function isSensitiveInput(el, text) {
    const type = String(el.type || '').toLowerCase();
    const id = String(el.id || '').toLowerCase();
    const name = String(el.name || '').toLowerCase();
    const label = String(el.getAttribute('aria-label') || '').toLowerCase();
    const role = String(el.getAttribute('role') || '').toLowerCase();
    const comb = `${type} ${id} ${name} ${label} ${role}`;

    if (type === 'password' || comb.includes('password')) return true;

    const digits = String(text).replace(/[^\d]/g, '');

    // Check for card numbers (13-19 digits usually)
    if (digits.length >= 13 && digits.length <= 19 && !/[a-zA-Z]/.test(String(text))) {
      if (/card|cc|pan/i.test(comb)) return true;
    }

    // Check for CVV/CVC (3-4 digits)
    if (digits.length >= 3 && digits.length <= 4 && !/[a-zA-Z]/.test(String(text))) {
      if (/cvv|cvc|sec.*code|sec.*num/i.test(comb)) return true;
    }

    // Check for amounts/prices
    if (/\d/.test(digits)) {
      if (/amount|sum|price/i.test(comb)) return true;
    }

    return false;
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
    clearAgentElementIndex();
    const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;

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

    function toGlobalRect(el, offsetX = 0, offsetY = 0) {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x + offsetX,
        y: rect.y + offsetY,
        w: rect.width,
        h: rect.height,
      };
    }

    function inViewport(globalRect) {
      if (!viewportOnly) return true;
      if (!globalRect || globalRect.w <= 0 || globalRect.h <= 0) return false;
      if (globalRect.x + globalRect.w < 0 || globalRect.y + globalRect.h < 0) return false;
      if (globalRect.x > viewportW || globalRect.y > viewportH) return false;
      return true;
    }

    function roundedRect(rect) {
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.w),
        h: Math.round(rect.h),
      };
    }

    function traverse(el, depth = 0, context = { offsetX: 0, offsetY: 0, frame: 'main' }) {
      if (nodeCount >= maxNodes || depth > maxDepth) return null;
      if (!el || el.nodeType !== 1) return null;
      if (!isElementVisible(el)) return null;

      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'meta', 'link'].includes(tag)) return null;
      const globalRect = toGlobalRect(el, context.offsetX, context.offsetY);
      if (!inViewport(globalRect)) return null;

      // Same-origin iframe traversal; cross-origin frames are reported as inaccessible.
      if (tag === 'iframe') {
        nodeCount++;
        interactiveId++;
        el.setAttribute('data-agent-id', String(interactiveId));
        indexAgentElement(interactiveId, el);
        const iframeNode = {
          id: interactiveId,
          tag: 'iframe',
          role: 'iframe',
          rect: roundedRect(globalRect),
        };
        const iframeName = el.title || el.getAttribute('aria-label') || '';
        if (iframeName) iframeNode.name = iframeName;
        iframeNode.src = el.src || '';
        try {
          const iframeDoc = el.contentDocument;
          if (iframeDoc) {
            iframeNode.accessible = true;
            if (iframeDoc.title) iframeNode.name = iframeDoc.title;
            const frameRoot = iframeDoc.body || iframeDoc.documentElement;
            const frameChildren = [];
            if (frameRoot) {
              const frameContext = {
                offsetX: globalRect.x,
                offsetY: globalRect.y,
                frame: `${context.frame}>iframe[${interactiveId}]`,
              };
              for (const child of frameRoot.children) {
                const node = traverse(child, depth + 1, frameContext);
                if (node) frameChildren.push(node);
              }
            }
            if (frameChildren.length > 0) iframeNode.children = frameChildren;
          }
        } catch {
          iframeNode.accessible = false;
        }
        return iframeNode;
      }

      const role = getElementRole(el);
      const interactive = isInteractive(el);
      const name = getAccessibleName(el);

      const isCanvas = tag === 'canvas';

      // Recurse children (light DOM + shadow DOM)
      const children = [];
      for (const child of el.children) {
        const node = traverse(child, depth + 1, context);
        if (node) children.push(node);
      }
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          const node = traverse(child, depth + 1, context);
          if (node) children.push(node);
        }
      }

      // Skip non-semantic containers with no role and one child (flatten), but keep canvas nodes.
      if (!isCanvas && !role && !interactive && !name && children.length === 1) {
        return children[0];
      }

      // Skip empty non-interactive nodes unless it's a canvas/WebGL surface.
      if (!isCanvas && !role && !interactive && !name && children.length === 0) {
        return null;
      }

      nodeCount++;
      const node = {};

      if (interactive) {
        interactiveId++;
        node.id = interactiveId;
        node.rect = roundedRect(globalRect);
        el.setAttribute('data-agent-id', String(interactiveId));
        indexAgentElement(interactiveId, el);
      }

      if (role) node.role = role;
      if (name) node.name = name;
      if (tag) node.tag = tag;
      if (isCanvas) {
        node.canvas = true;
        if (!node.role) node.role = 'graphics-document';
      }
      if (context.frame !== 'main' && node.id) {
        node.frame = context.frame;
      }

      const state = getState(el);
      if (state) node.state = state;

      if (children.length > 0) node.children = children;

      return node;
    }

    const tree = traverse(activeDoc.body || activeDoc.documentElement, 0, { offsetX: 0, offsetY: 0, frame: 'main' });
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

  function collectSomMarksFromTree(node, marks, limit = 40) {
    if (!node || typeof node !== 'object' || marks.length >= limit) return;
    if (Number.isInteger(node.id) && node.rect && Number(node.rect.w) > 2 && Number(node.rect.h) > 2) {
      const role = String(node.role || '').trim();
      const name = String(node.name || '').trim();
      const tag = String(node.tag || '').trim();
      const label = [role, name || tag].filter(Boolean).join(': ').slice(0, 80);
      marks.push({
        id: node.id,
        x: Math.round(Number(node.rect.x) || 0),
        y: Math.round(Number(node.rect.y) || 0),
        w: Math.round(Number(node.rect.w) || 0),
        h: Math.round(Number(node.rect.h) || 0),
        label,
        frame: String(node.frame || ''),
      });
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        if (marks.length >= limit) break;
        collectSomMarksFromTree(child, marks, limit);
      }
    }
  }

  function getSomMarks(payload = {}) {
    const maxMarks = Math.min(Math.max(Number(payload?.maxMarks) || 30, 4), 80);
    const treeResult = extractAccessibilityTree({
      maxDepth: Math.min(Math.max(Number(payload?.maxDepth) || 10, 2), 14),
      maxNodes: Math.min(Math.max(Number(payload?.maxNodes) || 320, 40), 900),
      viewportOnly: true,
    });
    const marks = [];
    collectSomMarksFromTree(treeResult?.tree, marks, maxMarks * 3);
    marks.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.id - b.id));
    const limited = marks.slice(0, maxMarks);

    return {
      success: true,
      url: treeResult?.url || '',
      title: treeResult?.title || '',
      frame: treeResult?.frame || activeFrameLabel,
      markCount: limited.length,
      marks: limited,
      sourceInteractiveCount: Number(treeResult?.interactiveCount || 0),
    };
  }

  // ===== GET PAGE TEXT =====

  function normalizeTextScope(value) {
    const raw = String(value || 'full').trim().toLowerCase();
    if (raw === 'viewport' || raw === 'selector') return raw;
    return 'full';
  }

  function intersectsViewport(el, view) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const h = view.innerHeight || el.ownerDocument?.documentElement?.clientHeight || 0;
    const w = view.innerWidth || el.ownerDocument?.documentElement?.clientWidth || 0;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < 0 || rect.top > h) return false;
    if (rect.right < 0 || rect.left > w) return false;
    return true;
  }

  function uniqueRoots(elements) {
    const out = [];
    for (const el of elements) {
      if (!el) continue;
      const nested = out.some((base) => base.contains(el));
      if (nested) continue;
      // Remove roots that are nested inside the new root.
      for (let i = out.length - 1; i >= 0; i--) {
        if (el.contains(out[i])) out.splice(i, 1);
      }
      out.push(el);
    }
    return out;
  }

  function getPreferredContentRoots(activeDoc) {
    const selectors = [
      'main',
      '[role="main"]',
      'article',
      '.content',
      '.article',
      '.entry-content',
      '.post-content',
      '.main-content',
      '[class*="answer"]',
      '[id*="content"]',
    ];
    const found = [];
    for (const selector of selectors) {
      const nodes = Array.from(activeDoc.querySelectorAll(selector));
      for (const node of nodes) {
        if (!node || !isElementVisible(node)) continue;
        found.push(node);
      }
      if (found.length >= 40) break;
    }
    return uniqueRoots(found);
  }

  function collectTextFromRoots(activeDoc, activeView, roots, maxChars, viewportOnly) {
    const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'HEADER', 'ASIDE']);
    let collected = '';
    let truncated = false;

    for (const root of roots) {
      if (!root || !isElementVisible(root)) continue;
      const walker = activeDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (blockedTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          const role = parent.getAttribute('role');
          if (role === 'banner' || role === 'navigation') return NodeFilter.FILTER_REJECT;
          if (!isElementVisible(parent)) return NodeFilter.FILTER_REJECT;
          if (viewportOnly && !intersectsViewport(parent, activeView)) return NodeFilter.FILTER_REJECT;
          const value = node.nodeValue?.trim();
          if (!value) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue?.trim();
        if (!value) continue;
        const next = collected ? `${collected}\n${value}` : value;
        if (next.length > maxChars) {
          collected = next.slice(0, maxChars);
          truncated = true;
          break;
        }
        collected = next;
      }
      if (truncated) break;
    }

    return {
      text: collected.replace(/\n{3,}/g, '\n\n').trim(),
      truncated,
    };
  }

  function getPageText(payload = {}) {
    const activeDoc = getActiveDocument();
    const activeView = activeDoc.defaultView || window;
    const scope = normalizeTextScope(payload?.scope);
    const selector = String(payload?.selector || '').trim();
    const maxChars = Math.min(Math.max(Number(payload?.maxChars) || 15000, 200), 50000);

    let roots = [];
    if (scope === 'selector') {
      if (!selector) {
        return makeError(ACTION_ERROR.INVALID_ACTION, 'get_page_text with scope=selector requires selector');
      }
      let nodes;
      try {
        nodes = Array.from(activeDoc.querySelectorAll(selector));
      } catch {
        return makeError(ACTION_ERROR.INVALID_ACTION, `Invalid CSS selector: "${selector}"`);
      }
      roots = uniqueRoots(nodes);
    } else {
      const preferred = getPreferredContentRoots(activeDoc);
      roots = preferred.length > 0 ? preferred : [activeDoc.body];
    }

    const viewportOnly = scope === 'viewport';
    const { text, truncated } = collectTextFromRoots(activeDoc, activeView, roots, maxChars, viewportOnly);

    return {
      url: activeView.location.href,
      title: activeDoc.title,
      text,
      charCount: text.length,
      frame: activeFrameLabel,
      scope,
      selector: scope === 'selector' ? selector : '',
      rootCount: roots.length,
      truncated,
    };
  }

  function normalizePriceNumber(raw) {
    const cleaned = String(raw || '').replace(/[^\d.,]/g, '');
    if (!cleaned) return null;
    const hasComma = cleaned.includes(',');
    const hasDot = cleaned.includes('.');
    let normalized = cleaned;
    if (hasComma && hasDot) {
      const lastComma = cleaned.lastIndexOf(',');
      const lastDot = cleaned.lastIndexOf('.');
      if (lastComma > lastDot) {
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
      } else {
        normalized = cleaned.replace(/,/g, '');
      }
    } else if (hasComma && !hasDot) {
      const parts = cleaned.split(',');
      normalized = parts.length > 1 && parts[parts.length - 1].length <= 2
        ? `${parts.slice(0, -1).join('')}.${parts[parts.length - 1]}`
        : cleaned.replace(/,/g, '');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
    const n = Number.parseFloat(normalized);
    return Number.isFinite(n) ? n : null;
  }

  function extractPriceFromText(text) {
    const match = String(text || '').match(/([$€£¥₽₹])\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
    if (!match) return { value: null, currency: '' };
    return {
      value: normalizePriceNumber(match[2]),
      currency: match[1] || '',
    };
  }

  function extractRatingFromText(text) {
    const src = String(text || '').toLowerCase();
    let rating = null;
    const direct = src.match(/(\d(?:[.,]\d)?)\s*(?:out of|\/)\s*5/);
    if (direct) {
      rating = Number.parseFloat(direct[1].replace(',', '.'));
    } else {
      const stars = src.match(/(\d(?:[.,]\d)?)\s*stars?/);
      if (stars) rating = Number.parseFloat(stars[1].replace(',', '.'));
    }

    let ratingCount = null;
    const countMatch = src.match(/([\d,.]+)\s*(ratings?|reviews?)/);
    if (countMatch) {
      const asInt = Number.parseInt(countMatch[1].replace(/[^\d]/g, ''), 10);
      ratingCount = Number.isFinite(asInt) ? asInt : null;
    }

    return {
      value: Number.isFinite(rating) ? rating : null,
      count: ratingCount,
    };
  }

  function extractCanonicalUrl(el, baseUrl) {
    const link = el.querySelector('a[href]');
    if (!link) return '';
    const href = String(link.getAttribute('href') || '').trim();
    if (!href || /^javascript:/i.test(href)) return '';
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return '';
    }
  }

  function extractTitle(el) {
    const titleEl = el.querySelector('h1,h2,h3,[data-cy*="title"],[class*="title"],a');
    const text = String(titleEl?.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length >= 4) return text.slice(0, 280);
    const fallback = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    return fallback.slice(0, 280);
  }

  function scoreItem(item) {
    let c = 0;
    if (item.title && item.title.length >= 6) c += 0.4;
    if (item.url) c += 0.2;
    if (typeof item.price_value === 'number') c += 0.2;
    if (typeof item.rating_value === 'number') c += 0.2;
    return Math.min(1, Math.round(c * 100) / 100);
  }

  function buildStructuredItem(el, activeView) {
    const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length < 12) return null;

    const title = extractTitle(el);
    const url = extractCanonicalUrl(el, activeView.location.href);
    const img = el.querySelector('img[src]')?.getAttribute('src') || '';
    const price = extractPriceFromText(text);
    const rating = extractRatingFromText(text);

    if (!title && !url && typeof price.value !== 'number' && typeof rating.value !== 'number') {
      return null;
    }

    const item = {
      title,
      price_value: typeof price.value === 'number' ? price.value : null,
      price_currency: price.currency || '',
      rating_value: typeof rating.value === 'number' ? rating.value : null,
      rating_count: typeof rating.count === 'number' ? rating.count : null,
      url,
      image: img || '',
    };
    item.confidence = scoreItem(item);
    return item;
  }

  function candidateRoots(activeDoc, hint, selector) {
    if (selector) {
      try {
        return Array.from(activeDoc.querySelectorAll(selector));
      } catch {
        return [];
      }
    }

    const lcHint = String(hint || '').toLowerCase();
    const selectors = [];
    if (lcHint.includes('product') || lcHint.includes('item')) {
      selectors.push(
        '[data-testid*="product"]',
        '[class*="product-card"]',
      );
    }
    selectors.push(
      '[class*="search-result"]',
      '[class*="result-item"]',
      'article',
      'li',
      '[role="article"]',
    );

    const out = [];
    for (const s of selectors) {
      const found = Array.from(activeDoc.querySelectorAll(s));
      for (const el of found) {
        if (out.length >= 800) return out;
        out.push(el);
      }
    }
    return out;
  }

  function extractStructured(payload = {}) {
    const activeDoc = getActiveDocument();
    const activeView = activeDoc.defaultView || window;
    const hint = String(payload?.hint || '').trim();
    const selector = String(payload?.selector || '').trim();
    const maxItems = Math.min(Math.max(Number(payload?.maxItems) || 30, 1), 100);
    const wantsProducts = /product|products|item|items|headphone|headphones/i.test(`${hint} ${selector}`);

    const rawRoots = candidateRoots(activeDoc, hint, selector);
    const roots = uniqueRoots(rawRoots).filter((el) => {
      if (!isElementVisible(el)) return false;
      const inChrome = el.closest('nav,header,footer,aside,[role="navigation"],[role="banner"]');
      if (inChrome) return false;
      const txt = String(el.innerText || '');
      if (txt.trim().length < 12) return false;
      return true;
    });

    const dedupe = new Set();
    const items = [];
    for (const el of roots) {
      const item = buildStructuredItem(el, activeView);
      if (!item) continue;
      if (wantsProducts && item.price_value === null && item.rating_value === null) continue;
      if (/^results?$/i.test(String(item.title || '').trim())) continue;
      const dedupeKey = item.url || item.title;
      if (!dedupeKey) continue;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);
      items.push(item);
      if (items.length >= maxItems) break;
    }

    return {
      success: true,
      page_url: activeView.location.href,
      title: activeDoc.title,
      frame: activeFrameLabel,
      hint,
      selectorUsed: selector || '',
      count: items.length,
      items,
    };
  }

  // ===== DOM ACTIONS =====

  function collectAccessibleDocuments(rootDoc, out = [], seen = new Set()) {
    if (!rootDoc || seen.has(rootDoc)) return out;
    seen.add(rootDoc);
    out.push(rootDoc);
    const frames = Array.from(rootDoc.querySelectorAll('iframe'));
    for (const frame of frames) {
      try {
        const frameDoc = frame.contentDocument;
        if (frameDoc) collectAccessibleDocuments(frameDoc, out, seen);
      } catch {
        // Cross-origin frame.
      }
    }
    return out;
  }

  function collectFrameEntries(rootDoc = document, parentLabel = 'main', out = [], seenDocs = new Set()) {
    if (!rootDoc || seenDocs.has(rootDoc)) return out;
    seenDocs.add(rootDoc);
    const frames = Array.from(rootDoc.querySelectorAll('iframe'));
    for (const frameEl of frames) {
      let id = null;
      try {
        id = ensureAgentId(frameEl);
      } catch {
        id = null;
      }
      const label = `${parentLabel}>iframe[${id ?? '?'}]`;
      const name = String(frameEl.title || frameEl.getAttribute('aria-label') || '').trim();
      const src = String(frameEl.src || '').trim();
      let frameDoc = null;
      let accessible = false;
      let error = '';
      try {
        frameDoc = frameEl.contentDocument || null;
        accessible = !!frameDoc;
        if (!accessible) error = 'Iframe is not accessible';
      } catch (err) {
        error = err?.message || 'Cross-origin iframe';
      }
      out.push({
        id,
        label,
        name,
        src,
        accessible,
        error,
        docRef: frameDoc,
      });
      if (frameDoc) {
        collectFrameEntries(frameDoc, label, out, seenDocs);
      }
    }
    return out;
  }

  function frameListPublic(entries = []) {
    return entries.map((entry, index) => ({
      index,
      id: Number.isInteger(entry?.id) ? entry.id : null,
      label: String(entry?.label || ''),
      name: String(entry?.name || ''),
      src: String(entry?.src || ''),
      accessible: !!entry?.accessible,
    }));
  }

  function switchFrameContext(payload = {}) {
    const targetRaw = payload?.target;
    const targetString = String(targetRaw ?? '').trim();
    const useMain = payload?.main === true || targetString.toLowerCase() === 'main';

    const allFrames = collectFrameEntries(document);
    const availableFrames = frameListPublic(allFrames);

    if (useMain) {
      activeDocument = document;
      activeFrameLabel = 'main';
      clearFindTextState();
      return {
        success: true,
        frame: activeFrameLabel,
        title: document.title || '',
        url: window.location.href,
        availableFrames,
      };
    }

    const accessibleFrames = allFrames.filter((entry) => entry?.accessible && entry?.docRef);
    if (accessibleFrames.length === 0) {
      return makeError(ACTION_ERROR.INVALID_TARGET, 'No accessible iframes found on this page', {
        frame: activeFrameLabel,
        availableFrames,
      });
    }

    let selected = null;
    if (targetString) {
      if (/^\d+$/.test(targetString)) {
        const id = Number(targetString);
        selected = accessibleFrames.find((entry) => entry.id === id) || null;
      } else {
        const needle = targetString.toLowerCase();
        selected = accessibleFrames.find((entry) => String(entry.label || '').toLowerCase() === needle) || null;
        if (!selected) {
          selected = accessibleFrames.find((entry) => {
            const haystack = `${entry.label || ''} ${entry.name || ''} ${entry.src || ''}`.toLowerCase();
            return haystack.includes(needle);
          }) || null;
        }
      }
    } else if (payload?.index !== undefined && payload?.index !== null) {
      const idx = Number(payload.index);
      if (Number.isInteger(idx) && idx >= 0 && idx < accessibleFrames.length) {
        selected = accessibleFrames[idx];
      }
    }

    if (!selected?.docRef) {
      return makeError(ACTION_ERROR.INVALID_TARGET, 'switch_frame target not found. Use main=true, target iframe [id], or index.', {
        frame: activeFrameLabel,
        availableFrames,
      });
    }

    activeDocument = selected.docRef;
    activeFrameLabel = String(selected.label || 'main');
    clearFindTextState();

    const activeView = activeDocument.defaultView || window;
    return {
      success: true,
      frame: activeFrameLabel,
      frameId: selected.id,
      title: activeDocument.title || '',
      url: activeView.location?.href || '',
      availableFrames,
    };
  }

  function findByAgentIdInRoot(root, selector, seen = new Set()) {
    if (!root || seen.has(root)) return null;
    seen.add(root);

    if (typeof root.querySelector === 'function') {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    }
    if (typeof root.querySelectorAll !== 'function') return null;
    const hosts = root.querySelectorAll('*');
    for (const host of hosts) {
      if (host?.shadowRoot) {
        const nested = findByAgentIdInRoot(host.shadowRoot, selector, seen);
        if (nested) return nested;
      }
    }
    return null;
  }

  function clearAgentIdsInRoot(root, seen = new Set()) {
    if (!root || seen.has(root)) return;
    seen.add(root);

    if (typeof root.querySelectorAll === 'function') {
      const withIds = root.querySelectorAll('[data-agent-id]');
      for (const node of withIds) {
        node.removeAttribute('data-agent-id');
      }
      const hosts = root.querySelectorAll('*');
      for (const host of hosts) {
        if (host?.shadowRoot) clearAgentIdsInRoot(host.shadowRoot, seen);
      }
    }
  }

  function findElementById(agentId) {
    const normalizedId = Number(agentId);
    if (!Number.isInteger(normalizedId) || normalizedId <= 0) return null;

    const indexed = agentElementIndex.get(normalizedId);
    if (indexed && indexed.isConnected) return indexed;
    agentElementIndex.delete(normalizedId);

    const selector = `[data-agent-id="${normalizedId}"]`;
    const docs = collectAccessibleDocuments(document);
    for (const docRef of docs) {
      const found = findByAgentIdInRoot(docRef, selector);
      if (found) {
        indexAgentElement(normalizedId, found);
        return found;
      }
    }
    return null;
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

  function waitForDomSettle(payload = {}) {
    const activeDoc = getActiveDocument();
    const timeoutMs = Math.min(Math.max(Number(payload?.timeoutMs) || 3000, 200), 10000);
    const quietMs = Math.min(Math.max(Number(payload?.quietMs) || 450, 100), 3000);
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let lastMutationAt = Date.now();
      let settled = false;
      let observer = null;

      const finish = (isSettled) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        resolve({
          success: true,
          settled: !!isSettled,
          waitedMs: Date.now() - startedAt,
          quietMs,
          frame: activeFrameLabel,
        });
      };

      try {
        observer = new MutationObserver((mutations) => {
          if (mutations && mutations.length > 0) {
            lastMutationAt = Date.now();
          }
        });
        observer.observe(activeDoc.documentElement || activeDoc.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: false,
        });
      } catch {
        setTimeout(() => finish(false), Math.min(quietMs, timeoutMs));
        return;
      }

      const tick = () => {
        if (settled) return;
        const now = Date.now();
        if ((now - lastMutationAt) >= quietMs) {
          finish(true);
          return;
        }
        if ((now - startedAt) >= timeoutMs) {
          finish(false);
          return;
        }
        setTimeout(tick, Math.min(200, quietMs));
      };

      setTimeout(tick, 50);
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
      return makeError(ACTION_ERROR.INVALID_ACTION, 'Action payload must be an object', {
        hint: {
          strategy: 'use_valid_action_schema',
          nextTool: 'read_page',
          args: {},
          avoidRepeat: true,
        },
      });
    }
    const { type, target, params = {} } = action;

    switch (type) {
      case 'click': {
        const el = findElementById(target);
        if (!el) {
          return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, {
            target,
            hint: {
              strategy: 'refresh_targets',
              nextTool: 'read_page',
              args: {},
              avoidRepeat: true,
            },
          });
        }
        // CSP-safe guard: avoid clicking javascript: links which are blocked in extensions.
        const link = el.closest?.('a[href]') || (el.tagName === 'A' ? el : null);
        const href = link?.getAttribute?.('href')?.trim() || '';
        if (/^javascript\s*:/i.test(href)) {
          return makeError(
            ACTION_ERROR.INVALID_ACTION,
            `Blocked click on javascript: URL for [${target}]. Use a real link or another interaction method.`,
            {
              target,
              href,
              hint: {
                strategy: 'change_interaction_method',
                nextTool: 'press_key',
                args: { key: 'Enter' },
                avoidRepeat: true,
              },
            },
          );
        }
        if (isSensitiveElement(el) && !params?.confirm) {
          return makeError(
            ACTION_ERROR.CONFIRMATION_REQUIRED,
            `Element [${target}] appears sensitive. Repeat action with confirm=true.`,
            {
              target,
              hint: {
                strategy: 'retry_with_confirmation',
                nextTool: 'click',
                args: { target, confirm: true },
                avoidRepeat: false,
              },
            },
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
        if (!el) {
          return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, {
            target,
            hint: {
              strategy: 'refresh_targets',
              nextTool: 'read_page',
              args: {},
              avoidRepeat: true,
            },
          });
        }
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();

        const text = String(params?.text ?? '');

        if (isSensitiveInput(el, text)) {
          return makeError(
            'SENSITIVE_DATA_BLOCKED',
            `SECURITY BLOCK: Field [${target}] appears to be a sensitive field (password/card/CVV). Automated typing is blocked for safety.`,
            { target }
          );
        }

        if (!setTextLikeValue(el, text)) {
          return makeError(ACTION_ERROR.INVALID_TARGET, `Element [${target}] is not a text input`, {
            target,
            hint: {
              strategy: 'find_text_input',
              nextTool: 'find',
              args: { query: 'input or search field' },
              avoidRepeat: true,
            },
          });
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
        const activeDoc = getActiveDocument();
        const view = activeDoc.defaultView || window;
        const root = activeDoc.scrollingElement || activeDoc.documentElement || activeDoc.body;
        const beforeY = Math.max(Number(view.scrollY || root?.scrollTop || 0), 0);
        const maxY = Math.max(
          Number(root?.scrollHeight || 0) - Number(view.innerHeight || activeDoc.documentElement?.clientHeight || 0),
          0
        );
        const rawAmount = Number(params?.amount);
        const amount = Number.isFinite(rawAmount)
          ? Math.min(Math.max(Math.round(Math.abs(rawAmount)), 40), 12000)
          : 500;
        const direction = String(target || 'down').toLowerCase() === 'up' ? -1 : 1;
        view.scrollBy({ top: direction * amount, behavior: 'auto' });
        const afterY = Math.max(Number(view.scrollY || root?.scrollTop || 0), 0);
        const moved = Math.abs(afterY - beforeY) >= 1;
        const atTop = afterY <= 1;
        const atBottom = afterY >= Math.max(maxY - 1, 0);
        return {
          success: true,
          description: `Scrolled ${direction < 0 ? 'up' : 'down'} ${amount}px`,
          beforeY,
          afterY,
          deltaY: afterY - beforeY,
          moved,
          atTop,
          atBottom,
          maxY,
        };
      }

      case 'hover': {
        const el = findElementById(target);
        if (!el) {
          return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, {
            target,
            hint: {
              strategy: 'refresh_targets',
              nextTool: 'read_page',
              args: {},
              avoidRepeat: true,
            },
          });
        }
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        return { success: true, description: `Hovered [${target}]` };
      }

      case 'select': {
        const el = findElementById(target);
        if (!el) {
          return makeError(ACTION_ERROR.ELEMENT_NOT_FOUND, `Element [${target}] not found`, {
            target,
            hint: {
              strategy: 'refresh_targets',
              nextTool: 'read_page',
              args: {},
              avoidRepeat: true,
            },
          });
        }
        const value = String(params?.value ?? '');
        if (el instanceof HTMLSelectElement) {
          el.value = value;
        } else if (!setTextLikeValue(el, value)) {
          return makeError(ACTION_ERROR.INVALID_TARGET, `Element [${target}] is not selectable`, {
            target,
            hint: {
              strategy: 'find_selectable_control',
              nextTool: 'find',
              args: { query: 'dropdown or select' },
              avoidRepeat: true,
            },
          });
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

        const hasModifier = !!(flags?.ctrlKey || flags?.metaKey || flags?.altKey || flags?.shiftKey);
        const navKey = String(params.key || '').trim();
        if (!hasModifier && ['End', 'Home', 'PageDown', 'PageUp'].includes(navKey)) {
          const view = activeDoc.defaultView || window;
          const root = activeDoc.scrollingElement || activeDoc.documentElement || activeDoc.body;
          const beforeY = Math.max(Number(view.scrollY || root?.scrollTop || 0), 0);
          const pageStep = Math.max(Math.round((Number(view.innerHeight) || 900) * 0.9), 320);
          if (navKey === 'End') {
            view.scrollTo({ top: Number(root?.scrollHeight || beforeY), behavior: 'auto' });
          } else if (navKey === 'Home') {
            view.scrollTo({ top: 0, behavior: 'auto' });
          } else if (navKey === 'PageDown') {
            view.scrollBy({ top: pageStep, behavior: 'auto' });
          } else if (navKey === 'PageUp') {
            view.scrollBy({ top: -pageStep, behavior: 'auto' });
          }
          const afterY = Math.max(Number(view.scrollY || root?.scrollTop || 0), 0);
          const maxY = Math.max(
            Number(root?.scrollHeight || 0) - Number(view.innerHeight || activeDoc.documentElement?.clientHeight || 0),
            0
          );
          const moved = Math.abs(afterY - beforeY) >= 1;
          return {
            success: true,
            description: `Pressed ${navKey}`,
            beforeY,
            afterY,
            deltaY: afterY - beforeY,
            moved,
            atTop: afterY <= 1,
            atBottom: afterY >= Math.max(maxY - 1, 0),
            maxY,
          };
        }

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
        return makeError(ACTION_ERROR.INVALID_ACTION, `Unknown action type: ${type}`, {
          type,
          hint: {
            strategy: 'use_supported_action_type',
            nextTool: 'read_page',
            args: {},
            avoidRepeat: true,
          },
        });
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
          if (containsWholeWord(text, w)) {
            score += 1;
          }
        } catch { /* regex-unsafe word, skip bonus */ }
      }

      // Bonus for shorter text (more specific match is better)
      score += Math.max(0, 3 - text.length / 100);

      const rect = el.getBoundingClientRect();
      const agentId = ensureAgentId(el);
      const inputType = el.tagName.toLowerCase() === 'input'
        ? String(el.getAttribute('type') || el.type || '').toLowerCase()
        : '';
      candidates.push({
        agentId,
        tag: el.tagName.toLowerCase(),
        text: el.innerText?.trim().slice(0, 60),
        role: getElementRole(el),
        inputType,
        score: Math.round(score * 100) / 100,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    });

    // Sort by relevance score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, 10);
  }

  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function containsWholeWord(text, word) {
    const token = String(word || '').trim();
    if (!token) return false;
    // Unicode-aware boundaries: treat any non letter/number/"_" as a separator.
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(token)}([^\\p{L}\\p{N}_]|$)`, 'iu');
    return pattern.test(String(text || ''));
  }

  function isWordBoundaryChar(ch) {
    return !ch || /[^\p{L}\p{N}_]/u.test(ch);
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
    const start = Math.max(0, idx - 150);
    const end = Math.min(raw.length, idx + queryLength + 150);
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
      return makeError(ACTION_ERROR.INVALID_ACTION, 'find_text requires non-empty query', {
        hint: {
          strategy: 'provide_query',
          nextTool: 'find_text',
          args: { query: 'your search phrase' },
          avoidRepeat: false,
        },
      });
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
        {
          hint: {
            strategy: 'start_find_text_context',
            nextTool: 'find_text',
            args: { query: findTextState.query || '' },
            avoidRepeat: false,
          },
        },
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
        case 'getSomMarks':
          sendResponse(getSomMarks(payload));
          break;
        case 'getPageText':
          sendResponse(getPageText(payload));
          break;
        case 'extractStructured':
          sendResponse(extractStructured(payload));
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
        case 'waitForDomSettle':
          waitForDomSettle(payload).then((result) => {
            sendResponse(result);
          });
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
        case 'getViewportState':
          {
            const activeDoc = getActiveDocument();
            const activeView = activeDoc.defaultView || window;
            const docEl = activeDoc.documentElement;
            sendResponse({
              success: true,
              url: activeView.location.href,
              title: activeDoc.title,
              frame: activeFrameLabel,
              scroll: {
                x: Math.round(activeView.scrollX || 0),
                y: Math.round(activeView.scrollY || 0),
                maxX: Math.max(Math.round((docEl.scrollWidth || 0) - (docEl.clientWidth || 0)), 0),
                maxY: Math.max(Math.round((docEl.scrollHeight || 0) - (docEl.clientHeight || 0)), 0),
              },
              viewport: {
                w: Math.max(Math.round(activeView.innerWidth || docEl.clientWidth || 0), 0),
                h: Math.max(Math.round(activeView.innerHeight || docEl.clientHeight || 0), 0),
              },
            });
          }
          break;
        case 'setViewportState':
          {
            const activeDoc = getActiveDocument();
            const activeView = activeDoc.defaultView || window;
            const docEl = activeDoc.documentElement;
            const x = Math.max(Number(payload?.x) || 0, 0);
            const y = Math.max(Number(payload?.y) || 0, 0);
            const maxX = Math.max((docEl.scrollWidth || 0) - (docEl.clientWidth || 0), 0);
            const maxY = Math.max((docEl.scrollHeight || 0) - (docEl.clientHeight || 0), 0);
            activeView.scrollTo({
              left: Math.min(x, maxX),
              top: Math.min(y, maxY),
              behavior: 'auto',
            });
            sendResponse({
              success: true,
              scroll: {
                x: Math.round(activeView.scrollX || 0),
                y: Math.round(activeView.scrollY || 0),
                maxX: Math.round(maxX),
                maxY: Math.round(maxY),
              },
              frame: activeFrameLabel,
            });
          }
          break;
        case 'switchFrame':
          sendResponse(switchFrameContext(payload));
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
          {
            const docs = collectAccessibleDocuments(document);
            for (const docRef of docs) {
              clearAgentIdsInRoot(docRef);
            }
            clearAgentElementIndex();
          }
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
