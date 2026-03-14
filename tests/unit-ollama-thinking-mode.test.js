import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../src/providers/ollama.js';

test('OllamaProvider uses empty apiKey by default', () => {
  const provider = new OllamaProvider();
  assert.equal(provider.apiKey, '');
});

test('OllamaProvider ignores stale apiKey from config', () => {
  const provider = new OllamaProvider({ apiKey: 'stale-token' });
  assert.equal(provider.apiKey, '');
});

test('OllamaProvider normalizes localhost baseUrl to /v1', () => {
  const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
  assert.equal(provider.baseUrl, 'http://localhost:11434/v1');
});

test('OllamaProvider disables thinking mode for qwen models', async () => {
  const provider = new OllamaProvider({ model: 'qwen3-vl:8b' });
  let capturedBody = null;

  provider._request = async (_endpoint, body) => {
    capturedBody = body;
    return {
      choices: [{ message: { content: 'ok' } }],
      usage: {},
    };
  };

  await provider.chat([{ role: 'user', content: 'test' }]);

  assert.ok(capturedBody);
  assert.equal(capturedBody.think, false);
  assert.equal(capturedBody.options?.thinking, false);
});

test('OllamaProvider does not force thinking flags for non-qwen models', async () => {
  const provider = new OllamaProvider({ model: 'llava:7b' });
  let capturedBody = null;

  provider._request = async (_endpoint, body) => {
    capturedBody = body;
    return {
      choices: [{ message: { content: 'ok' } }],
      usage: {},
    };
  };

  await provider.chat([{ role: 'user', content: 'test' }]);

  assert.ok(capturedBody);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedBody, 'think'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedBody.options || {}, 'thinking'), false);
});

test('OllamaProvider returns actionable hint on 403', async () => {
  const provider = new OllamaProvider({ model: 'qwen3-vl:8b' });
  provider._request = async () => {
    const err = new Error('forbidden');
    err.status = 403;
    throw err;
  };

  await assert.rejects(
    () => provider.chat([{ role: 'user', content: 'test' }]),
    /Base URL is "http:\/\/localhost:11434\/v1"/i,
  );
});
