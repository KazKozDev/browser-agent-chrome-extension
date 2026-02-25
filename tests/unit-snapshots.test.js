import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';

function makeChrome(initialUrl = 'https://example.com/account') {
  const state = {
    currentUrl: initialUrl,
    cookiesByUrl: new Map(),
    queuedCookieReads: [],
    setCookieCalls: [],
    removeCookieCalls: [],
    viewportSetCalls: [],
    monitorCalls: 0,
    clearFindCalls: 0,
  };

  const chromeMock = {
    storage: {
      local: {
        get: async () => ({ diagnosticTelemetry: [] }),
        set: async () => {},
      },
    },
    tabs: {
      get: async () => ({ id: 1, url: state.currentUrl, title: 'Example' }),
      update: async (_tabId, updateInfo = {}) => {
        if (typeof updateInfo.url === 'string') {
          state.currentUrl = updateInfo.url;
        }
        return { id: 1, url: state.currentUrl };
      },
      sendMessage: async (_tabId, message = {}) => {
        const action = String(message.action || '');
        if (action === 'getViewportState') {
          return {
            success: true,
            url: state.currentUrl,
            frame: 'top',
            scroll: { x: 10, y: 220 },
            viewport: { w: 1280, h: 720 },
          };
        }
        if (action === 'setViewportState') {
          state.viewportSetCalls.push({
            x: Number(message?.payload?.x) || 0,
            y: Number(message?.payload?.y) || 0,
          });
          return { success: true, scroll: { x: message?.payload?.x || 0, y: message?.payload?.y || 0 } };
        }
        if (action === 'startMonitoring') {
          state.monitorCalls += 1;
          return { success: true };
        }
        if (action === 'clearFindText') {
          state.clearFindCalls += 1;
          return { success: true };
        }
        return { success: true };
      },
      onUpdated: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    cookies: {
      getAll: async ({ url }) => {
        if (state.queuedCookieReads.length > 0) {
          return state.queuedCookieReads.shift();
        }
        return state.cookiesByUrl.get(String(url || '')) || [];
      },
      set: async (details = {}) => {
        state.setCookieCalls.push(details);
        return details;
      },
      remove: async (details = {}) => {
        state.removeCookieCalls.push(details);
        return details;
      },
    },
  };

  return { chromeMock, state };
}

function makeAgent(chromeMock) {
  global.chrome = chromeMock;
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent.metrics = {
    llmCalls: 0,
    toolCalls: 0,
    errors: 0,
    duplicateToolCalls: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    normalization: { total: 0, changed: 0 },
    invalidActions: { total: 0, repeated: 0 },
    completion: { doneAttempts: 0, rejectedNoSubstance: 0 },
    stepLimit: { reached: false, failed: 0 },
  };
  agent._waitForNavigation = async () => {};
  return agent;
}

test('capture snapshot stores url viewport and cookies', async () => {
  const { chromeMock, state } = makeChrome();
  state.cookiesByUrl.set('https://example.com/account', [
    {
      name: 'session',
      value: 'token-a',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      storeId: '0',
    },
  ]);
  const agent = makeAgent(chromeMock);

  const capture = await agent._captureStateSnapshot('confirmed_click', 'click', { confirm: true }, 7);
  assert.equal(capture.success, true);
  assert.ok(capture.snapshotId);
  assert.equal(agent._stateSnapshots.length, 1);
  assert.equal(agent._stateSnapshots[0].tabUrl, 'https://example.com/account');
  assert.equal(agent._stateSnapshots[0].cookieCount, 1);
  assert.equal(agent._stateSnapshots[0].viewport?.scroll?.y, 220);
});

test('restore snapshot rolls back url cookies and scroll', async () => {
  const { chromeMock, state } = makeChrome('https://example.com/account');
  state.cookiesByUrl.set('https://example.com/account', [
    {
      name: 'session',
      value: 'token-a',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      storeId: '0',
    },
  ]);
  const agent = makeAgent(chromeMock);

  const capture = await agent._captureStateSnapshot('type_submit_enter', 'type', { enter: true }, 8);
  assert.equal(capture.success, true);

  state.currentUrl = 'https://example.com/profile';
  state.queuedCookieReads.push([
    {
      name: 'session',
      value: 'token-b',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      storeId: '0',
    },
    {
      name: 'stale',
      value: '1',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'lax',
      storeId: '0',
    },
  ]);

  const restored = await agent._restoreStateSnapshot({ index: 0 });
  assert.equal(restored.success, true);
  assert.equal(restored.restored.url, true);
  assert.equal(state.currentUrl, 'https://example.com/account');
  assert.equal(restored.restored.scroll, true);
  assert.ok(restored.restored.cookies.restored >= 1);
  assert.ok(restored.restored.cookies.removed >= 1);
  assert.ok(state.setCookieCalls.length >= 1);
  assert.ok(state.removeCookieCalls.length >= 1);
  assert.ok(state.viewportSetCalls.length >= 1);
});

test('checkpoint state includes serialized snapshots', async () => {
  const { chromeMock, state } = makeChrome();
  state.cookiesByUrl.set('https://example.com/account', []);
  const agent = makeAgent(chromeMock);

  await agent._captureStateSnapshot('press_enter', 'press_key', { key: 'Enter' }, 2);
  const checkpoint = agent.getCheckpointState();

  assert.ok(Array.isArray(checkpoint.stateSnapshots));
  assert.equal(checkpoint.stateSnapshots.length, 1);
  assert.ok(String(checkpoint.stateSnapshots[0].id || '').startsWith('snap_'));
});
