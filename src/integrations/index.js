import { send as sendTelegram } from './telegram.js';
import { send as sendNotion } from './notion.js';
import { send as sendSlack } from './slack.js';
import { send as sendDiscord } from './discord.js';
import { send as sendAirtable } from './airtable.js';
import { send as sendSheets } from './sheets.js';
import { send as sendEmail } from './email.js';
import { send as sendCustomWebhook } from './custom-webhook.js';

export async function dispatchConnection(conn, payload, testMode = false) {
  switch (conn?.id) {
    case 'telegram': return sendTelegram(conn, payload, testMode);
    case 'notion': return sendNotion(conn, payload, testMode);
    case 'slack': return sendSlack(conn, payload, testMode);
    case 'discord': return sendDiscord(conn, payload, testMode);
    case 'airtable': return sendAirtable(conn, payload, testMode);
    case 'sheets': return sendSheets(conn, payload, testMode);
    case 'email': return sendEmail(conn, payload, testMode);
    default:
      if (conn?.custom) return sendCustomWebhook(conn, payload, testMode);
      throw new Error(`Unsupported connector: ${conn?.id || 'unknown'}`);
  }
}
