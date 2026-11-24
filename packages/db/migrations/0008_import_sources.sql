-- Import links (card K3, ADR-25): remembers which row in the kitchen app each item imported
-- from another system became, so running the import again updates or skips instead of
-- duplicating. kind says which table local_id points into (recipe, food or planned_meal);
-- there is no foreign key because it can point into any of them, and the importer checks the
-- row still exists. fingerprint is a hash of what was imported, so an unchanged item is
-- skipped and a user's later edits to it are left alone. Adds a table only; nothing here
-- drops or rewrites anything.

CREATE TABLE import_source (
  household_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_import_source_household REFERENCES household (id),
  source       VARCHAR(20)      NOT NULL CONSTRAINT ck_import_source_source CHECK (LEN(source) > 0),
  kind         VARCHAR(20)      NOT NULL CONSTRAINT ck_import_source_kind CHECK (kind IN ('recipe', 'food', 'planned_meal')),
  external_id  NVARCHAR(200)    NOT NULL,
  local_id     UNIQUEIDENTIFIER NOT NULL,
  fingerprint  CHAR(64)         NULL,
  imported_at  DATETIME2(0)     NOT NULL CONSTRAINT df_import_source_imported DEFAULT SYSUTCDATETIME(),
  CONSTRAINT pk_import_source PRIMARY KEY (household_id, source, kind, external_id)
);
