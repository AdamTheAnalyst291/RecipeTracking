import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { MoneyError, type Budgets } from "@kitchen/db";
import type { ApiError, MoneyMonthBudget } from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";

/** The budget store for the signed-in user's household, and that household's id. */
export type BudgetAccess = (user: SignedInUser) => Promise<{ budgets: Budgets; householdId: string }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for a request that can't be used; becomes a 400 with the message. */
class BadRequest extends Error {}

const fail = (status: number, error: string): HttpResponseInit => ({ status, jsonBody: { error } satisfies ApiError });
const STATUS = { "not-found": 404, invalid: 400, conflict: 409 } as const;

async function respond(context: InvocationContext, run: () => Promise<HttpResponseInit>): Promise<HttpResponseInit> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BadRequest) return fail(400, error.message);
    if (error instanceof MoneyError) return fail(STATUS[error.code], error.message);
    // The message may name the server or login, so it goes to the log and not to the caller.
    context.error("Budgets could not reach the database", error);
    return fail(503, "Budgets aren't available right now. Try again shortly.");
  }
}

async function readChange(request: HttpRequest): Promise<{ month: string; amountCents: number | null }> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    throw new BadRequest("The body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("The body must be a JSON object.");
  const { month, amountCents } = body as Record<string, unknown>;
  if (typeof month !== "string") throw new BadRequest("month is required, as YYYY-MM.");
  if (amountCents !== null && (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents))) {
    throw new BadRequest("amountCents is required, in whole cents (null clears the budget).");
  }
  return { month, amountCents };
}

/**
 * The budget routes (card $3, ADR-27), within the signed-in member's household: a month's
 * spend vs budget, and setting a category's monthly budget from a month on.
 */
export function createBudgetHandlers(access: BudgetAccess): Record<"budgets" | "budget", AuthenticatedHandler> {
  const route =
    (method: string, work: (request: HttpRequest, open: () => ReturnType<BudgetAccess>) => Promise<HttpResponseInit>): AuthenticatedHandler =>
    (request, context, user) =>
      respond(context, async () => (request.method === method ? work(request, () => access(user)) : fail(405, "Method not allowed.")));

  return {
    budgets: route("GET", async (request, open) => {
      const month = request.query.get("month");
      if (!month) throw new BadRequest("month is required, as YYYY-MM.");
      const { budgets, householdId } = await open();
      return { status: 200, jsonBody: (await budgets.month(householdId, month)) satisfies MoneyMonthBudget };
    }),

    budget: route("PUT", async (request, open) => {
      const categoryId = request.params.id ?? "";
      if (!GUID.test(categoryId)) throw new BadRequest("The category id must be an ID.");
      const { month, amountCents } = await readChange(request);
      const { budgets, householdId } = await open();
      return { status: 200, jsonBody: (await budgets.setBudget(householdId, categoryId, month, amountCents)) satisfies MoneyMonthBudget };
    }),
  };
}
