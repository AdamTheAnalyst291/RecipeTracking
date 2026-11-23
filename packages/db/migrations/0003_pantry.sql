-- The pantry (card K4, ADR-25, ADR-28): products linked to foods, current stock, a staples
-- flag and the latest price, plus a daily snapshot of stock and price. Add-only: one new
-- constraint on food, new tables, nothing dropped or rewritten.

-- Lets a product's food be checked to belong to the product's own household.
ALTER TABLE food ADD CONSTRAINT uq_food_id_household UNIQUE (id, household_id);

-- Something we buy or keep, tied to one food. Several products can share a food (two brands
-- of flour). Only staples are tracked: a food with no staple product is "assume we need it".
-- The price is the latest one seen, for a package of package_quantity (in the stock unit).
CREATE TABLE product (
  id               UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_product PRIMARY KEY CONSTRAINT df_product_id DEFAULT NEWSEQUENTIALID(),
  household_id     UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_product_household REFERENCES household (id),
  food_id          UNIQUEIDENTIFIER NOT NULL,
  name             NVARCHAR(200)    NOT NULL,
  unit_id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_product_unit REFERENCES unit (id),
  stock_quantity   DECIMAL(18, 4)   NOT NULL CONSTRAINT df_product_stock DEFAULT 0 CONSTRAINT ck_product_stock CHECK (stock_quantity >= 0),
  is_staple        BIT              NOT NULL CONSTRAINT df_product_staple DEFAULT 0,
  package_quantity DECIMAL(18, 4)   NULL CONSTRAINT ck_product_package CHECK (package_quantity > 0),
  price_cents      INT              NULL CONSTRAINT ck_product_price CHECK (price_cents >= 0),
  price_date       DATE             NULL,
  created_at       DATETIME2(0)     NOT NULL CONSTRAINT df_product_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_product_food FOREIGN KEY (food_id, household_id) REFERENCES food (id, household_id),
  -- A price comes whole or not at all.
  CONSTRAINT ck_product_price_whole CHECK (
    (price_cents IS NULL AND package_quantity IS NULL AND price_date IS NULL)
    OR (price_cents IS NOT NULL AND package_quantity IS NOT NULL AND price_date IS NOT NULL))
);
CREATE INDEX ix_product_household ON product (household_id);
CREATE INDEX ix_product_food ON product (food_id);

-- Stock and price change over time and a missed day can't be rebuilt, so a timer writes
-- one row per product per day. Running again the same day overwrites that day's row.
CREATE TABLE pantry_snapshot (
  product_id       UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_pantry_snapshot_product REFERENCES product (id),
  snapshot_date    DATE             NOT NULL,
  stock_quantity   DECIMAL(18, 4)   NOT NULL,
  unit_id          UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_pantry_snapshot_unit REFERENCES unit (id),
  package_quantity DECIMAL(18, 4)   NULL,
  price_cents      INT              NULL,
  price_date       DATE             NULL,
  taken_at         DATETIME2(0)     NOT NULL CONSTRAINT df_pantry_snapshot_taken DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_pantry_snapshot PRIMARY KEY (product_id, snapshot_date)
);
