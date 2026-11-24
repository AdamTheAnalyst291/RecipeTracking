-- Import links for products (card K5, ADR-25): the Grocy import remembers which product each
-- Grocy product became, in the same import_source table the Mealie import uses. That needs
-- 'product' as a kind. The check is replaced by a wider one; no row is touched, nothing is
-- dropped or rewritten.

ALTER TABLE import_source DROP CONSTRAINT ck_import_source_kind;
ALTER TABLE import_source ADD CONSTRAINT ck_import_source_kind CHECK (kind IN ('recipe', 'food', 'planned_meal', 'product'));
