import { safeFetchJson } from './common.js';

export async function send(conn, payload, testMode = false) {
  const to = conn?.values?.email?.trim();
  const service = conn?.values?.service?.trim();
  if (!to || !service) throw new Error('Email address/service missing');
  if (!/^https?:\/\//i.test(service)) {
    throw new Error('Email service must be an HTTP endpoint');
  }
  const body = testMode
    ? { to, subject: 'BrowseAgent test', text: 'Email connector test successful.' }
    : { to, subject: 'BrowseAgent task result', text: payload.text, payload };
  await safeFetchJson(service, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'email.endpoint');
}
