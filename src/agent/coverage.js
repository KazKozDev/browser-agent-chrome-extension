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
      ['get_page_text', 'read_page', 'find_text', 'find', 'extract_structured', 'navigate'].includes(a.tool),
    );

    // Guard 1: If zero successful actions (everything failed), reject unconditionally
    if (successes.length === 0) {
      return {
        ok: false,
        result: {
          success: false,
          code: 'PREMATURE_DONE',
          error: 'Completion rejected: every action you attempted has failed. Try a different approach: use read_page or get_page_text to understand the page, navigate to a different URL, or use find to locate interactive targets.',
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
        ['get_page_text', 'read_page', 'find_text', 'find', 'extract_structured'].includes(a.tool),
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

  _validateDoneCoverage(summary = '', answer = '', options = {}) {
    const allowPartial = options?.allowPartial === true;
    // Guard 1: Behavioral check — for non-navigate-only goals, require that page content
    // was actually read (get_page_text / find_text / find) after the last navigate call.
    // This catches "navigate → done" sequences where the agent never read the page.
    if (!this._isNavigateOnly) {
      let lastNavigateIdx = -1;
      let hasPageReadAfterNavigate = false;
      const readTools = new Set(['get_page_text', 'find_text', 'find', 'extract_structured', 'read_page']);
      for (let i = 0; i < this.history.length; i++) {
        const item = this.history[i];
        if (!item || item.type !== 'action') continue;
        if (item.tool === 'navigate') {
          lastNavigateIdx = i;
          const navPageText = String(item?.result?.pageText || '').trim();
          hasPageReadAfterNavigate = navPageText.length >= 40;
          continue;
        }
        if (lastNavigateIdx >= 0 && i > lastNavigateIdx && readTools.has(item.tool) && item.result?.success !== false) {
          hasPageReadAfterNavigate = true;
        }
      }
      if (lastNavigateIdx >= 0 && !hasPageReadAfterNavigate) {
        if (allowPartial) {
          return {
            ok: true,
            missing: ['page not read after last navigation — call get_page_text or read_page before done'],
            partial: true,
          };
        }
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

    if (missing.length === 0) return { ok: true, missing: [] };
    if (allowPartial) return { ok: true, missing, partial: true };
    return { ok: false, missing };
  },

  _validateDoneQuality(summary = '', answer = '') {
    const summaryText = String(summary || '').trim();
    const answerText = String(answer || '').trim();
    const combined = `${summaryText}\n${answerText}`.trim();
    if (!combined) {
      return {
        ok: false,
        reason: 'Completion rejected: empty done result. Provide a substantive result, not only process actions.',
        nextTool: 'get_page_text',
      };
    }

    const goalText = String(this._goal || '').toLowerCase();
    const infoGoal = /(find|search|check|look\s*up|lookup|news|price|weather|who|what|when|where|how\s+much|which|rate)/i.test(goalText);
    const processOnly = /(clicked|typed|navigated|opened|pressed|scrolled|filled|submitted)/i.test(combined);
    const hasFactSignal = (
      /https?:\/\/\S+/i.test(combined) ||
      /[\p{N}]{2,}/u.test(combined) ||
      /[:]\s*\S+/u.test(combined) ||
      /[«"'].*?[»"']/u.test(combined)
    );

    const recentActions = Array.isArray(this.history)
      ? this.history.slice(-20).filter((h) => h?.type === 'action' && h.tool !== 'done' && h.tool !== 'fail')
      : [];
    const hasHighSignalObservation = recentActions.some((entry) => (
      typeof this._isHighSignalObservation === 'function' && this._isHighSignalObservation(entry)
    ));

    if (infoGoal) {
      if (answerText.length < 20) {
        return {
          ok: false,
          reason: 'Completion rejected: answer is too short for an information task.',
          nextTool: 'get_page_text',
        };
      }
      if (!hasFactSignal && !hasHighSignalObservation) {
        return {
          ok: false,
          reason: 'Completion rejected: no factual evidence found in final answer.',
          nextTool: 'get_page_text',
        };
      }
    }

    if (processOnly && !hasFactSignal) {
      return {
        ok: false,
        reason: 'Completion rejected: process-only status ("clicked/typed/opened") is not a valid final result.',
        nextTool: infoGoal ? 'get_page_text' : 'read_page',
      };
    }

    return { ok: true };
  },

  _normalizeSubGoalStatus(status) {
    const s = String(status || '').trim().toLowerCase();
    if (['pending', 'in_progress', 'completed', 'blocked'].includes(s)) return s;
    return 'pending';
  },

  _buildSubGoalRecord(text, idx) {
    return {
      id: `sg_${idx + 1}`,
      text: String(text || '').trim().slice(0, 220),
      status: 'pending',
      confidence: 0,
      attempts: 0,
      evidence: [],
      lastTool: '',
      lastUpdatedStep: -1,
    };
  },

  _restoreSubGoals(rawSubGoals = []) {
    if (!Array.isArray(rawSubGoals) || rawSubGoals.length === 0) {
      this._subGoals = [];
      return [];
    }
    const restored = [];
    for (const item of rawSubGoals) {
      if (!item || typeof item !== 'object') continue;
      const text = String(item.text || '').trim().slice(0, 220);
      if (!text) continue;
      const confidence = Number(item.confidence);
      const attempts = Number(item.attempts);
      const evidence = Array.isArray(item.evidence)
        ? item.evidence.map((e) => String(e || '').trim().slice(0, 220)).filter(Boolean).slice(0, 4)
        : [];
      restored.push({
        id: String(item.id || `sg_${restored.length + 1}`),
        text,
        status: this._normalizeSubGoalStatus(item.status),
        confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
        attempts: Number.isFinite(attempts) ? Math.min(Math.max(Math.floor(attempts), 0), 200) : 0,
        evidence,
        lastTool: String(item.lastTool || '').slice(0, 40),
        lastUpdatedStep: Number.isFinite(Number(item.lastUpdatedStep)) ? Number(item.lastUpdatedStep) : -1,
      });
      if (restored.length >= 8) break;
    }
    this._subGoals = restored;
    return restored;
  },

  _initializeSubGoals(goalText = '') {
    const parts = this._extractGoalSubtasks(String(goalText || this._goal || ''));
    const selected = parts.length > 0
      ? parts
      : [String(goalText || this._goal || '').trim()].filter(Boolean);
    const normalized = selected
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    this._subGoals = normalized.map((text, idx) => this._buildSubGoalRecord(text, idx));
    return this._subGoals;
  },

  _getSubGoalSnapshot(maxEvidence = 2) {
    const cap = Math.min(Math.max(Number(maxEvidence) || 2, 0), 4);
    const items = Array.isArray(this._subGoals) ? this._subGoals : [];
    return items.map((sg) => ({
      id: String(sg.id || ''),
      text: String(sg.text || '').slice(0, 220),
      status: this._normalizeSubGoalStatus(sg.status),
      confidence: Number.isFinite(Number(sg.confidence)) ? Number(sg.confidence) : 0,
      attempts: Number.isFinite(Number(sg.attempts)) ? Number(sg.attempts) : 0,
      evidence: Array.isArray(sg.evidence)
        ? sg.evidence.map((e) => String(e || '').slice(0, 220)).filter(Boolean).slice(0, cap)
        : [],
      lastTool: String(sg.lastTool || '').slice(0, 40),
      lastUpdatedStep: Number.isFinite(Number(sg.lastUpdatedStep)) ? Number(sg.lastUpdatedStep) : -1,
    }));
  },

  _buildSubGoalTrackerText(maxItems = 6) {
    const items = Array.isArray(this._subGoals) ? this._subGoals.slice(0, Math.max(Number(maxItems) || 6, 1)) : [];
    if (items.length === 0) return 'No explicit sub-goals detected yet.';

    const completed = items.filter((sg) => sg.status === 'completed').length;
    const blocked = items.filter((sg) => sg.status === 'blocked').length;
    const lines = [`Progress: ${completed}/${items.length} completed${blocked > 0 ? `, ${blocked} blocked` : ''}`];
    for (const sg of items) {
      const conf = Math.round(Math.min(Math.max(Number(sg.confidence) || 0, 0), 1) * 100);
      const ev = Array.isArray(sg.evidence) && sg.evidence.length > 0
        ? `; evidence: ${sg.evidence.slice(0, 1).join(' | ')}`
        : '';
      lines.push(`- [${sg.status}] ${sg.text} (conf=${conf}%, attempts=${Number(sg.attempts || 0)})${ev}`);
    }
    return lines.join('\n');
  },

  _getRemainingSubGoals(maxItems = 6) {
    const cap = Math.max(Number(maxItems) || 6, 1);
    const items = Array.isArray(this._subGoals) ? this._subGoals : [];
    return items
      .filter((sg) => sg && String(sg.status || '') !== 'completed')
      .slice(0, cap)
      .map((sg) => String(sg.text || '').trim())
      .filter(Boolean);
  },

  _matchSubGoalsByText(text, maxMatches = 2) {
    const corpus = String(text || '').toLowerCase();
    if (!corpus) return [];
    const items = Array.isArray(this._subGoals) ? this._subGoals : [];
    const scored = [];
    for (const sg of items) {
      if (!sg || sg.status === 'completed') continue;
      const keywords = this._extractCoverageKeywords(sg.text);
      if (keywords.length === 0) continue;
      const hits = keywords.filter((kw) => corpus.includes(kw));
      if (hits.length === 0) continue;
      const ratio = hits.length / keywords.length;
      scored.push({ sg, score: ratio * 10 + hits.length });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(Number(maxMatches) || 2, 1)).map((item) => item.sg);
  },

  _appendSubGoalEvidence(subGoal, evidenceText = '') {
    if (!subGoal || !evidenceText) return;
    const text = String(evidenceText || '').trim().replace(/\s+/g, ' ').slice(0, 220);
    if (!text) return;
    if (!Array.isArray(subGoal.evidence)) subGoal.evidence = [];
    if (!subGoal.evidence.includes(text)) subGoal.evidence.unshift(text);
    if (subGoal.evidence.length > 4) subGoal.evidence.length = 4;
  },

  _buildActionEvidenceText(tool, args, result) {
    const chunks = [String(tool || '')];
    if (args && typeof args === 'object') {
      for (const key of ['query', 'text', 'url', 'target', 'selector']) {
        if (args[key] !== undefined && args[key] !== null) {
          chunks.push(`${key}:${String(args[key]).slice(0, 120)}`);
        }
      }
    }
    if (result && typeof result === 'object') {
      for (const key of ['url', 'finalUrl', 'title', 'query', 'warning', 'reason', 'error']) {
        if (result[key] !== undefined && result[key] !== null) {
          chunks.push(`${key}:${String(result[key]).slice(0, 180)}`);
        }
      }
      if (typeof result.text === 'string' && result.text.trim()) {
        chunks.push(result.text.slice(0, 240));
      }
      if (typeof result.pageText === 'string' && result.pageText.trim()) {
        chunks.push(result.pageText.slice(0, 240));
      }
    }
    return chunks.join(' | ');
  },

  _updateSubGoalsAfterAction(step, tool, args, result) {
    if (!Array.isArray(this._subGoals) || this._subGoals.length === 0) return;

    const evidenceText = this._buildActionEvidenceText(tool, args, result);
    let targets = this._matchSubGoalsByText(evidenceText, 2);
    if (targets.length === 0) {
      const fallback = this._subGoals.find((sg) => sg.status === 'in_progress')
        || this._subGoals.find((sg) => sg.status === 'pending');
      if (fallback) targets = [fallback];
    }
    if (targets.length === 0) return;

    const blockedCodes = new Set(['SITE_BLOCKED', 'POLICY_CONFLICT', 'ACTION_LOOP_GUARD']);
    const success = result?.success !== false;
    const isHighSignal = success && typeof this._isHighSignalObservation === 'function'
      ? this._isHighSignalObservation({ type: 'action', tool, result })
      : false;

    for (const sg of targets) {
      if (!sg || sg.status === 'completed') continue;
      sg.attempts = Number(sg.attempts || 0) + 1;
      sg.lastTool = String(tool || '').slice(0, 40);
      sg.lastUpdatedStep = Number.isFinite(Number(step)) ? Number(step) : -1;
      this._appendSubGoalEvidence(sg, evidenceText);

      if (!success) {
        if (blockedCodes.has(String(result?.code || ''))) {
          sg.status = 'blocked';
          sg.confidence = Math.min(Math.max(Number(sg.confidence || 0), 0.05), 0.35);
        } else {
          if (sg.status === 'pending') sg.status = 'in_progress';
          sg.confidence = Math.max(0.05, Number(sg.confidence || 0) - 0.08);
        }
        continue;
      }

      if (sg.status === 'pending') sg.status = 'in_progress';
      const base = Number(sg.confidence || 0);
      sg.confidence = Math.min(0.95, Math.max(base, 0.2) + (isHighSignal ? 0.28 : 0.12));

      const keywords = this._extractCoverageKeywords(sg.text);
      if (keywords.length > 0) {
        const hits = keywords.filter((kw) => evidenceText.toLowerCase().includes(kw)).length;
        const required = Math.min(2, keywords.length);
        if (isHighSignal && hits >= required) {
          sg.status = 'completed';
          sg.confidence = Math.max(sg.confidence, 0.85);
        }
      }
    }
  },

  _applyCoverageToSubGoals(missingSubtasks = []) {
    if (!Array.isArray(this._subGoals) || this._subGoals.length === 0) return;
    const missing = new Set(
      (Array.isArray(missingSubtasks) ? missingSubtasks : [])
        .map((s) => String(s || '').trim().toLowerCase())
        .filter(Boolean),
    );

    for (const sg of this._subGoals) {
      if (!sg || sg.status === 'blocked') continue;
      const key = String(sg.text || '').trim().toLowerCase();
      if (missing.has(key)) {
        if (sg.status === 'completed') sg.status = 'in_progress';
        sg.confidence = Math.min(Number(sg.confidence || 0), 0.74);
        continue;
      }
      sg.status = 'completed';
      sg.confidence = Math.max(Number(sg.confidence || 0), 0.9);
    }
  },

  _extractGoalSubtasks(goalText) {
    if (!goalText) return [];
    const normalized = goalText
      .replace(/[\n\r]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!normalized) return [];

    // Protect chunks that should stay atomic before splitting by conjunctions.
    const placeholders = [];
    const protectChunk = (chunk) => {
      const token = `__protected_${placeholders.length}__`;
      placeholders.push(String(chunk));
      return token;
    };
    const restoreChunks = (value) => String(value || '').replace(/__protected_(\d+)__/g, (m, idx) => {
      const n = Number(idx);
      if (!Number.isFinite(n) || n < 0 || n >= placeholders.length) return m;
      return placeholders[n];
    });

    let protectedGoal = normalized;

    // Keep quoted spans intact (they often contain item pairs or named entities).
    protectedGoal = protectedGoal.replace(/"[^"]+"|'[^']+'|«[^»]+»|“[^”]+”/g, (m) => protectChunk(m));

    // Keep common "single intent with two entities" phrases intact:
    // e.g. "price macbook air and macbook pro", "compare x and y".
    protectedGoal = protectedGoal.replace(
      /\b(?:price|cost|compare|find)\s+([^\n,;:.]{2,80}?)\s+(?:and)\s+([^\n,;:.]{2,80}?)(?=(?:\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\balso\b))|$)/gi,
      (m) => protectChunk(m),
    );

    const separators = /(?:\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\band\b|\balso\b)\s+)/i;
    const parts = protectedGoal
      .split(separators)
      .map((p) => restoreChunks(p).trim())
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
      'it', 'how', 'what', 'why', 'for', 'or', 'need', 'please', 'do', 'make',
      'open', 'check', 'find', 'go', 'to', 'from', 'by', 'and', 'but',
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
