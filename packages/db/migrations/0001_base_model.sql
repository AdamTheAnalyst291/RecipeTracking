-- The base model every kitchen feature builds on (ADR-25): households, the people in
-- them, one table of foods shared by recipes, pantry and shopping, and units with
-- conversions. Tables only; nothing here drops or rewrites anything.

CREATE TABLE household (
  id         UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_household PRIMARY KEY CONSTRAINT df_household_id DEFAULT NEWSEQUENTIALID(),
  name       NVARCHAR(200)    NOT NULL,
  created_at DATETIME2(0)     NOT NULL CONSTRAINT df_household_created DEFAULT SYSUTCDATETIME()
);

-- A signed-in person. entra_object_id is the "oid" claim of their Microsoft Entra token.
CREATE TABLE [user] (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_user PRIMARY KEY CONSTRAINT df_user_id DEFAULT NEWSEQUENTIALID(),
  household_id    UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_user_household REFERENCES household (id),
  entra_object_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT uq_user_entra_object_id UNIQUE,
  display_name    NVARCHAR(200)    NULL,
  created_at      DATETIME2(0)     NOT NULL CONSTRAINT df_user_created DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_user_household ON [user] (household_id);

-- Units are shared by every household. "kind" keeps conversions sensible: grams
-- convert to ounces, never to millilitres.
CREATE TABLE unit (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_unit PRIMARY KEY CONSTRAINT df_unit_id DEFAULT NEWSEQUENTIALID(),
  name         NVARCHAR(50)     NOT NULL CONSTRAINT uq_unit_name UNIQUE,
  abbreviation NVARCHAR(20)     NOT NULL CONSTRAINT uq_unit_abbreviation UNIQUE,
  kind         VARCHAR(10)      NOT NULL CONSTRAINT ck_unit_kind CHECK (kind IN ('mass', 'volume', 'count')),
  CONSTRAINT uq_unit_id_kind UNIQUE (id, kind)
);

-- "1 from_unit = factor to_unit". Both ends must be the same kind (enforced by the
-- composite foreign keys). Both directions are stored, so a lookup never has to invert.
CREATE TABLE unit_conversion (
  from_unit_id UNIQUEIDENTIFIER NOT NULL,
  to_unit_id   UNIQUEIDENTIFIER NOT NULL,
  kind         VARCHAR(10)      NOT NULL,
  factor       DECIMAL(18, 8)   NOT NULL CONSTRAINT ck_unit_conversion_factor CHECK (factor > 0),
  CONSTRAINT pk_unit_conversion PRIMARY KEY (from_unit_id, to_unit_id),
  CONSTRAINT ck_unit_conversion_distinct CHECK (from_unit_id <> to_unit_id),
  CONSTRAINT fk_unit_conversion_from FOREIGN KEY (from_unit_id, kind) REFERENCES unit (id, kind),
  CONSTRAINT fk_unit_conversion_to FOREIGN KEY (to_unit_id, kind) REFERENCES unit (id, kind)
);

-- One food table for recipes, pantry and shopping lists. Names are unique per
-- household, ignoring case.
CREATE TABLE food (
  id              UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_food PRIMARY KEY CONSTRAINT df_food_id DEFAULT NEWSEQUENTIALID(),
  household_id    UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_food_household REFERENCES household (id),
  name            NVARCHAR(200)    COLLATE Latin1_General_100_CI_AS NOT NULL,
  default_unit_id UNIQUEIDENTIFIER NULL CONSTRAINT fk_food_default_unit REFERENCES unit (id),
  created_at      DATETIME2(0)     NOT NULL CONSTRAINT df_food_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_food_household_name UNIQUE (household_id, name)
);
