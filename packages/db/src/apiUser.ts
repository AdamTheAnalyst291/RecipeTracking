import type mssql from "mssql";
import { checkUserName, createEntraUserIfMissing, type EntraIdentity } from "./entraUser.js";

const WHAT = "API user";

/**
 * Gives an existing database user what the API needs: read and write every table's rows
 * (`db_datareader`, `db_datawriter`), and nothing more. It can't change the schema; the
 * migrations run as the server's Entra admin instead. Safe to run again.
 */
export async function grantApiUser(pool: mssql.ConnectionPool, name: string): Promise<void> {
  checkUserName(name, WHAT);
  await pool.request().batch(`ALTER ROLE db_datareader ADD MEMBER [${name}]; ALTER ROLE db_datawriter ADD MEMBER [${name}];`);
}

/**
 * Makes the API's managed identity (the Functions app, such as func-kitchen-dev-abc123) a
 * database user that can read and write the data, creating it from the identity's client ID
 * if it isn't there yet. Run by the deploy workflows after the migrations, as the database's
 * Entra admin. Without it the API can't sign in to the database at all.
 */
export async function ensureApiUser(pool: mssql.ConnectionPool, identity: EntraIdentity): Promise<void> {
  await createEntraUserIfMissing(pool, identity, WHAT);
  await grantApiUser(pool, identity.name);
}
