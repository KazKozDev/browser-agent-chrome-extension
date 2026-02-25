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
  return new Agent({ config: {}, currentProvider: null }, 1);
}

test('validateNavigateUrl auto-adds https for bare domains', () => {
  const agent = makeAgent();
  const out = agent._validateNavigateUrl('example.com/path');
  assert.equal(out, 'https://example.com/path');
});

test('validateNavigateUrl rejects embedded credentials', () => {
  const agent = makeAgent();
  assert.throws(
    () => agent._validateNavigateUrl('https://user:pass@example.com/'),
    /embedded credentials/i,
  );
});

test('checkSiteBlocked uses normalized host and blocks deceptive blocklist entries', () => {
  const agent = makeAgent();
  agent.blockedDomains = new Set(['https://www.safe.com@evil.com/path']);
  const blocked = agent._checkSiteBlocked('https://evil.com/dashboard');
  assert.match(String(blocked || ''), /blocked by the site blocklist/i);
});
