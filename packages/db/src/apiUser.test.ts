import { randomBytes, randomUUID } from "node:crypto";
import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureApiUser, grantApiUser } from "./apiUser.js";
import { createBanks } from "./banks.js";
import { createBudgets } from "./budgets.js";
import { resolveHousehold } from "./households.js";
import { runMigrations } from "./migrate.js";
import { createMoney } from "./money.js";
import { createEmptyDatabase, testServer } from "./test-database.js";

// The API signs in as its managed identity, which the migration step makes a database user
// (the Banks 503 of card $2: until then it had none). SQL Server in a container has no
// Entra ID, so a SQL login stands in for that identity, and the tests sign in as it to run
// the real stores with only the grants the API gets.
describe.skipIf(!testServer)("the API's database user", () => {
  let pool: sql.ConnectionPool;
  let drop: () => Promise<void>;
  let api: sql.ConnectionPool | undefined;
  const name = `func_kitchen_test_${randomUUID().slice(0, 8)}`;
  const password = `Aa1!${randomBytes(18).toString("hex")}`;
  let dropLogin: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    const admin = await new sql.ConnectionPool(testServer!).connect();
    await admin.request().batch(`CREATE LOGIN [${name}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF`);
    dropLogin = async () => {
      await admin.request().batch(`DROP LOGIN [${name}]`);
      await admin.close();
    };
    await pool.request().batch(`CREATE USER [${name}] FOR LOGIN [${name}]`);
  });
  afterAll(async () => {
    await api?.close();
    await drop();
    await dropLogin();
  });

  /** A pool signed in as the API's stand-in, to the test database. */
  async function signInAsApi(): Promise<sql.ConnectionPool> {
    const database = (await pool.request().query("SELECT DB_NAME() AS name")).recordset[0].name as string;
    const server = testServer!.replace(/;?\s*(User Id|Password)=[^;]*/gi, "");
    api ??= await new sql.ConnectionPool(`${server};User Id=${name};Password=${password};Database=${database}`).connect();
    return api;
  }

  const member = { objectId: "00000000-0000-0000-0000-0000000000a1", displayName: "Test member" };

  it("can't open the Banks screen before it's granted", async () => {
    const db = await signInAsApi();
    await expect(resolveHousehold(db, member)).rejects.toThrow(/permission was denied/i);
  });

  it("opens the Banks screen once granted: signs in a member and lists their banks", async () => {
    await grantApiUser(pool, name);
    const db = await signInAsApi();

    const householdId = await resolveHousehold(db, member);
    expect(await createBanks(db).list(householdId)).toEqual([]);
    expect(await createMoney(db).accounts(householdId)).toEqual([]);
    expect((await createBudgets(db).month(householdId, "2026-11")).lines).toEqual([]);
  });

  it("can connect a bank: writes plaid_item and its accounts", async () => {
    await grantApiUser(pool, name);
    const db = await signInAsApi();
    const householdId = await resolveHousehold(db, member);

    await createMoney(db).importPlaid(householdId, { accounts: [{ account_id: "acc-test-0001", name: "Everyday Checking", mask: "0000" }], transactions: [] });
    const bank = await createBanks(db).addItem(householdId, {
      plaidItemId: "item-test-0001",
      institution: "Test Bank",
      accessTokenSecret: "plaid-access-token-item-test-0001",
      plaidAccountIds: ["acc-test-0001"],
    });
    expect(bank.accounts.map((a) => a.name)).toEqual(["Everyday Checking"]);
  });

  it("can't change the schema or the migration history", async () => {
    await grantApiUser(pool, name);
    const db = await signInAsApi();
    await expect(db.request().batch("CREATE TABLE intruder (id INT)")).rejects.toThrow(/permission denied|CREATE TABLE permission/i);
    await expect(db.request().batch("DROP TABLE plaid_withdrawn")).rejects.toThrow(/permission|does not exist/i);
    const roles = await pool
      .request()
      .input("name", name)
      .query("SELECT IS_ROLEMEMBER('db_datareader', @name) AS reader, IS_ROLEMEMBER('db_datawriter', @name) AS writer, IS_ROLEMEMBER('db_owner', @name) AS owner, IS_ROLEMEMBER('db_ddladmin', @name) AS ddl");
    expect(roles.recordset[0]).toEqual({ reader: 1, writer: 1, owner: 0, ddl: 0 });
  });

  it("is safe to run again, and leaves an existing user alone", async () => {
    await grantApiUser(pool, name);
    await ensureApiUser(pool, { name, clientId: randomUUID() });
    const db = await signInAsApi();
    await expect(resolveHousehold(db, member)).resolves.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("refuses names that could break out of the brackets, and client IDs that aren't GUIDs", async () => {
    await expect(grantApiUser(pool, "x]; DROP TABLE household; --")).rejects.toThrow(/name/);
    await expect(ensureApiUser(pool, { name: "x]", clientId: randomUUID() })).rejects.toThrow(/name/);
    await expect(ensureApiUser(pool, { name, clientId: "func-kitchen-dev" })).rejects.toThrow(/client ID/);
  });
});
