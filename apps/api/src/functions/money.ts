import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { CATEGORY_KINDS, MoneyError, type CategoryChange, type CategoryKind, type Money, type NewRule, type SplitInput, type TransactionFilter } from "@kitchen/db";
import type {
  ApiError,
  MoneyAccountsResponse,
  MoneyCategoriesResponse,
  MoneyRulesApplied,
  MoneyRulesResponse,
  MoneyTransactionsResponse,
} from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";

/** The money store for the signed-in user's household, and that household's id. */
export type MoneyAccess = (user: SignedInUser) => Promise<{ money: Money; householdId: string }>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown for a request that can't be used; becomes a 400 with the message. */
class BadRequest extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function readObject(request: HttpRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    throw new BadRequest("The body must be JSON.");
  }
  if (!isObject(body)) throw new BadRequest("The body must be a JSON object.");
  return body;
}

function guid(value: unknown, what: string): string {
  if (typeof value !== "string" || !GUID.test(value)) throw new BadRequest(`${what} must be an ID.`);
  return value;
}

const idParam = (request: HttpRequest, what: string) => guid(request.params.id ?? "", `The ${what} id`);

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest(`${key} is required.`);
  return value;
}

function kindFrom(value: unknown): CategoryKind {
  if (!CATEGORY_KINDS.includes(value as CategoryKind)) throw new BadRequest("kind must be spending or not-spending.");
  return value as CategoryKind;
}

function categoryChangeFrom(body: Record<string, unknown>): CategoryChange {
  const change: CategoryChange = {};
  if (body.name !== undefined) change.name = text(body, "name");
  if (body.kind !== undefined) change.kind = kindFrom(body.kind);
  if (change.name === undefined && change.kind === undefined) throw new BadRequest("Give a name or a kind.");
  return change;
}

function ruleFrom(body: Record<string, unknown>): NewRule {
  const field = body.field;
  const match = body.match;
  if (field !== "payee" && field !== "description") throw new BadRequest("field must be payee or description.");
  if (match !== "equals" && match !== "contains") throw new BadRequest("match must be equals or contains.");
  return { field, match, pattern: text(body, "pattern"), categoryId: guid(body.categoryId, "categoryId") };
}

function splitsFrom(body: Record<string, unknown>): SplitInput[] {
  const splits = body.splits;
  if (!Array.isArray(splits)) throw new BadRequest("splits must be a list.");
  return splits.map((s: unknown) => {
    if (!isObject(s)) throw new BadRequest("Each split must be an object.");
    if (typeof s.amountCents !== "number" || !Number.isSafeInteger(s.amountCents)) throw new BadRequest("Each split needs amountCents, in whole cents.");
    return { categoryId: guid(s.categoryId, "Each split's categoryId"), amountCents: s.amountCents };
  });
}

function filterFrom(request: HttpRequest): TransactionFilter {
  const filter: TransactionFilter = {};
  if (request.query.get("uncategorized") === "true") filter.uncategorized = true;
  const limit = request.query.get("limit");
  if (limit !== null) {
    if (!/^\d{1,4}$/.test(limit)) throw new BadRequest("limit must be a whole number.");
    filter.limit = Number(limit);
  }
  return filter;
}

const fail = (status: number, error: string): HttpResponseInit => ({ status, jsonBody: { error } satisfies ApiError });
const STATUS = { "not-found": 404, invalid: 400, conflict: 409 } as const;

async function respond(context: InvocationContext, run: () => Promise<HttpResponseInit>): Promise<HttpResponseInit> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BadRequest) return fail(400, error.message);
    if (error instanceof MoneyError) return fail(STATUS[error.code], error.message);
    // The message may name the server or login, so it goes to the log and not to the caller.
    context.error("Money could not reach the database", error);
    return fail(503, "Money isn't available right now. Try again shortly.");
  }
}

type Names = "accounts" | "categories" | "category" | "transactions" | "transactionCategory" | "transactionSplits" | "rules" | "rule" | "ruleOrder" | "applyRules";

/**
 * The money routes (card $1), all within the signed-in member's household. There is no route
 * that creates transactions or changes amounts or accounts: those come only from the bank
 * import (ADR-27).
 */
export function createMoneyHandlers(access: MoneyAccess): Record<Names, AuthenticatedHandler> {
  /** Runs `work` when the method is one of `methods`, else answers 405. */
  const route =
    (methods: string[], work: (request: HttpRequest, money: () => ReturnType<MoneyAccess>) => Promise<HttpResponseInit>): AuthenticatedHandler =>
    (request, context, user) =>
      respond(context, async () => (methods.includes(request.method) ? work(request, () => access(user)) : fail(405, "Method not allowed.")));

  return {
    accounts: route(["GET"], async (_request, open) => {
      const { money, householdId } = await open();
      return { status: 200, jsonBody: { accounts: await money.accounts(householdId) } satisfies MoneyAccountsResponse };
    }),

    categories: route(["GET", "POST"], async (request, open) => {
      if (request.method === "GET") {
        const { money, householdId } = await open();
        return { status: 200, jsonBody: { categories: await money.categories(householdId) } satisfies MoneyCategoriesResponse };
      }
      const body = await readObject(request);
      const name = text(body, "name");
      const kind = body.kind === undefined ? "spending" : kindFrom(body.kind);
      const { money, householdId } = await open();
      return { status: 201, jsonBody: await money.addCategory(householdId, name, kind) };
    }),

    category: route(["PATCH"], async (request, open) => {
      const categoryId = idParam(request, "category");
      const change = categoryChangeFrom(await readObject(request));
      const { money, householdId } = await open();
      return { status: 200, jsonBody: await money.updateCategory(householdId, categoryId, change) };
    }),

    transactions: route(["GET"], async (request, open) => {
      const filter = filterFrom(request);
      const { money, householdId } = await open();
      return { status: 200, jsonBody: { transactions: await money.transactions(householdId, filter) } satisfies MoneyTransactionsResponse };
    }),

    transactionCategory: route(["PUT"], async (request, open) => {
      const transactionId = idParam(request, "transaction");
      const body = await readObject(request);
      if (!("categoryId" in body)) throw new BadRequest("categoryId is required (null clears it).");
      const categoryId = body.categoryId === null ? null : guid(body.categoryId, "categoryId");
      const { money, householdId } = await open();
      return { status: 200, jsonBody: await money.setCategory(householdId, transactionId, categoryId) };
    }),

    transactionSplits: route(["PUT"], async (request, open) => {
      const transactionId = idParam(request, "transaction");
      const splits = splitsFrom(await readObject(request));
      const { money, householdId } = await open();
      return { status: 200, jsonBody: await money.setSplits(householdId, transactionId, splits) };
    }),

    rules: route(["GET", "POST"], async (request, open) => {
      if (request.method === "GET") {
        const { money, householdId } = await open();
        return { status: 200, jsonBody: { rules: await money.rules(householdId) } satisfies MoneyRulesResponse };
      }
      const rule = ruleFrom(await readObject(request));
      const { money, householdId } = await open();
      return { status: 201, jsonBody: await money.addRule(householdId, rule) };
    }),

    rule: route(["PUT", "DELETE"], async (request, open) => {
      const ruleId = idParam(request, "rule");
      if (request.method === "PUT") {
        const rule = ruleFrom(await readObject(request));
        const { money, householdId } = await open();
        return { status: 200, jsonBody: await money.updateRule(householdId, ruleId, rule) };
      }
      const { money, householdId } = await open();
      await money.removeRule(householdId, ruleId);
      return { status: 204 };
    }),

    ruleOrder: route(["PUT"], async (request, open) => {
      const ids = (await readObject(request)).ruleIds;
      if (!Array.isArray(ids)) throw new BadRequest("ruleIds must be a list.");
      const ruleIds = ids.map((r: unknown) => guid(r, "Each rule id"));
      const { money, householdId } = await open();
      return { status: 200, jsonBody: { rules: await money.reorderRules(householdId, ruleIds) } satisfies MoneyRulesResponse };
    }),

    applyRules: route(["POST"], async (_request, open) => {
      const { money, householdId } = await open();
      return { status: 200, jsonBody: (await money.applyRules(householdId)) satisfies MoneyRulesApplied };
    }),
  };
}
