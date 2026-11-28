-- A small, made-up household with a little of every source table, for the fixture build
-- (warehouse/scripts/fixture-build.sh). Runs as the test server admin after the migrations,
-- which also seed the units and their conversions. No real data.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @home UNIQUEIDENTIFIER = '00000000-0000-0000-0000-0000000000a1';
DECLARE @g UNIQUEIDENTIFIER = (SELECT id FROM unit WHERE abbreviation = 'g');
DECLARE @ml UNIQUEIDENTIFIER = (SELECT id FROM unit WHERE abbreviation = 'ml');
DECLARE @ea UNIQUEIDENTIFIER = (SELECT id FROM unit WHERE abbreviation = 'ea');

INSERT household (id, name) VALUES (@home, N'Fixture Home');
INSERT [user] (id, household_id, entra_object_id, display_name)
VALUES ('00000000-0000-0000-0000-0000000000b1', @home, '00000000-0000-0000-0000-0000000000b2', N'Sam Fixture');

INSERT food (id, household_id, name, default_unit_id) VALUES
  ('00000000-0000-0000-0000-0000000000f1', @home, N'Rice', @g),
  ('00000000-0000-0000-0000-0000000000f2', @home, N'Milk', @ml),
  ('00000000-0000-0000-0000-0000000000f3', @home, N'Egg', @ea),
  ('00000000-0000-0000-0000-0000000000f4', @home, N'Basil', NULL);

INSERT product (id, household_id, food_id, name, unit_id, stock_quantity, is_staple, package_quantity, price_cents, price_date) VALUES
  ('00000000-0000-0000-0000-0000000000c1', @home, '00000000-0000-0000-0000-0000000000f1', N'Jasmine rice 2 kg', @g, 1500, 1, 2000, 549, '2026-11-01'),
  ('00000000-0000-0000-0000-0000000000c2', @home, '00000000-0000-0000-0000-0000000000f2', N'Whole milk 1 l', @ml, 0, 1, 1000, 299, '2026-11-20'),
  ('00000000-0000-0000-0000-0000000000c3', @home, '00000000-0000-0000-0000-0000000000f3', N'Eggs, dozen', @ea, 6, 0, NULL, NULL, NULL);

INSERT pantry_snapshot (product_id, snapshot_date, stock_quantity, unit_id, package_quantity, price_cents, price_date) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '2026-11-25', 1800, @g, 2000, 549, '2026-11-01'),
  ('00000000-0000-0000-0000-0000000000c1', '2026-11-26', 1500, @g, 2000, 549, '2026-11-01'),
  ('00000000-0000-0000-0000-0000000000c2', '2026-11-26', 0, @ml, 1000, 299, '2026-11-20'),
  ('00000000-0000-0000-0000-0000000000c3', '2026-11-26', 6, @ea, NULL, NULL, NULL);

INSERT recipe (id, household_id, name, servings, total_minutes, source_url, source_credit) VALUES
  ('00000000-0000-0000-0000-0000000000d1', @home, N'Pad kra pao กะเพรา', 2, 25, N'https://example.com/pad-kra-pao', N'Example Kitchen'),
  ('00000000-0000-0000-0000-0000000000d2', @home, N'Crème brûlée', 4, NULL, NULL, NULL);
INSERT recipe_tag (recipe_id, tag) VALUES
  ('00000000-0000-0000-0000-0000000000d1', N'Thai'),
  ('00000000-0000-0000-0000-0000000000d1', N'weeknight'),
  ('00000000-0000-0000-0000-0000000000d2', N'dessert');
INSERT recipe_ingredient (recipe_id, household_id, position, food_id, quantity, unit_id, note) VALUES
  ('00000000-0000-0000-0000-0000000000d1', @home, 1, '00000000-0000-0000-0000-0000000000f1', 300, @g, NULL),
  ('00000000-0000-0000-0000-0000000000d1', @home, 2, '00000000-0000-0000-0000-0000000000f3', 2, @ea, N'fried'),
  ('00000000-0000-0000-0000-0000000000d1', @home, 3, '00000000-0000-0000-0000-0000000000f4', NULL, NULL, N'a handful'),
  ('00000000-0000-0000-0000-0000000000d2', @home, 1, '00000000-0000-0000-0000-0000000000f2', 500, @ml, NULL),
  ('00000000-0000-0000-0000-0000000000d2', @home, 2, '00000000-0000-0000-0000-0000000000f3', 5, @ea, N'yolks only');
INSERT recipe_step (recipe_id, position, instruction) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 1, N'Cook the rice.'),
  ('00000000-0000-0000-0000-0000000000d1', 2, N'Stir-fry, then top with a fried egg.'),
  ('00000000-0000-0000-0000-0000000000d2', 1, N'Bake in a water bath, chill, torch the sugar.');

INSERT planned_meal (household_id, plan_date, meal_slot, recipe_id, servings) VALUES
  (@home, '2026-11-30', 'dinner', '00000000-0000-0000-0000-0000000000d1', 2),
  (@home, '2026-12-01', 'snack', '00000000-0000-0000-0000-0000000000d2', 4);

-- The second cook's recipe was deleted afterwards, so its recipe_id is empty.
INSERT cooked_event (household_id, recipe_id, recipe_name, servings_made, cooked_at) VALUES
  (@home, '00000000-0000-0000-0000-0000000000d1', N'Pad kra pao กะเพรา', 2, '2026-11-24T19:30:00'),
  (@home, NULL, N'Old soup', 1.5, '2026-11-20T12:00:00');

INSERT shopping_list (id, household_id, start_date, end_date)
VALUES ('00000000-0000-0000-0000-0000000000e1', @home, '2026-11-30', '2026-12-06');
INSERT shopping_list_item (list_id, household_id, food_id, name, quantity, unit_id, source, checked) VALUES
  ('00000000-0000-0000-0000-0000000000e1', @home, '00000000-0000-0000-0000-0000000000f2', N'Milk', 500, @ml, 'plan', 0),
  ('00000000-0000-0000-0000-0000000000e1', @home, NULL, N'Paper towels', NULL, NULL, 'manual', 1);

INSERT money_account (id, household_id, name, mask)
VALUES ('00000000-0000-0000-0000-000000000101', @home, N'Checking', N'0000');
INSERT money_category (id, household_id, name, kind) VALUES
  ('00000000-0000-0000-0000-000000000201', @home, N'Groceries', 'spending'),
  ('00000000-0000-0000-0000-000000000202', @home, N'Household', 'spending'),
  ('00000000-0000-0000-0000-000000000203', @home, N'Transfers', 'not-spending');
INSERT money_rule (household_id, position, field, match_type, pattern, category_id)
VALUES (@home, 1, 'payee', 'contains', N'Grocer', '00000000-0000-0000-0000-000000000201');

-- One categorized by a rule, one by hand, one split across two categories, one uncategorized.
INSERT money_transaction (id, household_id, account_id, posted_on, amount_cents, payee, description, plaid_transaction_id, category_id, category_source) VALUES
  ('00000000-0000-0000-0000-000000000301', @home, '00000000-0000-0000-0000-000000000101', '2026-11-22', -4512, N'Fixture Grocer', N'GROCER #12', N'fixture-txn-1', '00000000-0000-0000-0000-000000000201', 'rule'),
  ('00000000-0000-0000-0000-000000000302', @home, '00000000-0000-0000-0000-000000000101', '2026-11-23', -10000, N'Savings', N'TRANSFER OUT', N'fixture-txn-2', '00000000-0000-0000-0000-000000000203', 'manual'),
  ('00000000-0000-0000-0000-000000000303', @home, '00000000-0000-0000-0000-000000000101', '2026-11-24', -6000, N'Big Box', N'BIG BOX 77', NULL, NULL, NULL),
  ('00000000-0000-0000-0000-000000000304', @home, '00000000-0000-0000-0000-000000000101', '2026-11-25', 250000, N'Employer', N'PAYROLL', NULL, NULL, NULL);
INSERT money_split (transaction_id, household_id, category_id, position, amount_cents) VALUES
  ('00000000-0000-0000-0000-000000000303', @home, '00000000-0000-0000-0000-000000000201', 1, -3500),
  ('00000000-0000-0000-0000-000000000303', @home, '00000000-0000-0000-0000-000000000202', 2, -2500);

INSERT money_budget (household_id, category_id, starts_on, amount_cents) VALUES
  (@home, '00000000-0000-0000-0000-000000000201', '2026-11-01', 60000),
  (@home, '00000000-0000-0000-0000-000000000202', '2026-11-01', NULL);
