import { useEffect, useMemo, useState } from "react";
import { checkApiHealth, loadConfig, type ApiHealth } from "./health.js";
import { fetchMe, type Me } from "./me.js";
import { createRecipeApi } from "./recipes/api.js";
import { Recipes } from "./recipes/Recipes.js";
import { startSignIn, type SignIn } from "./signIn.js";

type Session =
  | { state: "loading" }
  | { state: "not-configured" }
  | { state: "signed-out"; signIn: SignIn }
  | { state: "signed-in"; signIn: SignIn; me: Me; apiUrl: string }
  | { state: "failed"; reason: string };

export function App() {
  const [health, setHealth] = useState<ApiHealth | "checking">("checking");
  const [session, setSession] = useState<Session>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    const reason = (error: unknown) => (error instanceof Error ? error.message : "Could not load configuration");

    loadConfig()
      .catch((error: unknown) => {
        // Without config.json neither the API nor sign-in can be reached.
        if (!cancelled) setHealth({ state: "down", reason: reason(error) });
        throw error;
      })
      .then(async (config) => {
        void checkApiHealth(config.apiUrl).then((result) => !cancelled && setHealth(result));
        if (!config.auth) return { state: "not-configured" } as const;
        const signIn = await startSignIn(config.auth);
        if (!signIn.account) return { state: "signed-out", signIn } as const;
        return { state: "signed-in", signIn, me: await fetchMe(config.apiUrl, signIn.getToken), apiUrl: config.apiUrl } as const;
      })
      .catch((error: unknown): Session => ({ state: "failed", reason: reason(error) }))
      .then((result) => {
        if (!cancelled) setSession(result);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Kitchen</h1>
      <SessionView session={session} />
      <p role="status" data-testid="api-health">
        {health === "checking" && "API: checking…"}
        {health !== "checking" && health.state === "ok" && "API: ok"}
        {health !== "checking" && health.state === "down" && `API: down (${health.reason})`}
      </p>
    </main>
  );
}

function SessionView({ session }: { session: Session }) {
  switch (session.state) {
    case "loading":
      return <p>Signing in…</p>;
    case "not-configured":
      return <p>Sign-in isn't set up for this copy of the app.</p>;
    case "failed":
      return <p>Sign-in failed ({session.reason}).</p>;
    case "signed-out":
      return (
        <button type="button" onClick={() => void session.signIn.signIn()}>
          Sign in with Microsoft
        </button>
      );
    case "signed-in": {
      const signOut = (
        <button type="button" onClick={() => void session.signIn.signOut()}>
          Sign out
        </button>
      );
      const { me } = session;
      if (me.state === "member") {
        return (
          <>
            <p>
              Signed in as {me.profile.name ?? session.signIn.account?.username} (household {me.profile.household.id}). {signOut}
            </p>
            <KitchenRecipes apiUrl={session.apiUrl} getToken={session.signIn.getToken} />
          </>
        );
      }
      if (me.state === "signed-out") {
        return (
          <button type="button" onClick={() => void session.signIn.signIn()}>
            Sign in again
          </button>
        );
      }
      if (me.state === "not-a-member") {
        return (
          <p>
            {session.signIn.account?.username} isn't allowed into this kitchen. {signOut}
          </p>
        );
      }
      return (
        <p>
          Couldn't reach the kitchen ({me.reason}). {signOut}
        </p>
      );
    }
  }
}

function KitchenRecipes({ apiUrl, getToken }: { apiUrl: string; getToken: () => Promise<string> }) {
  const api = useMemo(() => createRecipeApi(apiUrl, getToken), [apiUrl, getToken]);
  return <Recipes api={api} />;
}
