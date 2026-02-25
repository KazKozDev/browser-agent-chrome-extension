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

function makeAgent() {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent.metrics = {
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    errors: 0,
    duplicateToolCalls: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    cost: { estimatedUsd: 0, provider: 'groq' },
    providerId: 'groq',
    normalization: { total: 0, changed: 0 },
    invalidActions: { total: 0, repeated: 0 },
    completion: { doneAttempts: 0, rejectedNoSubstance: 0 },
    stepLimit: { reached: false, failed: 0 },
    budgets: {
      configured: { wallClockMs: 60000, totalTokens: 100000, estimatedCostUsd: 10 },
      exceeded: null,
    },
  };
  agent._pauseForLimiterOverride = async () => ({ continued: false });
  return agent;
}

test('normalizeReflectionState applies composite confidence penalties', () => {
  const agent = makeAgent();
  agent._goal = 'collect release details';
  agent._noProgressStreak = 6;
  agent._dupCount = 2;
  agent._blockedRepeatCount = 1;
  agent._subGoals = [
    { text: 'collect release details', status: 'completed' },
    { text: 'verify source', status: 'in_progress' },
  ];

  const raw = {
    facts: ['found release item'],
    unknowns: [],
    sufficiency: false,
    confidence: 0.7,
    search_query: 'release notes',
    summary: '',
    answer: '',
    actions: [{ tool: 'read_page', args: {} }],
  };
  const out = agent._normalizeReflectionState(raw, [{ name: 'read_page' }], { total: 50, used: 20, remaining: 30 });

  assert.equal(out.ok, true);
  assert.ok(out.state.confidence < 0.7);
  assert.ok(out.state.confidence_components);
  assert.ok(out.state.confidence_components.stagnation_penalty < 1);
  assert.ok(out.state.confidence_components.loop_penalty < 1);
  assert.ok(out.state.confidence_components.progress_ratio > 0);
});

test('run stops with timeout status when token budget is exceeded', async () => {
  const agent = makeAgent();
  agent.maxSteps = 3;
  agent._goal = 'find exact data and summarize';
  agent._sendToContent = async (action) => {
    if (action === 'readPage') return { url: 'https://example.com', title: 'Example', interactiveCount: 0, nodeCount: 1, tree: {} };
    if (action === 'getPageText') return { url: 'https://example.com', title: 'Example', text: '', charCount: 0 };
    return { success: true };
  };
  agent._pauseIfManualInterventionNeeded = async () => {};
  agent._runReflection = async () => {
    agent.metrics.tokens.total += 500;
    return {
      ok: true,
      state: {
        facts: ['temporary finding'],
        unknowns: ['need final verification'],
        sufficiency: false,
        confidence: 0.4,
        search_query: 'data',
        summary: '',
        answer: '',
        actions: [{ tool: 'read_page', args: {} }],
        next_action: { tool: 'read_page', args: {} },
      },
    };
  };
  agent._handleToolCalls = async () => null;
  agent._startTabWatcher = () => {};
  agent._stopTabWatcher = () => {};

  const result = await agent.run('Find exact data and summarize', {
    budgets: {
      maxWallClockMs: 120000,
      maxTotalTokens: 400,
      maxEstimatedCostUsd: 10,
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'timeout');
  assert.match(String(result.reason || ''), /Token budget exceeded/i);
  assert.equal(result.partial_result?.status, 'partial');
  assert.match(String(result.answer || ''), /Collected findings/i);
  assert.equal(result.metrics?.budgets?.exceeded?.kind, 'tokens');
});

test('token precheck reports skip when projected request exceeds remaining budget', () => {
  const agent = makeAgent();
  agent._resourceBudgets = {
    maxWallClockMs: 60000,
    maxTotalTokens: 1000,
    maxEstimatedCostUsd: 10,
  };
  agent.metrics.tokens.total = 995;
  const out = agent._precheckTokenBudgetForChat(
    [{ role: 'user', content: 'x'.repeat(120) }],
    [],
    {},
    { policy: 'skip', label: 'unit_precheck' },
  );
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.match(String(out.reason || ''), /Token budget pre-check blocked unit_precheck/i);
});

test('runReflection stops before provider.chat when pre-send token estimate exceeds budget', async () => {
  const agent = makeAgent();
  agent._goal = 'collect data';
  agent._resourceBudgets = {
    maxWallClockMs: 60000,
    maxTotalTokens: 50,
    maxEstimatedCostUsd: 10,
  };
  agent.metrics.tokens.total = 45;
  let calls = 0;
  agent.provider = {
    chat: async () => {
      calls += 1;
      return {
        toolCalls: [{
          id: 'reflect_1',
          name: 'submit_reflection',
          arguments: {
            facts: ['x'],
            unknowns: ['y'],
            sufficiency: false,
            confidence: 0.4,
            search_query: 'x',
            summary: '',
            answer: '',
            actions: [{ tool: 'read_page', args: {} }],
            next_action: { tool: 'read_page', args: {} },
          },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      };
    },
  };

  const out = await agent._runReflection(
    1,
    [{ role: 'user', content: 'x'.repeat(500) }],
    [{ name: 'read_page' }],
    { total: 10, used: 1, remaining: 9 },
  );

  assert.equal(calls, 0);
  assert.equal(out.ok, false);
  assert.ok(out.budgetTerminal);
  assert.equal(out.budgetTerminal.status, 'timeout');
  assert.match(String(out.error || ''), /Token budget pre-check blocked reflection/i);
});

test('runReflection falls back when reflection soft-timeout is hit', async () => {
  const agent = makeAgent();
  agent._goal = 'как пишется телеграм на сайте грамота ру';
  agent._reflectionChatSoftTimeoutMs = 1000;
  let calls = 0;
  agent.provider = {
    chat: async () => {
      calls += 1;
      return await new Promise(() => {});
    },
  };

  const startedAt = Date.now();
  const out = await agent._runReflection(
    1,
    [{ role: 'user', content: 'Find spelling on gramota.ru' }],
    [{ name: 'find_text' }, { name: 'get_page_text' }],
    { total: 10, used: 1, remaining: 9 },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(calls, 1);
  assert.equal(out.ok, true);
  assert.equal(out.fallback, true);
  assert.match(String(out.error || ''), /timed out/i);
  assert.equal(out.state?.actions?.[0]?.tool, 'find_text');
  assert.ok(elapsedMs >= 900 && elapsedMs < 5000);
});

test('checkResourceBudgets does not enforce wall-clock when disabled', () => {
  const agent = makeAgent();
  agent._resourceBudgets = {
    maxWallClockMs: 0,
    maxTotalTokens: 100000,
    maxEstimatedCostUsd: 10,
  };
  agent.metrics.startedAt = Date.now() - 60 * 60 * 1000;
  agent.metrics.tokens.total = 100;
  agent.metrics.cost.estimatedUsd = 0.01;

  const out = agent._checkResourceBudgets(3);
  assert.equal(out, null);
});

test('shouldEscalateForHumanGuidance triggers on medium confidence under stagnation pressure', () => {
  const agent = makeAgent();
  agent._noProgressStreak = 6;
  agent._reflectionNoActionStreak = 0;
  agent._humanGuidanceEscalationCount = 0;
  const should = agent._shouldEscalateForHumanGuidance(
    {
      sufficiency: false,
      confidence: 0.62,
      facts: ['found likely answer candidate'],
      unknowns: ['need final confirmation'],
      actions: [{ tool: 'read_page', args: {} }],
    },
    { remaining: 2, total: 10 },
  );
  assert.equal(should, true);
});

test('shouldEscalateForHumanGuidance triggers on near-medium confidence with duplicate-loop signal', () => {
  const agent = makeAgent();
  agent._noProgressStreak = 1;
  agent._dupCount = 1;
  agent._blockedRepeatCount = 0;
  agent._reflectionNoActionStreak = 0;
  agent._humanGuidanceEscalationCount = 0;
  const should = agent._shouldEscalateForHumanGuidance(
    {
      sufficiency: false,
      confidence: 0.46,
      facts: ['dictionary result found', 'support answer found'],
      unknowns: ['final wording'],
      actions: [{ tool: 'find_text', args: { query: 'ютуб' } }],
    },
    { remaining: 44, total: 50 },
  );
  assert.equal(should, true);
});

test('buildHumanGuidanceBlockers explains procedural pause reasons when unknowns are empty', () => {
  const agent = makeAgent();
  agent._noProgressStreak = 6;
  agent._dupCount = 1;
  agent._blockedRepeatCount = 0;
  agent._reflectionNoActionStreak = 0;

  const blockers = agent._buildHumanGuidanceBlockers(
    {
      sufficiency: false,
      confidence: 0.47,
      facts: ['dictionary entry located'],
      unknowns: [],
      actions: [{ tool: 'find_text', args: { query: 'ютуб' } }],
    },
    { remaining: 43, total: 50 },
  );

  assert.ok(Array.isArray(blockers));
  assert.ok(blockers.length > 0);
  assert.ok(blockers.some((item) => /below done threshold/i.test(String(item))));
  assert.ok(blockers.some((item) => /no meaningful progress/i.test(String(item))));
});

test('maybeAutoCompleteFromEvidence returns complete when facts are sufficient under low-signal loop pressure', () => {
  const agent = makeAgent();
  agent._goal = 'как пишется ватсап на грамота ру';
  agent._isNavigateOnly = true;
  agent._checkPrematureDone = () => ({ ok: true });
  agent._validateDoneQuality = () => ({ ok: true });
  agent._validateDoneCoverage = () => ({ ok: true });
  agent._noProgressStreak = 6;
  agent._dupCount = 1;
  const out = agent._maybeAutoCompleteFromEvidence(
    {
      sufficiency: false,
      confidence: 0.48,
      facts: [
        'Словарная статья: ватса́п — существительное, мужской род, 2-е склонение',
        'Рекомендуемое написание: «Ватсап»',
      ],
      unknowns: [],
      summary: 'На Грамоте рекомендуется писать: «Ватсап».',
      answer: 'Словарная фиксация: «ватса́п». Рекомендованное написание в ответах службы: «Ватсап».',
      actions: [{ tool: 'find_text', args: { query: 'ватсап' } }],
    },
    { remaining: 44, total: 50 },
    8,
  );

  assert.ok(out);
  assert.equal(out.success, true);
  assert.equal(out.status, 'complete');
  assert.match(String(out.answer || ''), /Ватсап/i);
});

test('pauseForHumanGuidance pauses and resumes agent loop', async () => {
  const agent = makeAgent();
  agent.status = 'running';
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
  ];
  const pausePromise = agent._pauseForHumanGuidance(
    3,
    messages,
    {
      confidence: 0.58,
      facts: ['candidate answer found'],
      unknowns: ['verify edge case'],
    },
    { remaining: 1, total: 8 },
  );
  setTimeout(() => {
    agent.resume('finish with the collected dictionary facts');
  }, 20);

  const out = await pausePromise;
  assert.equal(out.resumed, true);
  assert.equal(out.aborted, false);
  assert.equal(agent.status, 'running');
  assert.match(String(messages[messages.length - 1]?.content || ''), /resumed with guidance/i);
  assert.match(String(messages[messages.length - 1]?.content || ''), /dictionary facts/i);
  const pauseStep = agent.history.find((item) => item?.type === 'pause' && item?.kind === 'guidance_needed');
  assert.ok(pauseStep);
  assert.ok(Array.isArray(pauseStep.blockers));
  assert.ok(pauseStep.blockers.length > 0);
});

test('requestPartialCompletion exits guidance pause as aborted signal', async () => {
  const agent = makeAgent();
  agent.status = 'running';
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
  ];
  const pausePromise = agent._pauseForHumanGuidance(
    4,
    messages,
    {
      confidence: 0.52,
      facts: ['fact one'],
      unknowns: ['unknown one'],
    },
    { remaining: 4, total: 12 },
  );
  setTimeout(() => {
    agent.requestPartialCompletion();
  }, 20);

  const out = await pausePromise;
  assert.equal(out.aborted, true);
  assert.equal(out.resumed, false);
  assert.equal(agent._manualPartialRequested, true);
});

test('handleToolCalls returns partial when no-progress persists after human-guidance escalation', async () => {
  const agent = makeAgent();
  agent.status = 'running';
  agent._goal = 'найти как пишется камаз на грамота ру';
  agent._humanGuidanceEscalationCount = 1;
  agent._noProgressStreak = 8;
  agent._reflectionState = {
    facts: [
      'Словарь фиксирует написание «КамА́З»',
      'Допустимы варианты «КамА́З» и «КАМА́З» в словарной фиксации',
    ],
    unknowns: [],
    sufficiency: false,
    confidence: 0.46,
    summary: '',
    answer: '',
    actions: [{ tool: 'find_text', args: { query: 'камаз' } }],
    next_action: { tool: 'find_text', args: { query: 'камаз' } },
  };
  agent._executeTool = async () => ({
    success: true,
    url: 'https://gramota.ru/poisk?query=%D0%BA%D0%B0%D0%BC%D0%B0%D0%B7&mode=all',
    title: 'Поиск по Грамоте',
    tree: {},
  });

  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
  ];
  const out = await agent._handleToolCalls(
    12,
    messages,
    { toolCalls: [{ id: 'tc1', name: 'read_page', arguments: {} }] },
    { remaining: 36, total: 50 },
  );

  assert.ok(out);
  assert.equal(out.status, 'partial');
  assert.match(String(out.reason || ''), /after human-guidance escalation/i);
  assert.match(String(out.answer || ''), /Collected findings/i);
});

test('handleToolCalls returns partial when no-progress persists and best-effort facts exist', async () => {
  const agent = makeAgent();
  agent.status = 'running';
  agent._goal = 'найди как пишется ватсап на грамота ру';
  agent._humanGuidanceEscalationCount = 0;
  agent._noProgressStreak = 8;
  agent._reflectionState = {
    facts: [
      'Словарная статья: ватса́п — существительное, мужской род, 2-е склонение',
      'Рекомендуемое нормативное написание — «Ватсап»',
    ],
    unknowns: [],
    sufficiency: false,
    confidence: 0.33,
    summary: '',
    answer: '',
    actions: [{ tool: 'find_text', args: { query: 'ватсап gramota.ru' } }],
    next_action: { tool: 'find_text', args: { query: 'ватсап gramota.ru' } },
  };
  agent._executeTool = async () => ({
    success: true,
    url: 'https://gramota.ru/poisk?query=%D0%B2%D0%B0%D1%82%D1%81%D0%B0%D0%BF&mode=all',
    title: 'Поиск по Грамоте',
    currentIndex: 0,
    matches: [],
  });

  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'task' },
  ];
  const out = await agent._handleToolCalls(
    14,
    messages,
    { toolCalls: [{ id: 'tc2', name: 'find_text', arguments: { query: 'ватсап gramota.ru' } }] },
    { remaining: 36, total: 50 },
  );

  assert.ok(out);
  assert.equal(out.status, 'partial');
  assert.match(String(out.reason || ''), /Returning best-effort result/i);
  assert.match(String(out.answer || ''), /Ватсап/i);
});

test('checkResourceBudgets triggers early timeout on aggressive token burn-rate projection', () => {
  const agent = makeAgent();
  agent.maxSteps = 20;
  agent._resourceBudgets = {
    maxWallClockMs: 120000,
    maxTotalTokens: 10000,
    maxEstimatedCostUsd: 10,
  };
  agent.metrics.tokens.total = 7000;
  const out = agent._checkResourceBudgets(4);

  assert.ok(out);
  assert.equal(out.status, 'timeout');
  assert.match(String(out.reason || ''), /burn-rate projection exceeded budget early/i);
  assert.equal(out.metrics?.budgets?.exceeded?.kind, 'tokens_projection');
});

test('buildSerpLoopGuard blocks repeated read-only parsing on same SERP', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://www.google.com/search?q=browser+agent';
  agent.history = [
    {
      type: 'action',
      tool: 'find_text',
      args: { query: 'browser agent' },
      result: { success: true, found: false, count: 0, url: 'https://www.google.com/search?q=browser+agent' },
    },
    {
      type: 'action',
      tool: 'get_page_text',
      args: { scope: 'full' },
      result: { success: true, charCount: 120, url: 'https://www.google.com/search?q=browser+agent' },
    },
    {
      type: 'action',
      tool: 'read_page',
      args: {},
      result: { success: true, url: 'https://www.google.com/search?q=browser+agent' },
    },
  ];

  const guard = agent._buildSerpLoopGuard('get_page_text');
  assert.equal(guard.blocked, true);
  assert.match(String(guard.reason || ''), /Search-results loop detected/i);
  assert.ok(guard.hint?.nextTool);
});

test('detectSemanticRepeat catches repeated low-signal find_text on same page', () => {
  const agent = makeAgent();
  agent._lastKnownUrl = 'https://example.com/search';
  agent.history = [
    {
      type: 'action',
      tool: 'find_text',
      args: { query: 'exact phrase' },
      result: { success: true, found: false, count: 0, url: 'https://example.com/search' },
    },
    {
      type: 'action',
      tool: 'find_text',
      args: { query: 'exact phrase' },
      result: { success: true, found: false, count: 0, url: 'https://example.com/search' },
    },
  ];

  const out = agent._detectSemanticRepeat('find_text', { query: 'exact phrase' });
  assert.equal(out.repeated, true);
  assert.ok(out.hint?.nextTool);
});

test('detectDeadEndNavigationResult identifies 404-like pages and proposes recovery candidates', () => {
  const agent = makeAgent();
  const dead = agent._detectDeadEndNavigationResult({
    pageTitle: '404 Not Found',
    pageText: 'Sorry, the page you requested was not found.',
    pageUrl: 'https://example.com/posts/old-slug',
  });
  assert.equal(dead.isDeadEnd, true);

  const candidates = agent._buildDeadEndRecoveryCandidates('https://example.com/posts/old-slug');
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.length > 0);
  assert.ok(candidates.some((url) => url === 'https://example.com/posts' || url === 'https://example.com/'));
});

test('resume handles JS domain permission pause by approving current domain', async () => {
  const agent = makeAgent();
  agent.status = 'running';

  const pending = agent._waitForJsDomainApproval('slovari.ru');
  assert.equal(agent.status, 'paused_waiting_user');

  const resumed = agent.resume();
  assert.equal(resumed, true);

  const approved = await pending;
  assert.equal(approved, true);
  assert.equal(agent.status, 'running');
  assert.ok(agent.trustedJsDomains.has('slovari.ru'));
});
