import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type mssql from "mssql";
import { checkUserName, createEntraUserIfMissing, type EntraIdentity } from "./entraUser.js";

/** The grants, shared with warehouse/scripts/fixture-build.sh. */
const warehouseBuilderGrantsFile = fileURLToPath(new URL("../sql/warehouse-builder.sql", import.meta.url));

/** The identity that runs the nightly dbt build (card W1), such as kitchen-github-dev-warehouse. */
export type WarehouseBuilder = EntraIdentity;

const WHAT = "Warehouse builder";

/**
 * Gives an existing database user what dbt needs (ADR-28): read every table in dbo, and own
 * the marts schema, creating it if it isn't there. It can't write to dbo or create anything
 * outside marts. Safe to run again.
 */
export async function grantWarehouseBuilder(pool: mssql.ConnectionPool, name: string): Promise<void> {
  checkUserName(name, WHAT);
  const grants = readFileSync(warehouseBuilderGrantsFile, "utf8").replaceAll("$(WAREHOUSE_BUILDER)", name);
  await pool.request().batch(grants);
}

/**
 * Makes the warehouse identity a database user that reads the app's tables and builds marts,
 * creating it from its client ID if it isn't there yet. Run as the database's Entra admin
 * (the Deploy Dev workflow, after the migrations). Safe to run on every deploy.
 */
export async function ensureWarehouseBuilder(pool: mssql.ConnectionPool, builder: WarehouseBuilder): Promise<void> {
  await createEntraUserIfMissing(pool, builder, WHAT);
  await grantWarehouseBuilder(pool, builder.name);
}
