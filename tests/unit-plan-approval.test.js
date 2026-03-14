import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent/agent.js';

global.chrome = global.chrome || {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
    },
  },
};

test('plan approval uses manual intervention pipeline and persists pending state', async () => {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent._goal = 'find the cheapest headphones on amazon';

  const interventions = [];
  const statuses = [];
  agent.onIntervention = (details) => interventions.push(details);
  agent.onStatus = (status) => statuses.push(status);

  const wait = agent._pauseForPlanApproval('1. Open Amazon\n2. Sort by price\n3. Extract cheapest item');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(agent.status, 'paused_waiting_user');
  assert.equal(interventions.length, 1);
  assert.equal(interventions[0].type, 'planApproval');
  assert.match(interventions[0].plan, /^1\./);

  const checkpoint = agent.getCheckpointState();
  assert.equal(checkpoint.activePauseKind, 'plan_approval');
  assert.equal(checkpoint.pendingIntervention?.type, 'planApproval');
  assert.match(String(checkpoint.pendingPlanText || ''), /^1\./);

  agent.approvePlan();
  const approved = await wait;

  assert.equal(approved, true);
  assert.match(agent._approvedPlanText, /^1\./);
  assert.ok(statuses.includes('paused_waiting_user'));
  assert.ok(statuses.includes('running'));
});

test('recovered pending plan approval can be restored from checkpoint state', () => {
  const agent = new Agent({ config: {}, currentProvider: null }, 1);
  agent._goal = 'extract prices';
  agent._pendingPlanText = '1. Open pricing page\n2. Extract values';
  agent._approvedPlanText = '';
  agent._activePauseKind = 'plan_approval';
  agent._pendingIntervention = {
    type: 'planApproval',
    kind: 'plan_approval',
    goal: 'extract prices',
    plan: agent._pendingPlanText,
    message: 'Review plan',
  };
  agent.status = 'paused_waiting_user';

  const checkpoint = agent.getCheckpointState();
  assert.equal(checkpoint.pendingIntervention?.type, 'planApproval');
  assert.equal(checkpoint.pendingPlanText, '1. Open pricing page\n2. Extract values');
  assert.equal(checkpoint.activePauseKind, 'plan_approval');
});
