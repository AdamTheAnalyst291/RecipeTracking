import type { InvocationContext } from "@azure/functions";
import type { ReceiptReminders } from "@kitchen/db";
import type { Alert } from "../bank/alert.js";
import { errorText } from "../bank/log.js";

/**
 * Sunday evening in US Central, the app's region. Timers run on UTC (Flex Consumption has no
 * time zone setting), so this is Monday 00:00 UTC: Sunday 6 PM in winter, 7 PM in summer.
 */
export const RECEIPT_REMINDER_SCHEDULE = "0 0 0 * * 1";

const centralTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23",
});

/** The earliest hour (Central) on a Sunday that its own week is reminded about. */
const EVENING = 18;

/**
 * The Monday of the week to remind about: the week ending on the latest Sunday evening in US
 * Central. A run that comes late, even on the next Sunday morning, still means the week that
 * had its evening.
 */
function reminderWeek(now: Date): string {
  const part = Object.fromEntries(centralTime.formatToParts(now).map((p) => [p.type, Number(p.value)])) as Record<string, number>;
  // The Central calendar date, held as UTC midnight so the day arithmetic has no clock changes.
  const day = new Date(Date.UTC(part.year!, part.month! - 1, part.day!));
  const sinceSunday = day.getUTCDay() === 0 && part.hour! < EVENING ? 7 : day.getUTCDay();
  day.setUTCDate(day.getUTCDate() - sinceSunday - 6); // back to that Sunday, then to its Monday
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
    // A failure to unmark is only logged, so the reason the push failed is what's thrown.
    await reminders.release(households, week).catch((e: unknown) => context.error(`Receipt reminder couldn't unmark the week of ${week}: ${errorText(e)}`));
    throw error;
  }
  context.log(`Receipt reminder for the week of ${week}: sent`);
  return true;
}
