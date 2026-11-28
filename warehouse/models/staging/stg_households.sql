select
    id as household_id,
    name as household_name,
    created_at
from {{ source('app', 'household') }}
