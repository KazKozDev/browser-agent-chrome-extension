# Privacy Policy — Browser Agent

Effective date: February 25, 2026

Browser Agent is a Chrome extension that automates browsing actions and can call third-party AI/API providers chosen by the user.

## What data the extension can access

Depending on the task and enabled features, Browser Agent can access:

- web page content, URLs, and page structure for sites you open while using the extension;
- cookies and local page state needed for browser automation flows;
- text you type in the extension UI (task prompts, settings values);
- optional integration payloads when you connect external services (for example Slack/Notion/Telegram/webhook).

## How data is used

Data is used only to provide extension functionality:

- execute your requested browser task;
- generate AI-driven next actions and summaries;
- optionally send task outputs to integrations you explicitly enable;
- provide safety controls (blocklist, manual intervention prompts, permission checks).

## Where data is processed

- Extension state is primarily stored locally in Chrome extension storage.
- If you configure an AI provider (for example Groq, Fireworks, xAI, Ollama, etc.), relevant task context may be sent to that provider to run the task.
- If you enable connectors, data you choose to send is transmitted to those connector endpoints.

Browser Agent does not sell your personal data.

## Data sharing

Data is shared only when necessary to provide user-requested functionality:

- to the AI/API provider you configured;
- to external connectors you enabled;
- when required by law.

No advertising or data brokerage use is intended.

## Security

- Network transmission is performed over secure connections where supported by the destination service.
- The extension includes safeguards such as domain blocklists, JavaScript permission prompts per domain, and manual intervention for sensitive flows.

## Your choices and controls

You can:

- stop tasks at any time;
- clear extension state by removing/reinstalling the extension;
- change or remove configured API keys/connectors in Settings;
- disable optional features (for example tracker/ad blocking and routing).

## Third-party services

When you use third-party AI/connectors, their own privacy policies and terms apply to data processed by those services.

## Contact

For privacy questions: kazkozdev@gmail.com

