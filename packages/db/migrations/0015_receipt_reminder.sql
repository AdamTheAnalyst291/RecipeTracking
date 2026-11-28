-- Weekly receipt reminder (card P5, ADR-25): which weeks each household has already been
-- reminded about, so no week gets a second push. Adds a table only; nothing here drops or
-- rewrites anything.

CREATE TABLE receipt_reminder (
  household_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_receipt_reminder_household REFERENCES household (id),
  week_start   DATE             NOT NULL, -- the Monday of the week
  sent_at      DATETIME2(3)     NOT NULL CONSTRAINT df_receipt_reminder_sent DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_receipt_reminder PRIMARY KEY (household_id, week_start)
);
