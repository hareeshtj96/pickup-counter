import type { ApiError } from '../api/client';

type Shortage = { productId: string; requested?: number; available?: number; required?: number; inStock?: number };
type FieldIssue = { path: string; message: string };

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Turns the backend's `{ error: { code, message, details } }` into a message a
 * customer or staff member can act on. `names` maps product ids to names.
 */
export function describeApiError(error: ApiError, names: ReadonlyMap<string, string> = new Map()): string {
  const name = (id: string) => names.get(id) ?? 'an item';

  switch (error.code) {
    case 'INSUFFICIENT_STOCK': {
      const lines = asArray<Shortage>(error.details).map(
        (s) => `${name(s.productId)}: ${s.available ?? 0} left (you asked for ${s.requested ?? '?'})`,
      );
      return `Not enough stock. ${lines.join('; ')}. Availability has been refreshed.`;
    }
    case 'INSUFFICIENT_PHYSICAL_STOCK': {
      const lines = asArray<Shortage>(error.details).map(
        (s) => `${name(s.productId)}: ${s.inStock ?? 0} on the shelf, ${s.required ?? '?'} needed`,
      );
      return `Cannot hand over this order: ${lines.join('; ')}. Nothing was changed; please ask a supervisor.`;
    }
    case 'ORDER_ALREADY_COLLECTED':
      return 'This order had already been collected. No stock was deducted again.';
    case 'UNKNOWN_PRODUCT':
      return 'One of the selected products no longer exists. The catalog has been refreshed.';
    case 'VALIDATION_ERROR': {
      const issues = asArray<FieldIssue>(error.details).map((issue) => issue.message);
      return issues.length > 0 ? `Please check your order: ${issues.join('; ')}.` : error.message;
    }
    case 'RESERVATION_BUSY':
    case 'COLLECTION_BUSY':
    case 'PAYMENT_BUSY':
      return 'The counter is busy right now. Please try again in a moment.';
    case 'NETWORK_ERROR':
      return 'Could not reach the server. Check your connection and try again.';
    default:
      return error.status >= 500 ? 'Something went wrong on the server. Please try again.' : error.message;
  }
}
