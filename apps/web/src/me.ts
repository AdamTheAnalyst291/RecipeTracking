import type { MeResponse } from "@kitchen/shared";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Me =
  | { state: "member"; me: MeResponse }
  | { state: "not-a-member" }
  | { state: "signed-out" }
  | { state: "error"; reason: string };

/** Asks the API who is signed in. A 403 means the account isn't in the household. */
export async function fetchMe(apiUrl: string, getToken: () => Promise<string>, fetchFn: Fetch = fetch): Promise<Me> {
  try {
    const response = await fetchFn(`${apiUrl}/api/me`, { headers: { Authorization: `Bearer ${await getToken()}` } });
    if (response.status === 401) return { state: "signed-out" };
    if (response.status === 403) return { state: "not-a-member" };
    if (!response.ok) return { state: "error", reason: `HTTP ${response.status}` };
    return { state: "member", me: (await response.json()) as MeResponse };
  } catch (error) {
    return { state: "error", reason: error instanceof Error ? error.message : "Request failed" };
  }
}
