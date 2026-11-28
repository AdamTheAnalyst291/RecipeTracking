select
    id as planned_meal_id,
    household_id,
    plan_date,
    meal_slot,
    recipe_id,
    servings,
    created_at
from {{ source('app', 'planned_meal') }}
