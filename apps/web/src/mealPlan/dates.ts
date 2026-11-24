/** Dates are `YYYY-MM-DD` strings throughout; arithmetic is done in UTC so a clock change never shifts a day. */

const utc = (date: string): Date => new Date(`${date}T00:00:00Z`);
const text = (d: Date): string => d.toISOString().slice(0, 10);

/** Today on this device's clock. */
export const localToday = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return text(d);
}

/** The Monday on or before `date`. */
export function weekStart(date: string): string {
  const day = utc(date).getUTCDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

/** The seven days of the week starting at `start`, with today's first when it falls in the week. */
export function weekDays(start: string, today: string): string[] {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return days.includes(today) ? [today, ...days.filter((d) => d !== today)] : days;
}

/** "Tue 24 Nov". */
export function dayLabel(date: string): string {
  return utc(date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
