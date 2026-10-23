-- Product catalog.
-- Money is stored as integer paise (Rs 1 = 100 paise), never as a float.
-- INTEGER (max 2,147,483,647 paise, about Rs 2.1 crore) is ample for a snack
-- price, and node-postgres returns INTEGER as a JS number (BIGINT would arrive
-- as a string).

-- Reusable trigger function: keeps updated_at correct on every UPDATE, so
-- application code cannot forget to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE products (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  price_paise    INTEGER     NOT NULL,
  -- Total physical units on hand. Units reserved by orders (Phase 3) are
  -- subtracted from this when computing what customers can still buy.
  stock_quantity INTEGER     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT products_name_not_blank     CHECK (btrim(name) <> ''),
  CONSTRAINT products_name_max_length    CHECK (char_length(name) <= 120),
  CONSTRAINT products_price_positive     CHECK (price_paise > 0),
  CONSTRAINT products_stock_non_negative CHECK (stock_quantity >= 0)
);

-- The same snack cannot be listed twice ("Samosa" vs "samosa").
CREATE UNIQUE INDEX products_name_unique_ci ON products (lower(name));

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
