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
};

function makeAgent() {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent.history = [];
  agent._goal = 'find llm news in february 2026 in english';
  agent._isNavigateOnly = false;
  agent._appendMessage = () => {};
  agent._emitStep = () => {};
  agent._notify = () => {};
  agent._finalizeMetrics = () => ({});
  return agent;
}

test('navigate with pageText counts as read evidence for done coverage', () => {
  const agent = makeAgent();
  agent.history = [
    {
      step: 0,
      type: 'action',
      tool: 'navigate',
      result: {
        success: true,
        url: 'https://example.com',
        pageText: 'Search results: LLM launch Feb 18, 2026 and GLM-5 Feb 10, 2026 with details.',
      },
    },
  ];

  const coverage = agent._validateDoneCoverage(
    'Found LLM news',
    'Gemini 3.1 Pro (Feb 18, 2026), GLM-5 (Feb 10, 2026).',
    { allowPartial: false },
  );
  assert.equal(coverage.ok, true);
});

test('repeated completion rejection forces evidence action to break reflection-only loop', async () => {
  const agent = makeAgent();
  let forcedCalls = 0;
  agent._handleToolCalls = async () => {
    forcedCalls += 1;
    return null;
  };

  const activeTools = [{ name: 'get_page_text' }, { name: 'read_page' }];
  const stepBudget = { remaining: 10 };
  const messages = [];

  const first = await agent._handleCompletionRejectedNoAction(
    1,
    messages,
    activeTools,
    stepBudget,
    { code: 'DONE_COVERAGE_FAILED', reason: 'missing evidence', searchQuery: 'llm news february 2026' },
  );
  assert.equal(first.handled, false);
  assert.equal(forcedCalls, 0);

  const second = await agent._handleCompletionRejectedNoAction(
    2,
    messages,
    activeTools,
    stepBudget,
    { code: 'DONE_COVERAGE_FAILED', reason: 'missing evidence', searchQuery: 'llm news february 2026' },
  );
  assert.equal(second.handled, true);
  assert.equal(forcedCalls, 1);
});

test('done is rejected while post-action verification is still pending', async () => {
  const agent = makeAgent();
  agent._pendingVerification = {
    step: 2,
    tool: 'computer',
    action: 'click',
    actionLabel: 'click',
    expectedOutcome: 'the clicked control should change the page state',
  };

  const verification = agent._validateDoneVerification();
  assert.equal(verification.ok, false);
  assert.match(verification.reason, /not verified yet/i);
});

test('successful observation clears pending verification', () => {
  const agent = makeAgent();
  agent._pendingVerification = {
    step: 2,
    tool: 'computer',
    action: 'click',
    actionLabel: 'click',
    expectedOutcome: 'the clicked control should change the page state',
  };

  agent._updatePendingVerificationAfterAction(
    3,
    'read_page',
    {},
    {},
    { success: true, url: 'https://example.com', tree: {} },
  );

  assert.equal(agent._pendingVerification, null);
});
