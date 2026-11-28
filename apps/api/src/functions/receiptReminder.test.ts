import type { InvocationContext } from "@azure/functions";
import { createMealPlan, createReceiptReminders, runMigrations, type MealPlan, type ReceiptReminders } from "@kitchen/db";
import { createEmptyDatabase, testServer } from "@kitchen/db/test-database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runReceiptReminder } from "./receiptReminder.js";

// The timer fires Mondays 00:00 UTC, which is Sunday evening in US Central.
// 2026-11-23 is a Monday; this is Sunday 2026-11-29, 6 PM CST.
const SUNDAY_EVENING = new Date("2026-11-30T00:00:00Z");

describe.skipIf(!testServer)("weekly receipt reminder", () => {
  let pool: Awaited<ReturnType<typeof createEmptyDatabase>>["pool"];
  let drop: () => Promise<void>;
  let plan: MealPlan;
  let reminders: ReceiptReminders;
  let household: string;
  let recipe: string;

  const context = { log: vi.fn(), error: vi.fn() } as unknown as InvocationContext;
  const alert = vi.fn(async (_title: string, _message: string) => {});
  const run = (now = SUNDAY_EVENING) => runReceiptReminder(reminders, alert, now, context);

  async function id(query: string, params: Record<string, unknown> = {}): Promise<string> {
    const request = pool.request();
    for (const [k, v] of Object.entries(params)) request.input(k, v);
    return (await request.query(query)).recordset[0].id;
  }
  const planDinner = (date: string) => plan.add(household, { date, slot: "dinner", recipeId: recipe });

  beforeAll(async () => {
    ({ pool, drop } = await createEmptyDatabase());
    await runMigrations(pool);
    plan = createMealPlan(pool);
    reminders = createReceiptReminders(pool);
    household = await id("INSERT household (name) OUTPUT inserted.id VALUES ('Test household')");
    recipe = await id("INSERT recipe (household_id, name) OUTPUT inserted.id VALUES (@household, 'Soup')", { household });
  });
  afterAll(async () => {
    await drop();
  });
  beforeEach(async () => {
    await pool.request().query("DELETE planned_meal; DELETE receipt_reminder");
    alert.mockClear();
  });

  it("sends one push about a week that has planned meals", async () => {
    await planDinner("2026-11-24");
    await planDinner("2026-11-26");

    expect(await run()).toBe(true);

    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith("Log your receipts", "Meal plan active the week of 2026-11-23: log your receipts.");
  });

  it("sends nothing for a week without a plan, whatever the weeks around it hold", async () => {
    await planDinner("2026-11-22"); // the Sunday before
    await planDinner("2026-11-30"); // the Monday after

    expect(await run()).toBe(false);

    expect(alert).not.toHaveBeenCalled();
  });

  it("never sends twice for the same week, even when meals are added after the push", async () => {
    await planDinner("2026-11-24");
    await run();
    await planDinner("2026-11-29");

    expect(await run()).toBe(false);

    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("sends again for the next planned week", async () => {
    await planDinner("2026-11-24");
    await planDinner("2026-12-01");
    await run();

    expect(await run(new Date("2026-12-07T00:00:00Z"))).toBe(true);

    expect(alert).toHaveBeenLastCalledWith("Log your receipts", "Meal plan active the week of 2026-11-30: log your receipts.");
  });

  it.each([
    ["on the schedule in winter (Sunday 6 PM CST)", "2026-11-30T00:00:00Z", "2026-11-23"],
    ["on the schedule in summer (Sunday 7 PM CDT)", "2026-06-15T00:00:00Z", "2026-06-08"],
    ["late, on Monday morning Central", "2026-11-30T15:00:00Z", "2026-11-23"],
    ["late, on the Saturday after", "2026-12-05T18:00:00Z", "2026-11-23"],
    ["at 6 PM on Sunday", "2026-11-30T00:00:00Z", "2026-11-23"],
    ["late, on Sunday morning, before that week's own evening", "2026-11-29T15:00:00Z", "2026-11-16"],
    ["just before 6 PM on Sunday", "2026-11-29T23:59:00Z", "2026-11-16"],
    ["on the Sunday the clocks go forward", "2026-03-09T00:00:00Z", "2026-03-02"],
  ])("takes the week ending on the latest Sunday evening in Central: %s", async (_when, now, week) => {
    await planDinner(week);

    expect(await run(new Date(now))).toBe(true);

    expect(alert).toHaveBeenCalledWith("Log your receipts", `Meal plan active the week of ${week}: log your receipts.`);
  });

  it("leaves the week unsent when ntfy refuses the push, so a rerun can send it", async () => {
    await planDinner("2026-11-24");
    alert.mockRejectedValueOnce(new Error("ntfy refused the alert (HTTP 500)"));

    await expect(run()).rejects.toThrow("HTTP 500");
    expect(await run()).toBe(true);
    expect(await run()).toBe(false);

    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("reports why the push failed even when the week can't be unmarked", async () => {
    await planDinner("2026-11-24");
    alert.mockRejectedValueOnce(new Error("ntfy refused the alert (HTTP 500)"));
    const stuck: ReceiptReminders = { ...reminders, release: () => Promise.reject(new Error("database gone")) };

    await expect(runReceiptReminder(stuck, alert, SUNDAY_EVENING, context)).rejects.toThrow("HTTP 500");

    expect(context.error).toHaveBeenCalledWith(expect.stringContaining("database gone"));
  });

  it("sends one push when more than one household planned the week", async () => {
    const other = await id("INSERT household (name) OUTPUT inserted.id VALUES ('Other household')");
    const theirs = await id("INSERT recipe (household_id, name) OUTPUT inserted.id VALUES (@other, 'Stew')", { other });
    await planDinner("2026-11-24");
    await plan.add(other, { date: "2026-11-25", slot: "dinner", recipeId: theirs });

    await run();

    expect(alert).toHaveBeenCalledTimes(1);
    expect(await run()).toBe(false);
  });
});
