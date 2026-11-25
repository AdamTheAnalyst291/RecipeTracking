import type { PlannedMeal } from "@kitchen/shared";
import { useEffect, useState } from "react";
import type { MealPlanApi } from "../mealPlan/api.js";
import { dayLabel, weekStart } from "../mealPlan/dates.js";
import { SLOT_LABEL, servingsText } from "../mealPlan/MealPlan.js";

interface Props {
  api: MealPlanApi;
  /** `YYYY-MM-DD`. */
  today: string;
  /** Opens the meal plan. */
  onPlan: () => void;
}

/** What is planned for today. */
export function Today({ api, today, onPlan }: Props) {
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.week(weekStart(today)).then(
      (week) => !cancelled && setMeals(week.filter((m) => m.date === today)),
      (error: unknown) => !cancelled && setProblem(error instanceof Error ? error.message : "Something went wrong."),
    );
    return () => {
      cancelled = true;
    };
  }, [api, today]);

  return (
    <section className="today">
      <h2>Today</h2>
      <p>{dayLabel(today)}</p>
      {problem && <p role="alert">Couldn't load today's meals ({problem}).</p>}
      {meals === null && !problem && <p>Loading…</p>}
      {meals?.length === 0 && <p>Nothing planned today.</p>}
      {meals && meals.length > 0 && (
        <ul className="today-meals" aria-label="Today's meals">
          {meals.map((m) => (
            <li key={m.id}>
              <strong>{SLOT_LABEL[m.slot]}</strong> <span>{m.recipeName}</span> <span>{servingsText(m.servings)}</span>
            </li>
          ))}
        </ul>
      )}
      {meals && (
        <button type="button" onClick={onPlan}>
          {meals.length === 0 ? "Plan a meal" : "See the week"}
        </button>
      )}
    </section>
  );
}
