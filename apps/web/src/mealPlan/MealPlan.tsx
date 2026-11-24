import { MEAL_SLOTS, type MealSlot, type PlannedMeal, type RecipeSummary } from "@kitchen/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { RecipeApi } from "../recipes/api.js";
import type { MealPlanApi } from "./api.js";
import { addDays, dayLabel, localToday, weekDays, weekStart } from "./dates.js";

const SLOT_LABEL: Record<MealSlot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

type Editing = { kind: "add"; date: string } | { kind: "move"; id: string } | null;

const servingsText = (n: number) => `${n} serving${n === 1 ? "" : "s"}`;
const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong.");

interface Props {
  api: MealPlanApi;
  /** Where the recipes to plan come from. */
  recipes: RecipeApi;
  /** Today as `YYYY-MM-DD`; the device's clock unless a test says otherwise. */
  today?: string;
}

/** The week's meal plan: today's meals first, then the rest of the week. Add, move, re-serve and remove meals. */
export function MealPlan({ api, recipes, today = localToday() }: Props) {
  const [start, setStart] = useState(() => weekStart(today));
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [recipeList, setRecipeList] = useState<RecipeSummary[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  // The week on screen now, so a change that finishes after the person moved on can't overwrite it.
  const shownStart = useRef(start);
  shownStart.current = start;

  useEffect(() => {
    let cancelled = false;
    setMeals(null);
    api.week(start).then(
      (loaded) => {
        if (cancelled) return;
        setMeals(loaded);
        setProblem(null);
      },
      (error: unknown) => !cancelled && setProblem(reasonOf(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, start]);

  useEffect(() => {
    let cancelled = false;
    recipes.list().then(
      (loaded) => !cancelled && setRecipeList(loaded),
      (error: unknown) => !cancelled && setProblem(reasonOf(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [recipes]);

  /** Runs a change, then reloads the week so the screen shows what the server holds. */
  const change = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await run();
        const reloaded = await api.week(start);
        if (shownStart.current !== start) return;
        setMeals(reloaded);
        setProblem(null);
        setEditing(null);
      } catch (error) {
        setProblem(reasonOf(error));
      } finally {
        setBusy(false);
      }
    },
    [api, start],
  );

  const days = weekDays(start, today);
  const dayOptions = [...days].sort();

  return (
    <div className="meal-plan">
      <div className="meal-plan-header">
        <h2>Meal plan</h2>
        <div className="meal-plan-nav">
          <button type="button" onClick={() => setStart(addDays(start, -7))}>
            Previous week
          </button>
          <button type="button" onClick={() => setStart(weekStart(today))}>
            This week
          </button>
          <button type="button" onClick={() => setStart(addDays(start, 7))}>
            Next week
          </button>
        </div>
      </div>
      {problem && <p role="alert" className="meal-plan-problem">{problem}</p>}
      {meals === null && !problem && <p>Loading the week…</p>}
      {meals !== null &&
        days.map((date) => {
          const label = dayLabel(date);
          const dayMeals = meals.filter((m) => m.date === date);
          return (
            <section key={date} aria-label={label} className={date === today ? "meal-day meal-day-today" : "meal-day"}>
              <h3>{date === today ? `Today, ${label}` : label}</h3>
              {dayMeals.length === 0 ? (
                <p className="meal-empty">Nothing planned</p>
              ) : (
                <ul className="meal-list">
                  {dayMeals.map((m) => (
                    <li key={m.id}>
                      <strong>{SLOT_LABEL[m.slot]}</strong>
                      <span className="meal-recipe">{m.recipeName}</span>
                      <span className="meal-servings">{servingsText(m.servings)}</span>
                      <span className="meal-actions">
                        <button
                          type="button"
                          aria-label={`Fewer servings of ${m.recipeName}`}
                          disabled={busy || m.servings <= 1}
                          onClick={() => void change(() => api.update(m.id, { servings: m.servings - 1 }))}
                        >
                          −
                        </button>
                        <button
                          type="button"
                          aria-label={`More servings of ${m.recipeName}`}
                          disabled={busy}
                          onClick={() => void change(() => api.update(m.id, { servings: m.servings + 1 }))}
                        >
                          +
                        </button>
                        <button type="button" aria-label={`Move ${m.recipeName}`} disabled={busy} onClick={() => setEditing({ kind: "move", id: m.id })}>
                          Move
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${m.recipeName}`}
                          disabled={busy}
                          onClick={() => void change(() => api.remove(m.id))}
                        >
                          Remove
                        </button>
                      </span>
                      {editing?.kind === "move" && editing.id === m.id && (
                        <MoveForm
                          meal={m}
                          dayOptions={dayOptions}
                          busy={busy}
                          onCancel={() => setEditing(null)}
                          onSubmit={(date, slot) => void change(() => api.update(m.id, { date, slot }))}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {editing?.kind === "add" && editing.date === date ? (
                <AddForm
                  recipes={recipeList}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSubmit={(slot, recipeId, servings) =>
                    void change(() => api.add({ date, slot, recipeId, ...(servings === undefined ? {} : { servings }) }))
                  }
                />
              ) : (
                <button type="button" aria-label={`Add meal on ${label}`} disabled={busy} onClick={() => setEditing({ kind: "add", date })}>
                  Add meal
                </button>
              )}
            </section>
          );
        })}
    </div>
  );
}

function SlotSelect({ value, onChange }: { value: MealSlot; onChange: (slot: MealSlot) => void }) {
  return (
    <label>
      Meal
      <select value={value} onChange={(e) => onChange(e.target.value as MealSlot)}>
        {MEAL_SLOTS.map((slot) => (
          <option key={slot} value={slot}>
            {SLOT_LABEL[slot]}
          </option>
        ))}
      </select>
    </label>
  );
}

function AddForm({
  recipes,
  busy,
  onSubmit,
  onCancel,
}: {
  recipes: RecipeSummary[];
  busy: boolean;
  onSubmit: (slot: MealSlot, recipeId: string, servings: number | undefined) => void;
  onCancel: () => void;
}) {
  const [slot, setSlot] = useState<MealSlot>("dinner");
  const [recipeId, setRecipeId] = useState("");
  const [servings, setServings] = useState("");
  const chosen = recipeId || recipes[0]?.id || "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    const count = servings.trim() === "" ? undefined : Number(servings);
    onSubmit(slot, chosen, count);
  };

  return (
    <form className="meal-form" onSubmit={submit}>
      <SlotSelect value={slot} onChange={setSlot} />
      <label>
        Recipe
        <select value={chosen} onChange={(e) => setRecipeId(e.target.value)}>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Servings
        <input type="number" inputMode="numeric" min={1} step={1} placeholder="Recipe's own" value={servings} onChange={(e) => setServings(e.target.value)} />
      </label>
      <div className="meal-form-buttons">
        <button type="submit" disabled={busy || !chosen}>
          Add
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {recipes.length === 0 && <p className="meal-empty">No recipes yet. Add one under Recipes first.</p>}
    </form>
  );
}

function MoveForm({
  meal,
  dayOptions,
  busy,
  onSubmit,
  onCancel,
}: {
  meal: PlannedMeal;
  dayOptions: string[];
  busy: boolean;
  onSubmit: (date: string, slot: MealSlot) => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(meal.date);
  const [slot, setSlot] = useState<MealSlot>(meal.slot);

  return (
    <form
      className="meal-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(date, slot);
      }}
    >
      <label>
        Day
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          {dayOptions.map((d) => (
            <option key={d} value={d}>
              {dayLabel(d)}
            </option>
          ))}
        </select>
      </label>
      <SlotSelect value={slot} onChange={setSlot} />
      <div className="meal-form-buttons">
        <button type="submit" disabled={busy}>
          Move
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
