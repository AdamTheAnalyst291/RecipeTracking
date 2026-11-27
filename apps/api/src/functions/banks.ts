import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { MoneyError, type Banks, type Money } from "@kitchen/db";
import type { ApiError, BankLinkToken, BankSyncSummary, BanksResponse } from "@kitchen/shared";
import type { AuthenticatedHandler, SignedInUser } from "../auth.js";
import type { Alert } from "../bank/alert.js";
import { PlaidApiError, PlaidConfigError, type PlaidClient } from "../bank/plaid.js";
import { errorText, functionLog } from "../bank/log.js";
import { redact } from "../bank/redact.js";
import { syncBanks } from "../bank/sync.js";
import { accessTokenSecretName, type TokenVault } from "../bank/vault.js";

/** The bank store and money for the signed-in user's household, and that household's id. */
export type BankAccess = (user: SignedInUser) => Promise<{ banks: Banks; money: Money; householdId: string }>;

/** Plaid, Key Vault and the phone alert. `plaid` is made on first use, so missing settings answer 503. */
export interface BankServices {
  plaid: () => PlaidClient;
  vault: TokenVault;
  alert: Alert;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN = 200;

class BadRequest extends Error {}
class NotFound extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function readObject(request: HttpRequest): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest("The body must be JSON.");
  }
  if (!isObject(body)) throw new BadRequest("The body must be a JSON object.");
  return body;
}

function bankId(value: unknown): string {
  if (typeof value !== "string" || !GUID.test(value)) throw new BadRequest("The bank id must be an ID.");
  return value;
}

const fail = (status: number, error: string): HttpResponseInit => ({ status, jsonBody: { error } satisfies ApiError });
const STATUS = { "not-found": 404, invalid: 400, conflict: 409 } as const;

/**
 * Turns an error into an answer. Every message is redacted, and only messages are logged:
 * an error object can carry the request that held the access token.
 */
function answer(context: InvocationContext, error: unknown, secrets: string[]): HttpResponseInit {
  if (error instanceof BadRequest) return fail(400, error.message);
  if (error instanceof NotFound) return fail(404, error.message);
  if (error instanceof MoneyError) return fail(STATUS[error.code], error.message);
  if (error instanceof PlaidConfigError) {
    context.error(`Plaid isn't configured: ${error.message}`);
    return fail(503, "Bank connections aren't set up in this environment yet.");
  }
  if (error instanceof PlaidApiError) {
    const message = redact(error.message, secrets);
    context.error(`Plaid refused: ${message}`);
    return fail(502, `Plaid refused: ${message}`);
  }
  context.error(`Banks failed: ${errorText(error, secrets)}`);
  return fail(503, "Banks aren't available right now. Try again shortly.");
}

type Names = "banks" | "linkToken" | "sync" | "sandboxResetLogin";

/**
 * Bank connections through Plaid (card $2), all within the signed-in member's household. The
 * access token Plaid gives goes to Key Vault and nowhere else: never the database, a log or
 * a response (ADR-27).
 */
export function createBankHandlers(access: BankAccess, services: BankServices): Record<Names, AuthenticatedHandler> {
  /** Runs `work` when the method is one of `methods`, else answers 405. `secrets` collects tokens to redact. */
  const route =
    (methods: string[], work: (request: HttpRequest, open: () => ReturnType<BankAccess>, secrets: string[], context: InvocationContext) => Promise<HttpResponseInit>): AuthenticatedHandler =>
    async (request, context, user) => {
      if (!methods.includes(request.method)) return fail(405, "Method not allowed.");
      const secrets: string[] = [];
      try {
        return await work(request, () => access(user), secrets, context);
      } catch (error) {
        return answer(context, error, secrets);
      }
    };

  return {
    banks: route(["GET", "POST"], async (request, open, secrets, context) => {
      if (request.method === "GET") {
        const plaid = services.plaid();
        const { banks, householdId } = await open();
        return { status: 200, jsonBody: { environment: plaid.environment, banks: await banks.list(householdId) } satisfies BanksResponse };
      }

      // Plaid Link's onSuccess: exchange the public token and keep the access token in Key Vault.
      const body = await readObject(request);
      const publicToken = body.publicToken;
      if (typeof publicToken !== "string" || publicToken.trim() === "" || publicToken.length > MAX_TOKEN) throw new BadRequest("publicToken is required.");
      const institution = typeof body.institution === "string" ? body.institution : null;
      const plaid = services.plaid();
      const { banks, money, householdId } = await open();

      const { itemId, accessToken } = await plaid.exchangePublicToken(publicToken.trim());
      secrets.push(accessToken);
      const secretName = accessTokenSecretName(itemId);
      try {
        await services.vault.save(secretName, accessToken);
      } catch (error) {
        // The connection exists at Plaid but its token couldn't be kept: say so plainly, since
        // connecting again uses another of the Trial's slots.
        context.error(`Connected ${institution ?? "a bank"} (Plaid item ${itemId}) but couldn't store its access token: ${errorText(error, secrets)}`);
        throw error;
      }
      // Saved straight away, so whatever fails next is repaired by the next sync (which reads
      // the accounts again) instead of leaving a connection the app doesn't know about.
      const saved = { plaidItemId: itemId, institution, accessTokenSecret: secretName };
      await banks.addItem(householdId, { ...saved, plaidAccountIds: [] });
      const accounts = await plaid.accounts(accessToken);
      await money.importPlaid(householdId, { accounts, transactions: [] });
      const bank = await banks.addItem(householdId, { ...saved, plaidAccountIds: accounts.map((a) => a.account_id) });
      return { status: 201, jsonBody: bank };
    }),

    linkToken: route(["POST"], async (request, open, secrets) => {
      const body = await readObject(request);
      const forBank = body.bankId === undefined || body.bankId === null ? null : bankId(body.bankId);
      const plaid = services.plaid();
      const { banks, householdId } = await open();
      if (forBank) {
        // Update mode ("Reconnect"): repairs the same login, so transaction ids stay the same.
        const item = await banks.item(householdId, forBank);
        const accessToken = await services.vault.read(item.accessTokenSecret);
        secrets.push(accessToken);
        return { status: 200, jsonBody: { linkToken: await plaid.createLinkToken({ userId: householdId, accessToken }) } satisfies BankLinkToken };
      }
      // Each new connection uses up a Plaid Trial slot for good, so make sure its token can be kept first.
      await services.vault.checkWritable();
      return { status: 200, jsonBody: { linkToken: await plaid.createLinkToken({ userId: householdId }) } satisfies BankLinkToken };
    }),

    sync: route(["POST"], async (_request, open, _secrets, context) => {
      const { banks, money, householdId } = await open();
      const summary = await syncBanks(
        {
          banks,
          money,
          plaid: services.plaid,
          vault: services.vault,
          alert: services.alert,
          log: functionLog(context),
        },
        { householdId },
      );
      return { status: 200, jsonBody: summary satisfies BankSyncSummary };
    }),

    sandboxResetLogin: route(["POST"], async (request, open, secrets) => {
      const id = bankId(request.params.id ?? "");
      const plaid = services.plaid();
      if (plaid.environment !== "sandbox") throw new NotFound("Only Plaid Sandbox can reset a login.");
      const { banks, householdId } = await open();
      const item = await banks.item(householdId, id);
      const accessToken = await services.vault.read(item.accessTokenSecret);
      secrets.push(accessToken);
      await plaid.sandboxResetLogin(accessToken);
      return { status: 204 };
    }),
  };
}
