import { randomUUID } from "node:crypto";
import sql from "mssql";

/**
 * Tests run against a real SQL Server (a container locally and in CI), set through
 * KITCHEN_TEST_SQL, for example:
 *   Server=localhost,14330;User Id=sa;Password=...;TrustServerCertificate=true
 * Each test file gets its own empty database, dropped afterwards.
 */
export const testServer = process.env.KITCHEN_TEST_SQL;

// Locally the database tests skip without a server. In CI a missing server must fail,
// or the suite would pass green without proving anything. The one exception is the Deploy
// Dev workflow, which rebuilds what the pull-request workflow already tested (against a
// SQL Server it has no service for) and so lets those tests skip. Anywhere else, including
// a renamed or new workflow, the guard stays on.
const skipsInCi = process.env.GITHUB_WORKFLOW === "Deploy Dev";
if (!testServer && process.env.CI && !skipsInCi) {
  throw new Error("KITCHEN_TEST_SQL is not set in CI, so the database tests would silently skip");
}

export async function createEmptyDatabase(): Promise<{
  pool: sql.ConnectionPool;
  drop: () => Promise<void>;
}> {
  if (!testServer) throw new Error("Set KITCHEN_TEST_SQL to a SQL Server connection string");
  const name = `kitchen_test_${randomUUID().replaceAll("-", "")}`;
  const admin = await new sql.ConnectionPool(testServer).connect();
  await admin.request().batch(`CREATE DATABASE [${name}]`);
  const pool = await new sql.ConnectionPool(`${testServer};Database=${name};Request Timeout=0`).connect();
  return {
    pool,
    drop: async () => {
      await pool.close();
      await admin.request().batch(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
      await admin.request().batch(`DROP DATABASE [${name}]`);
      await admin.close();
    },
  };
}
