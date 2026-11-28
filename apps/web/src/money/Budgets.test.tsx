// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Budgets } from "./Budgets.js";
import { inMemoryBudgetApi } from "./test-budget-api.js";
import { sampleCategories } from "./test-api.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 20_000 });

function open(api = inMemoryBudgetApi()) {
  const user = userEvent.setup();
  render(<Budgets api={api} categories={[...sampleCategories(), { id: "c-books", name: "Books", kind: "spending" }]} today="2026-11-27" />);
  return { api, user };
}
const line = (category: string) => screen.getByRole("listitem", { name: new RegExp(`^${category}`) });

describe("the budget view", () => {
  it("shows this month's spend vs budget, Groceries at the top", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "November 2026" })).toBeTruthy();
    const lines = within(screen.getByRole("list", { name: "Budgets" })).getAllByRole("listitem");
    expect(lines.map((l) => within(l).getByRole("heading").textContent)).toEqual(["Groceries", "Household"]);
    expect(within(line("Groceries")).getByText("$412.50 of $600.00")).toBeTruthy();
    expect(within(line("Groceries")).getByText("$187.50 left")).toBeTruthy();
    expect(within(line("Household")).getByText(/\$35\.00 spent, no budget/)).toBeTruthy();
  });

  it("goes back to past months, and not past this one", async () => {
    const { user } = open();
    await screen.findByRole("heading", { name: "November 2026" });
    expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(await screen.findByRole("heading", { name: "October 2026" })).toBeTruthy();
    expect(await within(line("Groceries")).findByText("$650.00 over")).toBeTruthy();
  });

  it("sets a budget from this month on", async () => {
    const { api, user } = open();
    await screen.findByRole("heading", { name: "November 2026" });
    await user.click(within(line("Household")).getByRole("button", { name: "Set budget" }));
    await user.type(within(line("Household")).getByLabelText("Monthly budget"), "80");
    await user.click(within(line("Household")).getByRole("button", { name: "Save from November on" }));
    await vi.waitFor(() => expect(api.calls).toContainEqual(["c-household", "2026-11", 8000]));
    expect(await within(line("Household")).findByText("$35.00 of $80.00")).toBeTruthy();
  });

  it("adds a budget for a category not listed yet", async () => {
    const { api, user } = open();
    await screen.findByRole("heading", { name: "November 2026" });
    const form = screen.getByRole("group", { name: "Add a budget" });
    await user.selectOptions(within(form).getByLabelText("Category"), "Books");
    await user.type(within(form).getByLabelText("Monthly budget"), "25");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(api.calls).toContainEqual(["c-books", "2026-11", 2500]));
    expect(await screen.findByText("$0.00 of $25.00")).toBeTruthy();
  });

  it("offers only spending categories for a new budget (card $6)", async () => {
    const cats = [...sampleCategories(), { id: "c-books", name: "Books", kind: "spending" as const }, { id: "c-pay", name: "Pay", kind: "not-spending" as const }];
    render(<Budgets api={inMemoryBudgetApi()} categories={cats} today="2026-11-27" />);
    await screen.findByRole("heading", { name: "November 2026" });
    const options = within(within(screen.getByRole("group", { name: "Add a budget" })).getByLabelText("Category")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Choose…", "Books"]);
  });

  it("clears a budget from this month on", async () => {
    const { api, user } = open();
    await screen.findByRole("heading", { name: "November 2026" });
    await user.click(within(line("Groceries")).getByRole("button", { name: "Set budget" }));
    await user.click(within(line("Groceries")).getByRole("button", { name: "Clear from November on" }));
    await vi.waitFor(() => expect(api.calls).toContainEqual(["c-groceries", "2026-11", null]));
  });

  it("says why when the budgets can't load", async () => {
    const api = inMemoryBudgetApi();
    api.month = async () => Promise.reject(new Error("Budgets aren't available right now."));
    open(api);
    expect((await screen.findByRole("alert")).textContent).toContain("Budgets aren't available right now.");
  });
});
