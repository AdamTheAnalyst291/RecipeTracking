{#
  Every model builds in the target schema (marts), whatever custom schema it names. The
  warehouse identity owns marts and nothing else, so dbt's usual marts_<custom> schemas
  would fail anyway (packages/db/sql/warehouse-builder.sql).
#}
{% macro generate_schema_name(custom_schema_name, node) -%}
  {{ target.schema }}
{%- endmacro %}
