-- The standard units and the conversions between them: reference data every household
-- shares. Imperial volumes are US measures. Food-specific conversions (a cup of flour
-- in grams) belong to the food and come with the cards that need them.

INSERT unit (name, abbreviation, kind) VALUES
  ('gram', 'g', 'mass'), ('kilogram', 'kg', 'mass'), ('ounce', 'oz', 'mass'), ('pound', 'lb', 'mass'),
  ('millilitre', 'ml', 'volume'), ('litre', 'l', 'volume'), ('teaspoon', 'tsp', 'volume'),
  ('tablespoon', 'tbsp', 'volume'), ('fluid ounce', 'fl oz', 'volume'), ('cup', 'cup', 'volume'),
  ('each', 'ea', 'count');

-- Each unit's size in its kind's base unit: grams for mass, millilitres for volume.
DECLARE @to_base TABLE (abbreviation NVARCHAR(20), factor DECIMAL(18, 8));
INSERT @to_base VALUES
  ('g', 1), ('kg', 1000), ('oz', 28.34952313), ('lb', 453.59237),
  ('ml', 1), ('l', 1000), ('tsp', 4.92892159), ('tbsp', 14.78676478),
  ('fl oz', 29.57352956), ('cup', 236.58823650);

-- Every ordered pair of distinct units of one kind: 1 a = (a / b) b.
INSERT unit_conversion (from_unit_id, to_unit_id, kind, factor)
SELECT a.id, b.id, a.kind, CAST(fa.factor / fb.factor AS DECIMAL(18, 8))
FROM unit a
JOIN @to_base fa ON fa.abbreviation = a.abbreviation
JOIN unit b ON b.kind = a.kind AND b.id <> a.id
JOIN @to_base fb ON fb.abbreviation = b.abbreviation;
