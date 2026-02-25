import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const token = conn?.values?.token?.trim();
  const chatId = conn?.values?.chatId?.trim();
  if (!token || !chatId) throw new Error('Telegram token/chat ID missing');
  if (testMode) {
    await safeFetchJson(`https://api.telegram.org/bot${token}/getMe`, {}, 'telegram.getMe');
    return;
  }
  const body = new URLSearchParams({
    chat_id: chatId,
    text: payload.text.slice(0, 3900),
    disable_web_page_preview: 'true',
  });
  await safeFetchJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body.toString(),
  }, 'telegram.sendMessage');
}
