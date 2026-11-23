import type { HttpResponseInit } from "@azure/functions";
import type { MeResponse } from "@kitchen/shared";
import type { AuthenticatedHandler } from "../auth.js";

/** Who is signed in, and which household they belong to. */
export const meHandler: AuthenticatedHandler = async (_request, _context, user): Promise<HttpResponseInit> => {
  const body: MeResponse = { name: user.name ?? null, household: { id: user.household.id } };
  return { status: 200, jsonBody: body };
};
