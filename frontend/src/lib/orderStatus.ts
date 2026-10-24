import type { OrderStatus } from '../api/pickup';

type StatusCopy = { label: string; guidance: string; tone: 'info' | 'success' | 'warning' | 'neutral' };

/** Labels and next steps for every status the backend can return. */
export const ORDER_STATUS: Record<OrderStatus, StatusCopy> = {
  pending: {
    label: 'Awaiting payment',
    guidance: 'Your items are reserved. Complete payment before the timer runs out to keep them.',
    tone: 'info',
  },
  paid: {
    label: 'Paid – ready for pickup',
    guidance: 'Payment confirmed by the server. Show this order ID at the counter to collect your items.',
    tone: 'success',
  },
  expired: {
    label: 'Reservation expired',
    guidance: 'The reservation ran out before payment and the items were released. Place a new order to try again.',
    tone: 'neutral',
  },
  needs_review: {
    label: 'Needs review',
    guidance:
      'A payment was received that could not be applied automatically (for example after the reservation expired). ' +
      'A staff member will resolve it; the order cannot be collected yet.',
    tone: 'warning',
  },
  collected: {
    label: 'Collected',
    guidance: 'This order has been handed over. Enjoy your snacks!',
    tone: 'neutral',
  },
};
