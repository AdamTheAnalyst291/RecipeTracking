import type { MoneyBudgetLine, MoneyCategory, MoneyMonthBudget } from "@kitchen/shared";
import { useEffect, useState, type FormEvent } from "react";
import type { BudgetApi } from "./budget-api.js";
import { centsText, dollarsToCents } from "./format.js";

const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong.");

/** `YYYY-MM` moved by `by` months. */
export function addMonths(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + by;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

const asDate = (month: string) => new Date(`${month}-01T12:00:00Z`);
/** "November 2026". */
const monthTitle = (month: string) => asDate(month).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
/** "November". */
const monthOfYear = (month: string) => asDate(month).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

interface Props {
  api: BudgetApi;
  /** The household's categories, for adding a budget to one not listed yet. */
  categories: MoneyCategory[];
  /** Today as `YYYY-MM-DD`; the month it falls in is the current month. */
  today: string;
}

/**
 * Spend vs budget per category for this month and past ones (card $3, ADR-27). A budget set
 * for a month carries on to later months until changed. No envelope rollover: what's left of
 * one month doesn't move to the next.
 */
export function Budgets({ api, categories, today }: Props) {
  const current = today.slice(0, 7);
  const [month, setMonth] = useState(current);
  const [report, setReport] = useState<MoneyMonthBudget | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReport(undefined);
    setProblem(null);
    api.month(month).then(
      (r) => {
        if (cancelled) return;
        setReport(r);
        setProblem(null);
      },
      (error: unknown) => !cancelled && setProblem(reasonOf(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, month]);

  async function save(categoryId: string, amountCents: number | null): Promise<boolean> {
    setBusy(true);
    try {
      setReport(await api.setBudget(categoryId, month, amountCents));
      setProblem(null);
      return true;
    } catch (error) {
      setProblem(reasonOf(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const listed = new Set(report?.lines.map((l) => l.categoryId));
  // Not-spending categories (transfers, pay, other income) never have a budget (card $6).
  const unlisted = categories.filter((c) => c.kind === "spending" && !listed.has(c.id));

  return (
    <div className="money-budgets">
      <div className="money-month">
        <button type="button" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          ‹
        </button>
        <h3>{monthTitle(month)}</h3>
        <button type="button" aria-label="Next month" disabled={month >= current} onClick={() => setMonth(addMonths(month, 1))}>
          ›
        </button>
      </div>
      {problem && (
        <p role="alert" className="money-problem">
          {problem}
        </p>
      )}
      {report === undefined && !problem && <p>Loading budgets…</p>}
      {report?.lines.length === 0 && <p>No budgets or spending this month.</p>}
      <ul className="money-list" aria-label="Budgets">
        {report?.lines.map((l) => (
          <BudgetRow key={l.categoryId} line={l} monthLabel={monthOfYear(month)} busy={busy} save={(amount) => save(l.categoryId, amount)} />
        ))}
      </ul>
      {report && unlisted.length > 0 && <AddBudget categories={unlisted} busy={busy} monthLabel={monthOfYear(month)} save={save} />}
    </div>
  );
}

function BudgetRow({ line, monthLabel, busy, save }: { line: MoneyBudgetLine; monthLabel: string; busy: boolean; save: (amountCents: number | null) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const amount = dollarsToCents(typed);
  const spent = centsText(line.spentCents, { sign: line.spentCents < 0 });
  const left = line.budgetCents === null ? 0 : line.budgetCents - line.spentCents;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (amount !== undefined && (await save(amount))) setEditing(false);
  }

  return (
    <li className="money-budget" aria-label={`${line.category} ${spent} spent`}>
      <div className="money-tx-top">
        <h4>{line.category}</h4>
        {line.budgetCents === null ? (
          <span>{spent} spent, no budget</span>
        ) : (
          <span>
            {spent} of {centsText(line.budgetCents, { sign: false })}
          </span>
        )}
      </div>
      {line.budgetCents !== null && (
        <>
          <meter min={0} max={Math.max(line.budgetCents, 1)} value={Math.max(0, line.spentCents)} aria-label={`${line.category} spent of budget`} />
          <p className={left < 0 ? "money-meta money-over" : "money-meta"}>
            <span>{left < 0 ? `${centsText(-left, { sign: false })} over` : `${centsText(left, { sign: false })} left`}</span>
            {line.budgetFrom && ` · budget since ${monthTitle(line.budgetFrom)}`}
          </p>
        </>
      )}
      {editing ? (
        <form className="money-tx-actions" onSubmit={(e) => void submit(e)}>
          <AmountInput typed={typed} setTyped={setTyped} />
          <button type="submit" disabled={busy || amount === undefined}>
            Save from {monthLabel} on
          </button>
          {line.budgetCents !== null && (
            <button type="button" disabled={busy} onClick={() => void save(null).then((ok) => ok && setEditing(false))}>
              Clear from {monthLabel} on
            </button>
          )}
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="money-tx-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setTyped(line.budgetCents === null ? "" : (line.budgetCents / 100).toFixed(2));
              setEditing(true);
            }}
          >
            Set budget
          </button>
        </div>
      )}
    </li>
  );
}

function AddBudget({ categories, monthLabel, busy, save }: { categories: MoneyCategory[]; monthLabel: string; busy: boolean; save: (categoryId: string, amountCents: number) => Promise<boolean> }) {
  const [categoryId, setCategoryId] = useState("");
  const [typed, setTyped] = useState("");
  const amount = dollarsToCents(typed);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!categoryId || amount === undefined) return;
    if (await save(categoryId, amount)) {
      setCategoryId("");
      setTyped("");
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <fieldset className="money-tx-actions" aria-label="Add a budget">
        <legend>Add a budget from {monthLabel} on</legend>
        <label>
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <AmountInput typed={typed} setTyped={setTyped} />
        <button type="submit" disabled={busy || !categoryId || amount === undefined}>
          Add
        </button>
      </fieldset>
    </form>
  );
}

/** The typed monthly budget, in dollars. */
function AmountInput({ typed, setTyped }: { typed: string; setTyped: (value: string) => void }) {
  return (
    <label>
      Monthly budget
      <input inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="$600" />
    </label>
  );
}
