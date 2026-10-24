import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeApiError } from './errors';
import { formatCountdown, formatPaise, isUuid } from './format';

describe('formatPaise', () => {
  it.each([
    [2000, '₹20.00'],
    [5, '₹0.05'],
    [123456, '₹1,234.56'],
    [12345678, '₹1,23,456.78'], // Indian digit grouping
    [0, '₹0.00'],
  ])('%i paise -> %s', (paise, expected) => {
    expect(formatPaise(paise)).toBe(expected);
  });
});

describe('formatCountdown', () => {
  it.each([
    [120, '2:00'],
    [119, '1:59'],
    [5, '0:05'],
    [0, '0:00'],
    [-3, '0:00'],
  ])('%i s -> %s', (seconds, expected) => {
    expect(formatCountdown(seconds)).toBe(expected);
  });
});

describe('isUuid', () => {
  it('accepts UUIDs only', () => {
    expect(isUuid('e15fb5e3-7e16-469a-b400-5b02df0f2592')).toBe(true);
    expect(isUuid('e15fb5e3')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});

describe('describeApiError', () => {
  const names = new Map([['p1', 'Samosa']]);

  it('explains stock shortages with product names', () => {
    const error = new ApiError(409, 'INSUFFICIENT_STOCK', 'x', [{ productId: 'p1', requested: 3, available: 1 }]);
    expect(describeApiError(error, names)).toBe(
      'Not enough stock. Samosa: 1 left (you asked for 3). Availability has been refreshed.',
    );
  });

  it('explains physical stock shortages at pickup', () => {
    const error = new ApiError(409, 'INSUFFICIENT_PHYSICAL_STOCK', 'x', [{ productId: 'p1', required: 3, inStock: 2 }]);
    expect(describeApiError(error, names)).toContain('Samosa: 2 on the shelf, 3 needed');
  });

  it('lists validation messages', () => {
    const error = new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.', [
      { path: 'body.items', message: 'items must contain at least one item' },
    ]);
    expect(describeApiError(error)).toBe('Please check your order: items must contain at least one item.');
  });

  it('hides server internals for 5xx', () => {
    expect(describeApiError(new ApiError(500, 'INTERNAL_ERROR', 'stack trace here'))).toBe(
      'Something went wrong on the server. Please try again.',
    );
  });

  it.each(['RESERVATION_BUSY', 'COLLECTION_BUSY', 'PAYMENT_BUSY'])('treats %s as a retryable busy state', (code) => {
    expect(describeApiError(new ApiError(503, code, 'x'))).toMatch(/busy/);
  });
});
