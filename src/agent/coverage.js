export const coverageMethods = {
  /**
   * Guard: reject premature done when the agent hasn't accomplished anything.
   * Two checks:
   *   1. If NO successful non-read action happened at all, reject (blind done).
   *   2. If mostly failures with no reads, reject (gave-up done).
   */
  _checkPrematureDone(args) {
    const allActions = this.history.filter((h) => h?.type === 'action' && h.tool !== 'done' && h.tool !== 'fail');

    // Guard 0: If no actions at all before done, reject
    if (allActions.length === 0) {
      return {
        ok: false,
        result: {
          success: false,
          code: 'PREMATURE_DONE',
          error: 'Completion rejected: you have not performed any actions yet. Read the page first with read_page or get_page_text, then act on the user\'s request.',
        },
      };
    }

    // Count successes across all history
    const successes = allActions.filter((a) => a.result?.success !== false);
    const reads = allActions.filter((a) =>
      a.result?.success !== false &&
      ['get_page_text', 'read_page', 'find_text', 'find', 'extract_structured', 'javascript', 'navigate'].includes(a.tool),
    );

    // Guard 1: If zero successful actions (everything failed), reject unconditionally
    if (successes.length === 0) {
      return {
        ok: false,
        result: {
          success: false,
          code: 'PREMATURE_DONE',
          error: 'Completion rejected: every action you attempted has failed. Try a different approach: use read_page or get_page_text to understand the page, navigate to a different URL, or use javascript.',
        },
      };
    }

    // Guard 2: Check recent window — if mostly failures and no reads, reject if answer looks hollow
    const recent = this.history.slice(-8);
    const recentActions = recent.filter((h) => h?.type === 'action' && h.tool !== 'done' && h.tool !== 'fail');
    if (recentActions.length >= 2) {
      const recentFailures = recentActions.filter((a) => a.result?.success === false);
      const recentReads = recentActions.filter((a) =>
        a.result?.success !== false &&
        ['get_page_text', 'read_page', 'find_text', 'find', 'extract_structured', 'javascript'].includes(a.tool),
      );
      const failRatio = recentFailures.length / recentActions.length;
      if (failRatio >= 0.5 && recentReads.length === 0) {
        return {
          ok: false,
          result: {
            success: false,
            code: 'PREMATURE_DONE',
            error: 'Completion rejected: most recent actions failed and no page content was read. Try a different approach: navigate to a direct URL, use get_page_text to read page content, or try a different website.',
          },
        };
      }
    }

    return { ok: true };
  },

  _validateDoneCoverage(summary = '', answer = '') {
    // Guard 1: Behavioral check — for non-navigate-only goals, require that page content
    // was actually read (get_page_text / find_text / find) after the last navigate call.
    // This catches "navigate → done" sequences where the agent never read the page.
    if (!this._isNavigateOnly) {
      let lastNavigateIdx = -1;
      let hasPageReadAfterNavigate = false;
      const readTools = new Set(['get_page_text', 'find_text', 'find', 'extract_structured', 'read_page', 'javascript']);
      for (let i = 0; i < this.history.length; i++) {
        const item = this.history[i];
        if (!item || item.type !== 'action') continue;
        if (item.tool === 'navigate') lastNavigateIdx = i;
        if (lastNavigateIdx >= 0 && i > lastNavigateIdx && readTools.has(item.tool) && item.result?.success !== false) {
          hasPageReadAfterNavigate = true;
        }
      }
      if (lastNavigateIdx >= 0 && !hasPageReadAfterNavigate) {
        return {
          ok: false,
          missing: ['page not read after last navigation — call get_page_text or read_page before done'],
        };
      }
    }

    const subtasks = this._extractGoalSubtasks(String(this._goal || ''));
    if (subtasks.length < 2) {
      return { ok: true, missing: [] };
    }

    const evidenceChunks = [];
    for (let i = Math.max(0, this.history.length - 24); i < this.history.length; i++) {
      const item = this.history[i];
      if (!item) continue;
      if (item.type === 'action') {
        let packed = '';
        try {
          packed = JSON.stringify(item.result || {});
        } catch {
          packed = '';
        }
        evidenceChunks.push(`${item.tool || ''} ${packed}`.toLowerCase());
      } else if (item.type === 'thought' || item.type === 'error' || item.type === 'pause') {
        const text = String(item.content || item.error || item.reason || '');
        if (text) evidenceChunks.push(text.toLowerCase());
      }
    }
    evidenceChunks.push(String(summary || '').toLowerCase());
    evidenceChunks.push(String(answer || '').toLowerCase());
    const corpus = evidenceChunks.join('\n');

    const missing = [];
    for (const subtask of subtasks) {
      const keywords = this._extractCoverageKeywords(subtask);
      if (keywords.length === 0) continue;

      const matched = keywords.filter((kw) => corpus.includes(kw));
      const requiredHits = Math.min(2, keywords.length);
      if (matched.length < requiredHits) {
        missing.push(subtask);
      }
    }

    return { ok: missing.length === 0, missing };
  },

  _extractGoalSubtasks(goalText) {
    if (!goalText) return [];
    const normalized = goalText
      .replace(/[\n\r]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!normalized) return [];

    const separators = /(?:\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\band\b|\balso\b|\bи\b|\bзатем\b|\bпотом\b|\bа также\b)\s+)/i;
    const parts = normalized
      .split(separators)
      .map((p) => p.trim())
      .filter((p) => p.length >= 6)
      .filter((p) => !/^task\s*:/.test(p));

    // Keep unique, preserve order.
    const uniq = [];
    for (const part of parts) {
      if (!uniq.includes(part)) uniq.push(part);
    }
    return uniq.slice(0, 8);
  },

  _extractCoverageKeywords(text) {
    const stopwords = new Set([
      'the', 'and', 'then', 'with', 'from', 'that', 'this', 'into', 'for', 'you', 'your', 'have', 'just', 'also',
      'find', 'check', 'open', 'go', 'to', 'on', 'in', 'of', 'a', 'an', 'is', 'are',
      'и', 'затем', 'потом', 'это', 'как', 'что', 'чтобы', 'для', 'или', 'надо', 'нужно', 'сделай', 'сделать',
      'найди', 'проверь', 'открой', 'перейди', 'в', 'на', 'по', 'из', 'к', 'и', 'а', 'но',
    ]);

    const tokens = String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => t.length >= 3)
      .filter((t) => !stopwords.has(t));

    const uniq = [];
    for (const token of tokens) {
      if (!uniq.includes(token)) uniq.push(token);
    }
    return uniq.slice(0, 6);
  },
};
