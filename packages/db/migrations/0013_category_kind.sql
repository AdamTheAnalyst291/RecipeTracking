-- A category's kind (card $6, ADR-27). Adds one column only; nothing here drops or rewrites
-- anything. Every existing category gets the default and stays a spending category.
--
-- `spending`: counts towards spend vs budget. `not-spending`: transfers, pay and other income,
-- which budgets leave out entirely, so they never count as spending or as a refund even when
-- they are categorized.
ALTER TABLE money_category ADD kind VARCHAR(20) NOT NULL
  CONSTRAINT df_money_category_kind DEFAULT 'spending'
  CONSTRAINT ck_money_category_kind CHECK (kind IN ('spending', 'not-spending'));
