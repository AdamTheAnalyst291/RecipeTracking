-- Monthly category budgets (card $3, ADR-27). Adds a table only; nothing here drops or
-- rewrites anything, and it relies only on 0001 and 0010 (not on 0011).
--
-- A row sets a category's monthly budget from starts_on (the first of a month) onwards, so
-- the same amount carries to later months without being entered again, until a later row
-- changes it. A row with no amount clears the budget from that month. There is no envelope
-- rollover: whatever is left of one month's budget doesn't move to the next.
CREATE TABLE money_budget (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_money_budget PRIMARY KEY CONSTRAINT df_money_budget_id DEFAULT NEWSEQUENTIALID(),
  household_id UNIQUEIDENTIFIER NOT NULL,
  category_id  UNIQUEIDENTIFIER NOT NULL,
  starts_on    DATE             NOT NULL CONSTRAINT ck_money_budget_month CHECK (DAY(starts_on) = 1),
  amount_cents BIGINT           NULL CONSTRAINT ck_money_budget_amount CHECK (amount_cents IS NULL OR amount_cents >= 0),
  updated_at   DATETIME2(3)     NOT NULL CONSTRAINT df_money_budget_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_money_budget_household FOREIGN KEY (household_id) REFERENCES household (id),
  CONSTRAINT fk_money_budget_category FOREIGN KEY (category_id, household_id) REFERENCES money_category (id, household_id),
  CONSTRAINT uq_money_budget_category_month UNIQUE (household_id, category_id, starts_on)
);
