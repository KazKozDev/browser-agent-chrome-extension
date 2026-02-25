import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';

global.chrome = global.chrome || {};
global.chrome.storage = global.chrome.storage || {
  local: {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
  },
};
global.chrome.tabs = global.chrome.tabs || {
  get: async () => ({ id: 1, windowId: 1, url: 'https://example.com', title: 'Example' }),
  update: async () => {},
  sendMessage: async () => ({ success: true }),
  onUpdated: {
    addListener: () => {},
    removeListener: () => {},
  },
};
global.chrome.scripting = global.chrome.scripting || {
  executeScript: async () => [],
};

function makeMetrics() {
  return {
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    errors: 0,
    duplicateToolCalls: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    providerId: '',
    normalization: { total: 0, changed: 0 },
    invalidActions: { total: 0, repeated: 0 },
    completion: { doneAttempts: 0, rejectedNoSubstance: 0 },
    stepLimit: { reached: false, failed: 0 },
  };
}

test('run executes reflection actions[] as a batch within a single step', async () => {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent.maxSteps = 1;
  agent.metrics = makeMetrics();
  agent._sendToContent = async (action) => {
    if (action === 'readPage') {
      return { url: 'https://example.com', title: 'Example', interactiveCount: 0, nodeCount: 1, tree: {} };
    }
    if (action === 'getPageText') {
      return { url: 'https://example.com', title: 'Example', text: 'Example body text', charCount: 17 };
    }
    return { success: true };
  };
  agent._pauseIfManualInterventionNeeded = async () => {};
  agent._runReflection = async () => ({
    ok: true,
    state: {
      facts: ['loaded page'],
      unknowns: ['need extract'],
      sufficiency: false,
      confidence: 0.42,
      search_query: '',
      summary: '',
      answer: '',
      actions: [
        { tool: 'read_page', args: {} },
        { tool: 'get_page_text', args: { scope: 'viewport' } },
      ],
      next_action: { tool: 'read_page', args: {} },
    },
  });

  let capturedToolCalls = [];
  agent._handleToolCalls = async (_step, _messages, response) => {
    capturedToolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    return { success: false, reason: 'stub-stop', steps: 1, metrics: agent.metrics };
  };
  agent._startTabWatcher = () => {};
  agent._stopTabWatcher = () => {};
  agent._notify = () => {};
  agent._emitStep = () => {};
  agent._finalizeMetrics = () => agent.metrics;

  const result = await agent.run('collect data from page');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'stub-stop');
  assert.equal(capturedToolCalls.length, 2);
  assert.equal(capturedToolCalls[0].name, 'read_page');
  assert.equal(capturedToolCalls[1].name, 'get_page_text');
});
