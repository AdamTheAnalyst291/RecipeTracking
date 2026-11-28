-- recipe_id is empty when the recipe was deleted later; recipe_name keeps what it was called.
select
    id as cooked_event_id,
    household_id,
    recipe_id,
    recipe_name,
    servings_made,
    cooked_at,
    cast(cooked_at as date) as cooked_on
from {{ source('app', 'cooked_event') }}
