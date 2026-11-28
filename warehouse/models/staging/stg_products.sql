-- The latest price is for one package of package_quantity units.
select
    id as product_id,
    household_id,
    food_id,
    name as product_name,
    unit_id,
    stock_quantity,
    is_staple,
    package_quantity,
    price_cents,
    cast(price_cents / 100.0 as decimal(19, 2)) as price,
    price_date,
    created_at
from {{ source('app', 'product') }}
