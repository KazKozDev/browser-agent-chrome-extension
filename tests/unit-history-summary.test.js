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
  agent._goal = 'collect latest browser updates';
  agent.metrics = {
    llmCalls: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    normalization: { total: 0, changed: 0 },
    invalidActions: { total: 0, repeated: 0 },
    completion: { doneAttempts: 0, rejectedNoSubstance: 0 },
    stepLimit: { reached: false, failed: 0 },
    toolCalls: 0,
  };
  return agent;
}

test('trimMessages captures evicted content for summary queue', () => {
  const agent = makeAgent();
  agent.maxConversationMessages = 4;

  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: '{"success":true,"title":"Page A"}' },
    { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'get_page_text', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '2', content: '{"success":true,"text":"Some long extracted text"}' },
    { role: 'assistant', content: 'next step' },
    { role: 'user', content: 'continue' },
  ];

  agent._trimMessages(messages);
  const summaryState = agent._ensureHistorySummaryState();
  assert.ok(messages.length <= 4);
  assert.ok(Array.isArray(summaryState.pending));
  assert.ok(summaryState.pending.length >= 1);
  assert.ok(Array.isArray(summaryState.ragEntries));
  assert.ok(summaryState.ragEntries.length >= 1);
  assert.ok(summaryState.evictedMessages >= 1);
});

test('appendMessage keeps raw tool payload for Tier 2 summary before eviction', () => {
  const agent = makeAgent();
  agent.maxConversationMessages = 4;
  const longPayload = 'X'.repeat(1400);

  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'get_page_text', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: JSON.stringify({ success: true, text: longPayload }) },
    { role: 'assistant', content: 'analysis step' },
    { role: 'user', content: 'continue' },
  ];

  agent._appendMessage(messages, { role: 'assistant', content: 'new step' });
  const state = agent._ensureHistorySummaryState();
  const pendingText = String((state.pending || []).join('\n'));
  assert.match(pendingText, /X{40,}/);
  assert.doesNotMatch(pendingText, /Page state omitted/i);
});

test('compressHistory keeps only two latest vision messages and summarizes older screenshots', () => {
  const agent = makeAgent();
  const mkVision = (label) => ([
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${label}` } },
    { type: 'text', text: `Here is the screenshot of the current page. ${label}. Describe what you see and decide the next action.` },
  ]);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'step 1' },
    { role: 'user', content: mkVision('vision one') },
    { role: 'assistant', content: 'step 2' },
    { role: 'user', content: mkVision('vision two') },
    { role: 'assistant', content: 'step 3' },
    { role: 'user', content: mkVision('vision three') },
  ];

  agent._compressHistory(messages);

  assert.equal(Array.isArray(messages[7].content), true);
  assert.equal(Array.isArray(messages[5].content), true);
  assert.equal(typeof messages[3].content, 'string');
  assert.match(String(messages[3].content || ''), /Snapshot summary:/i);

  const state = agent._ensureHistorySummaryState();
  assert.ok(Array.isArray(state.ragEntries));
  assert.ok(state.ragEntries.some((entry) => /Snapshot summary:/i.test(String(entry?.text || ''))));
});

test('maybeSummarizeHistory merges pending chunks using provider', async () => {
  const agent = makeAgent();
  agent.provider = {
    chat: async () => ({
      text: '{"summary":"Merged: key facts preserved, unresolved blocker: captcha on target page."}',
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }),
  };
  agent._historySummary = {
    running: 'Old summary.',
    pending: ['assistant: looked up release page\ntool: {"success":true}'],
    evictedMessages: 2,
    evictedChars: 120,
    summarizedChunks: 0,
    summarizedMessages: 0,
    updatedAt: 0,
  };

  const res = await agent._maybeSummarizeHistory([], 5, true);
  assert.equal(res.summarized, true);

  const state = agent._ensureHistorySummaryState();
  assert.equal(state.pending.length, 0);
  assert.match(state.running, /Merged: key facts preserved/i);
  assert.ok(state.summarizedChunks >= 1);

  const taskState = agent._buildTaskStateSystemMessage();
  assert.match(String(taskState?.content || ''), /Compressed history summary:/);
  assert.match(String(taskState?.content || ''), /Merged: key facts preserved/i);

  const checkpoint = agent.getCheckpointState();
  assert.ok(checkpoint.historySummary);
  assert.match(String(checkpoint.historySummary?.running || ''), /Merged: key facts preserved/i);
  assert.ok(Array.isArray(checkpoint.historySummary?.ragEntries));
});

test('semantic retrieval surfaces relevant archived chunks', () => {
  const agent = makeAgent();
  agent._goal = 'find captcha blocker and login verification requirements';
  agent._historySummary = {
    running: 'Old summary',
    pending: [],
    ragEntries: [
      {
        id: 1,
        step: 3,
        source: 'evicted_turn',
        text: 'tool: captcha detected on login form and verification code required',
        createdAt: Date.now() - 1000,
      },
      {
        id: 2,
        step: 2,
        source: 'evicted_turn',
        text: 'tool: extracted product prices and ratings from search results',
        createdAt: Date.now() - 2000,
      },
    ],
    ragNextId: 3,
    evictedMessages: 2,
    evictedChars: 120,
    summarizedChunks: 0,
    summarizedMessages: 0,
    updatedAt: Date.now(),
  };

  const retrieved = agent._getRetrievedHistoryForState(1000, 1);
  assert.match(retrieved, /captcha detected on login form/i);
  assert.doesNotMatch(retrieved, /product prices and ratings/i);
});

test('maybeSummarizeHistory skips LLM call when token precheck predicts overflow', async () => {
  const agent = makeAgent();
  agent._resourceBudgets = {
    maxWallClockMs: 60000,
    maxTotalTokens: 100,
    maxEstimatedCostUsd: 10,
  };
  agent.metrics.tokens.total = 90;
  let chatCalls = 0;
  agent.provider = {
    chat: async () => {
      chatCalls += 1;
      return {
        text: '{"summary":"should not be called"}',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  agent._historySummary = {
    running: 'Old summary',
    pending: ['assistant: ' + 'x'.repeat(800)],
    ragEntries: [],
    ragNextId: 1,
    evictedMessages: 1,
    evictedChars: 800,
    summarizedChunks: 0,
    summarizedMessages: 0,
    updatedAt: 0,
  };

  const out = await agent._maybeSummarizeHistory([], 7, true);
  assert.equal(out.summarized, false);
  assert.equal(out.reason, 'budget_predicted_exceed');
  assert.equal(chatCalls, 0);
  const state = agent._ensureHistorySummaryState();
  assert.equal(Array.isArray(state.pending), true);
  assert.ok(state.pending.length >= 1);
});
