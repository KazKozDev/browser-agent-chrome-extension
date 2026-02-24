export const contextMethods = {
  _recordUsage(usage) {
    if (!this.metrics || !usage) return;
    const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0);
    const completion = Number(usage.completion_tokens || usage.output_tokens || 0);
    const total = Number(usage.total_tokens || prompt + completion);
    this.metrics.tokens.prompt += Number.isFinite(prompt) ? prompt : 0;
    this.metrics.tokens.completion += Number.isFinite(completion) ? completion : 0;
    this.metrics.tokens.total += Number.isFinite(total) ? total : 0;
  },

  _hasScratchpadData() {
    return this._scratchpad && typeof this._scratchpad === 'object' && Object.keys(this._scratchpad).length > 0;
  },

  _buildScratchpadSystemMessage() {
    if (!this._hasScratchpadData()) return null;
    let serialized = '';
    try {
      serialized = JSON.stringify(this._scratchpad);
    } catch {
      serialized = '{"error":"scratchpad serialization failed"}';
    }
    const maxChars = 4000;
    if (serialized.length > maxChars) {
      serialized = `${serialized.slice(0, maxChars)}...[truncated]`;
    }
    return {
      role: 'system',
      content: `Accumulated progress from previous steps (reliable memory, do not discard):\n${serialized}`,
    };
  },

  _buildMessagesForLLM(messages) {
    const scratchpadMessage = this._buildScratchpadSystemMessage();
    if (!scratchpadMessage) return messages;
    if (messages.length <= 1) return [...messages, scratchpadMessage];
    return [messages[0], scratchpadMessage, ...messages.slice(1)];
  },

  _appendMessage(messages, message) {
    messages.push(message);
    this._compressHistory(messages);
    this._trimMessages(messages);
  },

  _compressHistory(messages) {
    if (messages.length <= 4) return;

    let assistantTurns = 0;
    // Iterate from newest to oldest
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        assistantTurns++;
        continue;
      }

      // Keep full content only for the last 1-2 turns. Compress older heavy payloads.
      if (assistantTurns >= 2) {
        if (msg.role === 'tool' && typeof msg.content === 'string') {
          // If it's a huge string (likely read_page, get_page_text, find_text output)
          if (msg.content.length > 10000) {
            msg.content = JSON.stringify({ success: true, note: 'Content omitted from history to save context. You already read this page.' });
          }
        } else if (msg.role === 'user' && Array.isArray(msg.content)) {
          // It's a vision message (screenshot) from a past turn.
          const hasImage = msg.content.some(c => c.type === 'image_url');
          if (hasImage) {
            msg.content = 'Screenshot omitted from history to save context. You already analyzed this view.';
          }
        }
      }
    }
  },

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
  },

  _finalizeMetrics() {
    if (!this.metrics) return null;
    this.metrics.finishedAt = Date.now();
    this.metrics.durationMs = this.metrics.finishedAt - this.metrics.startedAt;
    return this.metrics;
  },

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

    // Keep structured extraction compact and deterministic for reflection.
    if (toolName === 'extract_structured' && safe && Array.isArray(safe.items)) {
      const compactItems = safe.items.slice(0, 20).map((item) => ({
        title: String(item?.title || '').slice(0, 220),
        price_value: Number.isFinite(Number(item?.price_value)) ? Number(item.price_value) : null,
        price_currency: String(item?.price_currency || '').slice(0, 4),
        rating_value: Number.isFinite(Number(item?.rating_value)) ? Number(item.rating_value) : null,
        rating_count: Number.isFinite(Number(item?.rating_count)) ? Number(item.rating_count) : null,
        url: String(item?.url || '').slice(0, 260),
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
      }));
      safe = {
        success: safe.success !== false,
        page_url: safe.page_url || safe.url || this._lastKnownUrl || '',
        title: String(safe.title || '').slice(0, 180),
        count: Number(safe.count || compactItems.length),
        returned: compactItems.length,
        items: compactItems,
        compactedForModel: true,
      };
    }

    // Inject current URL into every tool result so the model always knows where it is.
    // Skip tools that already return url in their result.
    const hasUrl = safe && (safe.url || safe.pageUrl || safe.finalUrl);
    if (!hasUrl && this._lastKnownUrl) {
      safe = { ...safe, _currentUrl: this._lastKnownUrl };
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
  },

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
  },
};
