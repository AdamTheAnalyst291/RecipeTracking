import type { BanksResponse, ConnectedBank } from "@kitchen/shared";
import type { BanksApi } from "./api.js";

// Made up, shaped like Plaid Sandbox's First Platypus Bank; the repo is public.
export const sampleBank = (overrides: Partial<ConnectedBank> = {}): ConnectedBank => ({
  id: "b1",
  institution: "First Platypus Bank",
  accounts: [
    { id: "a1", name: "Plaid Checking", mask: "0000" },
    { id: "a2", name: "Plaid Saving", mask: "1111" },
  ],
  needsReconnect: false,
  lastRun: { at: "2026-11-27T11:00:04.000Z", ok: true, added: 4, updated: 1, withdrawn: 0, message: "OK", errorCode: null },
  withdrawn: [],
  ...overrides,
});

/** A banks API held in memory, for the screen tests. It records what was asked of it. */
export function inMemoryBanksApi(start: Partial<BanksResponse> = {}): BanksApi & { state: BanksResponse; calls: string[] } {
  const api: ReturnType<typeof inMemoryBanksApi> = {
    state: { environment: start.environment ?? "sandbox", banks: start.banks ?? [] },
    calls: [],
    async banks() {
      return structuredClone(api.state);
    },
    async linkToken(bankId) {
      api.calls.push(bankId ? `linkToken ${bankId}` : "linkToken");
      return bankId ? `link-update-${bankId}` : "link-new";
    },
    async connect(publicToken, institution) {
      api.calls.push(`connect ${publicToken} ${institution}`);
      const bank = sampleBank({ id: `b${api.state.banks.length + 1}`, institution, lastRun: null });
      api.state.banks.push(bank);
      return structuredClone(bank);
    },
    async syncNow() {
      api.calls.push("sync");
      for (const b of api.state.banks) {
        b.needsReconnect = false;
        b.lastRun = { at: "2026-11-27T12:00:00.000Z", ok: true, added: 2, updated: 0, withdrawn: 0, message: "OK", errorCode: null };
      }
      return { banks: api.state.banks.length, failed: 0, added: 2, updated: 0, withdrawn: 0 };
    },
    async sandboxResetLogin(bankId) {
      api.calls.push(`reset ${bankId}`);
      const b = api.state.banks.find((x) => x.id === bankId);
      if (b) b.needsReconnect = true;
    },
  };
  return api;
}
