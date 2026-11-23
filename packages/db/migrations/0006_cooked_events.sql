-- Cooked events (card K8, ADR-25, ADR-28): one row each time someone presses "I made this"
-- on a recipe. The cooked count feeds the warehouse's recipe-cost mart and the content
-- export. Adds a table only; nothing here drops or rewrites anything, and it does not
-- depend on any later migration.

-- The recipe name is copied in so history survives a recipe being renamed or deleted;
-- recipe_id is cleared if the recipe is deleted. The household is always taken from the
-- recipe row when an event is written (see packages/db/src/cooking.ts).
CREATE TABLE cooked_event (
  id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_cooked_event PRIMARY KEY CONSTRAINT df_cooked_event_id DEFAULT NEWSEQUENTIALID(),
  household_id  UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_cooked_event_household REFERENCES household (id),
  recipe_id     UNIQUEIDENTIFIER NULL CONSTRAINT fk_cooked_event_recipe REFERENCES recipe (id) ON DELETE SET NULL,
  recipe_name   NVARCHAR(200)    NOT NULL,
  servings_made DECIMAL(9, 2)    NOT NULL CONSTRAINT ck_cooked_event_servings CHECK (servings_made > 0),
  cooked_at     DATETIME2(0)     NOT NULL CONSTRAINT df_cooked_event_cooked DEFAULT SYSUTCDATETIME()
);
CREATE INDEX ix_cooked_event_household_time ON cooked_event (household_id, cooked_at);
CREATE INDEX ix_cooked_event_recipe ON cooked_event (recipe_id);
