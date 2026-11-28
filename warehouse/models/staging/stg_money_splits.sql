select
    id as split_id,
    transaction_id,
    household_id,
    category_id,
    position,
    amount_cents,
    cast(amount_cents / 100.0 as decimal(19, 2)) as amount
from {{ source('app', 'money_split') }}
