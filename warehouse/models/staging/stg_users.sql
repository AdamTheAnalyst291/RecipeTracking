-- The Entra object ID is left out: the marts count people, they don't sign anyone in.
select
    id as user_id,
    household_id,
    display_name,
    created_at
from {{ source('app', 'user') }}
