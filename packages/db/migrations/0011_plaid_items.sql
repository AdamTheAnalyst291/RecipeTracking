-- Bank connections through Plaid (card $2, ADR-27). Adds tables only; nothing here drops or
-- rewrites anything, and it relies only on 0001 and 0010.
--
-- The access token Plaid gives for a connection never lives here: it is a Key Vault secret,
-- and this table keeps only that secret's name.

-- One bank login connected through Plaid Link (Plaid calls it an item). cursor is where the
-- last successful /transactions/sync ended; it only moves after that sync's rows are saved.
-- The last_run_* columns are the result of the most recent daily sync, good or bad.
CREATE TABLE plaid_item (
  id                  UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_plaid_item PRIMARY KEY CONSTRAINT df_plaid_item_id DEFAULT NEWSEQUENTIALID(),
  household_id        UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_plaid_item_household REFERENCES household (id),
  plaid_item_id       NVARCHAR(100)    NOT NULL CONSTRAINT ck_plaid_item_plaid_id CHECK (LEN(plaid_item_id) > 0),
  institution         NVARCHAR(200)    NULL,
  access_token_secret NVARCHAR(127)    NOT NULL CONSTRAINT ck_plaid_item_secret CHECK (LEN(access_token_secret) > 0),
  sync_cursor         NVARCHAR(1000)   NULL,
  needs_reconnect     BIT              NOT NULL CONSTRAINT df_plaid_item_needs_reconnect DEFAULT 0,
  last_run_at         DATETIME2(3)     NULL,
  last_run_ok         BIT              NULL,
  last_run_added      INT              NULL,
  last_run_updated    INT              NULL,
  last_run_withdrawn  INT              NULL,
  last_run_message    NVARCHAR(1000)   NULL,
  last_error_code     NVARCHAR(100)    NULL,
  created_at          DATETIME2(3)     NOT NULL CONSTRAINT df_plaid_item_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_plaid_item_household_plaid UNIQUE (household_id, plaid_item_id),
  CONSTRAINT uq_plaid_item_id_household UNIQUE (id, household_id)
);

-- Which of the household's accounts (money_account) came from which connection. An account
-- belongs to one connection.
CREATE TABLE plaid_item_account (
  plaid_item_id UNIQUEIDENTIFIER NOT NULL,
  household_id  UNIQUEIDENTIFIER NOT NULL,
  account_id    UNIQUEIDENTIFIER NOT NULL,
  CONSTRAINT pk_plaid_item_account PRIMARY KEY (plaid_item_id, account_id),
  CONSTRAINT fk_plaid_item_account_item FOREIGN KEY (plaid_item_id, household_id) REFERENCES plaid_item (id, household_id),
  CONSTRAINT fk_plaid_item_account_account FOREIGN KEY (account_id, household_id) REFERENCES money_account (id, household_id),
  CONSTRAINT uq_plaid_item_account_account UNIQUE (account_id)
);

-- A transaction the bank withdrew after it was saved (Plaid's `removed`). The transaction is
-- kept, never deleted; this row is so a person can check it.
CREATE TABLE plaid_withdrawn (
  household_id         UNIQUEIDENTIFIER NOT NULL,
  plaid_transaction_id NVARCHAR(100)    NOT NULL,
  plaid_item_id        UNIQUEIDENTIFIER NOT NULL,
  withdrawn_at         DATETIME2(3)     NOT NULL CONSTRAINT df_plaid_withdrawn_at DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_plaid_withdrawn PRIMARY KEY (household_id, plaid_transaction_id),
  CONSTRAINT fk_plaid_withdrawn_item FOREIGN KEY (plaid_item_id, household_id) REFERENCES plaid_item (id, household_id)
);
