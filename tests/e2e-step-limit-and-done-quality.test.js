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

test('done is rejected when final answer has no substantive result', async () => {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent.metrics = makeMetrics();
  agent.history = [{ step: 0, type: 'action', tool: 'read_page', result: { success: true } }];
  agent._appendMessage = (messages, msg) => messages.push(msg);
  agent._serializeToolResultForLLM = (_tool, result) => JSON.stringify(result);
  agent._emitStep = () => {};
  agent._notify = () => {};
  agent._finalizeMetrics = () => agent.metrics;
  agent._checkPrematureDone = () => ({ ok: true });
  agent._validateDoneCoverage = () => ({ ok: true, missing: [] });
  agent._executeTool = async (name, args) => {
    if (name === 'done') return { success: true, summary: args.summary, answer: args.answer || '' };
    return { success: true };
  };

  const messages = [];
  await agent._handleToolCalls(
    1,
    messages,
    {
      text: null,
      toolCalls: [{ id: 'done_1', name: 'done', arguments: { summary: 'Clicked the button', answer: '' } }],
    },
    { remaining: 5 },
  );

  const doneEntry = agent.history.find((h) => h.tool === 'done');
  assert.ok(doneEntry);
  assert.equal(doneEntry.result.success, false);
  assert.equal(doneEntry.result.code, 'DONE_QUALITY_FAILED');
});

test('run ends with fail when step limit is exhausted', async () => {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent.maxSteps = 1;
  agent._sendToContent = async (action) => {
    if (action === 'readPage') {
      return { url: 'https://example.com', title: 'Example', interactiveCount: 0, nodeCount: 1, tree: {} };
    }
    if (action === 'getPageText') {
      return { url: 'https://example.com', title: 'Example', text: '', charCount: 0 };
    }
    return { success: true };
  };
  agent._pauseIfManualInterventionNeeded = async () => {};
  agent._runReflection = async () => ({
    ok: true,
    state: {
      facts: [],
      unknowns: ['still missing required data'],
      sufficiency: false,
      confidence: 0.2,
      search_query: '',
      summary: '',
      answer: '',
      next_action: { tool: 'read_page', args: {} },
    },
  });
  agent._handleToolCalls = async () => null;
  agent._startTabWatcher = () => {};
  agent._stopTabWatcher = () => {};

  const result = await agent.run('Find exact data and return final answer');
  assert.equal(result.success, false);
  assert.equal(result.status, 'stuck');
  assert.match(result.reason, /Step limit reached/i);
  assert.equal(result.partial_result?.status, 'stuck');
  assert.ok(Array.isArray(result.partial_result?.remaining_subgoals));
  assert.equal(result.metrics.stepLimit.reached, true);
  assert.equal(result.metrics.stepLimit.failed, 1);
});
