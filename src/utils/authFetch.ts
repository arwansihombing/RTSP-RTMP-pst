const TOKEN_STORAGE_KEY = 'sb_session_token';
let memoryToken: string | null = null;

export function getAuthToken(): string | null {
  if (memoryToken) {
    return memoryToken;
  }
  try {
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      memoryToken = stored;
      return stored;
    }
  } catch {
    // sessionStorage may be blocked in strict third-party iframes
  }
  return null;
}

export function setAuthToken(token: string | null): void {
  memoryToken = token || null;
  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore storage restriction and keep memoryToken fallback
  }
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = (init.method || 'GET').toUpperCase();
  const token = getAuthToken();

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (method !== 'GET' && method !== 'HEAD' && !headers.has('X-Requested-With')) {
    headers.set('X-Requested-With', 'XMLHttpRequest');
  }

  const res = await fetch(input, {
    ...init,
    headers,
    credentials: init.credentials ?? 'same-origin',
  });

  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  if (res.status === 401 && !url.endsWith('/api/login')) {
    setAuthToken(null);
  }

  return res;
}
