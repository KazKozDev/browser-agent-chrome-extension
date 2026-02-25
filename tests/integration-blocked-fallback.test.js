import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';

global.chrome = global.chrome || {
  storage: {
    local: {
      get: async () => ({ diagnosticTelemetry: [] }),
      set: async () => {},
    },
  },
  tabs: {
    get: async () => ({ url: 'https://example.com', title: 'Example' }),
  },
};

function makeAgent() {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent.metrics = {
    toolCalls: 0,
    duplicateToolCalls: 0,
    invalidActions: { total: 0, repeated: 0 },
    completion: { doneAttempts: 0, rejectedNoSubstance: 0 },
  };
  agent.history = [];
  agent._lastToolKey = '';
  agent._dupCount = 0;
  agent._toolFailStreak = 0;
  agent._lastTypeFailed = false;
  agent._appendMessage = (messages, msg) => messages.push(msg);
  agent._serializeToolResultForLLM = (_tool, result) => JSON.stringify(result);
  agent._emitStep = () => {};
  agent._notify = () => {};
  agent._finalizeMetrics = () => agent.metrics;
  agent._checkPrematureDone = () => ({ ok: true });
  agent._validateDoneQuality = () => ({ ok: true });
  agent._validateDoneCoverage = () => ({ ok: true, missing: [] });
  agent._executeTool = async () => ({
    success: false,
    code: 'ELEMENT_NOT_FOUND',
    error: 'Element [999] not found',
    target: 999,
  });
  return agent;
}

test('blocked action includes machine-readable fallback hint', async () => {
  const agent = makeAgent();
  const messages = [];

  await agent._handleToolCalls(
    0,
    messages,
    {
      text: null,
      toolCalls: [{ id: 't1', name: 'click', arguments: { target: 999 } }],
    },
    { remaining: 5 },
  );

  const action = agent.history.find((h) => h.type === 'action' && h.tool === 'click');
  assert.ok(action);
  assert.equal(action.result.success, false);
  assert.equal(action.result.code, 'ELEMENT_NOT_FOUND');
  assert.equal(action.result.hint.nextTool, 'read_page');
  assert.equal(action.result.retryable, false);

  const fallback = agent._sanitizePlannedAction({ tool: 'click', args: { target: 999 } });
  assert.equal(fallback.tool, 'read_page');
});

test('repeated invalid action triggers anti-loop guard', async () => {
  const agent = makeAgent();
  const messages = [];

  await agent._handleToolCalls(
    0,
    messages,
    {
      text: null,
      toolCalls: [{ id: 't1', name: 'click', arguments: { target: 999 } }],
    },
    { remaining: 5 },
  );
  await agent._handleToolCalls(
    1,
    messages,
    {
      text: null,
      toolCalls: [{ id: 't2', name: 'click', arguments: { target: 999, clickCount: 2 } }],
    },
    { remaining: 4 },
  );

  const last = agent.history[agent.history.length - 1];
  assert.equal(last.result.code, 'ACTION_LOOP_GUARD');
  assert.equal(last.result.hint.strategy, 'fallback_after_block');
  assert.ok(agent.metrics.invalidActions.repeated >= 1);
});

test('sanitizePlannedAction avoids repeating identical find_text query on SERP', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://www.google.com/search?q=llm+news+feb+2026';
  agent._lastFindTextMiss = {
    query: 'llm news feb 2026 analysis',
    url: 'https://www.google.com/search?q=llm+news+feb+2026',
  };

  const next = agent._sanitizePlannedAction({
    tool: 'find_text',
    args: { query: 'llm news feb 2026 analysis' },
  });

  assert.ok(next);
  if (next.tool === 'find_text') {
    assert.notEqual(String(next.args?.query || '').toLowerCase(), 'llm news feb 2026 analysis');
  } else {
    assert.notEqual(next.tool, 'find_text');
  }
});
