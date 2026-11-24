// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShoppingApiError } from "./api.js";
import { Shopping, amountText, rangeText } from "./Shopping.js";
import { inMemoryShoppingApi, sampleList } from "./test-api.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 20_000 });

function open(api = inMemoryShoppingApi()) {
  const user = userEvent.setup();
  render(<Shopping api={api} />);
  return { api, user };
}
const toGet = () => within(screen.getByRole("list", { name: "To get" })).getAllByRole("listitem");

describe("the shopping list screen", () => {
  it("shows what to get with amounts and the dates it covers", async () => {
    open();

    await screen.findByText("Flour");
    expect(toGet().map((i) => i.textContent)).toEqual(["Flour200 g", "Lentils1.5 kg", "FoilRemove"]);
    expect(screen.getByText(/Mon 23 Nov – Sun 29 Nov · 3 to get/)).toBeTruthy();
  });

  it("explains when there is no list yet, and makes one for the coming week", async () => {
    const api = inMemoryShoppingApi(null);
    const { user } = open(api);

    await screen.findByText(/No list yet/);
    await user.click(screen.getByRole("button", { name: "Make a list for the coming week" }));

    await screen.findByText("Flour");
    expect(api.generated).toBe(1);
    expect(screen.queryByText(/No list yet/)).toBeNull();
  });

  it("ticks an item off into the Got it section and back again", async () => {
    const { api, user } = open();
    await screen.findByText("Flour");

    await user.click(screen.getByRole("checkbox", { name: /Flour/ }));

    const got = await screen.findByRole("list", { name: "Got it" });
    expect(within(got).getByText("Flour")).toBeTruthy();
    expect(toGet()).toHaveLength(2);
    expect(api.list?.items.find((i) => i.id === "i1")?.checked).toBe(true);

    await user.click(within(got).getByRole("checkbox", { name: /Flour/ }));
    await screen.findByText(/3 to get/);
    expect(screen.queryByRole("list", { name: "Got it" })).toBeNull();
  });

  it("adds an item by hand and clears the box", async () => {
    const { api, user } = open();
    await screen.findByText("Flour");

    await user.type(screen.getByLabelText("Add an item"), "  Milk, 2 L ");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await screen.findByText("Milk, 2 L");
    expect((screen.getByLabelText("Add an item") as HTMLInputElement).value).toBe("");
    expect(api.list?.items.at(-1)).toMatchObject({ name: "Milk, 2 L", source: "manual" });
  });

  it("won't add an empty item", async () => {
    open();
    await screen.findByText("Flour");
    expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("removes only hand-added items", async () => {
    const { user } = open();
    await screen.findByText("Foil");

    expect(screen.queryByRole("button", { name: "Remove Flour" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove Foil" }));

    await screen.findByText(/2 to get/);
    expect(screen.queryByText("Foil")).toBeNull();
  });

  it("says when a list has nothing to buy", async () => {
    open(inMemoryShoppingApi({ ...sampleList(), items: [] }));
    await screen.findByText("Nothing to buy for these days.");
  });

  it("shows why a load or a change failed, and keeps the list as it was", async () => {
    const api = inMemoryShoppingApi();
    api.failNextWith = new ShoppingApiError(503, "The shopping list isn't available right now.");
    const { user } = open(api);
    expect((await screen.findByRole("alert")).textContent).toContain("isn't available");

    cleanup();
    const second = inMemoryShoppingApi();
    second.setChecked = async () => {
      throw new ShoppingApiError(404, "No such item.");
    };
    render(<Shopping api={second} />);
    await screen.findByText("Flour");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: /Flour/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("No such item.");
    expect(toGet()).toHaveLength(3);
    void user;
  });
});

describe("amountText and rangeText", () => {
  it("formats amounts, with no amount as empty", () => {
    expect(amountText({ quantity: 1.5, unit: "kg" } as never)).toBe("1.5 kg");
    expect(amountText({ quantity: 3, unit: null } as never)).toBe("3");
    expect(amountText({ quantity: 0.333333, unit: "cup" } as never)).toBe("0.33 cup");
    expect(amountText({ quantity: null, unit: null } as never)).toBe("");
  });

  it("formats one day or a span", () => {
    expect(rangeText({ start: "2026-11-23", end: "2026-11-23" })).toBe("Mon 23 Nov");
    expect(rangeText({ start: "2026-11-23", end: "2026-11-29" })).toBe("Mon 23 Nov – Sun 29 Nov");
  });
});
