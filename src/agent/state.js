export const stateMethods = {
  getCheckpointState(maxHistoryItems = 200) {
    const safeLimit = Math.min(Math.max(Number(maxHistoryItems) || 200, 20), 400);
    const historyRaw = Array.isArray(this.history) ? this.history.slice(-safeLimit) : [];
    const sanitizeText = (value, maxChars = 3000) => {
      const text = String(value ?? '');
      if (text.length <= maxChars) return text;
      return `${text.slice(0, maxChars)}...[truncated]`;
    };
    const sanitizeResult = (tool, result) => {
      if (result === undefined) return result;
      if (result === null) return null;
      if (typeof result === 'string') return sanitizeText(result, 5000);
      let safeResult = result;
      if (tool === 'screenshot' && safeResult?.imageBase64) {
        safeResult = {
          ...safeResult,
          imageBase64: `[omitted base64 image, ${String(safeResult.imageBase64).length} chars]`,
        };
      }
      let packed = '';
      try {
        packed = JSON.stringify(safeResult);
      } catch {
        return { truncated: true, error: 'result serialization failed' };
      }
      const maxChars = 9000;
      if (packed.length <= maxChars) {
        try {
          return JSON.parse(packed);
        } catch {
          return sanitizeText(packed, maxChars);
        }
      }
      return {
        truncated: true,
        originalLength: packed.length,
        excerpt: packed.slice(0, maxChars),
      };
    };

    const history = historyRaw.map((entry) => {
      const item = entry && typeof entry === 'object' ? { ...entry } : { type: 'unknown' };
      if (typeof item.content === 'string') item.content = sanitizeText(item.content, 2500);
      if (typeof item.error === 'string') item.error = sanitizeText(item.error, 2500);
      if (typeof item.reason === 'string') item.reason = sanitizeText(item.reason, 2500);
      if (item.args && typeof item.args === 'object') {
        let argsPacked = '';
        try {
          argsPacked = JSON.stringify(item.args);
        } catch {
          argsPacked = '';
        }
        if (argsPacked.length > 3000) {
          item.args = { truncated: true, excerpt: argsPacked.slice(0, 3000) };
        }
      }
      if (Object.prototype.hasOwnProperty.call(item, 'result')) {
        item.result = sanitizeResult(item.tool, item.result);
      }
      return item;
    });
    let nextStep = 0;
    for (const item of history) {
      const step = Number(item?.step);
      if (Number.isFinite(step) && step >= nextStep) nextStep = step + 1;
    }
    let scratchpad = this._scratchpad && typeof this._scratchpad === 'object' ? this._scratchpad : {};
    try {
      const packed = JSON.stringify(scratchpad);
      if (packed.length > 30000) {
        scratchpad = { truncated: true, excerpt: packed.slice(0, 30000) };
      } else {
        scratchpad = JSON.parse(packed);
      }
    } catch {
      scratchpad = {};
    }
    let reflectionState = this._reflectionState && typeof this._reflectionState === 'object' && !Array.isArray(this._reflectionState)
      ? this._reflectionState
      : null;
    try {
      if (reflectionState) {
        const packed = JSON.stringify(reflectionState);
        reflectionState = packed.length > 8000
          ? { truncated: true, excerpt: packed.slice(0, 8000) }
          : JSON.parse(packed);
      }
    } catch {
      reflectionState = null;
    }
    return {
      goal: String(this._goal || ''),
      status: String(this.status || 'idle'),
      tabId: Number.isInteger(this.tabId) ? this.tabId : null,
      history,
      nextStep,
      scratchpad,
      reflectionState,
      lastKnownUrl: String(this._lastKnownUrl || ''),
      notifyConnectorCalls: Number(this._notifyConnectorCalls || 0),
      planMode: !!this.planMode,
      metrics: this.metrics || null,
    };
  },

  _mergeScratchpadValue(current, incoming) {
    if (Array.isArray(current) && Array.isArray(incoming)) {
      const seen = new Set();
      const out = [];
      for (const item of [...current, ...incoming]) {
        let key = '';
        try {
          key = JSON.stringify(item);
        } catch {
          key = String(item);
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= 200) break;
      }
      return out;
    }

    const currentObj = current && typeof current === 'object' && !Array.isArray(current);
    const incomingObj = incoming && typeof incoming === 'object' && !Array.isArray(incoming);
    if (currentObj && incomingObj) {
      const merged = { ...current };
      for (const [key, value] of Object.entries(incoming)) {
        merged[key] = this._mergeScratchpadValue(merged[key], value);
      }
      return merged;
    }

    return incoming;
  },

  _saveProgress(args = {}) {
    const rawData = Object.prototype.hasOwnProperty.call(args, 'data') ? args.data : args;
    if (rawData === undefined) {
      return this._makeError('INVALID_SAVE_PROGRESS', 'save_progress requires a data payload');
    }
    this._scratchpad = this._mergeScratchpadValue(this._scratchpad, rawData);
    const keys = Object.keys(this._scratchpad || {});
    return {
      success: true,
      savedKeys: keys,
      keyCount: keys.length,
      note: 'Progress saved to scratchpad memory and will be included in future reasoning.',
    };
  },

  _normalizeToolArgs(name, args) {
    const normalized = { ...args };
    const targetTools = new Set(['click', 'type', 'select', 'hover']);
    if (targetTools.has(name) && typeof normalized.target === 'string') {
      const trimmed = normalized.target.trim();
      if (/^\d+$/.test(trimmed)) {
        normalized.target = Number(trimmed);
      }
    }
    if (name === 'switch_tab') {
      if (typeof normalized.tabId === 'string' && /^\d+$/.test(normalized.tabId.trim())) {
        normalized.tabId = Number(normalized.tabId.trim());
      }
      if (typeof normalized.index === 'string' && /^\d+$/.test(normalized.index.trim())) {
        normalized.index = Number(normalized.index.trim());
      }
    }
    if (name === 'open_tab') {
      if (normalized.active !== undefined) {
        normalized.active = this._normalizeBoolean(normalized.active);
      }
    }
    if (name === 'click' && normalized.confirm === undefined) {
      normalized.confirm = this._goalAllowsSensitiveActions();
    }
    if (name === 'click') {
      const targetNum = Number(normalized.target);
      if (!Number.isFinite(targetNum) || targetNum <= 0) {
        const candidate = this._pickClickTargetFromFindHits?.(normalized.target);
        if (candidate !== null && candidate !== undefined) {
          normalized.target = candidate;
        }
      }
    }
    if (name === 'click') {
      normalized.confirm = this._normalizeBoolean(normalized.confirm);
    }
    if (name === 'click') {
      const button = String(normalized.button || 'left').trim().toLowerCase();
      normalized.button = ['left', 'right', 'middle'].includes(button) ? button : 'left';
      normalized.clickCount = Math.min(Math.max(Number(normalized.clickCount) || 1, 1), 3);
    }
    if (name === 'type' && normalized.enter !== undefined) {
      normalized.enter = this._normalizeBoolean(normalized.enter);
    }
    if (name === 'navigate' && typeof normalized.url === 'string') {
      normalized.url = normalized.url.trim();
    }
    if (name === 'find_text') {
      if (typeof normalized.query === 'string') {
        normalized.query = normalized.query.trim();
      }
      normalized.query = this._sanitizeFindTextQuery?.(normalized.query) || String(normalized.query || '').trim();
      normalized.caseSensitive = this._normalizeBoolean(normalized.caseSensitive);
      normalized.wholeWord = this._normalizeBoolean(normalized.wholeWord);
      if (normalized.scrollToFirst === undefined) {
        normalized.scrollToFirst = true;
      } else {
        normalized.scrollToFirst = this._normalizeBoolean(normalized.scrollToFirst);
      }
      normalized.maxResults = Math.min(Math.max(Number(normalized.maxResults) || 20, 1), 200);
    }
    if (name === 'open_tab' && typeof normalized.url === 'string') {
      normalized.url = normalized.url.trim();
      if (normalized.active === undefined) normalized.active = true;
    }
    if (name === 'scroll') {
      const rawDirection = String(normalized.direction || normalized.target || '').trim().toLowerCase();
      normalized.direction = rawDirection === 'up' ? 'up' : 'down';
      normalized.amount = Math.min(Math.max(Number(normalized.amount) || 500, 50), 4000);
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
      if (normalized.value !== undefined && normalized.value !== null) {
        normalized.value = String(normalized.value).trim();
      }
      normalized.timeoutMs = Math.min(Math.max(Number(normalized.timeoutMs) || 10000, 100), 120000);
      normalized.pollMs = Math.min(Math.max(Number(normalized.pollMs) || 250, 50), 5000);
      normalized.idleMs = Math.min(Math.max(Number(normalized.idleMs) || 1200, 200), 30000);
    }
    if (name === 'read_page') {
      if (normalized.viewportOnly !== undefined) {
        normalized.viewportOnly = this._normalizeBoolean(normalized.viewportOnly);
      }
    }
    if (name === 'get_page_text') {
      const rawScope = String(normalized.scope || 'full').trim().toLowerCase();
      normalized.scope = ['full', 'viewport', 'selector'].includes(rawScope) ? rawScope : 'full';
      if (normalized.selector !== undefined && normalized.selector !== null) {
        normalized.selector = String(normalized.selector).trim();
      }
      normalized.maxChars = Math.min(Math.max(Number(normalized.maxChars) || 15000, 200), 50000);
    }
    if (name === 'extract_structured') {
      if (normalized.hint !== undefined && normalized.hint !== null) {
        normalized.hint = String(normalized.hint).trim();
      }
      if (normalized.selector !== undefined && normalized.selector !== null) {
        normalized.selector = String(normalized.selector).trim();
      }
      normalized.maxItems = Math.min(Math.max(Number(normalized.maxItems) || 30, 1), 100);
    }
    if (name === 'save_progress') {
      if (!Object.prototype.hasOwnProperty.call(normalized, 'data')) {
        const clone = { ...normalized };
        delete clone.data;
        normalized.data = clone;
      }
    }
    if (name === 'notify_connector') {
      if (normalized.connectorId === undefined && normalized.id !== undefined) {
        normalized.connectorId = normalized.id;
      }
      if (normalized.message === undefined && normalized.text !== undefined) {
        normalized.message = normalized.text;
      }
      if (normalized.connectorId !== undefined && normalized.connectorId !== null) {
        normalized.connectorId = String(normalized.connectorId).trim();
      }
      if (normalized.message !== undefined && normalized.message !== null) {
        normalized.message = String(normalized.message).trim().slice(0, 6000);
      }
    }
    return normalized;
  },

  _normalizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'n', 'off', ''].includes(v)) return false;
    }
    return false;
  },
};
