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
    {{ cents_to_dollars('price_cents') }} as price,
    price_date,
    created_at
from {{ source('app', 'product') }}
