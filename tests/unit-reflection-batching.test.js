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
  agent._goal = 'find latest releases';
  return agent;
}

test('normalizeReflectionState supports actions[] and caps batch size', () => {
  const agent = makeAgent();
  const raw = {
    facts: ['partial evidence'],
    unknowns: ['need one more check'],
    sufficiency: false,
    confidence: 0.51,
    search_query: 'release notes',
    summary: '',
    answer: '',
    actions: [
      { tool: 'read_page', args: {} },
      { tool: 'scroll', args: { direction: 'down' } },
      { tool: 'get_page_text', args: { scope: 'viewport' } },
      { tool: 'find_text', args: { query: 'release' } },
      { tool: 'find', args: { query: 'version' } },
    ],
  };
  const allowedTools = [
    { name: 'read_page' },
    { name: 'scroll' },
    { name: 'get_page_text' },
    { name: 'find_text' },
    { name: 'find' },
  ];

  const normalized = agent._normalizeReflectionState(raw, allowedTools, { total: 50, used: 10, remaining: 40 });
  assert.equal(normalized.ok, true);
  assert.ok(Array.isArray(normalized.state.actions));
  assert.equal(normalized.state.actions.length, 4);
  assert.equal(normalized.state.actions[0].tool, 'read_page');
  assert.deepEqual(normalized.state.next_action, normalized.state.actions[0]);
});

test('normalizeReflectionState keeps backward compatibility with next_action', () => {
  const agent = makeAgent();
  const raw = {
    facts: [],
    unknowns: ['need initial observation'],
    sufficiency: false,
    confidence: 0.2,
    search_query: '',
    summary: '',
    answer: '',
    next_action: { tool: 'read_page', args: {} },
  };
  const normalized = agent._normalizeReflectionState(raw, [{ name: 'read_page' }], { total: 50, used: 0, remaining: 50 });
  assert.equal(normalized.ok, true);
  assert.ok(Array.isArray(normalized.state.actions));
  assert.equal(normalized.state.actions.length, 1);
  assert.equal(normalized.state.actions[0].tool, 'read_page');
  assert.equal(normalized.state.next_action.tool, 'read_page');
});
