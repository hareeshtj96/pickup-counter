import { useEffect, useRef } from 'react';
import type { Order } from './api/pickup';
import { Catalog } from './components/Catalog';
import { OrderPanel } from './components/OrderPanel';
import { useHashOrderId } from './hooks/useHashOrderId';
import { useOrder } from './hooks/useOrder';
import { useProducts } from './hooks/useProducts';

export function App() {
  const catalog = useProducts();
  const [orderId, trackOrder] = useHashOrderId();
  const tracked = useOrder(orderId);

  // Whenever the server reports a new status for the tracked order (paid,
  // expired, collected, …), stock may have changed: re-fetch the catalog.
  const { refresh: refreshCatalog } = catalog;
  const status = tracked.order?.status;
  const lastStatus = useRef(status);
  useEffect(() => {
    if (status !== undefined && lastStatus.current !== undefined && status !== lastStatus.current) {
      refreshCatalog();
    }
    lastStatus.current = status;
  }, [status, refreshCatalog]);

  const handleOrderCreated = (order: Order) => trackOrder(order.id);

  return (
    <>
      <header className="site-header">
        <h1>Pickup Counter</h1>
        <p>Reserve snacks, pay within 2 minutes, collect at the counter.</p>
      </header>
      <main className="layout">
        <Catalog catalog={catalog} onOrderCreated={handleOrderCreated} />
        <OrderPanel orderId={orderId} tracked={tracked} onTrack={trackOrder} onStockChanged={refreshCatalog} />
      </main>
    </>
  );
}
