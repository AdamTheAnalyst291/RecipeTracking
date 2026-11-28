select
    id as shopping_list_item_id,
    list_id as shopping_list_id,
    household_id,
    food_id,
    name as item_name,
    quantity,
    unit_id,
    source as item_source,
    checked as is_checked,
    created_at
from {{ source('app', 'shopping_list_item') }}
