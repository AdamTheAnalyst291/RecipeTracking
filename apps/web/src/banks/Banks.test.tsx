// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Banks } from "./Banks.js";
import type { OpenLink } from "./plaidLink.js";
import { inMemoryBanksApi, sampleBank } from "./test-api.js";

afterEach(cleanup);
vi.setConfig({ testTimeout: 20_000 });

/** Plaid Link stand-in: "the person finished Link" with a Sandbox public token, or closed it. */
const finishLink = (result: Awaited<ReturnType<OpenLink>> = { publicToken: "public-sandbox-1", institution: "First Platypus Bank" }) =>
  vi.fn<OpenLink>(async () => result);

function open(api = inMemoryBanksApi(), openLink = finishLink()) {
  const user = userEvent.setup();
  render(<Banks api={api} openLink={openLink} />);
  return { api, openLink, user };
}

describe("the Connect bank screen", () => {
  it("lists connected banks with their accounts and the last sync", async () => {
    open(inMemoryBanksApi({ banks: [sampleBank()] }));
    const bank = await screen.findByRole("listitem", { name: /First Platypus Bank/ });
    expect(within(bank).getByText("Plaid Checking ••0000")).toBeTruthy();
    expect(within(bank).getByText(/4 new, 1 updated/)).toBeTruthy();
  });

  it("connects a bank through Plaid Link, then syncs it", async () => {
    const { api, openLink, user } = open();
    await screen.findByText(/No bank connected yet/);
    await user.click(screen.getByRole("button", { name: "Connect a bank" }));

    await vi.waitFor(() => expect(api.calls).toEqual(["linkToken", "connect public-sandbox-1 First Platypus Bank", "sync"]));
    expect(openLink).toHaveBeenCalledWith("link-new");
    expect(await screen.findByRole("listitem", { name: /First Platypus Bank/ })).toBeTruthy();
  });

  it("does nothing when Link is closed without connecting", async () => {
    const { api, user } = open(inMemoryBanksApi(), finishLink(null));
    await screen.findByText(/No bank connected yet/);
    await user.click(screen.getByRole("button", { name: "Connect a bank" }));
    await vi.waitFor(() => expect(api.calls).toEqual(["linkToken"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("in production, asks first, because each connection uses one of Plaid's ten for good", async () => {
    const { api, user } = open(inMemoryBanksApi({ environment: "production" }));
    await screen.findByText(/No bank connected yet/);
    await user.click(screen.getByRole("button", { name: "Connect a bank" }));
    expect(api.calls).toEqual([]);
    expect(screen.getByText(/uses one of the 10/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Yes, connect" }));
    await vi.waitFor(() => expect(api.calls[0]).toBe("linkToken"));
  });

  it("offers Reconnect for a bank whose login needs repairing, using update mode, then syncs", async () => {
    const failed = sampleBank({
      needsReconnect: true,
      lastRun: { at: "2026-11-27T11:00:04.000Z", ok: false, added: 0, updated: 0, withdrawn: 0, message: "ITEM_LOGIN_REQUIRED: the login details changed", errorCode: "ITEM_LOGIN_REQUIRED" },
    });
    const { api, openLink, user } = open(inMemoryBanksApi({ banks: [failed] }));
    const bank = await screen.findByRole("listitem", { name: /First Platypus Bank/ });
    expect(within(bank).getByText(/ITEM_LOGIN_REQUIRED/)).toBeTruthy();
    await user.click(within(bank).getByRole("button", { name: "Reconnect" }));

    await vi.waitFor(() => expect(api.calls).toEqual(["linkToken b1", "sync"]));
    expect(openLink).toHaveBeenCalledWith("link-update-b1");
    await vi.waitFor(() => expect(within(screen.getByRole("listitem", { name: /First Platypus Bank/ })).queryByRole("button", { name: "Reconnect" })).toBeNull());
  });

  it("lists transactions the bank withdrew, for checking", async () => {
    open(
      inMemoryBanksApi({
        banks: [sampleBank({ withdrawn: [{ plaidTransactionId: "tx-9", transactionId: "t9", date: "2026-11-21", amountCents: -433, payee: "Starbucks", account: "Plaid Checking" }] })],
      }),
    );
    const list = await screen.findByRole("list", { name: "Withdrawn by the bank" });
    expect(within(list).getByText(/Starbucks/)).toBeTruthy();
    expect(within(list).getByText(/−\$4\.33/)).toBeTruthy();
  });

  it("syncs now on request and says how it went", async () => {
    const { api, user } = open(inMemoryBanksApi({ banks: [sampleBank()] }));
    await screen.findByRole("listitem", { name: /First Platypus Bank/ });
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await vi.waitFor(() => expect(api.calls).toEqual(["sync"]));
    expect((await screen.findByRole("status")).textContent).toMatch(/Synced: 2 new/);
  });

  it("in Sandbox, can make a login fail to try the alert and Reconnect; production has no such button", async () => {
    const { api, user } = open(inMemoryBanksApi({ banks: [sampleBank()] }));
    const bank = await screen.findByRole("listitem", { name: /First Platypus Bank/ });
    await user.click(within(bank).getByRole("button", { name: /Make the login fail/ }));
    await vi.waitFor(() => expect(api.calls).toEqual(["reset b1"]));
    expect(await within(bank).findByRole("button", { name: "Reconnect" })).toBeTruthy();

    cleanup();
    open(inMemoryBanksApi({ environment: "production", banks: [sampleBank()] }));
    const prodBank = await screen.findByRole("listitem", { name: /First Platypus Bank/ });
    expect(within(prodBank).queryByRole("button", { name: /Make the login fail/ })).toBeNull();
  });

  it("says why when the API refuses", async () => {
    const api = inMemoryBanksApi();
    api.linkToken = async () => Promise.reject(new Error("Bank connections aren't set up in this environment yet."));
    const { user } = open(api);
    await screen.findByText(/No bank connected yet/);
    await user.click(screen.getByRole("button", { name: "Connect a bank" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/aren't set up/);
  });
});
