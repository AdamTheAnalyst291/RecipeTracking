select
    id as category_id,
    household_id,
    name as category_name,
    kind as category_kind,
    created_at
from {{ source('app', 'money_category') }}
