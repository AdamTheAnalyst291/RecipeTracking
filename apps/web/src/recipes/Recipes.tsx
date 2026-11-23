import type { Recipe, RecipeIngredient, RecipeSummary } from "@kitchen/shared";
import { useEffect, useState } from "react";
import { RecipeApiError, type RecipeApi } from "./api.js";
import { RecipeEditor } from "./RecipeEditor.js";

type View = { page: "list" } | { page: "detail"; id: string; recipe?: Recipe } | { page: "edit"; recipe: Recipe | null };

const reasonOf = (error: unknown) => (error instanceof RecipeApiError ? error.messages.join(" ") : "Something went wrong.");

/** Browse, view, add, edit and delete recipes. */
export function Recipes({ api }: { api: RecipeApi }) {
  const [view, setView] = useState<View>({ page: "list" });
  switch (view.page) {
    case "list":
      return <RecipeList api={api} onOpen={(id) => setView({ page: "detail", id })} onAdd={() => setView({ page: "edit", recipe: null })} />;
    case "detail":
      return (
        <RecipeDetail
          api={api}
          id={view.id}
          initial={view.recipe}
          onBack={() => setView({ page: "list" })}
          onEdit={(recipe) => setView({ page: "edit", recipe })}
        />
      );
    case "edit": {
      const { recipe } = view;
      return (
        <RecipeEditor
          api={api}
          recipe={recipe}
          onSaved={(saved) => setView({ page: "detail", id: saved.id, recipe: saved })}
          onCancel={() => setView(recipe ? { page: "detail", id: recipe.id, recipe } : { page: "list" })}
        />
      );
    }
  }
}

function RecipeList({ api, onOpen, onAdd }: { api: RecipeApi; onOpen: (id: string) => void; onAdd: () => void }) {
  const [recipes, setRecipes] = useState<RecipeSummary[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.list().then(
      (loaded) => !cancelled && setRecipes(loaded),
      (error: unknown) => !cancelled && setProblem(reasonOf(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const needle = search.trim().toLowerCase();
  const shown = (recipes ?? []).filter(
    (r) => needle === "" || r.name.toLowerCase().includes(needle) || r.tags.some((t) => t.toLowerCase().includes(needle)),
  );

  return (
    <section className="recipes">
      <header className="recipes-header">
        <h2>Recipes</h2>
        <button type="button" onClick={onAdd}>
          Add recipe
        </button>
      </header>
      <input type="search" aria-label="Search recipes" placeholder="Search by name or tag" value={search} onChange={(e) => setSearch(e.target.value)} />
      {problem && <p role="alert">Couldn't load recipes ({problem}).</p>}
      {!problem && recipes === null && <p>Loading…</p>}
      {recipes?.length === 0 && <p>No recipes yet. Add your first one.</p>}
      {recipes && recipes.length > 0 && shown.length === 0 && <p>Nothing matches “{search.trim()}”.</p>}
      {shown.length > 0 && (
        <ul aria-label="Recipes" className="recipe-list">
          {shown.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onOpen(r.id)}>
                {r.name}
              </button>
              <span className="recipe-meta">
                {[r.totalMinutes !== null && `${r.totalMinutes} min`, r.servings !== null && `${r.servings} ${r.servings === 1 ? "serving" : "servings"}`]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {r.tags.length > 0 && <span className="recipe-tags">{r.tags.join(", ")}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ingredientText = ({ food, quantity, unit, note }: RecipeIngredient) =>
  `${[quantity, unit, food].filter((part) => part !== null).join(" ")}${note ? `, ${note}` : ""}`;

function RecipeDetail({
  api,
  id,
  initial,
  onBack,
  onEdit,
}: {
  api: RecipeApi;
  id: string;
  initial: Recipe | undefined;
  onBack: () => void;
  onEdit: (recipe: Recipe) => void;
}) {
  const [recipe, setRecipe] = useState<Recipe | null>(initial ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    api.get(id).then(
      (loaded) => !cancelled && setRecipe(loaded),
      (error: unknown) => !cancelled && setProblem(reasonOf(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, initial]);

  async function remove() {
    try {
      await api.remove(id);
      onBack();
    } catch (error) {
      setConfirming(false);
      setProblem(reasonOf(error));
    }
  }

  return (
    <article className="recipe">
      <button type="button" onClick={onBack}>
        Back to recipes
      </button>
      {problem && <p role="alert">Couldn't do that ({problem}).</p>}
      {!recipe && !problem && <p>Loading…</p>}
      {recipe && (
        <>
          <h2>{recipe.name}</h2>
          <p className="recipe-meta">
            {[recipe.totalMinutes !== null && `${recipe.totalMinutes} min`, recipe.servings !== null && `${recipe.servings} servings`]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {recipe.tags.length > 0 && <p className="recipe-tags">{recipe.tags.join(", ")}</p>}
          {recipe.sourceUrl ? (
            <p>
              From{" "}
              <a href={recipe.sourceUrl} target="_blank" rel="noopener noreferrer">
                {recipe.sourceCredit ?? recipe.sourceUrl}
              </a>
            </p>
          ) : (
            recipe.sourceCredit && <p>From {recipe.sourceCredit}</p>
          )}
          <h3>Ingredients</h3>
          <ul aria-label="Ingredients">
            {recipe.ingredients.map((i, n) => (
              <li key={n}>{ingredientText(i)}</li>
            ))}
          </ul>
          <h3>Steps</h3>
          <ol aria-label="Steps">
            {recipe.steps.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ol>
          <div className="recipe-actions">
            <button type="button" onClick={() => onEdit(recipe)}>
              Edit
            </button>
            {confirming ? (
              <>
                <button type="button" onClick={() => void remove()}>
                  Yes, delete {recipe.name}
                </button>
                <button type="button" onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)}>
                Delete
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}
