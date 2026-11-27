import type { MoneyCategory, MoneyRule, MoneyRuleField, MoneyRuleMatch, MoneySplitsChange, MoneyTransaction, NewMoneyRule } from "@kitchen/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MoneyApi } from "./api.js";
import { centsText, dollarsToCents, ruleText } from "./format.js";
import "./money.css";

const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong.");

interface Props {
  api: MoneyApi;
}

/**
 * Money (card $1, ADR-27): review bank transactions and set their category, split one across
 * categories, and keep the rules that categorize new ones. Transactions themselves only come
 * from the bank import; nothing here creates them or changes an amount.
 */
export function Money({ api }: Props) {
  const [tab, setTab] = useState<"transactions" | "rules">("transactions");
  const [txs, setTxs] = useState<MoneyTransaction[] | undefined>(undefined);
  const [cats, setCats] = useState<MoneyCategory[]>([]);
  const [rules, setRules] = useState<MoneyRule[]>([]);
  const [onlyUncategorized, setOnlyUncategorized] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Categories and rules load once; changes made here keep them current.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.categories(), api.rules()]).then(
      ([c, r]) => {
        if (cancelled) return;
        setCats(c);
        setRules(r);
      },
      (error: unknown) => !cancelled && setProblem(reasonOf(error)),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Transactions load again when the filter changes.
  useEffect(() => {
    let cancelled = false;
    api.transactions({ uncategorized: onlyUncategorized }).then(
      (t) => {
        if (cancelled) return;
        setTxs(t);
        setProblem(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        setTxs([]);
        setProblem(reasonOf(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, onlyUncategorized]);

  /** Runs a change; a failure keeps the screen as it was and says why. Resolves true when it worked. */
  const run = useCallback(async (change: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      await change();
      setProblem(null);
      return true;
    } catch (error) {
      setProblem(reasonOf(error));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const replace = (saved: MoneyTransaction) => setTxs((current) => current?.map((t) => (t.id === saved.id ? saved : t)));

  return (
    <section className="money" aria-label="Money">
      <h2>Money</h2>
      <div role="tablist" className="money-tabs">
        <button type="button" role="tab" aria-selected={tab === "transactions"} onClick={() => setTab("transactions")}>
          Transactions
        </button>
        <button type="button" role="tab" aria-selected={tab === "rules"} onClick={() => setTab("rules")}>
          Rules
        </button>
      </div>
      {problem && (
        <p role="alert" className="money-problem">
          {problem}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {tab === "transactions" ? (
        <Transactions
          txs={txs}
          cats={cats}
          busy={busy}
          failed={problem !== null}
          onlyUncategorized={onlyUncategorized}
          setOnlyUncategorized={setOnlyUncategorized}
          setCategory={(t, categoryId) => run(async () => replace(await api.setCategory(t.id, categoryId)))}
          setSplits={(t, splits) => run(async () => replace(await api.setSplits(t.id, splits)))}
        />
      ) : (
        <Rules
          cats={cats}
          rules={rules}
          busy={busy}
          addCategory={(name) =>
            run(async () => {
              const added = await api.addCategory(name);
              setCats((c) => [...c, added].sort((a, b) => a.name.localeCompare(b.name)));
            })
          }
          addRule={(rule) =>
            run(async () => {
              const added = await api.addRule(rule);
              setRules((r) => [...r, added]);
            })
          }
          removeRule={(rule) =>
            run(async () => {
              await api.removeRule(rule.id);
              setRules((r) => r.filter((x) => x.id !== rule.id));
            })
          }
          moveRule={(index, by) =>
            run(async () => {
              const ids = rules.map((r) => r.id);
              const [moved] = ids.splice(index, 1);
              ids.splice(index + by, 0, moved!);
              setRules(await api.reorderRules(ids));
            })
          }
          applyRules={() =>
            run(async () => {
              const { categorized } = await api.applyRules();
              setTxs(await api.transactions({ uncategorized: onlyUncategorized }));
              setNotice(`Rules categorized ${categorized} transaction${categorized === 1 ? "" : "s"}.`);
            })
          }
        />
      )}
    </section>
  );
}

type Splits = MoneySplitsChange["splits"];

function Transactions(props: {
  txs: MoneyTransaction[] | undefined;
  cats: MoneyCategory[];
  busy: boolean;
  failed: boolean;
  onlyUncategorized: boolean;
  setOnlyUncategorized: (value: boolean) => void;
  setCategory: (t: MoneyTransaction, categoryId: string | null) => Promise<boolean>;
  setSplits: (t: MoneyTransaction, splits: Splits) => Promise<boolean>;
}) {
  const { txs, cats, busy } = props;
  const [splitting, setSplitting] = useState<string | null>(null);

  return (
    <>
      <label className="money-filter">
        <input type="checkbox" checked={props.onlyUncategorized} onChange={(e) => props.setOnlyUncategorized(e.target.checked)} />
        Only uncategorized
      </label>
      {txs === undefined && <p>Loading transactions…</p>}
      {txs?.length === 0 && !props.failed && <p>{props.onlyUncategorized ? "Everything has a category." : "No transactions yet. They arrive once the bank is connected."}</p>}
      <ul className="money-list" aria-label="Transactions">
        {txs?.map((t) => (
          <li key={t.id} className="money-tx" aria-label={`${t.payee} ${centsText(t.amountCents)} ${t.date}`}>
            <div className="money-tx-top">
              <h3>{t.payee}</h3>
              <span className={t.amountCents < 0 ? "money-amount" : "money-amount money-in"}>{centsText(t.amountCents)}</span>
            </div>
            <p className="money-meta">
              {t.date} · {t.account}
              {t.categorySource === "rule" && " · set by a rule"}
              {t.categorySource === "manual" && " · set by you"}
            </p>
            {t.splits.length > 0 && <p className="money-splits">{t.splits.map((s) => `${s.category} ${centsText(s.amountCents)}`).join(" · ")}</p>}
            <div className="money-tx-actions">
              <label>
                Category
                <select
                  value={t.splits.length > 0 ? "split" : (t.categoryId ?? "")}
                  disabled={busy}
                  onChange={(e) => void props.setCategory(t, e.target.value === "" ? null : e.target.value)}
                >
                  <option value="">Uncategorized</option>
                  {t.splits.length > 0 && (
                    <option value="split" disabled>
                      Split
                    </option>
                  )}
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {splitting !== t.id && (
                <button type="button" disabled={busy} onClick={() => setSplitting(t.id)}>
                  {t.splits.length > 0 ? "Edit split" : "Split"}
                </button>
              )}
            </div>
            {splitting === t.id && (
              <SplitEditor
                tx={t}
                cats={cats}
                busy={busy}
                onCancel={() => setSplitting(null)}
                onSave={async (splits) => {
                  if (await props.setSplits(t, splits)) setSplitting(null);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

interface Part {
  key: number;
  categoryId: string;
  amount: string;
}

/** Edits the parts of one transaction. Amounts are typed without a sign; they take the transaction's. */
function SplitEditor({ tx, cats, busy, onCancel, onSave }: { tx: MoneyTransaction; cats: MoneyCategory[]; busy: boolean; onCancel: () => void; onSave: (splits: Splits) => Promise<void> }) {
  const [parts, setParts] = useState<Part[]>(() =>
    tx.splits.length > 0
      ? tx.splits.map((s, i) => ({ key: i, categoryId: s.categoryId, amount: (Math.abs(s.amountCents) / 100).toFixed(2) }))
      : [
          { key: 0, categoryId: "", amount: "" },
          { key: 1, categoryId: "", amount: "" },
        ],
  );
  const sign = tx.amountCents < 0 ? -1 : 1;
  const total = Math.abs(tx.amountCents);
  const cents = parts.map((p) => dollarsToCents(p.amount));
  const assigned = cents.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  const left = total - assigned;
  const complete = parts.every((p, i) => p.categoryId !== "" && (cents[i] ?? 0) > 0) && new Set(parts.map((p) => p.categoryId)).size === parts.length;
  const ok = complete && left === 0;
  const change = (key: number, patch: Partial<Part>) => setParts((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  return (
    <fieldset className="money-split">
      <legend>Split {tx.payee}</legend>
      {parts.map((p) => (
        <div key={p.key} className="money-part">
          <label>
            Category
            <select value={p.categoryId} onChange={(e) => change(p.key, { categoryId: e.target.value })}>
              <option value="">Choose…</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input inputMode="decimal" value={p.amount} onChange={(e) => change(p.key, { amount: e.target.value })} placeholder="0.00" />
          </label>
          {parts.length > 2 && (
            <button type="button" onClick={() => setParts((ps) => ps.filter((x) => x.key !== p.key))}>
              Remove part
            </button>
          )}
        </div>
      ))}
      <p className="money-left" aria-live="polite">
        {left === 0 ? "Adds up" : left > 0 ? `${centsText(left, { sign: false })} left to split` : `${centsText(-left, { sign: false })} too much`}
        {" "}of {centsText(total, { sign: false })}
      </p>
      <div className="money-split-actions">
        <button type="button" onClick={() => setParts((ps) => [...ps, { key: Math.max(...ps.map((x) => x.key)) + 1, categoryId: "", amount: "" }])}>
          Add a part
        </button>
        <button
          type="button"
          disabled={busy || !ok}
          onClick={() => void onSave(parts.map((p, i) => ({ categoryId: p.categoryId, amountCents: sign * (cents[i] ?? 0) })))}
        >
          Save split
        </button>
        {tx.splits.length > 0 && (
          <button type="button" disabled={busy} onClick={() => void onSave([])}>
            Remove split
          </button>
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </fieldset>
  );
}

function Rules(props: {
  cats: MoneyCategory[];
  rules: MoneyRule[];
  busy: boolean;
  addCategory: (name: string) => Promise<boolean>;
  addRule: (rule: NewMoneyRule) => Promise<boolean>;
  removeRule: (rule: MoneyRule) => Promise<boolean>;
  moveRule: (index: number, by: -1 | 1) => Promise<boolean>;
  applyRules: () => Promise<boolean>;
}) {
  const { cats, rules, busy } = props;
  const [category, setCategory] = useState("");
  const [field, setField] = useState<MoneyRuleField>("payee");
  const [match, setMatch] = useState<MoneyRuleMatch>("contains");
  const [pattern, setPattern] = useState("");
  const [ruleCategory, setRuleCategory] = useState("");

  const addCategory = async (event: FormEvent) => {
    event.preventDefault();
    if (category.trim() === "") return;
    if (await props.addCategory(category)) setCategory("");
  };
  const addRule = async (event: FormEvent) => {
    event.preventDefault();
    if (pattern.trim() === "" || ruleCategory === "") return;
    if (await props.addRule({ field, match, pattern, categoryId: ruleCategory })) setPattern("");
  };

  return (
    <>
      <h3>Rules</h3>
      <p className="money-meta">New transactions get the category of the first rule that matches. Rules never change a category you set or a split.</p>
      {rules.length === 0 && <p>No rules yet.</p>}
      <ol className="money-list" aria-label="Rules, in the order they run">
        {rules.map((r, i) => {
          const label = ruleText(r);
          return (
            <li key={r.id} className="money-rule">
              <span>{label}</span>
              <span className="money-rule-actions">
                <button type="button" aria-label={`Move up: ${label}`} disabled={busy || i === 0} onClick={() => void props.moveRule(i, -1)}>
                  ↑
                </button>
                <button type="button" aria-label={`Move down: ${label}`} disabled={busy || i === rules.length - 1} onClick={() => void props.moveRule(i, 1)}>
                  ↓
                </button>
                <button type="button" aria-label={`Remove: ${label}`} disabled={busy} onClick={() => void props.removeRule(r)}>
                  Remove
                </button>
              </span>
            </li>
          );
        })}
      </ol>
      <form className="money-form" onSubmit={(e) => void addRule(e)}>
        <label>
          Look at
          <select value={field} onChange={(e) => setField(e.target.value as MoneyRuleField)}>
            <option value="payee">Payee</option>
            <option value="description">Description</option>
          </select>
        </label>
        <label>
          Match
          <select value={match} onChange={(e) => setMatch(e.target.value as MoneyRuleMatch)}>
            <option value="contains">contains</option>
            <option value="equals">is exactly</option>
          </select>
        </label>
        <label>
          Text to match
          <input value={pattern} maxLength={200} onChange={(e) => setPattern(e.target.value)} placeholder="grocer" />
        </label>
        <label>
          Set category to
          <select value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value)}>
            <option value="">Choose…</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || pattern.trim() === "" || ruleCategory === ""}>
          Add rule
        </button>
      </form>
      <button type="button" disabled={busy || rules.length === 0} onClick={() => void props.applyRules()}>
        Run rules now
      </button>

      <h3>Categories</h3>
      <ul className="money-cats">
        {cats.map((c) => (
          <li key={c.id}>{c.name}</li>
        ))}
      </ul>
      <form className="money-form" onSubmit={(e) => void addCategory(e)}>
        <label>
          New category
          <input value={category} maxLength={100} onChange={(e) => setCategory(e.target.value)} placeholder="Groceries" />
        </label>
        <button type="submit" disabled={busy || category.trim() === ""}>
          Add category
        </button>
      </form>
    </>
  );
}
