# BrowseAgent v1.0.3

Release date: March 14, 2026

BrowseAgent v1.0.3 focuses on execution quality, safer automation, and a cleaner release package for Chrome Web Store delivery.

## Highlights

- Added plan approval flow so tasks can pause for explicit confirmation before execution starts.
- Added per-domain JavaScript permission prompts with safer script sandboxing that blocks cookies, storage, and auth-header access.
- Improved anti-looping with duplicate-call streak detection, zero-result escalation, adaptive recovery, and better fail-fast behavior.
- Reduced wasted model calls with adaptive `maxSteps`, deferred plan execution, read caching, and compact initial page snapshots.
- Improved temporal awareness and verification handling for tasks that refer to future or barely-started time windows.
- Refined provider setup docs and settings messaging around Z.AI, xAI, Ollama, and Fireworks compatibility.

## UI and workflow updates

- Added explicit approval controls in the side panel for plan approval and JS-domain permission prompts.
- Added transient thinking-state rendering so long reasoning steps are visible in the UI.
- Expanded contextual suggestion rendering and cleaned up history, routing, and settings presentation.

## Packaging and release

- Bumped extension version to `1.0.3` in manifest, UI, README, CWS docs, store-assets paths, and release artifact names.
- Aligned GitHub links with the current repository: `KazKozDev/browser-agent-chrome-extension`.
- Refreshed Chrome Web Store submission docs for the `v1.0.3` package.
