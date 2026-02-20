const fs = require('fs');

// 1. Update sidepanel.html
let html = fs.readFileSync('sidepanel.html', 'utf8');
html = html.replace('<div style="flex:1;"></div>', '<div id="suggestionsContainer" style="flex:1; display:flex; flex-direction:column; justify-content:flex-end; padding-bottom:12px;"></div>');
fs.writeFileSync('sidepanel.html', html);

// 2. Update sidepanel.js
let js = fs.readFileSync('sidepanel.js', 'utf8');
// Fix renderSuggestions to use suggestionsContainer
const oldRender = `function renderSuggestions(suggestions, tabTitle) {
  const el = document.getElementById('emptyState');
  if (!el) return;
  const chipsHtml = suggestions.map(s =>
    \`<button class="suggestion-chip" data-text="\${escapeAttr(s)}">\${escapeHtml(s)}</button>\`
  ).join('');
  el.innerHTML = \`
    <img src="../../icons/icon48.png" alt="Browser Agent" width="40" height="40" style="opacity:0.85">
    <p>I'll click, type and navigate for you.</p>
    <div class="suggestion-chips">\${chipsHtml}</div>
  \`;`;

const newRender = `function renderSuggestions(suggestions, tabTitle) {
  const el = document.getElementById('suggestionsContainer');
  if (!el) return;
  const chipsHtml = suggestions.map(s =>
    \`<button class="suggestion-chip" data-text="\${escapeAttr(s)}">\${escapeHtml(s)}</button>\`
  ).join('');
  
  // Only show the label if we are showing contextual (i.e. tabTitle is provided and we have fewer than default suggestions)
  const label = tabTitle ? \`<div style="font-size:10px; font-family:var(--font-mono); letter-spacing:1px; text-transform:uppercase; color:var(--text-tertiary); margin-bottom:8px; text-align:center;">Suggestions for this site</div>\` : '';
  
  el.innerHTML = \`
    \${label}
    <div class="suggestion-chips" style="justify-content:center;">\${chipsHtml}</div>
  \`;`;

js = js.replace(oldRender, newRender);

fs.writeFileSync('sidepanel.js', js);
console.log('Suggestions container fixed.');
