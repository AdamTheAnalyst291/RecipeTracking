/**
 * Opens Plaid Link with a Link token and resolves with Link's public token, or null when the
 * person closes it without connecting. Tests pass a stand-in instead.
 */
export type OpenLink = (linkToken: string) => Promise<{ publicToken: string; institution: string | null } | null>;

// Plaid serves Link only from its own CDN and doesn't allow a pinned or self-hosted copy, so
// this one script is the exception to pinned versions.
const LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface PlaidGlobal {
  create(options: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
    onExit: (error: unknown) => void;
  }): { open(): void; destroy(): void };
}

let loading: Promise<PlaidGlobal> | undefined;

function loadPlaid(): Promise<PlaidGlobal> {
  loading ??= new Promise<PlaidGlobal>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LINK_SCRIPT;
    script.async = true;
    script.onload = () => {
      const plaid = (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
      if (plaid) resolve(plaid);
      else reject(new Error("Plaid Link didn't load."));
    };
    script.onerror = () => {
      loading = undefined;
      reject(new Error("Couldn't load Plaid Link. Check the connection and try again."));
    };
    document.head.append(script);
  });
  return loading;
}

export const openPlaidLink: OpenLink = async (linkToken) => {
  const plaid = await loadPlaid();
  return new Promise((resolve, reject) => {
    const handler = plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        handler.destroy();
        resolve({ publicToken, institution: metadata.institution?.name ?? null });
      },
      onExit: (error) => {
        handler.destroy();
        if (error) reject(new Error("Plaid Link stopped before the bank was connected."));
        else resolve(null);
      },
    });
    handler.open();
  });
};
