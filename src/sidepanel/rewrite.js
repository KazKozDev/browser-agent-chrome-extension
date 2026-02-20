const fs = require('fs');

const css = `
    :root {
      --bg-primary: #1a1714;
      --bg-surface: rgba(196,164,105, 0.05);
      --bg-input: rgba(0,0,0, 0.3);
      --bg-hover: rgba(196,164,105, 0.08);
      --bg-active: rgba(196,164,105, 0.12);

      --border-subtle: rgba(196,164,105, 0.08);
      --border-default: rgba(196,164,105, 0.12);
      --border-emphasis: rgba(196,164,105, 0.2);
      --border-strong: rgba(196,164,105, 0.3);

      --text-primary: #e8dcc8;
      --text-secondary: rgba(196,164,105, 0.45);
      --text-tertiary: rgba(196,164,105, 0.3);
      --text-muted: rgba(196,164,105, 0.2);

      --accent-gold: #c4a469;
      --accent-gold-dim: rgba(196,164,105, 0.5);
      --accent-green: #6b8a5e;
      --accent-green-glow: rgba(107,138,94, 0.4);
      --accent-warning: #c4935a;
      
      --bg: var(--bg-primary);
      --surface: var(--bg-surface);
      --surface2: var(--bg-hover);
      --border: var(--border-default);
      --text: var(--text-primary);
      --text2: var(--text-secondary);
      --accent: var(--accent-gold);
      --accent2: var(--accent-gold-dim);
      --success: var(--accent-green);
      --error: #e17055;
      --warning: var(--accent-warning);

      --font-mono: 'JetBrains Mono', monospace;
      --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font-body);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 13px;
      line-height: 1.5;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Top Bar */
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }
    .top-bar-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-tertiary);
      transition: all 0.3s;
    }
    .status-dot.running {
      background: var(--accent-green);
      box-shadow: 0 0 8px var(--accent-green-glow);
      animation: pulse-green 1.5s infinite;
    }
    .status-dot.error { background: var(--error); }
    .status-dot.paused {
      background: var(--accent-warning);
      animation: pulse-warn 1.5s infinite;
    }
    @keyframes pulse-green {
      0%, 100% { opacity: 1; box-shadow: 0 0 8px var(--accent-green-glow); }
      50% { opacity: 0.5; box-shadow: 0 0 2px var(--accent-green-glow); }
    }
    @keyframes pulse-warn {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .top-bar-title {
      font-size: 14px;
      font-family: var(--font-mono);
      font-weight: 600;
      color: var(--text-primary);
    }
    .top-bar-close {
      background: none;
      border: none;
      color: var(--text-secondary);
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .top-bar-close:hover { color: var(--text-primary); }

    /* Tab Nav */
    .tab-nav {
      display: flex;
      padding: 0 20px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .tab-nav::-webkit-scrollbar { display: none; }
    .tab-item {
      padding: 12px 10px;
      font-size: 11px;
      font-family: var(--font-mono);
      letter-spacing: 0.5px;
      color: var(--text-tertiary);
      border-bottom: 2px solid transparent;
      cursor: pointer;
      white-space: nowrap;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-item.active {
      color: var(--accent-gold);
      border-bottom-color: var(--accent-gold);
    }
    .tab-item:hover:not(.active) { color: var(--text-secondary); }

    /* Content Area */
    .view-content {
      flex: 1;
      display: none;
      flex-direction: column;
      overflow-y: auto;
      padding: 20px;
    }
    .view-content.active { display: flex; }

    /* Page Header */
    .page-header { margin-bottom: 20px; }
    .page-header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      font-family: var(--font-mono);
      letter-spacing: 0.5px;
    }
    .page-header p {
      margin: 6px 0 0;
      font-size: 13px;
      color: var(--text-tertiary);
      line-height: 1.5;
    }

    /* Status Footer */
    .status-footer {
      display: flex;
      gap: 8px;
      padding: 16px 20px;
      border-top: 1px solid var(--border-subtle);
      margin-top: auto;
      flex-shrink: 0;
      justify-content: center;
      background: var(--bg-primary);
    }
    .badge {
      display: inline-flex;
      padding: 4px 10px;
      font-size: 10px;
      font-family: var(--font-mono);
      letter-spacing: 1px;
      text-transform: uppercase;
      border-radius: 4px;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    .badge-default {
      background: rgba(196,164,105, 0.08);
      border: 1px solid rgba(196,164,105, 0.2);
      color: rgba(196,164,105, 0.6);
    }
    .badge-green {
      background: rgba(107,138,94, 0.1);
      border: 1px solid rgba(107,138,94, 0.25);
      color: var(--accent-green);
    }
    .badge-gold {
      background: rgba(196,164,105, 0.12);
      border: 1px solid rgba(196,164,105, 0.3);
      color: var(--accent-gold);
    }

    /* Accordion */
    .accordion {
      border-bottom: 1px solid var(--border-subtle);
    }
    .accordion-summary {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 0;
      background: none;
      border: none;
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
      font-family: var(--font-mono);
      letter-spacing: 1.5px;
      text-transform: uppercase;
      font-weight: 600;
      outline: none;
    }
    .accordion-summary .chevron {
      width: 16px;
      height: 16px;
      transform: rotate(-90deg);
      transition: transform 0.25s ease;
      flex-shrink: 0;
    }
    .accordion.open .accordion-summary .chevron { transform: rotate(0deg); }
    .accordion-icon {
      color: var(--accent-gold-dim);
      display: flex;
    }
    .accordion-badge {
      margin-left: auto;
      font-size: 11px;
      color: var(--text-secondary);
      font-weight: 400;
      letter-spacing: 0.5px;
      text-transform: none;
    }
    .accordion-content {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.35s ease;
    }
    .accordion.open .accordion-content { max-height: 800px; }
    .accordion-inner { padding: 0 0 16px 28px; }

    /* Forms */
    .input-field, .select-field {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 13px;
      font-family: var(--font-mono);
      color: var(--text-primary);
      outline: none;
      transition: border-color 0.15s;
    }
    .input-field:focus, .select-field:focus { border-color: var(--accent-gold); }
    .input-field::placeholder { color: var(--text-tertiary); }
    .select-field { cursor: pointer; appearance: none; -webkit-appearance: none; }
    .btn-primary {
      background: rgba(196,164,105, 0.15);
      border: 1px solid var(--border-strong);
      color: var(--accent-gold);
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 12px;
      font-family: var(--font-mono);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 0.15s;
    }
    .btn-primary:hover { background: rgba(196,164,105, 0.25); }
    .btn-secondary {
      background: var(--bg-hover);
      border: 1px solid var(--border-emphasis);
      color: var(--text-primary);
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 12px;
      font-family: var(--font-mono);
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-secondary:hover { background: var(--bg-active); border-color: var(--border-strong); }

    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
      text-align: center;
    }
    .empty-icon { color: var(--text-muted); margin-bottom: 16px; display: flex; }
    .empty-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--accent-gold-dim);
      margin-bottom: 6px;
      font-family: var(--font-mono);
    }
    .empty-desc {
      font-size: 12px;
      color: var(--text-tertiary);
      max-width: 220px;
      line-height: 1.5;
    }

    /* Capabilities specific */
    .feature-item { padding: 6px 0; line-height: 1.5; }
    .feature-name { color: var(--text-primary); font-weight: 600; font-size: 13px; }
    .feature-desc { color: var(--text-secondary); font-size: 13px; }

    /* Chat Elements (kept from old CSS but adapted to Colors) */
    .input-area {
      padding: 10px 20px 16px;
      border-top: 1px solid var(--border-subtle);
      flex-shrink: 0;
      background: var(--bg-primary);
    }
    .input-row { display: flex; gap: 8px; }
    .input-row textarea {
      flex: 1;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      padding: 10px 12px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: inherit;
      resize: none;
      height: 38px;
      min-height: 38px;
      max-height: 100px;
      overflow-y: hidden;
      outline: none;
    }
    .input-row textarea:focus { border-color: var(--accent-gold); }
    .send-btn {
      background: rgba(196,164,105, 0.15);
      border: 1px solid var(--border-strong);
      color: var(--accent-gold);
      width: 40px;
      height: 40px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .send-btn.stop { background: rgba(225, 112, 85, 0.15); color: var(--error); border-color: rgba(225, 112, 85, 0.3); }
    .send-btn.resume { background: rgba(196,147,90, 0.15); color: var(--accent-warning); border-color: rgba(196,147,90, 0.3); }

    .steps-container {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-bottom: 20px;
    }
    .step {
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      word-break: break-word;
    }
    .step.thought { background: var(--bg-surface); border-left: 3px solid var(--accent-gold); }
    .step.action { background: var(--bg-hover); border-left: 3px solid var(--accent-green); }
    .step.error { background: rgba(225, 112, 85, 0.1); border-left: 3px solid var(--error); }
    .step.pause { background: rgba(196,147,90, 0.1); border-left: 3px solid var(--accent-warning); color: var(--text-primary); }
    .step .step-header {
      font-size: 10px;
      color: var(--text-tertiary);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-family: var(--font-mono);
    }
    .step .tool-name { color: var(--accent-gold-dim); font-family: var(--font-mono); font-weight: 500; }
    .step pre {
      background: var(--bg-primary);
      padding: 6px 8px;
      border-radius: 4px;
      margin-top: 4px;
      overflow-x: auto;
      font-size: 11px;
      font-family: var(--font-mono);
      white-space: pre-wrap;
      max-height: 120px;
      overflow-y: auto;
    }

    /* Card/Sections */
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-emphasis);
      border-radius: 8px;
      padding: 16px;
    }

    /* Result Banner */
    .result-banner.expanded {
      background: var(--bg-surface);
      border: 1px solid var(--border-emphasis);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .result-header { font-size: 13px; font-weight: 600; font-family: var(--font-mono); display: flex; align-items: center; gap: 6px; }
    .result-answer { margin-top: 12px; padding: 12px 14px; background: rgba(0,0,0,0.2); border-radius: 6px; }
`;

// Read the old HTML
let html = fs.readFileSync('sidepanel.html', 'utf8');

// Replace CSS
html = html.replace(/<style>[\s\S]*?<\/style>/i, `<style>\n${css}\n</style>`);

// Write back
fs.writeFileSync('sidepanel.html', html);
console.log('CSS injected successfully.');
