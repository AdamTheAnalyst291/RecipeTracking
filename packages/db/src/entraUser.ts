import mssql from "mssql";

/** An Entra identity (an app registration or a managed identity) that signs in to the database. */
export interface EntraIdentity {
  /** Database user name; letters, digits, `_` and `-` only, so it's safe inside brackets. */
  name: string;
  /** The identity's application (client) ID, which is an Entra service principal's SID. */
  clientId: string;
}

const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless `name` can go inside brackets safely. `what` names the user in the message. */
export function checkUserName(name: string, what: string): void {
  if (!NAME.test(name)) throw new Error(`${what} name must be letters, digits, _ and - only: ${name}`);
}

/**
 * Creates the database user for an Entra identity from its client ID, unless a user of that
 * name exists already. Run as the database's Entra admin. Creating by SID needs no Microsoft
 * Graph lookup, so the SQL server needs no directory permissions.
 */
export async function createEntraUserIfMissing(pool: mssql.ConnectionPool, identity: EntraIdentity, what: string): Promise<void> {
  checkUserName(identity.name, what);
  if (!GUID.test(identity.clientId)) throw new Error(`${what} client ID must be a GUID: ${identity.clientId}`);
  await pool
    .request()
    .input("name", identity.name)
    .input("clientId", identity.clientId)
    .query(`
      IF DATABASE_PRINCIPAL_ID(@name) IS NULL
      BEGIN
        DECLARE @sid NVARCHAR(40) = CONVERT(NVARCHAR(40), CONVERT(VARBINARY(16), CAST(@clientId AS UNIQUEIDENTIFIER)), 1);
        DECLARE @create NVARCHAR(400) = N'CREATE USER ' + QUOTENAME(@name) + N' WITH SID = ' + @sid + N', TYPE = E';
        EXEC (@create);
      END`);
}
