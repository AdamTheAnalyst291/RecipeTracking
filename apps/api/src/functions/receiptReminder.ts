import type { InvocationContext } from "@azure/functions";
import type { ReceiptReminders } from "@kitchen/db";
import type { Alert } from "../bank/alert.js";

/**
 * Sunday evening in US Central, the app's region. Timers run on UTC (Flex Consumption has no
 * time zone setting), so this is Monday 00:00 UTC: Sunday 6 PM in winter, 7 PM in summer.
 */
export const RECEIPT_REMINDER_SCHEDULE = "0 0 0 * * 1";

// en-CA writes dates as YYYY-MM-DD.
const centralDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * The Monday of the week to remind about: the week ending on the latest Sunday in US Central
 * (today, when it is Sunday). A run that comes late still means the week just ended.
 */
function reminderWeek(now: Date): string {
  const day = new Date(`${centralDate.format(now)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - day.getUTCDay() - 6); // back to that Sunday, then to its Monday
  return day.toISOString().slice(0, 10);
}

/**
 * The weekly timer's work (card P5): one phone push to log receipts, only when the week had a
 * meal plan and only once for that week. Returns whether it sent one.
 */
export async function runReceiptReminder(reminders: ReceiptReminders, alert: Alert, now: Date, context: InvocationContext): Promise<boolean> {
  const week = reminderWeek(now);
  // Marked before sending, so two runs at once can't both push.
  const households = await reminders.claimWeek(week);
  if (households.length === 0) {
    context.log(`Receipt reminder for the week of ${week}: nothing to send`);
    return false;
  }
  try {
    // One topic, so one push whoever planned.
    await alert("Log your receipts", `Meal plan active the week of ${week}: log your receipts.`);
  } catch (error) {
    await reminders.release(households, week);
    throw error;
  }
  context.log(`Receipt reminder for the week of ${week}: sent`);
  return true;
}
