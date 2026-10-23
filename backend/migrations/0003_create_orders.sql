-- Orders, order items and stock availability.
--
-- Physical stock (products.stock_quantity) is NOT decremented when an order is
-- created. Instead an order *reserves* units while it is:
--   * pending  and its reservation has not expired (expires_at > now()), or
--   * paid     (paid but not yet collected).
-- Collection (a later phase) decrements stock_quantity and moves the order to
-- 'collected' in the same transaction, so collected orders reserve nothing.
--
-- Status model (all values exist now; later phases add the transitions):
--   pending       created, unpaid, holds stock until expires_at
--   paid          payment confirmed in time, holds stock until collected
--   expired       unpaid past expires_at, holds nothing
--   needs_review  e.g. payment arrived after expiry; holds nothing until a
--                 person resolves it
--   collected     picked up, stock already decremented, holds nothing

CREATE TABLE orders (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  status       TEXT        NOT NULL DEFAULT 'pending',
  -- Sum of quantity * unit_price_paise over the order's items, fixed at creation.
  total_paise  INTEGER     NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Reservation deadline, always computed from database time.
  expires_at   TIMESTAMPTZ NOT NULL,
  paid_at      TIMESTAMPTZ,
  expired_at   TIMESTAMPTZ,
  collected_at TIMESTAMPTZ,

  CONSTRAINT orders_status_valid
    CHECK (status IN ('pending', 'paid', 'expired', 'needs_review', 'collected')),
  CONSTRAINT orders_total_positive CHECK (total_paise > 0),
  CONSTRAINT orders_expiry_after_creation CHECK (expires_at > created_at),
  -- Status timestamps must agree with the status.
  CONSTRAINT orders_paid_has_paid_at
    CHECK (status NOT IN ('paid', 'collected') OR paid_at IS NOT NULL),
  CONSTRAINT orders_expired_has_expired_at
    CHECK (status <> 'expired' OR expired_at IS NOT NULL),
  CONSTRAINT orders_collected_has_collected_at
    CHECK ((status = 'collected') = (collected_at IS NOT NULL))
);

-- Expiry sweep: find pending orders whose deadline has passed.
CREATE INDEX orders_pending_expires_at_idx ON orders (expires_at) WHERE status = 'pending';

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE order_items (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID    NOT NULL REFERENCES orders (id),
  product_id       UUID    NOT NULL REFERENCES products (id),
  quantity         INTEGER NOT NULL,
  -- Price snapshot: later product price changes never alter past orders.
  unit_price_paise INTEGER NOT NULL,

  CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT order_items_unit_price_positive CHECK (unit_price_paise > 0),
  -- One line per product; the API rejects duplicate product IDs.
  CONSTRAINT order_items_order_product_unique UNIQUE (order_id, product_id)
);

-- The UNIQUE constraint above already indexes lookups by order_id.
-- Availability sums reservations per product.
CREATE INDEX order_items_product_id_idx ON order_items (product_id);

-- Single definition of "units a customer can still buy", used by both the
-- catalog and order creation. now() is the transaction start time: inside a
-- transaction every check uses the same instant, and a slightly older instant
-- can only make an order look *still* reserved (never free stock early).
-- Reservations are summed per product through order_items_product_id_idx.
CREATE VIEW product_availability AS
SELECT p.id AS product_id,
       p.stock_quantity,
       r.reserved_units,
       GREATEST(p.stock_quantity - r.reserved_units, 0) AS available_units
  FROM products p
  CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(oi.quantity), 0)::integer AS reserved_units
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE oi.product_id = p.id
           AND ((o.status = 'pending' AND o.expires_at > now())
                OR o.status = 'paid')
       ) r;
