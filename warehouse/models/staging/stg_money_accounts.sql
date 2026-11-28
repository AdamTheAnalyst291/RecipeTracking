-- Plaid's account ID is left out: it only matters to the bank sync.
select
    id as account_id,
    household_id,
    name as account_name,
    mask as account_mask,
    created_at
from {{ source('app', 'money_account') }}
