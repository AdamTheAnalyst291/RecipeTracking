-- Meal plan (card K6, ADR-25): the recipes a household plans to cook, each on a day and in a
-- meal slot, with how many servings. The recipe link uses the (id, household_id) key from
-- 0004, so a household can never plan another household's recipe, and deleting a recipe
-- takes it off the plan. Adds a table only; nothing here drops or rewrites anything.

CREATE TABLE planned_meal (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_planned_meal PRIMARY KEY CONSTRAINT df_planned_meal_id DEFAULT NEWSEQUENTIALID(),
  household_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_planned_meal_household REFERENCES household (id),
  plan_date    DATE             NOT NULL,
  meal_slot    VARCHAR(10)      NOT NULL CONSTRAINT ck_planned_meal_slot CHECK (meal_slot IN ('breakfast', 'lunch', 'dinner', 'snack')),
  recipe_id    UNIQUEIDENTIFIER NOT NULL,
  servings     INT              NOT NULL CONSTRAINT ck_planned_meal_servings CHECK (servings BETWEEN 1 AND 1000),
  created_at   DATETIME2(3)     NOT NULL CONSTRAINT df_planned_meal_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT fk_planned_meal_recipe FOREIGN KEY (recipe_id, household_id) REFERENCES recipe (id, household_id) ON DELETE CASCADE
);
CREATE INDEX ix_planned_meal_household_date ON planned_meal (household_id, plan_date);
