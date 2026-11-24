import type { ShoppingItem, ShoppingList } from "@kitchen/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { dayLabel } from "../mealPlan/dates.js";
import type { ShoppingApi } from "./api.js";

const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong.");

/** "1.5 kg", "200 g", or nothing for a line with no amount. */
export function amountText(item: ShoppingItem): string {
  if (item.quantity === null) return "";
  const amount = String(Math.round(item.quantity * 100) / 100);
  return item.unit ? `${amount} ${item.unit}` : amount;
}

/** "Mon 23 Nov – Sun 29 Nov", or one day when the list covers just one. */
export function rangeText(list: Pick<ShoppingList, "start" | "end">): string {
  return list.start === list.end ? dayLabel(list.start) : `${dayLabel(list.start)} – ${dayLabel(list.end)}`;
}

interface Props {
  api: ShoppingApi;
}

/**
 * The shopping list: made from the coming week's meal plan minus what the pantry has, plus
 * anything added by hand. Big rows to tick off in the store; ticked items sink to the bottom.
 */
export function Shopping({ api }: Props) {
  const [list, setList] = useState<ShoppingList | null | undefined>(undefined); // undefined: loading
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.latest().then(
      (loaded) => {
        if (cancelled) return;
        setList(loaded);
        setProblem(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        setList(null);
        setProblem(reasonOf(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** Runs a change and shows the result; a failure keeps the screen as it was and says why. */
  const run = useCallback(async (change: () => Promise<void>) => {
    setBusy(true);
    try {
      await change();
      setProblem(null);
    } catch (error) {
      setProblem(reasonOf(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const make = () =>
    run(async () => {
      setList(await api.generate());
    });

  const update = (itemId: string, change: (items: ShoppingItem[]) => ShoppingItem[]) =>
    setList((current) => (current && current.items.some((i) => i.id === itemId) ? { ...current, items: change(current.items) } : current));

  const toggle = (item: ShoppingItem) =>
    list &&
    run(async () => {
      const saved = await api.setChecked(list.id, item.id, !item.checked);
      update(item.id, (items) => items.map((i) => (i.id === item.id ? saved : i)));
    });

  const remove = (item: ShoppingItem) =>
    list &&
    run(async () => {
      await api.removeItem(list.id, item.id);
      update(item.id, (items) => items.filter((i) => i.id !== item.id));
    });

  const add = (event: FormEvent) => {
    event.preventDefault();
    const text = name.trim();
    if (!list || text === "") return;
    void run(async () => {
      const added = await api.addItem(list.id, { name: text });
      setList((current) => (current && current.id === list.id ? { ...current, items: [...current.items, added] } : current));
      setName("");
    });
  };

  const left = list ? list.items.filter((i) => !i.checked) : [];
  const done = list ? list.items.filter((i) => i.checked) : [];

  return (
    <section className="shopping" aria-label="Shopping list">
      <div className="shopping-header">
        <h2>Shopping list</h2>
        <button type="button" disabled={busy} onClick={() => void make()}>
          {list ? "Make a new list for the coming week" : "Make a list for the coming week"}
        </button>
      </div>
      {problem && (
        <p role="alert" className="shopping-problem">
          {problem}
        </p>
      )}
      {list === undefined && !problem && <p>Loading the list…</p>}
      {list === null && !problem && <p>No list yet. Plan some meals, then make one.</p>}
      {list && (
        <>
          <p className="shopping-range">
            For {rangeText(list)} · {left.length} to get
          </p>
          {list.items.length === 0 && <p>Nothing to buy for these days.</p>}
          <ul className="shopping-items" aria-label="To get">
            {left.map((item) => (
              <ItemRow key={item.id} item={item} busy={busy} onToggle={() => void toggle(item)} onRemove={() => void remove(item)} />
            ))}
          </ul>
          {done.length > 0 && (
            <>
              <h3>Got it</h3>
              <ul className="shopping-items shopping-done" aria-label="Got it">
                {done.map((item) => (
                  <ItemRow key={item.id} item={item} busy={busy} onToggle={() => void toggle(item)} onRemove={() => void remove(item)} />
                ))}
              </ul>
            </>
          )}
          <form className="shopping-add" onSubmit={add}>
            <label>
              Add an item
              <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="Milk, 2 L" />
            </label>
            <button type="submit" disabled={busy || name.trim() === ""}>
              Add
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function ItemRow({ item, busy, onToggle, onRemove }: { item: ShoppingItem; busy: boolean; onToggle: () => void; onRemove: () => void }) {
  const amount = amountText(item);
  return (
    <li className={item.checked ? "shopping-item shopping-item-checked" : "shopping-item"}>
      <label className="shopping-check">
        <input type="checkbox" checked={item.checked} disabled={busy} onChange={onToggle} />
        <span className="shopping-name">{item.name}</span>
        {amount && <span className="shopping-amount">{amount}</span>}
      </label>
      {item.source === "manual" && (
        <button type="button" aria-label={`Remove ${item.name}`} disabled={busy} onClick={onRemove}>
          Remove
        </button>
      )}
    </li>
  );
}
