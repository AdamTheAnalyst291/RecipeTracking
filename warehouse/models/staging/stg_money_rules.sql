select
    id as rule_id,
    household_id,
    position,
    field as match_field,
    match_type,
    pattern,
    category_id,
    created_at
from {{ source('app', 'money_rule') }}
