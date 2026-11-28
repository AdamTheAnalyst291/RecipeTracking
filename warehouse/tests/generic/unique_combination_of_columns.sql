{#
  Fails for each combination of the given columns that appears more than once: the
  uniqueness check for tables whose key is more than one column.
#}
{% test unique_combination_of_columns(model, combination_of_columns) %}
select {{ combination_of_columns | join(', ') }}, count(*) as n
from {{ model }}
group by {{ combination_of_columns | join(', ') }}
having count(*) > 1
{% endtest %}
