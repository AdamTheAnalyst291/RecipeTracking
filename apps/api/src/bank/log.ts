import type { InvocationContext } from "@azure/functions";
import { redact } from "./redact.js";

/** Where the bank sync writes what it did. Only text goes here, already redacted. */
export interface BankLog {
  info(message: string): void;
  error(message: string): void;
}

/** An error as text fit for a log, an alert or a response: its message, with access tokens taken out. */
export const errorText = (error: unknown, secrets: string[] = []) => redact(error instanceof Error ? error.message : String(error), secrets);

/** The Functions log, for the bank sync. */
export const functionLog = (context: InvocationContext): BankLog => ({ info: (m) => context.log(m), error: (m) => context.error(m) });
