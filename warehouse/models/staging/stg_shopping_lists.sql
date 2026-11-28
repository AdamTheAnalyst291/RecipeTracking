select
    id as shopping_list_id,
    household_id,
    start_date,
    end_date,
    created_at
from {{ source('app', 'shopping_list') }}
