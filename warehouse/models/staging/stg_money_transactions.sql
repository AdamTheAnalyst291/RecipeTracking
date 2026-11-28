-- Negative amounts are money out. category_id is empty for uncategorized and split
-- transactions; a split transaction's categories are in stg_money_splits.
select
    id as transaction_id,
    household_id,
    account_id,
    posted_on,
    amount_cents,
    {{ cents_to_dollars('amount_cents') }} as amount,
    payee,
    description,
    plaid_transaction_id,
    category_id,
    category_source,
    created_at,
    updated_at
from {{ source('app', 'money_transaction') }}
