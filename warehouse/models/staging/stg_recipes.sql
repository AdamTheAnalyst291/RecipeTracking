select
    id as recipe_id,
    household_id,
    name as recipe_name,
    servings,
    total_minutes,
    source_url,
    source_credit,
    created_at,
    updated_at
from {{ source('app', 'recipe') }}
