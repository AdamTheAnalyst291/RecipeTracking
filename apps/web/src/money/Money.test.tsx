// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Money } from "./Money.js";
import { inMemoryMoneyApi } from "./test-api.js";
import { inMemoryBudgetApi } from "./test-budget-api.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 20_000 });

function open(api = inMemoryMoneyApi()) {
  const user = userEvent.setup();
  render(<Money api={api} budgets={inMemoryBudgetApi()} today="2026-11-27" />);
  return { api, user };
}
const row = (payee: string) => screen.getByRole("listitem", { name: new RegExp(payee) });

describe("the money screen: transactions", () => {
  it("lists transactions newest first with amount, date and category", async () => {
    open();
    await screen.findByText("Sample Grocer");
    const rows = within(screen.getByRole("list", { name: "Transactions" })).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("heading").textContent)).toEqual(["Corner Bakery", "Payroll Example Co", "Sample Grocer"]);
    expect(within(row("Sample Grocer")).getByText("−$84.37")).toBeTruthy();
    expect(within(row("Payroll Example Co")).getByText("+$1,500.00")).toBeTruthy();
    expect((within(row("Sample Grocer")).getByLabelText("Category") as HTMLSelectElement).value).toBe("c-groceries");
  });

  it("re-categorizes a transaction from its menu", async () => {
    const { api, user } = open();
    await screen.findByText("Sample Grocer");
    await user.selectOptions(within(row("Corner Bakery")).getByLabelText("Category"), "Household");
    await vi.waitFor(() => expect(api.txs.find((t) => t.id === "t3")?.category).toBe("Household"));
    expect(within(row("Corner Bakery")).getByText(/set by you/)).toBeTruthy();
  });

  it("shows only uncategorized transactions when asked", async () => {
    const { user } = open();
    await screen.findByText("Sample Grocer");
    await user.click(screen.getByRole("checkbox", { name: "Only uncategorized" }));
    await vi.waitFor(() => expect(screen.queryByText("Sample Grocer")).toBeNull());
    expect(screen.getByText("Corner Bakery")).toBeTruthy();
  });

  it("splits a transaction, only letting it save once the parts add up", async () => {
    const { api, user } = open();
    await screen.findByText("Sample Grocer");
    await user.click(within(row("Sample Grocer")).getByRole("button", { name: "Split" }));

    const editor = screen.getByRole("group", { name: "Split Sample Grocer" });
    const amounts = within(editor).getAllByLabelText("Amount");
    const cats = within(editor).getAllByLabelText("Category");
    await user.selectOptions(cats[0]!, "Groceries");
    await user.type(amounts[0]!, "60");
    await user.selectOptions(cats[1]!, "Household");
    await user.type(amounts[1]!, "20");

    expect(within(editor).getByText("$4.37 left to split of $84.37")).toBeTruthy();
    const save = within(editor).getByRole("button", { name: "Save split" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.clear(amounts[1]!);
    await user.type(amounts[1]!, "24.37");
    expect(within(editor).getByText("Adds up of $84.37")).toBeTruthy();
    expect(save.disabled).toBe(false);
    await user.click(save);

    await vi.waitFor(() => expect(api.txs.find((t) => t.id === "t1")?.splits.map((s) => s.amountCents)).toEqual([-6000, -2437]));
    expect(screen.queryByRole("group", { name: "Split Sample Grocer" })).toBeNull();
    expect(within(row("Sample Grocer")).getByText("Groceries −$60.00 · Household −$24.37")).toBeTruthy();
  });

  it("shows the API's refusal and keeps the editor open", async () => {
    const api = inMemoryMoneyApi();
    api.setSplits = async () => Promise.reject(new Error("The splits must add up to the transaction."));
    const { user } = open(api);
    await screen.findByText("Sample Grocer");
    await user.click(within(row("Corner Bakery")).getByRole("button", { name: "Split" }));
    const editor = screen.getByRole("group", { name: "Split Corner Bakery" });
    const amounts = within(editor).getAllByLabelText("Amount");
    const cats = within(editor).getAllByLabelText("Category");
    await user.selectOptions(cats[0]!, "Groceries");
    await user.type(amounts[0]!, "10");
    await user.selectOptions(cats[1]!, "Household");
    await user.type(amounts[1]!, "2.50");
    await user.click(within(editor).getByRole("button", { name: "Save split" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/add up/);
    expect(screen.getByRole("group", { name: "Split Corner Bakery" })).toBeTruthy();
  });
});

describe("the money screen: rules and categories", () => {
  it("adds a category", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("tab", { name: "Rules" }));
    await user.type(screen.getByLabelText("New category"), "Eating out");
    await user.click(screen.getByRole("button", { name: "Add category" }));
    await vi.waitFor(() => expect(api.cats.map((c) => c.name)).toContain("Eating out"));
  });

  it("adds rules, reorders and removes them, and runs them", async () => {
    const { api, user } = open();
    await user.click(await screen.findByRole("tab", { name: "Rules" }));

    const addRule = async (pattern: string, category: string) => {
      await user.type(screen.getByLabelText("Text to match"), pattern);
      await user.selectOptions(screen.getByLabelText("Set category to"), category);
      await user.click(screen.getByRole("button", { name: "Add rule" }));
      await screen.findByText(new RegExp(`“${pattern}”`));
    };
    await addRule("bakery", "Household");
    await addRule("grocer", "Groceries");

    const ruleRows = () => within(screen.getByRole("list", { name: "Rules, in the order they run" })).getAllByRole("listitem").map((li) => li.textContent);
    expect(ruleRows()[0]).toMatch(/bakery/);
    await user.click(screen.getByRole("button", { name: /Move up: Payee contains “grocer”/ }));
    await vi.waitFor(() => expect(ruleRows()[0]).toMatch(/grocer/));
    expect(api.ruleList.map((r) => r.pattern)).toEqual(["grocer", "bakery"]);

    await user.click(screen.getByRole("button", { name: "Run rules now" }));
    expect(await screen.findByText(/Rules categorized 1 transaction\b/)).toBeTruthy();
    expect(api.txs.find((t) => t.id === "t3")?.category).toBe("Household");

    await user.click(screen.getByRole("button", { name: /Remove: Payee contains “bakery”/ }));
    await vi.waitFor(() => expect(api.ruleList.map((r) => r.pattern)).toEqual(["grocer"]));
  });
});

describe("the money screen when the API is down", () => {
  it("says why, and doesn't claim there are no transactions", async () => {
    const api = inMemoryMoneyApi();
    api.transactions = async () => Promise.reject(new Error("Money isn't available right now."));
    open(api);
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't available/);
    expect(screen.queryByText(/No transactions yet/)).toBeNull();
  });
});

describe("the money screen: budgets", () => {
  it("shows this month's spend vs budget on its own tab, Groceries at the top", async () => {
    const user = userEvent.setup();
    render(<Money api={inMemoryMoneyApi()} budgets={inMemoryBudgetApi()} today="2026-11-27" />);
    await user.click(screen.getByRole("tab", { name: "Budgets" }));
    expect(await screen.findByRole("heading", { name: "November 2026" })).toBeTruthy();
    const lines = within(screen.getByRole("list", { name: "Budgets" })).getAllByRole("listitem");
    expect(within(lines[0]!).getByRole("heading").textContent).toBe("Groceries");
  });
});
