const fs = require('fs');
let js = fs.readFileSync('sidepanel.js', 'utf8');

// The new HTML has:
// chatView = Capabilities (default)
// settingsView = Settings
// scheduleView = Scheduled Tasks
// historyView = Task History
// Note: helpView is deleted.
// We must update the view switching logic.

const newSwitchLogic = `
function switchTab(viewId, btnId) {
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

  // Load data for specific tabs if needed
  if (viewId === 'settingsView') {
    sendMsg({ type: 'getConfig' });
    sendMsg({ type: 'getBlocklist' });
  } else if (viewId === 'scheduleView') {
    sendMsg({ type: 'getScheduledTasks' });
  }
}

btnHelp.addEventListener('click', () => switchTab('chatView', 'btnHelp'));
btnSettings.addEventListener('click', () => switchTab('settingsView', 'btnSettings'));
btnSchedule.addEventListener('click', () => switchTab('scheduleView', 'btnSchedule'));
btnHistory.addEventListener('click', () => switchTab('historyView', 'btnHistory'));
`;

// Replace the old event listeners block
// Find where btnSettings.addEventListener is, until the end of btnScheduleBack
js = js.replace(/btnSettings\.addEventListener[\s\S]*?btnScheduleBack\.addEventListener\('click', \(\) => {[\s\S]*?}\);/g, newSwitchLogic);

// Also remove `const helpView = document.getElementById('helpView');`
// And remove btnBacks since we have tabs now
js = js.replace(/const helpView = .*;\n/g, '');
js = js.replace(/const btnBack = .*;\n/g, '');
js = js.replace(/const btnHistoryBack = .*;\n/g, '');
js = js.replace(/const btnHelpBack = .*;\n/g, '');
js = js.replace(/const btnScheduleBack = .*;\n/g, '');

// Since "Capabilities" is now the default state of the Chat View,
// When the user starts a task, we should hide the Capabilities Accordions (#emptyState).
// We'll update the renderStep logic to hide emptyState (which it already does!).
// Let's ensure emptyState is displayed when task is stopped/cleared if it's empty.

fs.writeFileSync('sidepanel.js', js);
console.log('JS updated successfully.');
