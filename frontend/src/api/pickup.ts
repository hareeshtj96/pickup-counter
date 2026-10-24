// Typed calls for the Pickup Counter API. Shapes mirror the backend responses
// exactly; the server is the source of truth for prices, stock and status.
import { apiGet, apiPost } from './client';

export type Product = {
  id: string;
  name: string;
  pricePaise: number;
  availableUnits: number;
};

export type OrderStatus = 'pending' | 'paid' | 'expired' | 'needs_review' | 'collected';

export type OrderItem = {
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
};

export type Order = {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  createdAt: string;
  expiresAt: string;
  /** Seconds left on the reservation at response time; null once the deadline no longer applies. */
  expiresInSeconds: number | null;
  items: OrderItem[];
};

export type CollectResult = Order & { alreadyCollected: boolean };

export type PaymentOutcome =
  | 'paid'
  | 'late_payment'
  | 'amount_mismatch'
  | 'already_paid'
  | 'order_not_payable'
  | 'payment_failed';

export type PaymentResult = {
  eventId: string;
  orderId: string;
  outcome: PaymentOutcome;
  orderStatus: OrderStatus;
  duplicate: boolean;
};

/** Backend request limits (see README "POST /orders"). */
export const MAX_QUANTITY_PER_ITEM = 20;

export async function listProducts(signal?: AbortSignal): Promise<Product[]> {
  const body = await apiGet<{ products: Product[] }>('/products', { signal });
  return body.products;
}

export function createOrder(items: { productId: string; quantity: number }[]): Promise<Order> {
  return apiPost<Order>('/orders', { items });
}

export function getOrder(id: string, signal?: AbortSignal): Promise<Order> {
  return apiGet<Order>(`/orders/${encodeURIComponent(id)}`, { signal });
}

/**
 * Staff pickup claim. Only one claim per order can succeed; a competing or
 * repeated claim is rejected by the server with 409 ORDER_ALREADY_COLLECTED.
 */
export function claimPickup(id: string): Promise<CollectResult> {
  // The server requires Content-Type: application/json; the body itself is empty.
  return apiPost<CollectResult>(`/orders/${encodeURIComponent(id)}/pickup-claim`, {});
}

/**
 * DEVELOPMENT ONLY: asks the backend to simulate a captured payment for the
 * order's stored total. The browser never signs webhooks or sets a status;
 * the server runs its normal payment rules. Returns 404 when disabled.
 */
export function simulatePayment(id: string): Promise<PaymentResult> {
  // JSON Content-Type with an empty body: the server decides amount and event id.
  return apiPost<PaymentResult>(`/dev/orders/${encodeURIComponent(id)}/simulate-payment`, {});
}
