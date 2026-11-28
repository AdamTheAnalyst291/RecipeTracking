select
    recipe_id,
    position,
    instruction
from {{ source('app', 'recipe_step') }}
