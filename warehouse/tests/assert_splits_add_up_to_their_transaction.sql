-- A split transaction's parts always add up to the transaction (card $1). Fails for each
-- transaction whose splits don't.
select t.transaction_id, t.amount_cents, sum(s.amount_cents) as split_total_cents
from {{ ref('stg_money_transactions') }} t
join {{ ref('stg_money_splits') }} s on s.transaction_id = t.transaction_id
group by t.transaction_id, t.amount_cents
having sum(s.amount_cents) <> t.amount_cents
