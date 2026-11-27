import type { ReactNode } from "react";
import type { MealPlanApi } from "../mealPlan/api.js";
import { MealPlan } from "../mealPlan/MealPlan.js";
import type { MoneyApi } from "../money/api.js";
import type { BudgetApi } from "../money/budget-api.js";
import { Money } from "../money/Money.js";
import { PantryScreen } from "../PantryScreen.js";
import type { RecipeApi } from "../recipes/api.js";
import { Recipes } from "../recipes/Recipes.js";
import type { ShoppingApi } from "../shopping/api.js";
import { Shopping } from "../shopping/Shopping.js";
import { AppShell, type Screen } from "./AppShell.js";
import { Today } from "./Today.js";
import { useToday } from "./useToday.js";

interface Props {
  mealPlan: MealPlanApi;
  recipes: RecipeApi;
  shopping: ShoppingApi;
  pantry: { apiUrl: string; getToken: () => Promise<string>; onSignedOut: () => void };
  money: MoneyApi;
  /** Monthly budgets (card $3), shown as a tab of the money screen. */
  budgets?: BudgetApi;
  /** Who is signed in, with the way to sign out. Shown on Today. */
  account: ReactNode;
  /** Today as `YYYY-MM-DD`; the device's clock unless a test says otherwise. */
  today?: string;
}

/**
 * The signed-in app: its screens behind the bottom navigation. A new screen (money, say) is
 * one more entry in this list.
 */
export function Kitchen({ mealPlan, recipes, shopping, pantry, money, budgets, account, today: fixedToday }: Props) {
  const deviceToday = useToday();
  const today = fixedToday ?? deviceToday;
  const screens: Screen[] = [
    {
      id: "today",
      label: "Today",
      icon: "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19",
      render: (go) => (
        <>
          <Today api={mealPlan} today={today} onPlan={() => go("plan")} />
          {account}
        </>
      ),
    },
    {
      id: "plan",
      label: "Plan",
      icon: "M4 6h16v15H4zM4 10h16M8 3v5M16 3v5",
      render: () => <MealPlan api={mealPlan} recipes={recipes} today={today} />,
    },
    {
      id: "shopping",
      label: "Shopping",
      icon: "M3 4h2l2.5 11h10L20 7H6.5M9 20h.01M17 20h.01",
      render: () => <Shopping api={shopping} />,
    },
    {
      id: "pantry",
      label: "Pantry",
      icon: "M7 3h10v3H7zM6 8h12v13H6zM6 13h12",
      render: () => <PantryScreen {...pantry} />,
    },
    {
      id: "recipes",
      label: "Recipes",
      icon: "M12 6c-2-2-5-2-8-1v14c3-1 6-1 8 1 2-2 5-2 8-1V5c-3-1-6-1-8 1zM12 6v14",
      // So an open recipe or a half-typed one survives a look at the pantry or the list.
      keepOpen: true,
      render: () => <Recipes api={recipes} />,
    },
    {
      id: "money",
      label: "Money",
      icon: "M3 6h18v12H3zM3 10h18M7 15h3",
      render: () => <Money api={money} budgets={budgets} today={today} />,
    },
  ];
  return <AppShell screens={screens} />;
}
