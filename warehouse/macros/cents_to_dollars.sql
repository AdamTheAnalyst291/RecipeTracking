{# Whole cents (the app stores money as INT or BIGINT cents) as dollars and cents. #}
{% macro cents_to_dollars(column) -%}
  cast({{ column }} / 100.0 as decimal(19, 2))
{%- endmacro %}
