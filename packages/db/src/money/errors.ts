/** `not-found`: no such row in this household. `invalid`: a value that can't be stored. `conflict`: clashes with an existing row. */
export class MoneyError extends Error {
  constructor(
    readonly code: "not-found" | "invalid" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "MoneyError";
  }
}
