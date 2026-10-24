import { vi } from 'vitest';
import type { Order, Product } from '../api/pickup';

export type MockCall = { method: string; path: string; body: unknown };
export type MockReply = { status?: number; body?: unknown };
type Handler = (call: MockCall) => MockReply | Promise<MockReply>;

/**
 * Replaces global fetch with a tiny router keyed by "METHOD /path". Records
 * every call (method, path, parsed JSON body) and honours AbortSignal like the
 * real fetch. Unmatched routes answer 404 like the backend's notFound handler.
 */
export function installMockApi() {
  const handlers = new Map<string, Handler>();
  const calls: MockCall[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const path = new URL(url, 'http://localhost').pathname;
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, path, body };
    calls.push(call);

    const signal = init.signal;
    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });

    const handler = handlers.get(`${method} ${path}`);
    const reply: MockReply = handler
      ? await Promise.race([Promise.resolve(handler(call)), aborted])
      : { status: 404, body: { error: { code: 'NOT_FOUND', message: `Route ${method} ${path} not found.` } } };

    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    /** Registers a reply (object) or a handler (function) for "METHOD /path". */
    on(route: string, reply: MockReply | Handler) {
      handlers.set(route, typeof reply === 'function' ? reply : () => reply);
    },
    count(route: string): number {
      return calls.filter((call) => `${call.method} ${call.path}` === route).length;
    },
  };
}

/** A promise you resolve from the test, to hold a request "in flight". */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export const SAMOSA: Product = {
  id: 'a1b2c3d4-0001-4000-8000-000000000001',
  name: 'Samosa',
  pricePaise: 2000,
  availableUnits: 40,
};
export const BROWNIE: Product = {
  id: 'a1b2c3d4-0005-4000-8000-000000000005',
  name: 'Chocolate Brownie',
  pricePaise: 6000,
  availableUnits: 2,
};
export const PUFF: Product = {
  id: 'a1b2c3d4-0003-4000-8000-000000000003',
  name: 'Paneer Puff',
  pricePaise: 3500,
  availableUnits: 0,
};

export const ORDER_ID = 'e15fb5e3-7e16-469a-b400-5b02df0f2592';

export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    status: 'pending',
    totalPaise: 4000,
    createdAt: '2026-10-24T10:00:00.000Z',
    expiresAt: '2026-10-24T10:02:00.000Z',
    expiresInSeconds: 119,
    items: [{ productId: SAMOSA.id, name: 'Samosa', quantity: 2, unitPricePaise: 2000, lineTotalPaise: 4000 }],
    ...overrides,
  };
}
