// Bank connections through Plaid (card $2, ADR-27). Nothing here ever carries an access token.
import type { MoneyAccount } from "./money.js";

/** The result of the most recent daily sync of one bank. */
export interface BankRun {
  /** ISO time. */
  at: string;
  ok: boolean;
  added: number;
  updated: number;
  /** Saved transactions the bank withdrew in that run (kept, for a person to check). */
  withdrawn: number;
  message: string;
  /** Plaid's error code when the run failed, such as ITEM_LOGIN_REQUIRED. */
  errorCode: string | null;
}

/** A saved transaction the bank later withdrew. */
export interface WithdrawnTransaction {
  plaidTransactionId: string;
  transactionId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  payee: string;
  account: string;
}

export interface ConnectedBank {
  id: string;
  institution: string | null;
  accounts: MoneyAccount[];
  /** The login needs repairing: press Reconnect (Plaid Link's update mode). */
  needsReconnect: boolean;
  lastRun: BankRun | null;
  withdrawn: WithdrawnTransaction[];
}

/** Response of `GET /api/money/banks`. `environment` is which Plaid the API talks to. */
export interface BanksResponse {
  environment: "sandbox" | "production";
  banks: ConnectedBank[];
}

/** Body of `POST /api/money/bank-link-token`: a bank id for update mode ("Reconnect"), none to connect a new one. */
export interface BankLinkTokenRequest {
  bankId?: string;
}

/** Response of `POST /api/money/bank-link-token`. */
export interface BankLinkToken {
  linkToken: string;
}

/** Body of `POST /api/money/banks`: what Plaid Link's onSuccess gives. */
export interface BankConnect {
  publicToken: string;
  institution?: string | null;
}

/** Response of `POST /api/money/bank-sync`. */
export interface BankSyncSummary {
  banks: number;
  failed: number;
  added: number;
  updated: number;
  withdrawn: number;
}
