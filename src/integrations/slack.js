import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const url = conn?.values?.webhookUrl?.trim();
  if (!url) throw new Error('Slack webhook URL missing');
  const message = testMode ? { text: 'BrowseAgent: Slack test successful.' } : { text: payload.text.slice(0, 3500) };
  await safeFetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  }, 'slack.webhook');
}
