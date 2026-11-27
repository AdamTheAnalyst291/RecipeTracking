import { describe, expect, it, vi } from "vitest";
import { createAlert } from "./alert.js";

// A made-up topic; the real one is a Key Vault secret.
const TOPIC = "kitchen-test-topic-0000";

describe("phone alert through ntfy", () => {
  it("posts the message to the configured topic, marked high priority", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const alert = createAlert({ KITCHEN_ALERT_NTFY_TOPIC: ` ${TOPIC} ` }, fetchFn);
    await alert("Bank sync failed", "First Platypus Bank: ITEM_LOGIN_REQUIRED");

    expect(fetchFn).toHaveBeenCalledWith(`https://ntfy.sh/${TOPIC}`, expect.objectContaining({ method: "POST", body: "First Platypus Bank: ITEM_LOGIN_REQUIRED" }));
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ Title: "Bank sync failed", Priority: "high" });
  });

  it("can use another ntfy server", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await createAlert({ KITCHEN_ALERT_NTFY_TOPIC: TOPIC, KITCHEN_ALERT_NTFY_SERVER: "https://ntfy.example.test/" }, fetchFn)("t", "m");
    expect(fetchFn).toHaveBeenCalledWith(`https://ntfy.example.test/${TOPIC}`, expect.anything());
  });

  it("refuses a topic that isn't a plain name, and reports a missing topic or a refused post as an error", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 429 }));
    await expect(createAlert({}, fetchFn)("t", "m")).rejects.toThrow(/KITCHEN_ALERT_NTFY_TOPIC/);
    await expect(createAlert({ KITCHEN_ALERT_NTFY_TOPIC: "a/../b" }, fetchFn)("t", "m")).rejects.toThrow(/KITCHEN_ALERT_NTFY_TOPIC/);
    await expect(createAlert({ KITCHEN_ALERT_NTFY_TOPIC: TOPIC }, fetchFn)("t", "m")).rejects.toThrow(/429/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
