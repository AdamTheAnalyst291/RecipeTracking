/**
 * A phone alert through ntfy.sh (card $2). The topic is configuration (`KITCHEN_ALERT_NTFY_TOPIC`,
 * a Key Vault reference): anyone who knows a topic's name can read it, so it stays out of git.
 */
export type Alert = (title: string, message: string) => Promise<void>;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

export function createAlert(env: Record<string, string | undefined>, fetchFn: Fetch = fetch): Alert {
  return async (title, message) => {
    const topic = env.KITCHEN_ALERT_NTFY_TOPIC?.trim() ?? "";
    // Checked here, not at start-up, so a missing topic fails the alert loudly in the log
    // without stopping the sync itself.
    if (!TOPIC.test(topic)) throw new Error("KITCHEN_ALERT_NTFY_TOPIC is not set to a topic name (letters, digits, - and _)");
    const server = (env.KITCHEN_ALERT_NTFY_SERVER?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
    const response = await fetchFn(`${server}/${topic}`, {
      method: "POST",
      headers: { Title: title, Priority: "high", Tags: "bank" },
      body: message,
    });
    if (!response.ok) throw new Error(`ntfy refused the alert (HTTP ${response.status})`);
  };
}
