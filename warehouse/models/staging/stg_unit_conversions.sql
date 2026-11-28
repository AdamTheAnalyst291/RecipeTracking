select
    from_unit_id,
    to_unit_id,
    kind as unit_kind,
    factor
from {{ source('app', 'unit_conversion') }}
