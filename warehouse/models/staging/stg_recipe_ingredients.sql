select
    id as recipe_ingredient_id,
    recipe_id,
    household_id,
    position,
    food_id,
    quantity,
    unit_id,
    note
from {{ source('app', 'recipe_ingredient') }}
