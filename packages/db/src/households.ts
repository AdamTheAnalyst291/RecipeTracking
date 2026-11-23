import mssql from "mssql";

export interface Member {
  /** The person's Microsoft Entra object ID (`oid`). */
  objectId: string;
  displayName?: string | undefined;
}

/**
 * The database household a signed-in member belongs to. The API's sign-in check already
 * decided they may come in (auth.ts); this finds their `household` row, creating it and the
 * `user` row the first time. There is one household for now (ADR-25), so a new member joins
 * the existing one.
 */
export async function resolveHousehold(pool: mssql.ConnectionPool, member: Member): Promise<string> {
  const lookup = async (): Promise<string | undefined> => {
    const r = await pool
      .request()
      .input("oid", mssql.UniqueIdentifier, member.objectId)
      .query("SELECT household_id FROM [user] WHERE entra_object_id = @oid");
    return r.recordset[0]?.household_id as string | undefined;
  };

  const known = await lookup();
  if (known) return known;

  // Serialise first-time sign-ups, so two at once can't each create a household.
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    await new mssql.Request(tx).query(`
      DECLARE @r INT;
      EXEC @r = sp_getapplock @Resource = 'kitchen-first-sign-in', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 30000;
      IF @r < 0 THROW 50000, 'Could not get the sign-up lock', 1;`);
    const r = await new mssql.Request(tx)
      .input("oid", mssql.UniqueIdentifier, member.objectId)
      .input("name", mssql.NVarChar(200), member.displayName?.slice(0, 200) ?? null)
      .query(`
        DECLARE @h UNIQUEIDENTIFIER = (SELECT TOP 1 household_id FROM [user] WHERE entra_object_id = @oid);
        IF @h IS NULL SET @h = (SELECT TOP 1 id FROM household ORDER BY created_at, id);
        IF @h IS NULL
        BEGIN
          DECLARE @made TABLE (id UNIQUEIDENTIFIER);
          INSERT household (name) OUTPUT inserted.id INTO @made VALUES ('Home');
          SET @h = (SELECT id FROM @made);
        END
        IF NOT EXISTS (SELECT 1 FROM [user] WHERE entra_object_id = @oid)
          INSERT [user] (household_id, entra_object_id, display_name) VALUES (@h, @oid, @name);
        SELECT @h AS id;`);
    await tx.commit();
    return r.recordset[0].id as string;
  } catch (e) {
    await tx.rollback().catch(() => undefined);
    throw e;
  }
}
