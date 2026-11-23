import { parseRecipeInput, type Recipe, type Unit } from "@kitchen/shared";
import { useEffect, useState } from "react";
import { RecipeApiError, type RecipeApi } from "./api.js";

interface IngredientDraft {
  food: string;
  quantity: string;
  unit: string;
  note: string;
}

/** The form's fields as typed: everything is text until it's saved. */
interface Draft {
  name: string;
  servings: string;
  totalMinutes: string;
  sourceUrl: string;
  sourceCredit: string;
  tags: string;
  ingredients: IngredientDraft[];
  steps: string[];
}

function draftOf(recipe: Recipe | null): Draft {
  return {
    name: recipe?.name ?? "",
    servings: recipe?.servings?.toString() ?? "",
    totalMinutes: recipe?.totalMinutes?.toString() ?? "",
    sourceUrl: recipe?.sourceUrl ?? "",
    sourceCredit: recipe?.sourceCredit ?? "",
    tags: recipe?.tags.join(", ") ?? "",
    ingredients: (recipe?.ingredients ?? []).map((i) => ({
      food: i.food,
      quantity: i.quantity?.toString() ?? "",
      unit: i.unit ?? "",
      note: i.note ?? "",
    })),
    steps: recipe?.steps ?? [],
  };
}

const orNull = (text: string): string | null => (text.trim() === "" ? null : text);
const numberOrNull = (text: string): number | null => (text.trim() === "" ? null : Number(text));

/** The typed fields as the API's input. Blank ingredient and step rows are left out. */
function bodyOf(draft: Draft) {
  return {
    name: draft.name,
    servings: numberOrNull(draft.servings),
    totalMinutes: numberOrNull(draft.totalMinutes),
    sourceUrl: orNull(draft.sourceUrl),
    sourceCredit: orNull(draft.sourceCredit),
    tags: draft.tags.split(",").filter((t) => t.trim() !== ""),
    ingredients: draft.ingredients
      .filter((i) => [i.food, i.quantity, i.note].some((t) => t.trim() !== ""))
      .map((i) => ({ food: i.food, quantity: numberOrNull(i.quantity), unit: orNull(i.unit), note: orNull(i.note) })),
    steps: draft.steps.filter((s) => s.trim() !== ""),
  };
}

export function RecipeEditor({
  api,
  recipe,
  onSaved,
  onCancel,
}: {
  api: RecipeApi;
  /** The recipe being edited, or null to add a new one. */
  recipe: Recipe | null;
  onSaved: (saved: Recipe) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => draftOf(recipe));
  const [units, setUnits] = useState<Unit[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.units().then(
      (loaded) => !cancelled && setUnits(loaded),
      () => undefined, // the unit list is a convenience; saving reports real trouble
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setIngredient = (index: number, change: Partial<IngredientDraft>) =>
    set("ingredients", draft.ingredients.map((row, i) => (i === index ? { ...row, ...change } : row)));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const parsed = parseRecipeInput(bodyOf(draft));
    if (!parsed.ok) {
      setProblems(parsed.errors);
      return;
    }
    setProblems([]);
    setSaving(true);
    try {
      onSaved(recipe ? await api.update(recipe.id, parsed.value) : await api.create(parsed.value));
    } catch (error) {
      setProblems(error instanceof RecipeApiError ? error.messages : ["Couldn't save the recipe."]);
      setSaving(false);
    }
  }

  return (
    <form className="recipe-form" onSubmit={(e) => void save(e)} noValidate>
      <h2>{recipe ? "Edit recipe" : "Add recipe"}</h2>

      <label>
        Name
        <input value={draft.name} onChange={(e) => set("name", e.target.value)} maxLength={200} />
      </label>
      <div className="recipe-form-row">
        <label>
          Servings
          <input inputMode="numeric" value={draft.servings} onChange={(e) => set("servings", e.target.value)} />
        </label>
        <label>
          Total time (minutes)
          <input inputMode="numeric" value={draft.totalMinutes} onChange={(e) => set("totalMinutes", e.target.value)} />
        </label>
      </div>
      <label>
        Source link
        <input type="url" inputMode="url" value={draft.sourceUrl} onChange={(e) => set("sourceUrl", e.target.value)} />
      </label>
      <label>
        Credit
        <input value={draft.sourceCredit} onChange={(e) => set("sourceCredit", e.target.value)} maxLength={200} />
      </label>
      <label>
        Tags
        <input value={draft.tags} onChange={(e) => set("tags", e.target.value)} placeholder="quick, vegetarian" />
      </label>

      <fieldset>
        <legend>Ingredients</legend>
        {draft.ingredients.map((row, i) => (
          <div className="recipe-ingredient" key={i}>
            <input aria-label={`Food ${i + 1}`} placeholder="Food" value={row.food} onChange={(e) => setIngredient(i, { food: e.target.value })} />
            <input
              aria-label={`Quantity ${i + 1}`}
              placeholder="Amount"
              inputMode="decimal"
              value={row.quantity}
              onChange={(e) => setIngredient(i, { quantity: e.target.value })}
            />
            <select aria-label={`Unit ${i + 1}`} value={row.unit} onChange={(e) => setIngredient(i, { unit: e.target.value })}>
              <option value="">(no unit)</option>
              {units.map((u) => (
                <option key={u.abbreviation} value={u.abbreviation}>
                  {u.abbreviation}
                </option>
              ))}
            </select>
            <input aria-label={`Note ${i + 1}`} placeholder="Note" value={row.note} onChange={(e) => setIngredient(i, { note: e.target.value })} />
            <button type="button" aria-label={`Remove ingredient ${i + 1}`} onClick={() => set("ingredients", draft.ingredients.filter((_, n) => n !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => set("ingredients", [...draft.ingredients, { food: "", quantity: "", unit: "", note: "" }])}>
          Add ingredient
        </button>
      </fieldset>

      <fieldset>
        <legend>Steps</legend>
        {draft.steps.map((step, i) => (
          <div className="recipe-step" key={i}>
            <textarea
              aria-label={`Step ${i + 1}`}
              rows={2}
              value={step}
              onChange={(e) => set("steps", draft.steps.map((s, n) => (n === i ? e.target.value : s)))}
            />
            <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => set("steps", draft.steps.filter((_, n) => n !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" onClick={() => set("steps", [...draft.steps, ""])}>
          Add step
        </button>
      </fieldset>

      {problems.length > 0 && (
        <div role="alert" className="recipe-problems">
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="recipe-actions">
        <button type="submit" disabled={saving}>
          Save recipe
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
