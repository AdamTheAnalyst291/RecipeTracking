-- Money (card $1, ADR-27): bank accounts, their transactions, categories, splits of one
-- transaction across categories, and rules that set a category automatically. Built so
-- Plaid (card $2) can fill it later; nothing here talks to Plaid. Adds tables only; nothing
-- here drops or rewrites anything, and it relies only on 0001.
--
-- Amounts are whole cents in BIGINT. Money out of an account (spending) is negative and money
-- in (pay, refunds) is positive. Plaid's own amounts are the other way round; the import
-- flips them (money/plaid.ts).

-- An account at the bank. plaid_account_id is Plaid's id for it; mask is the last digits Plaid
-- shows, never the full account number.
CREATE TABLE money_account (
  id               UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_money_account PRIMARY KEY CONSTRAINT df_money_account_id DEFAULT NEWSEQUENTIALID(),
  household_id     UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_money_account_household REFERENCES household (id),
  name             NVARCHAR(200)    NOT NULL CONSTRAINT ck_money_account_name CHECK (LEN(name) > 0),
  mask             NVARCHAR(10)     NULL,
  plaid_account_id NVARCHAR(100)    NULL,
  created_at       DATETIME2(3)     NOT NULL CONSTRAINT df_money_account_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_money_account_id_household UNIQUE (id, household_id)
);
CREATE UNIQUE INDEX uq_money_account_plaid ON money_account (household_id, plaid_account_id) WHERE plaid_account_id IS NOT NULL;

-- What money was spent on, such as Groceries. Names are unique per household, ignoring case.
CREATE TABLE money_category (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_money_category PRIMARY KEY CONSTRAINT df_money_category_id DEFAULT NEWSEQUENTIALID(),
  household_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_money_category_household REFERENCES household (id),
  name         NVARCHAR(100)    COLLATE Latin1_General_100_CI_AS NOT NULL CONSTRAINT ck_money_category_name CHECK (LEN(name) > 0),
  created_at   DATETIME2(3)     NOT NULL CONSTRAINT df_money_category_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_money_category_household_name UNIQUE (household_id, name),
  CONSTRAINT uq_money_category_id_household UNIQUE (id, household_id)
);

-- One transaction on an account. It has one category (category_id, with category_source
-- saying whether a rule or a person set it), or splits (money_split) and no category_id, or
-- neither (uncategorized). plaid_transaction_id is unique per household, so importing the same
-- Plaid transaction again updates it instead of adding a second one.
CREATE TABLE money_transaction (
  id                   UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_money_transaction PRIMARY KEY CONSTRAINT df_money_transaction_id DEFAULT NEWSEQUENTIALID(),
  household_id         UNIQUEIDENTIFIER NOT NULL,
  account_id           UNIQUEIDENTIFIER NOT NULL,
  posted_on            DATE             NOT NULL,
  amount_cents         BIGINT           NOT NULL,
  payee                NVARCHAR(200)    NOT NULL,
  description          NVARCHAR(500)    NOT NULL,
  plaid_transaction_id NVARCHAR(100)    NULL,
  category_id          UNIQUEIDENTIFIER NULL,
  category_source      VARCHAR(6)       NULL CONSTRAINT ck_money_transaction_category_source CHECK (category_source IN ('rule', 'manual')),
  created_at           DATETIME2(3)     NOT NULL CONSTRAINT df_money_transaction_created DEFAULT SYSUTCDATETIME(),
  updated_at           DATETIME2(3)     NOT NULL CONSTRAINT df_money_transaction_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT ck_money_transaction_category_has_source CHECK ((category_id IS NULL AND category_source IS NULL) OR (category_id IS NOT NULL AND category_source IS NOT NULL)),
  CONSTRAINT fk_money_transaction_household FOREIGN KEY (household_id) REFERENCES household (id),
  CONSTRAINT fk_money_transaction_account FOREIGN KEY (account_id, household_id) REFERENCES money_account (id, household_id),
  CONSTRAINT fk_money_transaction_category FOREIGN KEY (category_id, household_id) REFERENCES money_category (id, household_id),
  CONSTRAINT uq_money_transaction_id_household UNIQUE (id, household_id)
);
CREATE UNIQUE INDEX uq_money_transaction_plaid ON money_transaction (household_id, plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL;
CREATE INDEX ix_money_transaction_household_posted ON money_transaction (household_id, posted_on DESC);

-- One part of a split transaction. The parts of one transaction add up to its amount; the app
-- checks that before saving them (money/splits.ts), since a CHECK can't see the other rows.
CREATE TABLE money_split (
  id             UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_money_split PRIMARY KEY CONSTRAINT df_money_split_id DEFAULT NEWSEQUENTIALID(),
  transaction_id UNIQUEIDENTIFIER NOT NULL,
  household_id   UNIQUEIDENTIFIER NOT NULL,
  category_id    UNIQUEIDENTIFIER NOT NULL,
  position       INT              NOT NULL,
  amount_cents   BIGINT           NOT NULL CONSTRAINT ck_money_split_amount CHECK (amount_cents <> 0),
  CONSTRAINT fk_money_split_transaction FOREIGN KEY (transaction_id, household_id) REFERENCES money_transaction (id, household_id) ON DELETE CASCADE,
  CONSTRAINT fk_money_split_category FOREIGN KEY (category_id, household_id) REFERENCES money_category (id, household_id),
  CONSTRAINT uq_money_split_transaction_category UNIQUE (transaction_id, category_id)
);

-- A rule sets a transaction's category when its pattern matches the payee or the description
-- (whole text, or anywhere in it; ignoring case). Rules run in position order and the first
-- match wins. They never change a category set by hand or a split transaction.
CREATE TABLE money_rule (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_money_rule PRIMARY KEY CONSTRAINT df_money_rule_id DEFAULT NEWSEQUENTIALID(),
  household_id UNIQUEIDENTIFIER NOT NULL,
  position     INT              NOT NULL,
  field        VARCHAR(11)      NOT NULL CONSTRAINT ck_money_rule_field CHECK (field IN ('payee', 'description')),
  match_type   VARCHAR(8)       NOT NULL CONSTRAINT ck_money_rule_match CHECK (match_type IN ('equals', 'contains')),
  pattern      NVARCHAR(200)    NOT NULL CONSTRAINT ck_money_rule_pattern CHECK (LEN(pattern) > 0),
  category_id  UNIQUEIDENTIFIER NOT NULL,
  created_at   DATETIME2(3)     NOT NULL CONSTRAINT df_money_rule_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_money_rule_household FOREIGN KEY (household_id) REFERENCES household (id),
  CONSTRAINT fk_money_rule_category FOREIGN KEY (category_id, household_id) REFERENCES money_category (id, household_id),
  CONSTRAINT uq_money_rule_household_position UNIQUE (household_id, position)
);
