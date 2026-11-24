import type { ShoppingItem, ShoppingList } from "@kitchen/shared";
import { ShoppingApiError, type ShoppingApi } from "./api.js";

/** A made-up list for the shopping screen tests; the repo is public. */
export const sampleList = (): ShoppingList => ({
  id: "11111111-1111-4111-8111-111111111111",
  start: "2026-11-23",
  end: "2026-11-29",
  createdAt: "2026-11-23T08:00:00.000Z",
  items: [
    { id: "i1", foodId: "f1", name: "Flour", quantity: 200, unit: "g", unitId: "u-g", source: "plan", checked: false },
    { id: "i2", foodId: "f2", name: "Lentils", quantity: 1.5, unit: "kg", unitId: "u-kg", source: "plan", checked: false },
    { id: "i3", foodId: null, name: "Foil", quantity: null, unit: null, unitId: null, source: "manual", checked: false },
  ],
});

/** A shopping API held in memory, for the screen tests. */
export function inMemoryShoppingApi(initial: ShoppingList | null = sampleList()): ShoppingApi & {
  list: ShoppingList | null;
  generated: number;
  failNextWith?: ShoppingApiError;
} {
  let next = 1;
  const api: ReturnType<typeof inMemoryShoppingApi> = {
    list: initial,
    generated: 0,
    async latest() {
      const fail = api.failNextWith;
      if (fail) {
        api.failNextWith = undefined;
        throw fail;
      }
      return api.list && structuredClone(api.list);
    },
    async generate() {
      api.generated++;
      api.list = { ...sampleList(), id: `22222222-2222-4222-8222-22222222222${api.generated}` };
      return structuredClone(api.list);
    },
    async addItem(_listId, input) {
      const item: ShoppingItem = {
        id: `new${next++}`,
        foodId: null,
        name: input.name,
        quantity: input.quantity ?? null,
        unit: input.unitId ? "l" : null,
        unitId: input.unitId ?? null,
        source: "manual",
        checked: false,
      };
      api.list?.items.push(item);
      return { ...item };
    },
    async setChecked(_listId, itemId, checked) {
      const item = api.list?.items.find((i) => i.id === itemId);
      if (!item) throw new ShoppingApiError(404, "No such item.");
      item.checked = checked;
      return { ...item };
    },
    async removeItem(_listId, itemId) {
      if (!api.list) return;
      api.list.items = api.list.items.filter((i) => i.id !== itemId);
    },
  };
  return api;
}
