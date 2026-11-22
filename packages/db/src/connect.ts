import mssql from "mssql";

export interface ConnectOptions {
  /** Full server name, like sql-kitchen-dev-abc123.database.windows.net. */
  server: string;
  database: string;
}

/**
 * Opens a pool to Azure SQL with Microsoft Entra sign-in and no password. Locally that
 * is `az login`; in GitHub Actions it is the OIDC session that azure/login sets up.
 */
export function connectEntra({ server, database }: ConnectOptions): Promise<mssql.ConnectionPool> {
  return new mssql.ConnectionPool({
    server,
    database,
    options: { encrypt: true },
    authentication: { type: "azure-active-directory-default", options: {} },
  }).connect();
}
