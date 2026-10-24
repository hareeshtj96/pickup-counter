// Small typed wrapper around fetch. All backend calls go through here so the
// base URL and error format are handled in one place.

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The backend's `error.details`, when present (e.g. stock shortages). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ErrorPayload = { error?: { code?: unknown; message?: unknown; details?: unknown } };

function readErrorPayload(body: unknown): { code?: string; message?: string; details?: unknown } {
  if (typeof body !== 'object' || body === null) return {};
  const error = (body as ErrorPayload).error;
  return {
    code: typeof error?.code === 'string' ? error.code : undefined,
    message: typeof error?.message === 'string' ? error.message : undefined,
    details: error?.details,
  };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
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
    if (isAbortError(err)) throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const { code, message, details } = readErrorPayload(body);
    throw new ApiError(
      response.status,
      code ?? 'HTTP_ERROR',
      message ?? `Request failed with status ${response.status}.`,
      details,
    );
  }
  return body as T;
}

export function apiGet<T>(path: string, init: Omit<RequestInit, 'method' | 'body'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...init, method: 'GET' });
}

/** POSTs `body` as JSON; omit `body` to send no request body at all. */
export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Normalises anything thrown by the API layer into an ApiError. */
export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'UNEXPECTED', 'Something went wrong. Please try again.');
}
