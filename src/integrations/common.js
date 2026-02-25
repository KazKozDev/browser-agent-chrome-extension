export async function safeFetchJson(url, options = {}, context = 'fetch') {
  const res = await fetch(url, options);
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || data?.raw || `HTTP ${res.status}`;
    throw new Error(`${context}: ${msg}`);
  }
  return data;
}
