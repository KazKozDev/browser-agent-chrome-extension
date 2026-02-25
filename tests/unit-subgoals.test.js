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
    toolCalls: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    normalization: { total: 0, changed: 0 },
    invalidActions: { total: 0, repeated: 0 },
    completion: { doneAttempts: 0, rejectedNoSubstance: 0 },
    stepLimit: { reached: false, failed: 0 },
  };
  agent._goal = 'find apple info, then check samsung info';
  return agent;
}

test('initialize sub-goals and render tracker text', () => {
  const agent = makeAgent();
  const items = agent._initializeSubGoals(agent._goal);
  assert.ok(Array.isArray(items));
  assert.ok(items.length >= 2);

  const tracker = agent._buildSubGoalTrackerText(6);
  assert.match(tracker, /Progress:/i);
  assert.match(tracker, /\[pending\]/i);
});

test('update sub-goals from high-signal action', () => {
  const agent = makeAgent();
  agent._initializeSubGoals(agent._goal);

  agent._updateSubGoalsAfterAction(
    1,
    'find_text',
    { query: 'apple info' },
    { success: true, found: true, count: 2, query: 'apple info' },
  );

  const snapshot = agent._getSubGoalSnapshot(2);
  const touched = snapshot.find((sg) => Number(sg.attempts || 0) > 0);
  assert.ok(touched);
  assert.ok(['in_progress', 'completed'].includes(touched.status));
  assert.ok(Number(touched.confidence || 0) >= 0.2);
});

test('apply coverage marks missing sub-goal as not completed', () => {
  const agent = makeAgent();
  const initialized = agent._initializeSubGoals(agent._goal);
  assert.ok(initialized.length >= 2);

  const missingText = initialized[0].text;
  agent._applyCoverageToSubGoals([missingText]);
  const snapshot = agent._getSubGoalSnapshot(2);
  const missing = snapshot.find((sg) => sg.text === missingText);
  const completed = snapshot.find((sg) => sg.text !== missingText);
  assert.ok(missing);
  assert.notEqual(missing.status, 'completed');
  if (completed) assert.equal(completed.status, 'completed');
});

test('checkpoint state includes structured sub-goals and task-state message', () => {
  const agent = makeAgent();
  agent._initializeSubGoals(agent._goal);
  const checkpoint = agent.getCheckpointState();
  assert.ok(Array.isArray(checkpoint.subGoals));
  assert.ok(checkpoint.subGoals.length >= 1);

  const stateMsg = agent._buildTaskStateSystemMessage();
  assert.match(String(stateMsg?.content || ''), /Sub-goals:/);
  assert.match(String(stateMsg?.content || ''), /Progress:/);
});
