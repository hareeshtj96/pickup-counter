import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, isAbortError, toApiError } from '../api/client';
import { type Order, getOrder } from '../api/pickup';

/** How often a pending order is re-checked with the server. */
export const ORDER_POLL_MS = 5_000;

export type OrderState = {
  order: Order | null;
  loading: boolean;
  error: ApiError | null;
  /** Date.now() when `order` was received; anchors the local countdown. */
  receivedAt: number;
  /** Re-fetches now. `force` cancels a request already in flight. */
  refresh: (force?: boolean) => void;
};

/**
 * Tracks GET /orders/:id. While the order is pending it is re-fetched every
 * ORDER_POLL_MS (never two requests at once); polling stops as soon as the
 * server reports any other status, and on unmount or id change.
 */
export function useOrder(orderId: string | null): OrderState {
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(orderId !== null);
  const [error, setError] = useState<ApiError | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(
    (force = false) => {
      if (orderId === null) return;
      if (inFlight.current) {
        if (!force) return; // a poll is already running; don't overlap
        inFlight.current.abort();
      }
      const controller = new AbortController();
      inFlight.current = controller;

      getOrder(orderId, controller.signal)
        .then((next) => {
          setOrder(next);
          setReceivedAt(Date.now());
          setError(null);
        })
        .catch((err: unknown) => {
          if (!isAbortError(err)) setError(toApiError(err));
        })
        .finally(() => {
          if (inFlight.current === controller) {
            inFlight.current = null;
            setLoading(false);
          }
        });
    },
    [orderId],
  );

  // Load whenever the id changes; abandon the previous order's request.
  useEffect(() => {
    setOrder(null);
    setError(null);
    setLoading(orderId !== null);
    refresh(true);
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [orderId, refresh]);

  // Poll only while the server says the order is pending.
  const status = order?.status;
  useEffect(() => {
    if (status !== 'pending') return;
    const timer = setInterval(() => refresh(), ORDER_POLL_MS);
    return () => clearInterval(timer);
  }, [status, refresh]);

  return { order, loading, error, receivedAt, refresh };
}
