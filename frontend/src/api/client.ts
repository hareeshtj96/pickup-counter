// Small typed wrapper around fetch. All backend calls go through here so the
// base URL and error format are handled in one place.

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ErrorPayload = { error?: { code?: unknown; message?: unknown } };

function readErrorPayload(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const error = (body as ErrorPayload).error;
  return {
    code: typeof error?.code === 'string' ? error.code : undefined,
    message: typeof error?.message === 'string' ? error.message : undefined,
  };
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { code, message } = readErrorPayload(body);
    throw new ApiError(
      response.status,
      code ?? 'HTTP_ERROR',
      message ?? `Request failed with status ${response.status}.`,
    );
  }
  return body as T;
}

export function apiGet<T>(path: string, init: Omit<RequestInit, 'method' | 'body'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...init, method: 'GET' });
}
