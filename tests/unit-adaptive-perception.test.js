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

test('sparse accessibility tree triggers vision fallback for interaction-oriented next step', () => {
  const agent = new Agent({ config: {}, currentProvider: { supportsVision: true } }, 1);
  agent.history = [
    {
      step: 1,
      type: 'action',
      tool: 'read_page',
      result: {
        success: true,
        interactiveCount: 1,
        nodeCount: 6,
        tree: { role: 'main', children: [{ role: 'generic', children: [] }] },
      },
    },
  ];

  assert.equal(agent._shouldForceVisionProbe('click'), true);
  assert.equal(agent._shouldForceVisionProbe('get_page_text'), false);
});

test('waitForNavigation runs dom-settle probe after load complete', async () => {
  const agent = new Agent({ config: {}, currentProvider: { supportsVision: false } }, 1);

  const originalOnUpdated = global.chrome.tabs.onUpdated;
  const listeners = new Set();
  global.chrome.tabs.onUpdated = {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
  };

  let domSettleCalls = 0;
  agent._sendToContent = async (action) => {
    if (action === 'waitForDomSettle') {
      domSettleCalls += 1;
      return { success: true, settled: true };
    }
    return { success: true };
  };

  try {
    const wait = agent._waitForNavigation(250);
    setTimeout(() => {
      for (const fn of listeners) fn(1, { status: 'complete' });
    }, 20);
    await wait;
  } finally {
    global.chrome.tabs.onUpdated = originalOnUpdated;
  }

  assert.equal(domSettleCalls, 1);
});

test('screenshot tool forwards SoM arguments to _takeScreenshot', async () => {
  const agent = new Agent({ config: {}, currentProvider: { supportsVision: true } }, 1);
  let capturedArgs = null;
  agent._takeScreenshot = async (args) => {
    capturedArgs = args;
    return { success: true, imageBase64: 'abc', format: 'jpeg' };
  };

  await agent._executeTool('screenshot', { som: false, maxMarks: 7 });
  assert.deepEqual(capturedArgs, { som: false, maxMarks: 7 });
});

test('summarizeSomForPrompt formats compact legend', () => {
  const agent = new Agent({ config: {}, currentProvider: { supportsVision: true } }, 1);
  const summary = agent._summarizeSomForPrompt({
    markCount: 12,
    marks: [
      { id: 3, label: 'button: Search', x: 24, y: 44, w: 90, h: 26 },
      { id: 9, label: 'textbox: Query input', x: 120, y: 56, w: 220, h: 34 },
    ],
  });

  assert.equal(summary.markCount, 12);
  assert.match(summary.legend, /\[3\]/);
  assert.match(summary.legend, /\[9\]/);
  assert.ok(Array.isArray(summary.structuredMarks));
  assert.equal(summary.structuredMarks.length, 2);
  assert.match(summary.structuredJson, /"id":3/);
  assert.match(summary.structuredJson, /"x":24/);
});

test('resolveScreenshotCropRect derives focused crop from SoM marks', () => {
  const agent = new Agent({ config: {}, currentProvider: { supportsVision: true } }, 1);
  const rect = agent._resolveScreenshotCropRect(
    1920,
    1080,
    [
      { id: 1, x: 730, y: 280, w: 420, h: 42, label: 'email input' },
      { id: 2, x: 730, y: 334, w: 420, h: 42, label: 'password input' },
      { id: 3, x: 730, y: 394, w: 180, h: 40, label: 'login button' },
    ],
    {},
    true,
  );

  assert.ok(rect);
  assert.ok(rect.w < 1920);
  assert.ok(rect.h < 1080);
  assert.equal(rect.reason, 'som_bounds');
});

test('fitScreenshotDimensions respects max side and pixel budget', () => {
  const agent = new Agent({ config: {}, currentProvider: { supportsVision: true } }, 1);
  const fitted = agent._fitScreenshotDimensions(2560, 1600, {
    maxWidth: 1280,
    maxHeight: 1280,
    maxPixels: 900000,
  });

  assert.ok(fitted.width <= 1280);
  assert.ok(fitted.height <= 1280);
  assert.ok((fitted.width * fitted.height) <= 900000);
});
