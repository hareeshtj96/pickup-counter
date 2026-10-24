import { type FormEvent, useCallback, useMemo, useRef, useState } from 'react';
import { toApiError } from '../api/client';
import { type PaymentOutcome, claimPickup, simulatePayment } from '../api/pickup';
import type { OrderState } from '../hooks/useOrder';
import { describeApiError } from '../lib/errors';
import { formatPaise, isUuid } from '../lib/format';
import { ORDER_STATUS } from '../lib/orderStatus';
import { Countdown } from './Countdown';

type Props = {
  orderId: string | null;
  tracked: OrderState;
  onTrack: (orderId: string | null) => void;
  /** Called after any action that can change stock, so the catalog re-fetches. */
  onStockChanged: () => void;
};

type Feedback = { orderId: string; kind: 'success' | 'error'; text: string };

const PAYMENT_KIND: Record<PaymentOutcome, Feedback['kind']> = {
  paid: 'success',
  already_paid: 'success',
  late_payment: 'error',
  amount_mismatch: 'error',
  order_not_payable: 'error',
  payment_failed: 'error',
};

const PAYMENT_TEXT: Record<PaymentOutcome, string> = {
  paid: 'Payment confirmed by the server.',
  already_paid: 'This order was already paid; nothing was charged twice.',
  late_payment: 'The payment arrived after the reservation expired, so the order needs staff review.',
  amount_mismatch: 'The payment amount did not match the order, so it needs staff review.',
  order_not_payable: 'This order can no longer be paid.',
  payment_failed: 'The payment failed.',
};

export function OrderPanel({ orderId, tracked, onTrack, onStockChanged }: Props) {
  const { order, loading, error, receivedAt, refresh } = tracked;
  const [lookup, setLookup] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pay' | 'collect' | null>(null);
  const busyRef = useRef(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const names = useMemo(() => new Map(order?.items.map((item) => [item.productId, item.name]) ?? []), [order]);
  const visibleFeedback = feedback && feedback.orderId === orderId ? feedback : null;
  const forceRefresh = useCallback(() => refresh(true), [refresh]);

  function handleLookup(event: FormEvent) {
    event.preventDefault();
    const id = lookup.trim();
    if (!isUuid(id)) {
      setLookupError('Enter a full order ID (for example 3f2b…-…).');
      return;
    }
    setLookupError(null);
    setLookup('');
    onTrack(id);
  }

  /** Runs one action at a time, then re-reads the order and stock from the server. */
  async function runAction(kind: 'pay' | 'collect', id: string, action: () => Promise<Feedback>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    try {
      setFeedback(await action());
    } catch (err) {
      const apiError = toApiError(err);
      const text =
        kind === 'pay' && apiError.status === 404 && apiError.code === 'NOT_FOUND'
          ? 'The payment simulator is turned off on this server. Pay with the signed webhook sender instead (see README "Payment webhook").'
          : describeApiError(apiError, names);
      setFeedback({ orderId: id, kind: 'error', text });
    } finally {
      busyRef.current = false;
      setBusy(null);
      refresh(true);
      onStockChanged();
    }
  }

  const pay = (id: string) =>
    runAction('pay', id, async () => {
      const result = await simulatePayment(id);
      return { orderId: id, kind: PAYMENT_KIND[result.outcome], text: PAYMENT_TEXT[result.outcome] };
    });

  const collect = (id: string) =>
    runAction('collect', id, async () => {
      // A claim that loses to another (409 ORDER_ALREADY_COLLECTED) is reported
      // through the error path with its own message.
      await claimPickup(id);
      return { orderId: id, kind: 'success', text: 'Collection confirmed by the server. Stock has been updated.' };
    });

  return (
    <section className="panel" aria-labelledby="order-heading">
      <h2 id="order-heading">Your order</h2>

      <form className="lookup" onSubmit={handleLookup}>
        <label htmlFor="order-lookup">Track an order by ID</label>
        <div className="lookup__row">
          <input
            id="order-lookup"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Order ID"
            value={lookup}
            aria-invalid={lookupError !== null}
            aria-describedby={lookupError ? 'order-lookup-error' : undefined}
            onChange={(event) => setLookup(event.target.value)}
          />
          <button type="submit" className="button">
            Track
          </button>
        </div>
        {lookupError && (
          <p id="order-lookup-error" className="field-error">
            {lookupError}
          </p>
        )}
      </form>

      {orderId === null && <p className="hint">Reserve some snacks, or enter an order ID to see its status.</p>}

      {orderId !== null && loading && !order && <p role="status">Loading order…</p>}

      {orderId !== null && error && (
        <div className="alert alert--error" role="alert">
          <p>{error.status === 404 ? 'No order was found with this ID.' : describeApiError(error)}</p>
          {error.status !== 404 && (
            <button type="button" className="button" onClick={forceRefresh}>
              Try again
            </button>
          )}
        </div>
      )}

      {order && order.id === orderId && (
        <article className="order" aria-labelledby="order-status">
          <div className="order__head">
            <p className="order__id">
              Order <code>{order.id}</code>
            </p>
            <p id="order-status" className={`badge badge--${ORDER_STATUS[order.status].tone}`}>
              {ORDER_STATUS[order.status].label}
            </p>
          </div>
          <p className="order__guidance">{ORDER_STATUS[order.status].guidance}</p>

          {order.status === 'pending' && order.expiresInSeconds !== null && (
            <Countdown seconds={order.expiresInSeconds} receivedAt={receivedAt} onElapsed={forceRefresh} />
          )}

          <table className="order__items">
            <caption className="visually-hidden">Items in this order</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="num">
                  Qty
                </th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.productId}>
                  <td>
                    {item.name}
                    <span className="unit-price"> @ {formatPaise(item.unitPricePaise)}</span>
                  </td>
                  <td className="num">{item.quantity}</td>
                  <td className="num">{formatPaise(item.lineTotalPaise)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={2}>
                  Total
                </th>
                <td className="num">
                  <strong>{formatPaise(order.totalPaise)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>

          <div className="order__actions">
            {order.status === 'pending' && (
              <div className="action">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void pay(order.id)}
                  disabled={busy !== null}
                >
                  {busy === 'pay' ? 'Processing payment…' : `Simulate payment of ${formatPaise(order.totalPaise)}`}
                </button>
                <p className="hint">
                  Development only: the server simulates the payment provider for the stored total. No real money
                  moves.
                </p>
              </div>
            )}
            {order.status === 'paid' && (
              <div className="action">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void collect(order.id)}
                  disabled={busy !== null}
                >
                  {busy === 'collect' ? 'Confirming pickup…' : 'Staff: confirm pickup'}
                </button>
                <p className="hint">
                  For counter staff. This demo has no staff login or pickup PIN, so anyone with the order ID could
                  press this.
                </p>
              </div>
            )}
            <button type="button" className="button button--ghost" onClick={forceRefresh} disabled={busy !== null}>
              Refresh status
            </button>
            <button type="button" className="button button--ghost" onClick={() => onTrack(null)}>
              Close
            </button>
          </div>

          {visibleFeedback && (
            <p
              className={`alert alert--${visibleFeedback.kind}`}
              role={visibleFeedback.kind === 'error' ? 'alert' : 'status'}
            >
              {visibleFeedback.text}
            </p>
          )}
        </article>
      )}
    </section>
  );
}
