import { type FormEvent, useMemo, useRef, useState } from 'react';
import { toApiError } from '../api/client';
import { MAX_QUANTITY_PER_ITEM, type Order, createOrder } from '../api/pickup';
import type { ProductsState } from '../hooks/useProducts';
import { describeApiError } from '../lib/errors';
import { formatPaise } from '../lib/format';
import { QuantityStepper } from './QuantityStepper';

type Props = {
  catalog: ProductsState;
  onOrderCreated: (order: Order) => void;
};

export function Catalog({ catalog, onOrderCreated }: Props) {
  const { products, loading, refreshing, error, refresh } = catalog;
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Guards against a second submit before React re-renders the disabled button.
  const submittingRef = useRef(false);

  const names = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const maxFor = (availableUnits: number) => Math.min(availableUnits, MAX_QUANTITY_PER_ITEM);

  // Selections are clamped to the latest server availability at render time.
  const selection = products
    .map((product) => ({ product, quantity: Math.min(quantities[product.id] ?? 0, maxFor(product.availableUnits)) }))
    .filter((line) => line.quantity > 0);
  const unitCount = selection.reduce((sum, line) => sum + line.quantity, 0);
  const estimatedPaise = selection.reduce((sum, line) => sum + line.product.pricePaise * line.quantity, 0);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submittingRef.current || selection.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const order = await createOrder(
        selection.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
      );
      setQuantities({});
      onOrderCreated(order);
    } catch (err) {
      setSubmitError(describeApiError(toApiError(err), names));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      refresh(); // availability changed either way (reserved, or someone else took it)
    }
  }

  return (
    <section className="panel" aria-labelledby="catalog-heading">
      <div className="panel__header">
        <h2 id="catalog-heading">Snacks</h2>
        <button type="button" className="button button--ghost" onClick={refresh} disabled={refreshing}>
          {refreshing && !loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {loading && <p role="status">Loading products…</p>}

      {!loading && error && (
        <div className="alert alert--error" role="alert">
          <p>Could not load products. {describeApiError(error)}</p>
          <button type="button" className="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {!loading && !error && products.length === 0 && <p>No products are available right now.</p>}

      {products.length > 0 && (
        <form onSubmit={(event) => void handleSubmit(event)} aria-describedby="catalog-note">
          <ul className="product-grid">
            {products.map((product) => {
              const max = maxFor(product.availableUnits);
              const soldOut = product.availableUnits === 0;
              return (
                <li key={product.id} className={`product${soldOut ? ' product--sold-out' : ''}`}>
                  <h3 className="product__name">{product.name}</h3>
                  <p className="product__price">{formatPaise(product.pricePaise)}</p>
                  <p className="product__stock">{soldOut ? 'Sold out' : `${product.availableUnits} available`}</p>
                  <QuantityStepper
                    productName={product.name}
                    value={Math.min(quantities[product.id] ?? 0, max)}
                    max={max}
                    disabled={soldOut || submitting}
                    onChange={(value) => setQuantities((current) => ({ ...current, [product.id]: value }))}
                  />
                </li>
              );
            })}
          </ul>

          <div className="order-bar">
            <p className="order-bar__summary">
              {unitCount === 0 ? (
                'Choose quantities to reserve.'
              ) : (
                <>
                  {unitCount} item{unitCount === 1 ? '' : 's'} · estimated <strong>{formatPaise(estimatedPaise)}</strong>
                </>
              )}
            </p>
            <button type="submit" className="button button--primary" disabled={submitting || unitCount === 0}>
              {submitting ? 'Reserving…' : 'Reserve for 2 minutes'}
            </button>
          </div>
          <p id="catalog-note" className="hint">
            Prices, stock and the final total are confirmed by the server when you reserve. Up to{' '}
            {MAX_QUANTITY_PER_ITEM} of each item per order.
          </p>
          {submitError && (
            <p className="alert alert--error" role="alert">
              {submitError}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
