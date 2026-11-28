select
    id as split_id,
    transaction_id,
    household_id,
    category_id,
    position,
    amount_cents,
    {{ cents_to_dollars('amount_cents') }} as amount
from {{ source('app', 'money_split') }}
