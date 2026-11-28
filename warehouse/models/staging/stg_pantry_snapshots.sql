select
    s.product_id,
    p.household_id,
    s.snapshot_date,
    s.stock_quantity,
    s.unit_id,
    s.package_quantity,
    s.price_cents,
    cast(s.price_cents / 100.0 as decimal(19, 2)) as price,
    s.price_date,
    s.taken_at
from {{ source('app', 'pantry_snapshot') }} s
join {{ source('app', 'product') }} p on p.id = s.product_id
