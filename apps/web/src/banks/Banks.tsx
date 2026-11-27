import type { BanksResponse, ConnectedBank } from "@kitchen/shared";
import { useCallback, useEffect, useState } from "react";
import { centsText } from "../money/format.js";
import "../money/money.css";
import type { BanksApi } from "./api.js";
import type { OpenLink } from "./plaidLink.js";

const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong.");
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

interface Props {
  api: BanksApi;
  openLink: OpenLink;
}

/**
 * Connect bank (card $2, ADR-27): connect a bank through Plaid Link, see each one's last daily
 * sync, repair a login that stopped working ("Reconnect", Link's update mode), and check
 * transactions the bank withdrew. The access token never reaches the browser.
 */
export function Banks({ api, openLink }: Props) {
  const [data, setData] = useState<BanksResponse | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const reload = useCallback(async () => setData(await api.banks()), [api]);

  useEffect(() => {
    let cancelled = false;
    api.banks().then(
      (d) => !cancelled && setData(d),
      (error: unknown) => {
        if (cancelled) return;
        setData({ environment: "sandbox", banks: [] });
        setProblem(reasonOf(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(reasonOf(error));
    } finally {
      setBusy(false);
    }
  };

  const syncAndSay = async () => {
    const s = await api.syncNow();
    await reload();
    setNotice(s.failed > 0 ? `Synced with ${s.failed} failure(s): ${s.added} new, ${s.updated} updated.` : `Synced: ${s.added} new, ${s.updated} updated.`);
  };

  const connect = () =>
    run(async () => {
      setConfirming(false);
      const linked = await openLink(await api.linkToken());
      if (!linked) return;
      await api.connect(linked.publicToken, linked.institution);
      await syncAndSay();
    });

  const reconnect = (bank: ConnectedBank) =>
    run(async () => {
      // Update mode repairs the same login, so there's nothing to exchange afterwards.
      const linked = await openLink(await api.linkToken(bank.id));
      if (!linked) return;
      await syncAndSay();
    });

  const production = data?.environment === "production";

  return (
    <section className="money" aria-labelledby="banks-heading">
      <h2 id="banks-heading">Banks</h2>
      {data?.environment === "sandbox" && (
        <p className="money-meta">Plaid Sandbox: no real bank here. In Link, pick any bank and sign in with user_good and pass_good.</p>
      )}
      {problem && (
        <p role="alert" className="money-problem">
          {problem}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}

      {data === undefined ? (
        <p>Loading…</p>
      ) : data.banks.length === 0 ? (
        <p>No bank connected yet. Transactions arrive every morning once one is.</p>
      ) : (
        <ul className="money-list" aria-label="Connected banks">
          {data.banks.map((bank) => (
            <BankRow
              key={bank.id}
              bank={bank}
              busy={busy}
              sandbox={data.environment === "sandbox"}
              onReconnect={() => void reconnect(bank)}
              onFail={() =>
                void run(async () => {
                  await api.sandboxResetLogin(bank.id);
                  await reload();
                  setNotice("The login now needs repairing. Sync now to see the failure and its alert, then Reconnect.");
                })
              }
            />
          ))}
        </ul>
      )}

      <div className="money-tx-actions">
        {confirming ? (
          <>
            <p>This uses one of the 10 bank connections Plaid's Trial allows, for good, even if it's removed later. Connect?</p>
            <button type="button" disabled={busy} onClick={() => void connect()}>
              Yes, connect
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" disabled={busy || data === undefined} onClick={() => (production ? setConfirming(true) : void connect())}>
            Connect a bank
          </button>
        )}
        {data !== undefined && data.banks.length > 0 && (
          <button type="button" disabled={busy} onClick={() => void run(syncAndSay)}>
            Sync now
          </button>
        )}
      </div>
    </section>
  );
}

function BankRow({ bank, busy, sandbox, onReconnect, onFail }: { bank: ConnectedBank; busy: boolean; sandbox: boolean; onReconnect: () => void; onFail: () => void }) {
  const name = bank.institution ?? "Bank";
  const run = bank.lastRun;
  return (
    <li aria-labelledby={`bank-${bank.id}`}>
      <h3 id={`bank-${bank.id}`}>{name}</h3>
      <ul aria-label={`${name} accounts`}>
        {bank.accounts.map((a) => (
          <li key={a.id}>{a.mask ? `${a.name} ••${a.mask}` : a.name}</li>
        ))}
      </ul>
      <p>
        {run === null
          ? "Not synced yet."
          : run.ok
            ? `Synced ${when(run.at)}: ${run.added} new, ${run.updated} updated${run.withdrawn > 0 ? `, ${run.withdrawn} withdrawn` : ""}.`
            : `Last sync failed ${when(run.at)}: ${run.message}`}
      </p>
      {bank.needsReconnect && (
        <>
          <p>The bank needs you to sign in again.</p>
          <button type="button" disabled={busy} onClick={onReconnect}>
            Reconnect
          </button>
        </>
      )}
      {bank.withdrawn.length > 0 && (
        <>
          <p>The bank withdrew these after they were saved. They're kept; check them and re-categorize or split as needed.</p>
          <ul aria-label="Withdrawn by the bank">
            {bank.withdrawn.map((w) => (
              <li key={w.plaidTransactionId}>
                {w.date} {w.payee} {centsText(w.amountCents)} ({w.account})
              </li>
            ))}
          </ul>
        </>
      )}
      {sandbox && !bank.needsReconnect && (
        <button type="button" disabled={busy} onClick={onFail}>
          Make the login fail (Sandbox)
        </button>
      )}
    </li>
  );
}
