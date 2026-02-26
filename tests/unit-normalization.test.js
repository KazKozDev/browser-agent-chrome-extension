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
  agent.metrics = {
    normalization: { total: 0, changed: 0 },
  };
  agent._deriveCurrentSearchNeedle = () => 'fallback query';
  return agent;
}

test('normalization keeps unicode letters and digits', () => {
  const agent = makeAgent();
  const input = '  こんにちは 世界 ١٢٣ Hello  ';
  const out = agent._sanitizeFindTextQuery(input, {
    allowFallbackWhenEmpty: true,
    source: 'test.unicode',
  });
  assert.equal(out, 'こんにちは 世界 ١٢٣ Hello');
});

test('non-empty query is not replaced by fallback value', () => {
  const agent = makeAgent();
  const input = 'how to spell the word hedgehog on gramota.ru';
  const out = agent._sanitizeFindTextQuery(input, {
    allowFallbackWhenEmpty: true,
    source: 'test.non_empty',
  });
  assert.equal(out, input);
});

test('empty query may use fallback and control chars are removed', () => {
  const agent = makeAgent();
  const mixed = '\u0000abc\u200B\t';
  const normalized = agent._sanitizeFindTextQuery(mixed, {
    allowFallbackWhenEmpty: true,
    source: 'test.mixed',
  });
  assert.equal(normalized, 'abc');

  const empty = agent._sanitizeFindTextQuery('  ', {
    allowFallbackWhenEmpty: true,
    source: 'test.empty',
  });
  assert.equal(empty, 'fallback query');
});

test('normalization metrics are tracked', () => {
  const agent = makeAgent();
  agent._normalizeToolArgs('find_text', { query: ' raw ' });
  assert.equal(agent.metrics.normalization.total, 1);
  assert.equal(agent.metrics.normalization.changed, 1);
});

test('restore_snapshot args normalization applies defaults', () => {
  const agent = makeAgent();
  const out = agent._normalizeToolArgs('restore_snapshot', {
    snapshotId: ' snap_1 ',
    index: '2',
    restoreCookies: 'false',
  });
  assert.equal(out.snapshotId, 'snap_1');
  assert.equal(out.index, 2);
  assert.equal(out.restoreUrl, true);
  assert.equal(out.restoreCookies, false);
  assert.equal(out.restoreScroll, true);
});
