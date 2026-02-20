# Browser Agent — Pre-Release E2E Test Checklist

> Run this checklist against a freshly packed extension (unpacked load from `browser-agent-ext/`)
> before every release candidate. Mark each item ✅ pass / ❌ fail / ⏭ skip (with reason).

---

## 0. Prerequisites

| # | Step |
|---|------|
| 0.1 | Load extension as unpacked in `chrome://extensions` (Developer mode ON) |
| 0.2 | Open any non-Chrome-internal tab (e.g. `example.com`) |
| 0.3 | Open the side panel via the extension icon |
| 0.4 | Configure at least one provider with a valid API key in Settings |

---

## 1. Plan Mode — Approve

**Goal**: Agent asks for plan approval before acting; user approves; task completes normally.

| # | Step | Expected |
|---|------|----------|
| 1.1 | Enable Plan Mode (toggle button, should turn gold/active) | Button shows active state |
| 1.2 | Run task: `"Open wikipedia.org"` | Agent generates a plan, shows approval banner with **▶ Execute** and **✕ Cancel** buttons |
| 1.3 | Click **▶ Execute** | Plan banner disappears; steps appear; agent navigates to wikipedia.org; task completes |
| 1.4 | Result banner shows success | ✓ summary contains "wikipedia" |

---

## 2. Plan Mode — Cancel

| # | Step | Expected |
|---|------|----------|
| 2.1 | Enable Plan Mode; run task: `"Search for cats on Google"` | Approval banner shown |
| 2.2 | Click **✕ Cancel** | Banner hides; status returns to idle; no navigation occurred |
| 2.3 | Input is re-enabled; another task can be started | ✓ |

---

## 3. Plan Mode — Disconnect & Reconnect During Approval Wait

| # | Step | Expected |
|---|------|----------|
| 3.1 | Enable Plan Mode; start task: `"Open github.com"` | Approval banner appears |
| 3.2 | Close the side panel | Agent continues waiting (keep-alive) |
| 3.3 | Re-open the side panel within 60 s | **Plan banner is shown again** (replayed from buffer); current status indicator shows "paused" |
| 3.4 | Click **▶ Execute** | Agent proceeds; task completes |

---

## 4. Agent Running — Disconnect & Reconnect (Replay Buffer)

| # | Step | Expected |
|---|------|----------|
| 4.1 | Disable Plan Mode; start a multi-step task: `"Search 'browser agent extension' on Google and read the first result title"` | Steps start appearing |
| 4.2 | After 2–3 steps appear, close the side panel | Agent keeps running in background |
| 4.3 | Re-open within 30 s | **All steps that occurred during disconnect are replayed** in the step log, no gap |
| 4.4 | Wait for task completion | Final result banner appears; desktop notification fires |
| 4.5 | No duplicate steps, no "undefined" steps in the log | ✓ |

---

## 5. Scheduled Tasks

| # | Step | Expected |
|---|------|----------|
| 5.1 | Open Schedule tab; add task: name `"Daily Weather"`, goal `"Search current weather in London on weather.com"`, interval `1` minute | Task appears in list |
| 5.2 | Wait ~65 seconds (or trigger via `chrome.alarms.create` in background console) | Desktop notification fires; step log shows the scheduled task ran |
| 5.3 | Start a manual task; wait for the schedule alarm to fire during the manual run | Log shows `"Skipping scheduled task … agent already running"` (no conflict) |
| 5.4 | Delete the scheduled task | Item disappears from list; no further alarms (verify `chrome.alarms.getAll()` in SW console) |

---

## 6. Blocklist

| # | Step | Expected |
|---|------|----------|
| 6.1 | Open Blocklist tab; add domain `example.com` | Domain appears in list |
| 6.2 | Run task: `"Open example.com"` | Agent attempts navigation; blocked — step log shows "blocked" error or task fails gracefully |
| 6.3 | Remove `example.com` from blocklist | Domain disappears |
| 6.4 | Run same task again | Navigation succeeds |

---

## 7. JavaScript Domain — Allow

| # | Step | Expected |
|---|------|----------|
| 7.1 | Run task that requires JS execution (e.g. `"Get the title of the current page using JavaScript"`) on a site not previously trusted | JS permission banner appears: `"Allow JavaScript on domain X?"` |
| 7.2 | Click **Allow** | Banner hides; JS executes; task completes |
| 7.3 | Run same JS task again on the same domain | **No permission prompt** (domain is trusted for the session) |

---

## 8. JavaScript Domain — Deny

| # | Step | Expected |
|---|------|----------|
| 8.1 | Run a JS task on an untrusted domain; click **Deny** | Agent receives denial; continues task with non-JS fallback or gracefully fails with explanation |
| 8.2 | No unhandled JS errors in extension console | ✓ |

---

## 9. http_request Security Guards

Open `chrome://extensions` → Inspect service worker  → Console; then trigger tasks below.

| # | Task | Expected Response from Agent |
|---|------|-------------------------------|
| 9.1 | `"Use http_request to fetch ftp://example.com"` | Blocked: `HTTP_REQUEST_BLOCKED — Scheme "ftp:" is not allowed` |
| 9.2 | `"Use http_request to GET http://localhost:11434/api/tags"` (no allow_private) | Blocked: `HTTP_REQUEST_BLOCKED — Requests to private/internal networks are blocked` |
| 9.3 | `"Use http_request to GET http://192.168.1.1"` | Blocked: private host |
| 9.4 | `"Use http_request to GET http://user:pass@api.example.com"` | Blocked: credentials in URL |
| 9.5 | `"Use http_request to GET https://httpbin.org/get"` | Success — returns JSON response |
| 9.6 | SW console should show audit line: `[Agent][http_request] GET https://httpbin.org/` | ✓ present |

---

## 10. Keep-Alive / Long Session (≥ 2 minutes)

| # | Step | Expected |
|---|------|----------|
| 10.1 | Start a task that takes multiple steps (find & read 3 news headlines) | Task completes without service worker terminating |
| 10.2 | Check SW console: no "service worker stopped" before task finishes | ✓ keep-alive alarms firing every 30 s |
| 10.3 | After task completes, check `chrome.alarms.getAll()` | `agent-keep-alive` alarm is cleared |

---

## 11. Concurrent / Edge Cases

| # | Step | Expected |
|---|------|----------|
| 11.1 | Try starting a second task while one is running | Error message: "Agent is already running. Stop it first." |
| 11.2 | Click Stop during a task | Task aborts; status returns to idle; no stale alarms |
| 11.3 | Open extension on a `chrome://` or `chrome-extension://` page | Graceful error (content script cannot be injected); no crash |
| 11.4 | Switch active provider mid-session via Settings | Config saved; next task uses new provider |

---

## Pass Criteria

All items in sections 1–10 must be ✅ before shipping. Section 11 items are
`should-pass` — document any ❌ with a known-issue note.

---

## Notes / Known Issues

_(fill in before each release)_
