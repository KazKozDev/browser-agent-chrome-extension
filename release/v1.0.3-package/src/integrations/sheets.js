import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const url = conn?.values?.appScriptUrl?.trim();
  if (!url) throw new Error('Apps Script URL missing');
  const body = testMode
    ? { test: true, source: 'browser-agent' }
    : { source: 'browser-agent', event: 'task_result', payload };
  await safeFetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'sheets.webhook');
}
