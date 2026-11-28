-- Receipts and the price ledger (card P4, ADR-25). Add-only: new constraints that every
-- existing row already satisfies, and new tables; nothing here drops or rewrites anything.

-- Lets a ledger line's product be checked to belong to the line's own household.
ALTER TABLE product ADD CONSTRAINT uq_product_id_household UNIQUE (id, household_id);

-- One receipt the household was given at a store.
CREATE TABLE receipt (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_receipt PRIMARY KEY CONSTRAINT df_receipt_id DEFAULT NEWSEQUENTIALID(),
  household_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_receipt_household REFERENCES household (id),
  store        NVARCHAR(100)    COLLATE Latin1_General_100_CI_AS NOT NULL,
  receipt_date DATE             NOT NULL,
  total_cents  INT              NOT NULL CONSTRAINT ck_receipt_total CHECK (total_cents >= 0),
  created_at   DATETIME2(3)     NOT NULL CONSTRAINT df_receipt_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_receipt_id_household UNIQUE (id, household_id)
);
-- Finds a receipt already saved, and a household's receipts by date.
CREATE INDEX ix_receipt_household_date ON receipt (household_id, receipt_date);

-- The price ledger: one row for every line of every receipt, matched to the pantry or not.
-- The name is the receipt's own text. price_cents is what was paid for the whole line
-- (below 0 for a coupon or discount); package_quantity is the size of one package, in
-- unit_id. food_id and product_id are set only where the line matched.
CREATE TABLE price_ledger (
  receipt_id       UNIQUEIDENTIFIER NOT NULL,
  line_no          INT              NOT NULL,
  household_id     UNIQUEIDENTIFIER NOT NULL,
  name             NVARCHAR(200)    NOT NULL,
  quantity         INT              NOT NULL CONSTRAINT ck_price_ledger_quantity CHECK (quantity > 0),
  price_cents      INT              NOT NULL,
  package_quantity DECIMAL(18, 4)   NULL CONSTRAINT ck_price_ledger_package CHECK (package_quantity > 0),
  unit_id          UNIQUEIDENTIFIER NULL CONSTRAINT fk_price_ledger_unit REFERENCES unit (id),
  food_id          UNIQUEIDENTIFIER NULL,
  product_id       UNIQUEIDENTIFIER NULL,
  CONSTRAINT pk_price_ledger PRIMARY KEY (receipt_id, line_no),
  CONSTRAINT fk_price_ledger_receipt FOREIGN KEY (receipt_id, household_id) REFERENCES receipt (id, household_id),
  CONSTRAINT fk_price_ledger_food FOREIGN KEY (food_id, household_id) REFERENCES food (id, household_id),
  CONSTRAINT fk_price_ledger_product FOREIGN KEY (product_id, household_id) REFERENCES product (id, household_id),
  -- A package size comes with its unit or not at all.
  CONSTRAINT ck_price_ledger_size_whole CHECK (
    (package_quantity IS NULL AND unit_id IS NULL) OR (package_quantity IS NOT NULL AND unit_id IS NOT NULL))
);
-- Recipe cost (card W2a) reads a product's and a food's past prices.
CREATE INDEX ix_price_ledger_product ON price_ledger (product_id);
CREATE INDEX ix_price_ledger_food ON price_ledger (food_id);
