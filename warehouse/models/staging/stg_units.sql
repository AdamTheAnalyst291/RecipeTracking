select
    id as unit_id,
    name as unit_name,
    abbreviation as unit_abbreviation,
    kind as unit_kind
from {{ source('app', 'unit') }}
