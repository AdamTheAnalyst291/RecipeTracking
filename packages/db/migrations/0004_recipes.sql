-- Recipes (card K1, ADR-25): a recipe with its tags, ingredients and ordered steps, all
-- scoped to a household. Ingredients point at the shared food and unit tables, and use the
-- (id, household_id) key on food that 0003 added, so a recipe can never use another
-- household's food. Adds tables only; nothing here drops or rewrites anything.

CREATE TABLE recipe (
  id            UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_recipe PRIMARY KEY CONSTRAINT df_recipe_id DEFAULT NEWSEQUENTIALID(),
  household_id  UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_recipe_household REFERENCES household (id),
  name          NVARCHAR(200)    NOT NULL CONSTRAINT ck_recipe_name CHECK (LEN(name) > 0),
  servings      INT              NULL CONSTRAINT ck_recipe_servings CHECK (servings >= 1),
  total_minutes INT              NULL CONSTRAINT ck_recipe_total_minutes CHECK (total_minutes >= 0),
  source_url    NVARCHAR(2000)   NULL,
  source_credit NVARCHAR(200)    NULL,
  created_at    DATETIME2(0)     NOT NULL CONSTRAINT df_recipe_created DEFAULT SYSUTCDATETIME(),
  updated_at    DATETIME2(0)     NOT NULL CONSTRAINT df_recipe_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT uq_recipe_id_household UNIQUE (id, household_id)
);
CREATE INDEX ix_recipe_household_name ON recipe (household_id, name);

-- Free-text labels ("quick", "vegetarian"); the same tag twice on a recipe is ignored case-wise.
CREATE TABLE recipe_tag (
  recipe_id UNIQUEIDENTIFIER                               NOT NULL CONSTRAINT fk_recipe_tag_recipe REFERENCES recipe (id) ON DELETE CASCADE,
  tag       NVARCHAR(50) COLLATE Latin1_General_100_CI_AS NOT NULL CONSTRAINT ck_recipe_tag CHECK (LEN(tag) > 0),
  CONSTRAINT pk_recipe_tag PRIMARY KEY (recipe_id, tag)
);

-- One line of the ingredient list: a food, an optional amount and unit, and a note
-- ("finely chopped"). Position keeps the order the recipe lists them in.
CREATE TABLE recipe_ingredient (
  id           UNIQUEIDENTIFIER NOT NULL CONSTRAINT pk_recipe_ingredient PRIMARY KEY CONSTRAINT df_recipe_ingredient_id DEFAULT NEWSEQUENTIALID(),
  recipe_id    UNIQUEIDENTIFIER NOT NULL,
  household_id UNIQUEIDENTIFIER NOT NULL,
  position     INT              NOT NULL CONSTRAINT ck_recipe_ingredient_position CHECK (position >= 1),
  food_id      UNIQUEIDENTIFIER NOT NULL,
  quantity     DECIMAL(12, 4)   NULL CONSTRAINT ck_recipe_ingredient_quantity CHECK (quantity > 0),
  unit_id      UNIQUEIDENTIFIER NULL CONSTRAINT fk_recipe_ingredient_unit REFERENCES unit (id),
  note         NVARCHAR(500)    NULL,
  CONSTRAINT uq_recipe_ingredient_position UNIQUE (recipe_id, position),
  CONSTRAINT fk_recipe_ingredient_recipe FOREIGN KEY (recipe_id, household_id) REFERENCES recipe (id, household_id) ON DELETE CASCADE,
  CONSTRAINT fk_recipe_ingredient_food FOREIGN KEY (food_id, household_id) REFERENCES food (id, household_id)
);

CREATE TABLE recipe_step (
  recipe_id   UNIQUEIDENTIFIER NOT NULL CONSTRAINT fk_recipe_step_recipe REFERENCES recipe (id) ON DELETE CASCADE,
  position    INT              NOT NULL CONSTRAINT ck_recipe_step_position CHECK (position >= 1),
  instruction NVARCHAR(4000)   NOT NULL CONSTRAINT ck_recipe_step_instruction CHECK (LEN(instruction) > 0),
  CONSTRAINT pk_recipe_step PRIMARY KEY (recipe_id, position)
);
