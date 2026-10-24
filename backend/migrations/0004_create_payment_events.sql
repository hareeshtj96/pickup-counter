-- Payment-provider webhook events.
--
-- Every accepted (correctly signed, valid, known-order) event is stored exactly
-- once. The UNIQUE constraint on event_id is what makes webhook delivery
-- idempotent: a retried or duplicated event can never be applied twice, even
-- when copies arrive at the same moment.
--
-- The event row and any order status change are written in the same
-- transaction, so there is never an event without its effect or vice versa.

CREATE TABLE payment_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Identifier assigned by the payment provider.
  event_id     TEXT        NOT NULL,
  order_id     UUID        NOT NULL REFERENCES orders (id),
  -- What the provider reported. Never trusted for the order total.
  amount_paise INTEGER     NOT NULL,
  status       TEXT        NOT NULL,
  -- What this application did with the event.
  outcome      TEXT        NOT NULL,
  -- Human-readable reason, e.g. for a needs_review decision.
  detail       TEXT,
  -- The exact signed request body, for audit.
  raw_payload  TEXT        NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payment_events_event_id_unique UNIQUE (event_id),
  CONSTRAINT payment_events_event_id_not_blank CHECK (btrim(event_id) <> ''),
  CONSTRAINT payment_events_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT payment_events_status_valid CHECK (status IN ('captured', 'failed')),
  CONSTRAINT payment_events_outcome_valid CHECK (outcome IN (
    'paid',               -- order moved pending -> paid
    'late_payment',       -- captured after expiry: order -> needs_review
    'amount_mismatch',    -- captured in time but wrong amount: order -> needs_review
    'already_paid',       -- order was already paid by another event: no change
    'order_not_payable',  -- order is needs_review or collected: no change
    'payment_failed'      -- provider reported a failed payment: no change
  ))
);

-- Audit / support lookups: all events for one order.
CREATE INDEX payment_events_order_id_idx ON payment_events (order_id);
