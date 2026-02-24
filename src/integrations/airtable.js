import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const apiKey = conn?.values?.apiKey?.trim();
  const baseId = conn?.values?.baseId?.trim();
  if (!apiKey || !baseId) throw new Error('Airtable API key/base ID missing');
  const table = encodeURIComponent('Table 1');
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${table}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (testMode) {
    await safeFetchJson(`${url}?maxRecords=1`, { headers }, 'airtable.test');
    return;
  }
  const body = {
    records: [
      {
        fields: {
          Task: payload.taskName || payload.goal || 'Task',
          Summary: payload.summary || payload.text.slice(0, 500),
          Success: payload.success ? 'true' : 'false',
          Steps: String(payload.steps),
          Timestamp: payload.timestamp,
        },
      },
    ],
  };
  await safeFetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, 'airtable.insert');
}
