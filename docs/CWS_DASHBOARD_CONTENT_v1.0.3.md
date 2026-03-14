# Chrome Web Store Dashboard Content (v1.0.3)

Date: March 14, 2026

This file contains ready-to-paste content for Chrome Web Store fields and disclosures.

## Privacy policy URL

Use this URL in the CWS Privacy Policy field:

`https://raw.githubusercontent.com/KazKozDev/browser-agent-chrome-extension/main/PRIVACY.md`

Optional browser-friendly view:

`https://github.com/KazKozDev/browser-agent-chrome-extension/blob/main/PRIVACY.md`

## Single purpose

Copy:

BrowseAgent automates user-requested browser tasks from a side panel: navigate pages, interact with forms, extract information, and send results to user-configured providers/connectors.

## Store description (short)

Copy:

AI browser automation for user-requested tasks: navigate, click, read, extract, and send results to your integrations.

## Store description (detailed)

Copy:

BrowseAgent is a Chrome extension that executes user-requested browsing tasks from the side panel.

What it does:
- Navigates websites and manages tabs.
- Interacts with pages (click, type, select, hover, scroll, key presses).
- Reads page structure/text and extracts structured results.
- Supports plan/approval flow before execution.
- Runs scheduled tasks with background continuation and recovery.
- Optionally routes results to user-enabled connectors (Slack, Notion, Telegram, Discord, Airtable, Google Sheets, webhook/email endpoints).

How it works:
- The user provides a goal.
- The extension uses configured AI provider(s) to plan and execute steps.
- Safety controls include blocklist, sensitive-action confirmation, and loop guards.

User control:
- Tasks are user-initiated and can be stopped anytime.
- Connector routing is optional and controlled in settings.
- Provider credentials are configured by the user.

Support: kazkozdev@gmail.com

## Broad permissions rationale (paste into listing text where needed)

Copy:

BrowseAgent needs broad host access and browser APIs because tasks can target arbitrary user-chosen websites and require full workflow execution (navigation, reading, form interaction, and tab management).

Permission rationale:
- `<all_urls>`, `http://*/*`, `https://*/*`: run only on sites the user asks to automate.
- `activeTab`, `tabs`, `tabGroups`: read/switch/open/close task tabs.
- `scripting`: inject content script for DOM reading and interactions.
- `cookies`: save/restore session state during rollback/recovery flows.
- `storage`, `unlimitedStorage`: persist settings, task history, checkpoints, and schedules.
- `alarms`: run scheduled tasks and keep-alive logic.
- `notifications`: completion/error notifications.
- `declarativeNetRequest`: enforce user blocklist and optional tracker blocker.
- `downloads`: inspect/download artifacts produced during tasks.
- `sidePanel`: provide the extension UI.

## Data usage disclosures (recommended selections)

Set disclosures to match this behavior:

- Data collected:
  - Website content (page text/structure used for task execution).
  - User activity on web pages during task execution (actions performed by the extension).
  - User-provided content (task prompts, connector payloads).
  - Authentication info entered by user for providers/connectors (API keys/tokens) stored in extension storage.
- Data shared:
  - Shared with third parties only when required for user-requested functionality:
    - configured AI providers;
    - enabled connectors/webhooks.
- Purpose:
  - App functionality.
- Not used for:
  - Advertising/personalization.
  - Sale of personal data.
  - Creditworthiness decisions.

If the CWS questionnaire asks for optional declarations, use:
- User can request data deletion by removing extension data/reinstalling extension.
- Data processing depends on user-enabled providers/connectors.

## Category / language / visibility (recommended)

Use these defaults unless you want a different go-to-market setup:

- Category: `Productivity`
- Default language: `English (United States)`
- Visibility: `Public`
- Distribution: `All regions` (or limit regions only if you need legal constraints)
