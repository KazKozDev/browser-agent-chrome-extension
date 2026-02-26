import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const token = conn?.values?.token?.trim();
  const databaseId = conn?.values?.databaseId?.trim();
  if (!token || !databaseId) throw new Error('Notion token/database ID missing');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
  };
  if (testMode) {
    await safeFetchJson('https://api.notion.com/v1/users/me', { headers }, 'notion.users.me');
    return;
  }
  const title = (payload.taskName || payload.goal || payload.summary || 'BrowseAgent Result').slice(0, 180);
  const body = {
    parent: { database_id: databaseId },
    properties: {
      Name: {
        title: [{ text: { content: title } }],
      },
    },
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: payload.text.slice(0, 1800) } }] },
      },
    ],
  };
  await safeFetchJson('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, 'notion.pages.create');
}
