import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const url = conn?.values?.webhookUrl?.trim();
  if (!url) throw new Error('Discord webhook URL missing');
  const message = testMode ? { content: 'Browser Agent: Discord test successful.' } : { content: payload.text.slice(0, 1900) };
  await safeFetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  }, 'discord.webhook');
}
