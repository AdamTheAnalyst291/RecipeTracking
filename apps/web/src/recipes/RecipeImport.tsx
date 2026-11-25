import type { RecipeImportResponse } from "@kitchen/shared";
import { useState } from "react";
import { RecipeApiError, type RecipeApi } from "./api.js";

/** Paste a recipe page's address; the draft it holds goes to the editor to be checked. */
export function RecipeImport({
  api,
  onImported,
  onCancel,
}: {
  api: RecipeApi;
  onImported: (draft: RecipeImportResponse) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [reading, setReading] = useState(false);

  async function read(event: React.FormEvent) {
    event.preventDefault();
    if (url.trim() === "") {
      setProblems(["Paste the recipe page's web address."]);
      return;
    }
    setProblems([]);
    setReading(true);
    try {
      onImported(await api.importFromUrl(url.trim()));
    } catch (error) {
      setProblems(error instanceof RecipeApiError ? error.messages : ["Couldn't import the recipe."]);
      setReading(false);
    }
  }

  return (
    <form className="recipe-form" onSubmit={(e) => void read(e)} noValidate>
      <h2>Import a recipe</h2>
      <label>
        Recipe page address
        <input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
      </label>
      {reading && <p>Reading the page…</p>}
      {problems.length > 0 && (
        <div role="alert" className="recipe-problems">
          {problems.join(" ")}
        </div>
      )}
      <div className="recipe-actions">
        <button type="submit" disabled={reading}>
          Import
        </button>
        <button type="button" onClick={onCancel} disabled={reading}>
          Cancel
        </button>
      </div>
    </form>
  );
}
