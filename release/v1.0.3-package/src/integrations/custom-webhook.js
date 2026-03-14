import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const url = conn?.values?.url?.trim();
  if (!url) throw new Error('Webhook URL missing');
  const method = (conn?.values?.method || 'POST').toUpperCase();
  const rawHeaders = conn?.values?.headers?.trim() || '{}';
  let headers = {};
  try {
    headers = JSON.parse(rawHeaders);
  } catch {
    throw new Error('Webhook headers must be valid JSON');
  }
  const body = testMode ? { test: true, source: 'browser-agent' } : { source: 'browser-agent', event: 'task_result', payload };
  await safeFetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  }, 'webhook.custom');
}
