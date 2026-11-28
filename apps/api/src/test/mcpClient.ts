/** Talks to the MCP handlers with the official client, as the Functions host and Claude would. */
import { HttpRequest, InvocationContext, type HttpResponseInit } from "@azure/functions";
import { Client, StreamableHTTPClientTransport, type VersionNegotiationMode } from "@modelcontextprotocol/client";

export const BASE = "https://func-kitchen-dev.azurewebsites.net/api";

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;

/** A fetch that hands each request to the Functions handler. */
function functionsFetch(handler: Handler): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const response = await handler(
      new HttpRequest({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), ...(body ? { body: { string: body } } : {}) }),
      new InvocationContext(),
    );
    const payload = response.jsonBody !== undefined ? JSON.stringify(response.jsonBody) : (response.body as string | undefined);
    return new Response(payload ?? null, { status: response.status ?? 200, headers: response.headers as Record<string, string> });
  };
}

export async function connect(handler: Handler, mode: VersionNegotiationMode, authorization?: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: functionsFetch(handler),
    ...(authorization ? { requestInit: { headers: { authorization } } } : {}),
  });
  await client.connect(transport);
  return client;
}

/** The JSON a tool answered with. */
export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as { type: string; text: string }[])[0];
  return { isError: result.isError === true, text: first?.text ?? "", json: first?.type === "text" && !result.isError ? JSON.parse(first.text) : undefined };
}
