import * as api from '@actual-app/api';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

// The Actual API is one global session, so calls are queued one at a time.
let queue: Promise<unknown> = Promise.resolve();

export function withActual<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const dataDir = join(config.dataDir, 'actual-cache');
    mkdirSync(dataDir, { recursive: true });
    await api.init({ dataDir, serverURL: config.actual.serverUrl, password: config.actual.password });
    try {
      await api.downloadBudget(
        config.actual.syncId,
        config.actual.budgetPassword ? { password: config.actual.budgetPassword } : undefined,
      );
      return await fn();
    } finally {
      await api.shutdown();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function listAccounts() {
  return withActual(async () => {
    const accounts = await api.getAccounts();
    return accounts.filter((a) => !a.closed).map((a) => ({ id: a.id, name: a.name }));
  });
}

export { api };
