# BrowseAgent Tool Reference

This file contains the full tool catalog exposed to the model. The main [README](../README.md) keeps only the product-level summary so it remains easy to scan for recruiters, reviewers and first-time users.

| Tool | Description |
|---|---|
| `read_page` | Accessibility tree with interactive element IDs |
| `get_page_text` | Page text extraction: `full`, `viewport` or `selector` |
| `extract_structured` | Structured extraction from repeated cards or result lists |
| `find` | Natural-language element search |
| `find_text` | Ctrl+F-style text search with snippets |
| `screenshot` | Capture screenshot, with optional Set-of-Mark overlays |
| `navigate` | Open URL, subject to blocklist checks |
| `back` | Browser history back |
| `forward` | Browser history forward |
| `reload` | Reload active tab |
| `click` | Click element IDs with single/double/triple and button options |
| `type` | Type text into one or multiple fields |
| `scroll` | Scroll page up or down |
| `select` | Select dropdown option |
| `hover` | Hover over element |
| `press_key` | Press key with optional modifiers |
| `wait_for` | Wait for element, text, URL, navigation or network-idle condition |
| `open_tab` | Open new tab |
| `list_tabs` | List tabs in current window |
| `switch_tab` | Switch active tab by ID or index |
| `close_tab` | Close active tab or tab by ID |
| `switch_frame` | Switch to main document or iframe by id, name or index |
| `restore_snapshot` | Roll back saved state snapshot including URL, cookies and scroll |
| `http_request` | HTTP request to external APIs or webhooks |
| `notify_connector` | Send message to a configured connector |
| `done` | Mark task complete |
| `save_progress` | Persist intermediate task memory |
| `fail` | Mark task failed |
