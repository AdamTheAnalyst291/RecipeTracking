select
    recipe_id,
    lower(tag) as tag
from {{ source('app', 'recipe_tag') }}
