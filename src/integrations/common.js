const DEFAULT_FETCH_TIMEOUT_MS = 15000;

export async function safeFetchJson(url, options = {}, context = 'fetch') {
  const timeoutMsRaw = Number(options?.timeoutMs);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
    ? timeoutMsRaw
    : DEFAULT_FETCH_TIMEOUT_MS;

  const fetchOptions = { ...(options || {}) };
  delete fetchOptions.timeoutMs;

  const controller = new AbortController();
  fetchOptions.signal = controller.signal;

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let res;
  try {
    res = await fetch(url, fetchOptions);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`${context}: request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`${context}: ${err?.message || String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }

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
