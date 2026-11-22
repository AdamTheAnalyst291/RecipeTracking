import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { HealthResponse } from "@kitchen/shared";

export async function health(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const body: HealthResponse = { status: "ok" };
  return { status: 200, jsonBody: body };
}
