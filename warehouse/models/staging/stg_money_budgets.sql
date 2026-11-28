-- amount_cents is empty when a month's budget was cleared.
select
    id as budget_id,
    household_id,
    category_id,
    starts_on as budget_month,
    amount_cents,
    {{ cents_to_dollars('amount_cents') }} as amount,
    updated_at
from {{ source('app', 'money_budget') }}
