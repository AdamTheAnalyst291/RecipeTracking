-- Shopping lists (card K7, ADR-25): a list built from a stretch of the meal plan minus pantry
-- stock, plus items added by hand, with a checked flag for ticking things off in the store.
-- A list keeps the dates it was built for. Adds tables only; nothing here drops or rewrites
-- anything, and it relies only on 0001 to 0006.

CREATE TABLE shopping_list (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_shopping_list PRIMARY KEY CONSTRAINT df_shopping_list_id DEFAULT NEWSEQUENTIALID(),
  household_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_shopping_list_household REFERENCES household (id),
  start_date   DATE             NOT NULL,
  end_date     DATE             NOT NULL,
  created_at   DATETIME2(3)     NOT NULL CONSTRAINT df_shopping_list_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT ck_shopping_list_dates CHECK (end_date >= start_date),
  -- Lets an item be checked to belong to the list's own household.
  CONSTRAINT uq_shopping_list_id_household UNIQUE (id, household_id)
);
CREATE INDEX ix_shopping_list_household_created ON shopping_list (household_id, created_at);

-- One line to buy. A line from the plan names its food (source 'plan'); one typed in by hand
-- is free text (source 'manual'). The amount and unit are both set or both empty, except that
-- an amount may have no unit ("3", counted). name is copied in so the line reads the same
-- later.
CREATE TABLE shopping_list_item (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_shopping_list_item PRIMARY KEY CONSTRAINT df_shopping_list_item_id DEFAULT NEWSEQUENTIALID(),
  list_id      UNIQUEIDENTIFIER NOT NULL,
  household_id UNIQUEIDENTIFIER NOT NULL,
  food_id      UNIQUEIDENTIFIER NULL,
  name         NVARCHAR(200)    NOT NULL CONSTRAINT ck_shopping_list_item_name CHECK (LEN(name) > 0),
  quantity     DECIMAL(12, 4)   NULL CONSTRAINT ck_shopping_list_item_quantity CHECK (quantity > 0),
  unit_id      UNIQUEIDENTIFIER NULL CONSTRAINT fk_shopping_list_item_unit REFERENCES unit (id),
  source       VARCHAR(6)       NOT NULL CONSTRAINT ck_shopping_list_item_source CHECK (source IN ('plan', 'manual')),
  checked      BIT              NOT NULL CONSTRAINT df_shopping_list_item_checked DEFAULT 0,
  created_at   DATETIME2(3)     NOT NULL CONSTRAINT df_shopping_list_item_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT ck_shopping_list_item_unit_needs_quantity CHECK (unit_id IS NULL OR quantity IS NOT NULL),
  CONSTRAINT fk_shopping_list_item_list FOREIGN KEY (list_id, household_id) REFERENCES shopping_list (id, household_id) ON DELETE CASCADE,
  CONSTRAINT fk_shopping_list_item_food FOREIGN KEY (food_id, household_id) REFERENCES food (id, household_id)
);
CREATE INDEX ix_shopping_list_item_list ON shopping_list_item (list_id);
