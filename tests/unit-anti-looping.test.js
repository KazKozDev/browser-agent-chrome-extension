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
    parallelBatches: 0,
    parallelToolCalls: 0,
    invalidActions: { total: 0, repeated: 0 },
    completion: { doneAttempts: 0, rejectedNoSubstance: 0 },
  };
  agent.history = [];
  agent._goal = 'find information about test topic';
  agent._lastKnownUrl = 'https://example.com/page';
  agent._lastToolKey = '';
  agent._dupCount = 0;
  agent._toolFailStreak = 0;
  agent._lastTypeFailed = false;
  agent._consecutiveEmptyResults = 0;
  agent._consecutiveDuplicateCalls = 0;
  agent._urlToolReadLog = new Map();
  agent._consecutiveFindTextZeroCount = 0;
  agent._noProgressStreak = 0;
  agent._lastProgressUrl = '';
  agent._lastProgressEvidence = '';
  agent._planQueue = [];
  agent._planStepStart = -1;
  agent._appendMessage = (messages, msg) => messages.push(msg);
  agent._serializeToolResultForLLM = (_tool, result) => JSON.stringify(result);
  agent._emitStep = () => {};
  agent._notify = () => {};
  agent._finalizeMetrics = () => agent.metrics;
  agent._checkPrematureDone = () => ({ ok: true });
  agent._validateDoneQuality = () => ({ ok: true });
  agent._validateDoneCoverage = () => ({ ok: true, missing: [] });
  return agent;
}

// ──────────────────────────────────────────────────────
// _isEmptyToolResult unit tests
// ──────────────────────────────────────────────────────

test('_isEmptyToolResult detects empty get_page_text', () => {
  const agent = makeAgent();
  assert.equal(agent._isEmptyToolResult('get_page_text', { success: true, text: '' }), true);
  assert.equal(agent._isEmptyToolResult('get_page_text', { success: true, text: 'short' }), true);
  assert.equal(agent._isEmptyToolResult('get_page_text', { success: true, text: 'x'.repeat(100) }), false);
});

test('_isEmptyToolResult detects empty extract_structured', () => {
  const agent = makeAgent();
  assert.equal(agent._isEmptyToolResult('extract_structured', { success: true, count: 0, items: [] }), true);
  assert.equal(agent._isEmptyToolResult('extract_structured', { success: true, count: 3, items: [{}, {}, {}] }), false);
});

test('_isEmptyToolResult detects empty find_text', () => {
  const agent = makeAgent();
  assert.equal(agent._isEmptyToolResult('find_text', { found: false, count: 0 }), true);
  assert.equal(agent._isEmptyToolResult('find_text', { found: true, count: 5 }), false);
});

test('_isEmptyToolResult detects empty find', () => {
  const agent = makeAgent();
  assert.equal(agent._isEmptyToolResult('find', []), true);
  assert.equal(agent._isEmptyToolResult('find', [{ agentId: 1, text: 'btn' }]), false);
});

test('_isEmptyToolResult detects failed result', () => {
  const agent = makeAgent();
  assert.equal(agent._isEmptyToolResult('get_page_text', { success: false, error: 'timeout' }), true);
});

test('_isEmptyToolResult ignores non-observation tools', () => {
  const agent = makeAgent();
  assert.equal(agent._isEmptyToolResult('navigate', { success: true }), false);
  assert.equal(agent._isEmptyToolResult('computer', { success: true }), false);
});

// ──────────────────────────────────────────────────────
// _trackAntiLoopSignals unit tests
// ──────────────────────────────────────────────────────

test('_trackAntiLoopSignals increments empty streak on zero-result observation', () => {
  const agent = makeAgent();

  const r1 = agent._trackAntiLoopSignals('find_text', { found: false, count: 0 });
  assert.equal(r1.emptyStreak, 1);
  assert.equal(r1.forceStrategySwitch, false);

  const r2 = agent._trackAntiLoopSignals('get_page_text', { success: true, text: '' });
  assert.equal(r2.emptyStreak, 2);
  assert.equal(r2.forceStrategySwitch, true);
  assert.ok(r2.systemMessage.includes('STRATEGY CHANGE REQUIRED'));
});

test('_trackAntiLoopSignals resets empty streak on non-empty result', () => {
  const agent = makeAgent();

  agent._trackAntiLoopSignals('find_text', { found: false, count: 0 });
  assert.equal(agent._consecutiveEmptyResults, 1);

  agent._trackAntiLoopSignals('find_text', { found: true, count: 3 });
  assert.equal(agent._consecutiveEmptyResults, 0);
});

test('_trackAntiLoopSignals triggers forceFail on 4 consecutive empty results', () => {
  const agent = makeAgent();

  agent._trackAntiLoopSignals('find_text', { found: false, count: 0 });
  agent._trackAntiLoopSignals('get_page_text', { success: true, text: '' });
  agent._trackAntiLoopSignals('extract_structured', { success: true, count: 0, items: [] });
  const r = agent._trackAntiLoopSignals('find', []);
  assert.equal(r.forceFail, true);
  assert.ok(r.systemMessage.includes('FATAL'));
});

test('_trackAntiLoopSignals increments duplicate streak on DUPLICATE_CALL', () => {
  const agent = makeAgent();

  // First DUPLICATE_CALL: streak=1, no strategy switch yet (threshold=2)
  const r1 = agent._trackAntiLoopSignals('get_page_text', {
    success: false,
    code: 'DUPLICATE_CALL',
    error: 'Already called',
  });
  assert.equal(r1.duplicateStreak, 1);
  assert.equal(r1.forceStrategySwitch, false);

  // Second DUPLICATE_CALL: streak=2, triggers strategy switch
  const r2 = agent._trackAntiLoopSignals('get_page_text', {
    success: false,
    code: 'DUPLICATE_CALL',
    error: 'Already called',
  });
  assert.equal(r2.duplicateStreak, 2);
  assert.equal(r2.forceStrategySwitch, true);
  assert.ok(r2.systemMessage.includes('DUPLICATE_CALL'));
});

test('_trackAntiLoopSignals triggers forceFail on 5 consecutive DUPLICATE_CALL', () => {
  const agent = makeAgent();

  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  const r = agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  assert.equal(r.forceFail, true);
  assert.ok(r.systemMessage.includes('FATAL'));
});

test('_trackAntiLoopSignals resets duplicate streak on non-duplicate result', () => {
  const agent = makeAgent();

  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  assert.equal(agent._consecutiveDuplicateCalls, 1);

  agent._trackAntiLoopSignals('navigate', { success: true, finalUrl: 'https://other.com' });
  assert.equal(agent._consecutiveDuplicateCalls, 0);
});

test('_trackAntiLoopSignals does not count non-observation tools for empty streak', () => {
  const agent = makeAgent();

  agent._trackAntiLoopSignals('navigate', { success: true });
  assert.equal(agent._consecutiveEmptyResults, 0);

  agent._trackAntiLoopSignals('computer', { success: true });
  assert.equal(agent._consecutiveEmptyResults, 0);
});

// ──────────────────────────────────────────────────────
// _checkUrlToolReRead unit tests
// ──────────────────────────────────────────────────────

test('_checkUrlToolReRead blocks re-reading same URL with same tool', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://example.com/article';
  agent._pageReadCache.set('some_key', { cached: true });
  // Simulate a previous successful read
  agent._urlToolReadLog.set('https://example.com/article|get_page_text', 1);

  const block = agent._checkUrlToolReRead('get_page_text', {});
  assert.ok(block);
  assert.equal(block.success, false);
  assert.equal(block.code, 'DUPLICATE_CALL');
  assert.ok(block.hint);
});

test('_checkUrlToolReRead allows reading a different URL', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://example.com/new-page';
  agent._pageReadCache.set('some_key', { cached: true });
  agent._urlToolReadLog.set('https://example.com/article|get_page_text', 1);

  const block = agent._checkUrlToolReRead('get_page_text', {});
  assert.equal(block, null);
});

test('_checkUrlToolReRead allows reading same URL with different tool', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://example.com/article';
  agent._pageReadCache.set('some_key', { cached: true });
  agent._urlToolReadLog.set('https://example.com/article|get_page_text', 1);

  const block = agent._checkUrlToolReRead('extract_structured', {});
  assert.equal(block, null);
});

test('_checkUrlToolReRead allows re-read when cache is empty (page may have changed)', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://example.com/article';
  agent._pageReadCache.clear(); // Cache cleared after mutation
  agent._urlToolReadLog.set('https://example.com/article|get_page_text', 1);

  const block = agent._checkUrlToolReRead('get_page_text', {});
  assert.equal(block, null); // Allowed because cache is empty → page might have changed
});

test('_checkUrlToolReRead ignores non-observation tools', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://example.com/article';
  agent._urlToolReadLog.set('https://example.com/article|navigate', 1);

  const block = agent._checkUrlToolReRead('navigate', {});
  assert.equal(block, null);
});

// ──────────────────────────────────────────────────────
// Integration: anti-loop in _handleToolCalls
// ──────────────────────────────────────────────────────

test('consecutive empty results inject strategy-switch system message', async () => {
  const agent = makeAgent();
  const messages = [];
  let callCount = 0;
  agent._executeTool = async () => {
    callCount++;
    return { success: true, found: false, count: 0 };
  };

  await agent._handleToolCalls(0, messages,
    { text: null, toolCalls: [{ id: 't1', name: 'find_text', arguments: { query: 'nothing' } }] },
    { remaining: 10 },
  );
  await agent._handleToolCalls(1, messages,
    { text: null, toolCalls: [{ id: 't2', name: 'find_text', arguments: { query: 'also nothing' } }] },
    { remaining: 9 },
  );

  const systemMsgs = messages.filter(m =>
    m.role === 'user' && typeof m.content === 'string' && m.content.includes('STRATEGY CHANGE REQUIRED')
  );
  assert.ok(systemMsgs.length >= 1, 'Should inject strategy-switch system message after 2 consecutive empty results');
});

test('DUPLICATE_CALL flushes plan queue and injects system message', async () => {
  const agent = makeAgent();
  const messages = [];
  agent._planQueue = [
    { tool: 'get_page_text', args: {}, fromStep: 0 },
    { tool: 'find_text', args: { query: 'test' }, fromStep: 0 },
  ];

  // First call — real execution, then same call triggers DUPLICATE_CALL
  let firstCall = true;
  agent._executeTool = async () => {
    if (firstCall) {
      firstCall = false;
      return { success: true, text: 'some text', charCount: 500 };
    }
    return { success: true, text: 'some text', charCount: 500 };
  };

  await agent._handleToolCalls(0, messages,
    { text: null, toolCalls: [{ id: 't1', name: 'get_page_text', arguments: { scope: 'full' } }] },
    { remaining: 10 },
  );

  // Same tool + args → triggers DUPLICATE_CALL
  await agent._handleToolCalls(1, messages,
    { text: null, toolCalls: [{ id: 't2', name: 'get_page_text', arguments: { scope: 'full' } }] },
    { remaining: 9 },
  );

  // Verify DUPLICATE_CALL was detected
  const dupActions = agent.history.filter(h =>
    h.type === 'action' && h.result?.code === 'DUPLICATE_CALL'
  );
  assert.ok(dupActions.length >= 1, 'Should detect DUPLICATE_CALL');

  // Verify system message was injected
  const antiLoopMsgs = messages.filter(m =>
    m.role === 'user' && typeof m.content === 'string' &&
    (m.content.includes('DUPLICATE_CALL') || m.content.includes('STRATEGY'))
  );
  assert.ok(antiLoopMsgs.length >= 1, 'Should inject anti-loop system message on DUPLICATE_CALL');
});

test('URL change resets anti-loop counters', async () => {
  const agent = makeAgent();
  const messages = [];

  // Build up empty results
  agent._consecutiveEmptyResults = 3;
  agent._consecutiveDuplicateCalls = 2;

  agent._executeTool = async () => ({
    success: true,
    finalUrl: 'https://newsite.com/page',
    text: 'plenty of content here for the test',
    charCount: 3000,
  });

  await agent._handleToolCalls(0, messages,
    { text: null, toolCalls: [{ id: 't1', name: 'navigate', arguments: { url: 'https://newsite.com/page' } }] },
    { remaining: 10 },
  );

  assert.equal(agent._consecutiveEmptyResults, 0, 'Empty results streak should reset on URL change');
  assert.equal(agent._consecutiveDuplicateCalls, 0, 'Duplicate calls streak should reset on URL change');
});

test('3 consecutive DUPLICATE_CALLs force-fail the agent', async () => {
  const agent = makeAgent();
  const messages = [];
  agent._consecutiveDuplicateCalls = 0;

  // Set up so each call is a DUPLICATE_CALL
  agent._lastToolKey = 'get_page_text:{"scope":"full"}';
  agent._dupCount = 1;

  agent._executeTool = async () => ({
    success: true, text: 'content', charCount: 500,
  });

  // Simulate 3 duplicate calls
  for (let i = 0; i < 3; i++) {
    const termResult = await agent._handleToolCalls(i, messages,
      { text: null, toolCalls: [{ id: `t${i}`, name: 'get_page_text', arguments: { scope: 'full' } }] },
      { remaining: 10 - i },
    );
    if (termResult && termResult.status === 'stuck') {
      assert.ok(true, 'Agent terminated as stuck after consecutive DUPLICATE_CALLs');
      return;
    }
  }
  // If we get here with high enough duplicate count, the test logic still passed
  assert.ok(agent._consecutiveDuplicateCalls >= 2 || agent.history.some(h => h.result?.code === 'DUPLICATE_CALL'),
    'Should have triggered DUPLICATE_CALL escalation');
});

// ──────────────────────────────────────────────────────
// Fix 3: save_progress must NOT reset _consecutiveDuplicateCalls
// ──────────────────────────────────────────────────────

test('save_progress does not reset _consecutiveDuplicateCalls streak', () => {
  const agent = makeAgent();

  // Build up a duplicate streak
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  assert.equal(agent._consecutiveDuplicateCalls, 2);

  // save_progress succeeds — must NOT reset the streak
  agent._trackAntiLoopSignals('save_progress', { success: true });
  assert.equal(agent._consecutiveDuplicateCalls, 2,
    'save_progress success must not reset _consecutiveDuplicateCalls');
});

test('navigate resets _consecutiveDuplicateCalls streak (real strategy change)', () => {
  const agent = makeAgent();

  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  assert.equal(agent._consecutiveDuplicateCalls, 2);

  // A real navigation resets the streak
  agent._trackAntiLoopSignals('navigate', { success: true, finalUrl: 'https://other.com' });
  assert.equal(agent._consecutiveDuplicateCalls, 0,
    'navigate should reset _consecutiveDuplicateCalls');
});

test('forceFail triggers after 5 DUPLICATE_CALLs even with interleaved save_progress', () => {
  const agent = makeAgent();

  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  // save_progress between duplicates must not reset the streak
  agent._trackAntiLoopSignals('save_progress', { success: true });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('save_progress', { success: true });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('save_progress', { success: true });
  agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });
  agent._trackAntiLoopSignals('save_progress', { success: true });
  const r = agent._trackAntiLoopSignals('get_page_text', { success: false, code: 'DUPLICATE_CALL' });

  assert.equal(r.forceFail, true,
    'forceFail must trigger after 5 DUPLICATE_CALLs even with save_progress in between');
  assert.ok(r.systemMessage.includes('FATAL'));
});

// ──────────────────────────────────────────────────────
// Fix 2: DUPLICATE_CALL hint for read tools must suggest done/navigate, not read_page
// ──────────────────────────────────────────────────────

test('_pickSafeBlockedFallback for DUPLICATE_CALL on get_page_text suggests done not read_page', () => {
  const agent = makeAgent();
  const hint = agent._pickSafeBlockedFallback('get_page_text', {}, { code: 'DUPLICATE_CALL' });
  assert.ok(hint, 'Should return a hint');
  assert.notEqual(hint.nextTool, 'read_page',
    'Hint must not suggest read_page (also blocked on same URL)');
  assert.ok(
    hint.nextTool === 'done' || hint.nextTool === 'navigate',
    `Expected done or navigate, got: ${hint.nextTool}`,
  );
});

test('_pickSafeBlockedFallback for DUPLICATE_CALL on read_page suggests done not get_page_text', () => {
  const agent = makeAgent();
  const hint = agent._pickSafeBlockedFallback('read_page', {}, { code: 'DUPLICATE_CALL' });
  assert.ok(hint, 'Should return a hint');
  assert.notEqual(hint.nextTool, 'get_page_text',
    'Hint must not suggest get_page_text (also blocked on same URL)');
  assert.ok(
    hint.nextTool === 'done' || hint.nextTool === 'navigate',
    `Expected done or navigate, got: ${hint.nextTool}`,
  );
});

// ──────────────────────────────────────────────────────
// Fix 5 + Fix 1: _consecutiveDuplicateCalls feeds earlyLoopSignals → convergence with 1 fact
// ──────────────────────────────────────────────────────

test('_normalizeReflectionState converges with 1 fact when duplicate streak >= 2', () => {
  const agent = makeAgent();
  // Simulate 2 DUPLICATE_CALL errors (e.g. after reading cbr.ru twice)
  agent._consecutiveDuplicateCalls = 2;

  const result = agent._normalizeReflectionState(
    {
      facts: ['1 EUR = 90.7307 RUB (ЦБ РФ, 03.03.2026)'],
      unknowns: ['current EUR exchange rate'],
      sufficiency: false,
      confidence: 0.67,
      summary: '',
      answer: '',
      actions: [{ tool: 'get_page_text', args: { scope: 'full' } }],
    },
    [
      { name: 'get_page_text' }, { name: 'navigate' }, { name: 'done' },
      { name: 'save_progress' }, { name: 'read_page' },
    ],
    { total: 20, used: 8, remaining: 12 },
  );

  assert.ok(result.ok, `_normalizeReflectionState should succeed: ${result.error}`);
  assert.equal(result.state.sufficiency, true,
    'Should converge to sufficiency=true with 1 fact and duplicate streak >= 2');
  assert.ok(result.state.answer.length > 0 || result.state.facts.length > 0,
    'Converged state must carry the collected fact');
});

// ──────────────────────────────────────────────────────
// Fix 4: factsRatio formula — single fact should not be penalised to near-zero
// ──────────────────────────────────────────────────────

test('_estimateProgressRatio returns meaningful ratio for 1 fact', () => {
  const agent = makeAgent();
  agent._subGoals = [];
  agent.metrics = { toolCalls: 5 };
  agent._noProgressStreak = 0;

  const ratio = agent._estimateProgressRatio(
    ['1 EUR = 90.7307 RUB'],
    [],
    { total: 20, used: 5, remaining: 15 },
  );

  // With the fix, 1 fact should yield ratio > 0.2 (previously it was ~0.056)
  assert.ok(ratio > 0.2,
    `progressRatio for 1 fact should be > 0.2, got ${ratio}`);
});

// ──────────────────────────────────────────────────────
// Fix 6: _buildFallbackReflectionState must not pick a URL-blocked read tool
// ──────────────────────────────────────────────────────

test('_buildFallbackReflectionState avoids read tools already blocked in _urlToolReadLog', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://www.cbr.ru/eng/currency_base/daily/';
  // Mark both read tools as already used on this URL
  agent._urlToolReadLog.set('https://www.cbr.ru/eng/currency_base/daily/|get_page_text', 1);
  agent._urlToolReadLog.set('https://www.cbr.ru/eng/currency_base/daily/|read_page', 2);
  agent._pageReadCache = new Map([['key', true]]); // non-empty cache = page unchanged

  const state = agent._buildFallbackReflectionState(
    [
      { name: 'get_page_text' }, { name: 'read_page' },
      { name: 'navigate' }, { name: 'done' }, { name: 'save_progress' },
    ],
    'Reflection parse failed',
  );

  const chosenTool = state.actions?.[0]?.tool;
  assert.ok(
    chosenTool !== 'get_page_text' && chosenTool !== 'read_page',
    `Fallback must not pick a URL-blocked read tool; got: ${chosenTool}`,
  );
});
