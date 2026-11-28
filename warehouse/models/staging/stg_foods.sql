select
    id as food_id,
    household_id,
    name as food_name,
    default_unit_id,
    created_at
from {{ source('app', 'food') }}
