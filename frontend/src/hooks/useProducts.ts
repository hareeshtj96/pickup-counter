import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApiError, isAbortError, toApiError } from '../api/client';
import { type Product, listProducts } from '../api/pickup';

export type ProductsState = {
  products: Product[];
  /** True until the first response (success or failure) arrives. */
  loading: boolean;
  /** True while any request is in flight, including background refreshes. */
  refreshing: boolean;
  error: ApiError | null;
  refresh: () => void;
};

/** Loads GET /products; `refresh()` re-fetches and supersedes any request in flight. */
export function useProducts(): ProductsState {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRefreshing(true);

    listProducts(controller.signal)
      .then((list) => {
        setProducts(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(toApiError(err));
      })
      .finally(() => {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setLoading(false);
          setRefreshing(false);
        }
      });
  }, []);

  useEffect(() => {
    refresh();
    return () => inFlight.current?.abort();
  }, [refresh]);

  return { products, loading, refreshing, error, refresh };
}
