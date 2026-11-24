import type { ApiError, MealPlanWeekResponse, NewPlannedMeal, PlannedMeal, PlannedMealChange } from "@kitchen/shared";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the meal plan screen needs from the API; tests swap in an in-memory one. */
export interface MealPlanApi {
  week(start: string): Promise<PlannedMeal[]>;
  add(meal: NewPlannedMeal): Promise<PlannedMeal>;
  update(id: string, change: PlannedMealChange): Promise<PlannedMeal>;
  remove(id: string): Promise<void>;
}

/** A request the API refused or couldn't answer. `message` is fit to show the person. */
export class MealPlanApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createMealPlanApi(apiUrl: string, getToken: () => Promise<string>, fetchFn: Fetch = fetch): MealPlanApi {
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      const auth = { Authorization: `Bearer ${await getToken()}` };
      const init: RequestInit =
        body === undefined
          ? { method, headers: auth }
          : { method, headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) };
      response = await fetchFn(`${apiUrl}${path}`, init);
    } catch (error) {
      throw new MealPlanApiError(0, error instanceof Error ? error.message : "Request failed");
    }
    if (response.ok) return response;
    const problem = (await response.json().catch(() => undefined)) as Partial<ApiError> | undefined;
    throw new MealPlanApiError(response.status, typeof problem?.error === "string" ? problem.error : `HTTP ${response.status}`);
  }

  return {
    async week(start) {
      return ((await (await send("GET", `/api/meal-plan?start=${encodeURIComponent(start)}`)).json()) as MealPlanWeekResponse).meals;
    },
    async add(meal) {
      return (await (await send("POST", "/api/meal-plan", meal)).json()) as PlannedMeal;
    },
    async update(id, change) {
      return (await (await send("PATCH", `/api/meal-plan/${id}`, change)).json()) as PlannedMeal;
    },
    async remove(id) {
      await send("DELETE", `/api/meal-plan/${id}`);
    },
  };
}
