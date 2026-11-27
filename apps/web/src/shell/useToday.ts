import { useEffect, useState } from "react";
import { localToday } from "../mealPlan/dates.js";

/** Today's date, moved on when the app is brought back after midnight. */
export function useToday(): string {
  const [today, setToday] = useState(localToday);
  useEffect(() => {
    const check = () => setToday(localToday());
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);
  return today;
}
