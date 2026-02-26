# Architecture Analysis: Code vs Research

## Priority Roadmap (by impact)

1. [x] Network-level domain filtering (DNR dynamic rules, blocks all request types)
2. [x] Multi-action batching (reflection: `actions[]` instead of `next_action`)
3. [x] Structured sub-goals (`SubGoal[]`: status/confidence/evidence/attempts)
4. [x] LLM-based history summarization (Tier 2, incremental anchored summary)
5. [x] Rollback/state snapshots before irreversible actions

## What Was Implemented in This Commit

- Added network-level domain blocking via `chrome.declarativeNetRequest` in the background service worker.
- Migrated DNR rules to domain-aware matching (`requestDomains`) with `urlFilter` fallback for compatibility.
- Added DNR rule sync on extension startup, blocklist updates, and `chrome.storage.local` changes.
- Added security preflight: task/recovery/scheduled run will not start if network block rules fail to sync.
- Added extra sync on `chrome.runtime.onInstalled` and `chrome.runtime.onStartup`.
- Added blocklist domain normalization (removes scheme/`www`/path/`user@host` noise).
- Strengthened URL navigation validation: `user:pass@host` URLs are blocked.
- Added unit tests for URL/blocklist security cases.
- Implemented multi-action batching: reflection now supports `actions[]` (up to 4 actions per step), and the run loop executes a batch in a single step while preserving early-break on navigation.
- Implemented structured sub-goal tracking: `SubGoal[]` with `status/confidence/evidence/attempts`, auto-init from goal, update on each action, and integration into task-state message plus checkpoint/resume.
- Implemented Tier-2 context compression: evicted history turns are collected as pending chunks, incrementally compressed via LLM into a running summary, and mixed into `[TASK STATE TRACKER]`; summary is persisted in checkpoint/resume.
- Implemented Tier-3 retrieval memory (embedding-like RAG): evicted chunks are indexed in `ragEntries`, then top-k relevant archived fragments are mixed into `[TASK STATE TRACKER]` as `Relevant archived memory (semantic retrieval)`.
- Implemented rollback/state snapshot manager: auto-captures snapshots before risky actions (`click(confirm)`, submit via Enter, risky `javascript`), adds `restore_snapshot` tool for URL/cookies/scroll rollback, and persists snapshot state in checkpoint/resume.

## Next Layer (After Top-5)

- Implemented composite confidence in reflection: `effective = 0.6 * corrected_llm_confidence * stagnation_penalty * loop_penalty + 0.4 * progress_ratio`.
- Added overconfidence correction (`* 0.85`) and stagnation decay (`0.9 ** noProgressStreak`) to confidence calibration.
- Added resource budgets in the run loop: wall-clock, total tokens, and estimated USD cost with early stop.
- Added structured terminal output: `status` + `partial_result` (`complete|partial|failed|timeout|stuck`, `remaining_subgoals`, `suggestion`).
- Adaptive perception: added sparse-AX detector (low interactive density) with automatic fallback to vision for interaction-oriented steps.
- Adaptive perception: `_waitForNavigation()` now waits for DOM settle via `MutationObserver` (`waitForDomSettle`) instead of fixed `500ms` hardcode.
- Adaptive perception: `read_page` is now task-aware (more compact viewport-oriented profile for form-like goals, wider profile for extraction-like goals).
- Adaptive perception: added structured SoM payload (`id/label/x/y/w/h` JSON) to the vision prompt, not only legend text.
- Added pre-send token estimation: before `provider.chat`, input/output tokens are estimated and preflight budget-check is applied; reflection call is blocked early on overflow, and history summarization switches to skip-mode without LLM call.
- Added human-in-the-loop escalation for medium confidence: when `confidence ~0.5-0.85` under stagnation/step-budget pressure, the agent switches to `paused_waiting_user` with `guidance_needed`, waits for Resume, and continues with user-reviewed context.
