// The bridge's own state: linked banks, Plaid access tokens and sync cursors.
// One small JSON file in the bridge-data volume; written atomically.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

export type LinkedAccount = {
  plaidAccountId: string;
  name: string;
  mask: string | null;
  // Actual account id, 'skip' to ignore this account, or null until chosen.
  actualAccountId: string | null;
};

export type LinkedItem = {
  itemId: string;
  accessToken: string;
  institution: string;
  cursor: string | null;
  accounts: LinkedAccount[];
};

export type SyncRun = {
  at: string;
  ok: boolean;
  imported: number;
  updated: number;
  message: string;
};

export type State = {
  items: LinkedItem[];
  lastRun: SyncRun | null;
};

const file = () => join(config.dataDir, 'state.json');

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as State;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], lastRun: null };
    throw err;
  }
}

export function saveState(state: State): void {
  mkdirSync(config.dataDir, { recursive: true });
  const tmp = file() + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file());
}

// An item syncs only once every account has an Actual account or 'skip',
// so its transactions are never consumed before there's somewhere to put them.
export function isReady(item: LinkedItem): boolean {
  return item.accounts.length > 0 && item.accounts.every((a) => a.actualAccountId !== null);
}
