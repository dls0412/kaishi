let token = '';
export function setLocalToken(value: string) { token = value; }
async function ensureLocalToken() {
  if (!token) {
    try {
      const response = await fetch('/api/local/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) {
        const state = await response.json();
        if (typeof state.token === 'string') setLocalToken(state.token);
      }
    } catch {
      // Standalone browser previews can still reach services that allow CORS.
    }
  }
}

export async function localRequest<T>(route: string, value: unknown = {}, signal?: AbortSignal): Promise<T> {
  await ensureLocalToken();
  if (!token) throw new Error('请通过「启动开视」打开本机客户端。');
  const response = await fetch('/api/local/' + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kaishi-token': token },
    body: JSON.stringify(value), signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '本机服务请求失败。');
  return result;
}

/** The local host forwards model traffic so providers need not allow browser CORS. */
export async function modelFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await ensureLocalToken();
  if (!token) return fetch(url, init);
  const upstreamHeaders = new Headers(init.headers);
  const headers = new Headers({ 'x-kaishi-token': token, 'x-kaishi-upstream': url });
  for (const key of ['authorization', 'x-api-key', 'anthropic-version', 'idempotency-key', 'content-type', 'bucket', 'ufile_indicated_region']) {
    const value = upstreamHeaders.get(key); if (value) headers.set(`x-upstream-${key}`, value);
  }
  // Let fetch assign a multipart boundary; the local server forwards it verbatim.
  return fetch('/api/local/upstream', { ...init, headers });
}
