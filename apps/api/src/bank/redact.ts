const ACCESS_TOKEN = /access-(?:sandbox|development|production)-[0-9a-f-]+/gi;

/**
 * Takes Plaid access tokens out of text bound for a log, an alert, the database or a response:
 * the ones given, and anything shaped like one. Log only text that went through this, never
 * an error object, which can carry the request that held the token.
 */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[access token]");
  return out.replace(ACCESS_TOKEN, "[access token]");
}
