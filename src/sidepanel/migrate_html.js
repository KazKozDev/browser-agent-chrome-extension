const fs = require('fs');

let html = fs.readFileSync('sidepanel.html', 'utf8');

// Replace everything between <body> and </body>
// Note: We'll piece together the new structure referencing the JSX mock.
let newBody = `<body>
  <!-- Top Bar -->
  <div class="top-bar">
    <div class="top-bar-left">
      <div id="statusDot" class="status-dot"></div>
      <div class="top-bar-title">Browser Agent</div>
    </div>
    <button class="top-bar-close" onclick="window.close()" title="Close">✕</button>
  </div>

  <!-- Tab Nav -->
  <div class="tab-nav">
    <div class="tab-item active" id="btnHelp" title="Capabilities">Capabilities</div>
    <div class="tab-item" id="btnSettings" title="Settings">Settings</div>
    <div class="tab-item" id="btnSchedule" title="Scheduled Tasks">Scheduled Tasks</div>
    <div class="tab-item" id="btnHistory" title="Task History">Task History</div>
  </div>

  <!-- Capabilities (Chat) View -->
  <div class="view-content active" id="chatView">
    <div class="page-header">
      <h2>Capabilities</h2>
      <p>Describe your goal — the agent handles the rest.</p>
    </div>

    <!-- The Empty State (Capabilities accordions) -->
    <div id="emptyState" style="margin-bottom: 20px;">
      
      <div class="accordion">
        <button class="accordion-summary">
          <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="accordion-icon"><span class="i i-shield"></span></span>
          Safety & Permissions
        </button>
        <div class="accordion-content"><div class="accordion-inner">
          <div class="feature-item"><span class="feature-name">Script sandboxing</span> <span class="feature-desc">— JS is filtered: no cookies, auth headers, or storage access</span></div>
          <div class="feature-item"><span class="feature-name">Per-domain JS permission</span> <span class="feature-desc">— agent asks before running scripts on new sites</span></div>
          <div class="feature-item"><span class="feature-name">Site blocklist</span> <span class="feature-desc">— block navigation to sensitive domains (banks, crypto)</span></div>
        </div></div>
      </div>

      <div class="accordion open">
        <button class="accordion-summary" onclick="this.parentElement.classList.toggle('open')">
          <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="accordion-icon"><span class="i i-list-checks"></span></span>
          Automation & Workflow
        </button>
        <div class="accordion-content"><div class="accordion-inner">
          <div class="feature-item"><span class="feature-name">Plan mode</span> <span class="feature-desc">— agent shows steps before executing, you approve or cancel</span></div>
          <div class="feature-item"><span class="feature-name">Shortcuts</span> <span class="feature-desc">— save prompts as /name slash commands for quick reuse</span></div>
          <div class="feature-item"><span class="feature-name">Scheduled tasks</span> <span class="feature-desc">— run goals automatically every N minutes / hours</span></div>
          <div class="feature-item"><span class="feature-name">Background workflows</span> <span class="feature-desc">— task continues even when side panel is closed</span></div>
          <div class="feature-item"><span class="feature-name">Smart suggestions</span> <span class="feature-desc">— contextual prompts based on the current site</span></div>
          <div class="feature-item"><span class="feature-name">Notifications</span> <span class="feature-desc">— desktop alerts when a task finishes</span></div>
        </div></div>
      </div>

      <div class="accordion">
        <button class="accordion-summary" onclick="this.parentElement.classList.toggle('open')">
          <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="accordion-icon"><span class="i i-globe"></span></span>
          Browsing & Navigation
        </button>
        <div class="accordion-content"><div class="accordion-inner">
          <div class="feature-item"><span class="feature-name">URLs & history</span> <span class="feature-desc">— open any URL, go back / forward, reload</span></div>
          <div class="feature-item"><span class="feature-name">Tabs / Iframes</span> <span class="feature-desc">— open, switch, close tabs; switch iframes</span></div>
        </div></div>
      </div>

      <div class="accordion">
        <button class="accordion-summary" onclick="this.parentElement.classList.toggle('open')">
          <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="accordion-icon"><span class="i i-mouse"></span></span>
          Page Interaction
        </button>
        <div class="accordion-content"><div class="accordion-inner">
          <div class="feature-item"><span class="feature-name">Clicks</span> <span class="feature-desc">— click, right-click, middle-click, triple-click</span></div>
          <div class="feature-item"><span class="feature-name">Forms / Types</span> <span class="feature-desc">— type text, fill inputs, select dropdowns</span></div>
        </div></div>
      </div>

      <div class="accordion">
        <button class="accordion-summary" onclick="this.parentElement.classList.toggle('open')">
          <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="accordion-icon"><span class="i i-eye"></span></span>
          Page Reading & Inspection
        </button>
        <div class="accordion-content"><div class="accordion-inner">
          <div class="feature-item"><span class="feature-name">Accessibility tree</span> <span class="feature-desc">— structured reading of page elements</span></div>
          <div class="feature-item"><span class="feature-name">Full text extraction</span> <span class="feature-desc">— get all text content from the page</span></div>
        </div></div>
      </div>

      <div class="accordion">
        <button class="accordion-summary" onclick="this.parentElement.classList.toggle('open')">
          <svg class="chevron" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="accordion-icon"><span class="i i-cloud"></span></span>
          External Integrations
        </button>
        <div class="accordion-content"><div class="accordion-inner">
          <div class="feature-item"><span class="feature-name">http_request</span> <span class="feature-desc">— call any REST API directly: Notion, Slack, Airtable</span></div>
        </div></div>
      </div>

    </div>

    <!-- Active steps stream (hidden initially) -->
    <div class="steps-container" id="stepsContainer"></div>

    <div class="result-banner" id="resultBanner"></div>
    <div class="plan-banner" id="planBanner" style="display:none;"></div>

    <!-- Pushing input down -->
    <div style="flex:1;"></div>

    <!-- Input Area -->
    <div class="input-area">
      <div id="shortcutsDropdown" class="shortcuts-dropdown" style="display:none;background:var(--bg-input);padding:10px;border-radius:6px;border:1px solid var(--border-subtle);margin-bottom:8px;"></div>
      <div class="input-row">
        <textarea id="goalInput" placeholder="Describe your goal..." rows="1"></textarea>
        <button class="send-btn" id="sendBtn" title="Run"><span class="i i-play"></span></button>
      </div>
      <div class="input-actions" style="display:flex;gap:6px;padding-top:6px;align-items:center;">
        <button class="icon-btn" id="btnSaveShortcut" style="font-size:14px;color:rgba(196,164,105, 0.45);background:none;border:none;cursor:pointer;"><span class="i i-bookmark"></span></button>
        <button class="icon-btn" id="btnPlanMode" style="font-size:14px;color:rgba(196,164,105, 0.45);background:none;border:none;cursor:pointer;"><span class="i i-list-checks"></span></button>
        <button class="icon-btn" id="btnNotionSave" style="font-size:14px;color:rgba(196,164,105, 0.45);background:none;border:none;cursor:pointer;"><span class="i i-notion"></span></button>
      </div>
    </div>
  </div>

  <!-- History View -->
  <div class="view-content" id="historyView">
    <div class="page-header">
      <h2>Task History</h2>
      <p>Previous tasks and their results.</p>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
      <button id="btnClearTelemetry" class="btn-secondary">Clear warnings</button>
    </div>
    <div id="historyTelemetry" style="display:none;margin-bottom:10px;padding:8px 10px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--bg-surface);font-size:11px;color:var(--text-secondary);"></div>
    <div id="historyList"></div>
    <div class="empty-state" id="historyEmpty">
      <div class="empty-icon"><span class="i i-clipboard" style="font-size:40px;"></span></div>
      <div class="empty-title">No tasks yet</div>
      <div class="empty-desc">Completed tasks will appear here with their stats and results.</div>
    </div>
  </div>

  <!-- Settings View -->
  <div class="view-content" id="settingsView">
    <div class="page-header">
      <h2>Settings</h2>
      <p>Even agents need a brain. Pick one below, add your API key and hit Test.</p>
    </div>
    <div id="tierGroups"></div>
    
    <div style="margin-top:20px;">
      <div style="font-size:12px;font-family:var(--font-mono);letter-spacing:1.5px;text-transform:uppercase;color:var(--text-primary);font-weight:600;margin-bottom:8px;">Site Blocklist</div>
      <p style="font-size:12px;color:var(--text-tertiary);margin:0 0 12px;line-height:1.4;">Block sites the agent should never visit. Crypto/payment blocked by default.</p>
      <div style="background:rgba(196,164,105, 0.03);border:1px solid rgba(196,164,105, 0.1);border-radius:8px;padding:16px;">
        <div id="blocklistSection"></div>
      </div>
    </div>
  </div>

  <!-- Schedule View -->
  <div class="view-content" id="scheduleView">
    <div class="page-header">
      <h2>Scheduled Tasks</h2>
      <p>Schedule recurring tasks — every 30 min, hourly, or daily. Runs in background, notifies when done.</p>
    </div>
    <div id="scheduledTasksSection"></div>
  </div>

  <!-- Footer (Shared) -->
  <div class="status-footer">
    <div class="badge badge-default">INJECTION RESISTANT</div>
    <div class="badge badge-default">LOOP PROTECTED</div>
    <div class="badge badge-green">LIVE TRACE</div>
  </div>

  <script src="sidepanel.js"></script>
</body>`;

html = html.replace(/<body>[\s\S]*<\/body>/i, newBody);

fs.writeFileSync('sidepanel.html', html);
console.log('HTML restructured successfully.');
