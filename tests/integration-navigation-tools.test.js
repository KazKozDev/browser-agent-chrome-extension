import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';
import { TOOLS } from '../src/tools/tools.js';

function makeChromeMock() {
  const calls = {
    goForward: [],
    reload: [],
    remove: [],
    query: [],
    sendMessage: [],
  };

  const state = {
    queryResult: [{ id: 2, active: true, url: 'https://example.com/next', title: 'Next' }],
  };

  const chromeMock = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    tabs: {
      goForward: async (tabId) => {
        calls.goForward.push(tabId);
      },
      reload: async (tabId, opts = {}) => {
        calls.reload.push({ tabId, opts });
      },
      remove: async (tabId) => {
        calls.remove.push(tabId);
      },
      query: async (queryInfo = {}) => {
        calls.query.push(queryInfo);
        return state.queryResult.slice();
      },
      get: async (tabId) => ({
        id: Number(tabId) || 1,
        windowId: 1,
        url: 'https://example.com',
        title: 'Example',
      }),
      update: async (tabId, updateInfo = {}) => ({
        id: Number(tabId) || 1,
        active: !!updateInfo.active,
      }),
      sendMessage: async (_tabId, message = {}) => {
        calls.sendMessage.push(message);
        if (message.action === 'switchFrame') {
          return {
            success: true,
            frame: 'main>iframe[42]',
            frameId: 42,
            availableFrames: [],
          };
        }
        return { success: true };
      },
      onUpdated: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    scripting: {
      executeScript: async () => [],
    },
    cookies: {
      getAll: async () => [],
      set: async () => ({}),
      remove: async () => ({}),
    },
    tabGroups: {
      query: async () => [],
      update: async () => ({}),
    },
  };

  return { chromeMock, calls, state };
}

function makeAgent(chromeMock) {
  global.chrome = chromeMock;
  return new Agent({ config: {}, currentProvider: null }, 1);
}

test('tools schema exposes forward/reload/close_tab/switch_frame', () => {
  const names = new Set(TOOLS.map((tool) => tool?.name).filter(Boolean));
  assert.equal(names.has('forward'), true);
  assert.equal(names.has('reload'), true);
  assert.equal(names.has('close_tab'), true);
  assert.equal(names.has('switch_frame'), true);
});

test('forward tool uses tab history forward path', async () => {
  const { chromeMock, calls } = makeChromeMock();
  const agent = makeAgent(chromeMock);
  let waited = 0;
  agent._waitForNavigation = async () => {
    waited += 1;
  };

  const out = await agent._executeTool('forward', {});
  assert.equal(out.success, true);
  assert.equal(out.direction, 'forward');
  assert.deepEqual(calls.goForward, [1]);
  assert.equal(waited, 1);
  assert.equal(calls.sendMessage.some((msg) => msg.action === 'startMonitoring'), true);
});

test('reload tool reloads current tab and forwards bypassCache', async () => {
  const { chromeMock, calls } = makeChromeMock();
  const agent = makeAgent(chromeMock);
  let waited = 0;
  agent._waitForNavigation = async () => {
    waited += 1;
  };

  const out = await agent._executeTool('reload', { bypassCache: true });
  assert.equal(out.success, true);
  assert.equal(out.tabId, 1);
  assert.equal(out.bypassCache, true);
  assert.equal(waited, 1);
  assert.equal(calls.reload.length, 1);
  assert.deepEqual(calls.reload[0], { tabId: 1, opts: { bypassCache: true } });
});

test('close_tab closes current tab and switches to newly active tab', async () => {
  const { chromeMock, calls, state } = makeChromeMock();
  const agent = makeAgent(chromeMock);
  state.queryResult = [{ id: 7, active: true, url: 'https://example.com/after-close', title: 'After' }];

  const out = await agent._executeTool('close_tab', {});
  assert.equal(out.success, true);
  assert.equal(out.closedTabId, 1);
  assert.equal(out.currentTabId, 7);
  assert.equal(agent.tabId, 7);
  assert.deepEqual(calls.remove, [1]);
  assert.equal(calls.sendMessage.some((msg) => msg.action === 'startMonitoring'), true);
});

test('switch_frame sends switchFrame action to content script', async () => {
  const { chromeMock, calls } = makeChromeMock();
  const agent = makeAgent(chromeMock);

  const out = await agent._executeTool('switch_frame', { target: 42 });
  assert.equal(out.success, true);
  assert.equal(out.frameId, 42);
  const frameMsg = calls.sendMessage.find((msg) => msg.action === 'switchFrame');
  assert.ok(frameMsg);
  assert.deepEqual(frameMsg.payload, { main: false, target: 42 });
});

test('switch_frame rejects empty selector payload', async () => {
  const { chromeMock, calls } = makeChromeMock();
  const agent = makeAgent(chromeMock);

  const out = await agent._executeTool('switch_frame', {});
  assert.equal(out.success, false);
  assert.equal(out.code, 'INVALID_FRAME_TARGET');
  assert.equal(calls.sendMessage.some((msg) => msg.action === 'switchFrame'), false);
});
