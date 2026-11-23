import type { PantryProduct, PantryProductChange } from "@kitchen/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { dollarsToCents, fetchPantry, formatPrice, formatQuantity, updateProduct } from "./pantry.js";

interface Props {
  apiUrl: string;
  getToken: () => Promise<string>;
  /** Called when the API says the sign-in has lapsed. */
  onSignedOut: () => void;
}

type Loaded = { state: "loading" } | { state: "error"; reason: string } | { state: "ready"; products: PantryProduct[] };

const today = (): string => new Date().toLocaleDateString("en-CA"); // local date as YYYY-MM-DD

export function PantryScreen({ apiUrl, getToken, onSignedOut }: Props) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });

  const load = useCallback(async () => {
    const result = await fetchPantry(apiUrl, getToken);
    if (result.state === "signed-out") return onSignedOut();
    setLoaded(
      result.state === "ok" ? { state: "ready", products: result.value } : { state: "error", reason: result.reason },
    );
  }, [apiUrl, getToken, onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (product: PantryProduct) =>
    setLoaded((current) =>
      current.state === "ready"
        ? { state: "ready", products: current.products.map((p) => (p.id === product.id ? product : p)) }
        : current,
    );

  return (
    <section aria-labelledby="pantry-heading" className="pantry">
      <h2 id="pantry-heading">Pantry</h2>
      {loaded.state === "loading" && <p>Loading the pantry…</p>}
      {loaded.state === "error" && (
        <p role="alert">
          Couldn't load the pantry ({loaded.reason}). <button type="button" onClick={() => void load()}>Try again</button>
        </p>
      )}
      {loaded.state === "ready" && loaded.products.length === 0 && (
        <p>No products yet. Add some through the API; screens for adding come with the shopping list.</p>
      )}
      {loaded.state === "ready" && (
        <ul className="products">
          {loaded.products.map((product) => (
            <li key={product.id}>
              <ProductCard
                product={product}
                change={(change) => updateProduct(apiUrl, getToken, product.id, change)}
                onChanged={replace}
                onSignedOut={onSignedOut}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface CardProps {
  product: PantryProduct;
  change: (change: PantryProductChange) => ReturnType<typeof updateProduct>;
  onChanged: (product: PantryProduct) => void;
  onSignedOut: () => void;
}

function ProductCard({ product, change, onChanged, onSignedOut }: CardProps) {
  const [amount, setAmount] = useState("");
  const [priceText, setPriceText] = useState("");
  const [sizeText, setSizeText] = useState("");
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  async function apply(next: PantryProductChange, done?: () => void) {
    setBusy(true);
    setProblem(undefined);
    const result = await change(next);
    setBusy(false);
    if (result.state === "signed-out") return onSignedOut();
    if (result.state === "error") return setProblem(result.reason);
    onChanged(result.value);
    done?.();
  }

  const quantity = amount.trim() === "" ? Number.NaN : Number(amount);
  const hasAmount = Number.isFinite(quantity) && quantity >= 0;
  const stockChange = (kind: "add" | "use" | "set") => () => {
    if (!hasAmount) return setProblem("Type an amount first.");
    void apply({ stock: kind === "set" ? { set: quantity } : { delta: kind === "add" ? quantity : -quantity } }, () => setAmount(""));
  };

  function savePrice(event: FormEvent) {
    event.preventDefault();
    const cents = dollarsToCents(priceText);
    const size = Number(sizeText);
    if (cents === undefined) return setProblem("Type the price like 2.49.");
    if (!Number.isFinite(size) || size <= 0) return setProblem("Type the package size.");
    void apply({ price: { priceCents: cents, packageQuantity: size, date } }, () => {
      setPriceText("");
      setSizeText("");
    });
  }

  return (
    <article className="product">
      <header>
        <h3>{product.name}</h3>
        <p className="stock" aria-label={`In stock: ${formatQuantity(product.stockQuantity, product.unit)}`}>
          {formatQuantity(product.stockQuantity, product.unit)}
        </p>
      </header>
      <p className="price">
        {product.priceCents === null || product.packageQuantity === null
          ? "No price yet"
          : `${formatPrice(product.priceCents)} for ${formatQuantity(product.packageQuantity, product.unit)}, ${product.priceDate ?? ""}`}
      </p>

      <label className="staple">
        <input
          type="checkbox"
          checked={product.staple}
          disabled={busy}
          onChange={(e) => void apply({ staple: e.target.checked })}
        />{" "}
        Staple (tracked; anything else is assumed needed)
      </label>

      <div className="stock-controls">
        <label>
          Amount ({product.unit})
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button type="button" disabled={busy} onClick={stockChange("add")}>Add</button>
        <button type="button" disabled={busy} onClick={stockChange("use")}>Use</button>
        <button type="button" disabled={busy} onClick={stockChange("set")}>Set to</button>
      </div>

      <details>
        <summary>Update price</summary>
        <form onSubmit={savePrice} className="price-form">
          <label>
            Price ($)
            <input inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
          </label>
          <label>
            For package of ({product.unit})
            <input type="number" inputMode="decimal" min="0" step="any" value={sizeText} onChange={(e) => setSizeText(e.target.value)} />
          </label>
          <label>
            Seen on
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button type="submit" disabled={busy}>Save price</button>
        </form>
      </details>

      {problem && <p role="alert">{problem}</p>}
    </article>
  );
}
