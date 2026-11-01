// `docker compose exec bridge npm run sync`: run the bank sync now and exit.
import { runSync } from './sync.js';

const run = await runSync();
process.exit(run.ok ? 0 : 1);
