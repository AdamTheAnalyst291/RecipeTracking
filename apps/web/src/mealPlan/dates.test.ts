import { describe, expect, it } from "vitest";
import { addDays, dayLabel, localToday, weekDays, weekStart } from "./dates.js";

describe("week dates", () => {
  it("finds the Monday of any day in the week, including Sunday", () => {
    expect(weekStart("2026-11-23")).toBe("2026-11-23"); // Monday
    expect(weekStart("2026-11-26")).toBe("2026-11-23");
    expect(weekStart("2026-11-29")).toBe("2026-11-23"); // Sunday
    expect(weekStart("2026-11-30")).toBe("2026-11-30");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-11-29", 2)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("puts today first when it is in the week, and keeps date order otherwise", () => {
    expect(weekDays("2026-11-23", "2026-11-25")).toEqual([
      "2026-11-25",
      "2026-11-23",
      "2026-11-24",
      "2026-11-26",
      "2026-11-27",
      "2026-11-28",
      "2026-11-29",
    ]);
    expect(weekDays("2026-11-30", "2026-11-25")[0]).toBe("2026-11-30");
  });

  it("reads today from the device's own clock", () => {
    expect(localToday(new Date(2026, 10, 5, 23, 59))).toBe("2026-11-05");
  });

  it("labels a day", () => {
    expect(dayLabel("2026-11-24")).toBe("Tue 24 Nov");
  });
});
