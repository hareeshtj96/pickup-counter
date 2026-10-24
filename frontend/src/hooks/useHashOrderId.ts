import { useCallback, useEffect, useState } from 'react';

const PREFIX = '#/orders/';

function readOrderId(): string | null {
  const hash = window.location.hash;
  return hash.startsWith(PREFIX) ? decodeURIComponent(hash.slice(PREFIX.length)) || null : null;
}

/**
 * The order being viewed lives in the URL (#/orders/<id>), so a reload or a
 * shared link reopens it. Nothing is stored in the browser.
 */
export function useHashOrderId(): [string | null, (id: string | null) => void] {
  const [orderId, setOrderId] = useState<string | null>(readOrderId);

  useEffect(() => {
    const onHashChange = () => setOrderId(readOrderId());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((id: string | null) => {
    window.location.hash = id ? `${PREFIX}${encodeURIComponent(id)}` : '';
    setOrderId(id);
  }, []);

  return [orderId, navigate];
}
