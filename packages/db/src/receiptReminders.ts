import mssql from "mssql";

/** Which weeks have had their receipt reminder, across every household (card P5). */
export interface ReceiptReminders {
  /**
   * Marks the week starting `weekStart` (a Monday, `YYYY-MM-DD`) as reminded for every household
   * with a planned meal in it that wasn't marked already, and returns those households.
   */
  claimWeek(weekStart: string): Promise<string[]>;
  /** Takes those marks back, for a push that didn't go out. */
  release(householdIds: string[], weekStart: string): Promise<void>;
}

export function createReceiptReminders(pool: mssql.ConnectionPool): ReceiptReminders {
  return {
    async claimWeek(weekStart) {
      // One statement, so the check and the mark can't come apart: two runs at once can't both
      // claim a week.
      const r = await pool.request().input("week", mssql.Date, weekStart).query(`
        INSERT receipt_reminder (household_id, week_start)
        OUTPUT inserted.household_id AS householdId
        SELECT DISTINCT m.household_id, CONVERT(DATE, @week)
        FROM planned_meal m
        WHERE m.plan_date >= CONVERT(DATE, @week) AND m.plan_date < DATEADD(DAY, 7, CONVERT(DATE, @week))
          AND NOT EXISTS (SELECT 1 FROM receipt_reminder s WITH (UPDLOCK, HOLDLOCK)
                          WHERE s.household_id = m.household_id AND s.week_start = CONVERT(DATE, @week))`);
      return r.recordset.map((row) => row.householdId as string);
    },

    async release(householdIds, weekStart) {
      for (const householdId of householdIds) {
        await pool
          .request()
          .input("h", mssql.UniqueIdentifier, householdId)
          .input("week", mssql.Date, weekStart)
          .query("DELETE receipt_reminder WHERE household_id = @h AND week_start = CONVERT(DATE, @week)");
      }
    },
  };
}
