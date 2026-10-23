import { expireOverdueOrders } from '../services/orders.service.js';

/**
 * Periodically persists the 'expired' status for unpaid orders past their
 * deadline. This only keeps stored statuses tidy: stock availability and
 * GET /orders/:id already treat overdue orders as expired without it.
 *
 * Runs inside the API process (no extra infrastructure). Sweeps never overlap.
 * Returns a function that stops the sweeper.
 */
export function startExpirySweeper(intervalMs: number): () => void {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    expireOverdueOrders()
      .then((count) => {
        if (count > 0) console.log(`Expiry sweep: marked ${count} order(s) as expired.`);
      })
      .catch((err: unknown) => {
        console.error('Expiry sweep failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  return () => clearInterval(timer);
}
