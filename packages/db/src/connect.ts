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
export async function connectEntra({ server, database }: ConnectOptions): Promise<mssql.ConnectionPool> {
  // The free-tier database auto-pauses, and the first connection wakes it: Azure answers
  // error 40613 until it's up (about a minute), so retry for a while.
  for (let attempt = 1; ; attempt++) {
    try {
      return await new mssql.ConnectionPool({
        server,
        database,
        options: { encrypt: true },
        connectionTimeout: 60_000,
        // A migration may run long, and a second runner may wait on the lock for minutes.
        requestTimeout: 0,
        authentication: { type: "azure-active-directory-default", options: {} },
      }).connect();
    } catch (e) {
      const unavailable = /40613|not currently available/i.test(e instanceof Error ? e.message : "");
      if (!unavailable || attempt >= 8) throw e;
      console.log(`Database is waking up (attempt ${attempt}); retrying`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}
