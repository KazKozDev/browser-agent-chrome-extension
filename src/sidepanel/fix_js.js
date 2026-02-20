const fs = require('fs');

let js = fs.readFileSync('sidepanel.js', 'utf8');

// The new HTML puts inputArea outside of chatView, so it's always visible.
// We should hide the input area if we aren't in chatView, OR we leave it visible everywhere,
// but the design spec shows it under chatView usually. Let's make it visible only in chatView by toggling it in switchTab.

const fixSwitchTab = `function switchTab(viewId, btnId) {
  // Hide all views
  ['chatView', 'settingsView', 'scheduleView', 'historyView'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  // Deactivate all tabs
  ['btnHelp', 'btnSettings', 'btnSchedule', 'btnHistory'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });

  // Activate selected
  const targetView = document.getElementById(viewId);
  if (targetView) targetView.classList.add('active');
  
  const targetBtn = document.getElementById(btnId);
  if (targetBtn) targetBtn.classList.add('active');

  // Toggle Input Area
  const inputArea = document.getElementById('mainInputArea');
  if (inputArea) {
    inputArea.style.display = (viewId === 'chatView') ? 'block' : 'none';
  }

  // Load data for specific tabs if needed
  if (viewId === 'settingsView') {
    sendMsg({ type: 'getConfig' });
    sendMsg({ type: 'getBlocklist' });
  } else if (viewId === 'scheduleView') {
    sendMsg({ type: 'getScheduledTasks' });
  } else if (viewId === 'historyView') {
    renderHistory();
  }
}`;

js = js.replace(/function switchTab\(viewId, btnId\) \{[\s\S]*?\}\n\}/, fixSwitchTab);

// Additionally, when sending a message we must show the steps container and hide the capabilities
const sendBtnEventStart = `sendBtn.addEventListener('click', () => {`;
const newSendEventStart = `sendBtn.addEventListener('click', () => {
  if (isPaused) {
    sendMsg({ type: 'resumeTask' });
    return;
  }

  if (isRunning) {
    sendMsg({ type: 'stopTask' });
    return;
  }

  const goal = goalInput.value.trim();
  if (!goal) return;

  currentGoal = goal;

  // Clear previous steps and hide capabilities
  stepsContainer.innerHTML = '';
  stepsContainer.classList.remove('finished');
  stepsContainer.style.display = 'flex'; // show steps
  
  const emptyStateEl = document.getElementById('emptyState');
  if (emptyStateEl) emptyStateEl.style.display = 'none'; // hide accordions
  const capabilitiesHeader = document.getElementById('capabilitiesHeader');
  if (capabilitiesHeader) capabilitiesHeader.style.display = 'none'; // hide header
  const suggestionsContainer = document.getElementById('suggestionsContainer');
  if (suggestionsContainer) suggestionsContainer.style.display = 'none';

  resultBanner.style.display = 'none';
  resultBanner.className = 'result-banner';
  resultBanner.textContent = '';

  // Add user goal
  const goalEl = document.createElement('div');
  goalEl.className = 'step thought';
  const goalHeader = document.createElement('div');
  goalHeader.className = 'step-header';
  goalHeader.innerHTML = \`<span class="i i-target"></span> Goal\`;
  goalEl.appendChild(goalHeader);
  goalEl.appendChild(document.createTextNode(goal));
  stepsContainer.appendChild(goalEl);

  sendMsg({ type: 'startTask', goal, planMode });
  goalInput.value = '';
  adjustGoalInputHeight();
});`;

js = js.replace(/sendBtn\.addEventListener\('click', \(\) => \{[\s\S]*?adjustGoalInputHeight\(\);\n\}\);/, newSendEventStart);

fs.writeFileSync('sidepanel.js', js);
console.log('JS fixed');
