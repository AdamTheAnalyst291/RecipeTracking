-- What the nightly dbt build (card W1, ADR-28) needs, and nothing more: read the app's
-- tables in dbo, and build tables and views in the marts schema only.
-- $(WAREHOUSE_BUILDER) is the database user's name (a sqlcmd variable). Safe to run again.
-- Used by ensureWarehouseBuilder (src/warehouseBuilder.ts) in the Deploy Dev workflow, and
-- by warehouse/scripts/fixture-build.sh, which proves dbt builds with these grants alone.
--
-- The builder owns marts. Owning the schema lets it create, rebuild, rename and drop what
-- dbt makes there, but CREATE TABLE and CREATE VIEW are database permissions, and creating
-- anywhere else also needs ALTER on that schema, which it doesn't have. Owning marts (rather
-- than dbo owning it) also breaks the ownership chain from its views to dbo's tables, so a
-- view in marts can never be used to write to the app's data.
IF SCHEMA_ID(N'marts') IS NULL
  EXEC (N'CREATE SCHEMA marts AUTHORIZATION [$(WAREHOUSE_BUILDER)]');
ELSE IF (SELECT principal_id FROM sys.schemas WHERE name = N'marts') <> DATABASE_PRINCIPAL_ID(N'$(WAREHOUSE_BUILDER)')
  ALTER AUTHORIZATION ON SCHEMA::marts TO [$(WAREHOUSE_BUILDER)];
GRANT SELECT ON SCHEMA::dbo TO [$(WAREHOUSE_BUILDER)];
-- Except what only sign-in and the bank sync need: who someone is in Entra, and the bank
-- connections (Key Vault secret names, sync cursors). No model reads them.
DENY SELECT ON OBJECT::dbo.plaid_item TO [$(WAREHOUSE_BUILDER)];
DENY SELECT ON OBJECT::dbo.plaid_item_account TO [$(WAREHOUSE_BUILDER)];
DENY SELECT ON OBJECT::dbo.plaid_withdrawn TO [$(WAREHOUSE_BUILDER)];
DENY SELECT ON OBJECT::dbo.[user] (entra_object_id) TO [$(WAREHOUSE_BUILDER)];
GRANT CREATE TABLE, CREATE VIEW TO [$(WAREHOUSE_BUILDER)];
