# kitchen

Two halves live in this repo while the move happens (ADR-25):

- **The new kitchen app** (`apps/`, `packages/`): a pnpm + turbo monorepo that will replace Mealie, Grocy and Actual Budget. `apps/web` is React + Vite, `apps/api` is Azure Functions on Node 24, and `packages/shared` holds types both use. From the repo root: `pnpm install`, then `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. CI (`.github/workflows/pull-request.yml`) runs the same on each pull request. Sign-in is Microsoft Entra, for household members only; `infra/README.md` ("Sign-in") has the one-time setup. Locally, `apps/web/public/config.json` leaves sign-in off; to try it against Dev, fill in its `auth` block with Dev's client ID and tenant ID, and don't commit them.
- **The legacy laptop setup** (`legacy/`): everything below. It is still the live system until switch-over (card S3), then it is deleted. Run its commands from the repo root as `.\legacy\mealie.cmd <command>`.

## Importing from Mealie (one time, card K3)

`pnpm --filter @kitchen/db import:mealie` copies your foods, recipes (name, servings, time, source, tags, ingredients, steps) and meal plan from the running Mealie into the kitchen database. It only reads Mealie (GET requests, enforced in code and tested) and never deletes a recipe, food or planned meal. A recipe that changed in Mealie since the last run has its tags, ingredients and steps rewritten from Mealie, so do your edits to it in Mealie until switch-over. Foods renamed in Mealie are not renamed again. It is safe to run again: each Mealie item is remembered (table `import_source`), so a second run skips what hasn't changed, updates what changed in Mealie and doesn't duplicate. Edits you made in the kitchen app to an unchanged recipe are kept.

Run it against **Dev first**, read the report, then run it against Prod at switch-over (card S3).

1. **Mealie token.** Start Mealie (`.\legacy\mealie.cmd start`), open http://localhost:9925, click your name → **Profile** → **API Tokens**, make one called `kitchen-import` and copy it. Don't save it in a file in the repo.
2. **Sign in to Azure** (the import uses your Entra sign-in, no database password): `az login`, to the account that can reach the database. The database must already have the latest migrations (a deploy applies them) and you must have signed in to the app once, so your household exists.
3. **Set the environment** in the terminal you'll run it from (PowerShell):

   ```powershell
   $env:MEALIE_URL = "http://localhost:9925"
   $env:MEALIE_TOKEN = "<the token from step 1>"
   $env:SQL_SERVER = "<server>.database.windows.net"   # Dev's SQL server; Prod's at switch-over
   $env:SQL_DATABASE = "<database name>"
   ```

   Dev's and Prod's server and database names are in the Azure portal (resource group `rg-kitchen-dev` / `rg-kitchen-prod`) and in `infra/README.md`. Only if the database has more than one household, also set `$env:KITCHEN_HOUSEHOLD_ID`.
4. **Run it** from the repo root: `pnpm --filter @kitchen/db import:mealie`.
5. **Read the report.** It lists how many foods, recipes and meal plan entries were new, updated or unchanged, then anything it couldn't carry over exactly: recipes Mealie wouldn't return, units that aren't in the unit table (kept in the ingredient's note), ingredient lines with no food (the whole line became a food), meal plan notes that aren't recipes (skipped), and sides/desserts (planned as dinner). Fix those by hand in the app if you care, or in Mealie and run again.
6. Clear the token afterwards: `Remove-Item Env:MEALIE_TOKEN`, and delete it in Mealie once switch-over is done.

## Importing from Grocy (one time, card K5)

`pnpm --filter @kitchen/db import:grocy` copies your Grocy pantry into the kitchen database: each active product (matched by name to a food you already have, or a new food), its current stock in its unit, a staple flag (Grocy's minimum stock above 0) and its latest price with the date it was bought. It only reads Grocy (GET requests to the Grocy server you name, enforced in code and tested) and never deletes anything. Grocy's price is per stock unit, so it is scaled by the size Grocy buys the product in (its purchase-to-stock factor, or 1) to give a price per package. It is safe to run again: each Grocy product is remembered (table `import_source`), so a second run skips what hasn't changed, brings stock, staple flag and price up to date for what has, and doesn't duplicate. Do your pantry changes in Grocy until switch-over (a product renamed in Grocy keeps its old name here); a rerun overwrites the stock and price of a changed product.

Run it against **Dev first**, read the report, then run it against Prod at switch-over (card S3). Run it after the Mealie import so the foods your recipes use are matched rather than made twice.

1. **Grocy API key.** Start Grocy (`.\legacy\mealie.cmd start`), open http://localhost:9283, click the user menu (top right) → **Manage API keys** → **Add**, and copy the key. Don't save it in a file in the repo.
2. **Sign in to Azure** (no database password): `az login`, as in the Mealie steps above. The database must have the latest migrations (a deploy applies them) and your household must exist.
3. **Set the environment** (PowerShell):

   ```powershell
   $env:GROCY_URL = "http://localhost:9283"
   $env:GROCY_API_KEY = "<the key from step 1>"
   $env:SQL_SERVER = "<server>.database.windows.net"   # Dev's SQL server; Prod's at switch-over
   $env:SQL_DATABASE = "<database name>"
   ```

   Only if the database has more than one household, also set `$env:KITCHEN_HOUSEHOLD_ID`.
4. **Run it** from the repo root: `pnpm --filter @kitchen/db import:grocy`.
5. **Read the report.** It lists how many products were new, updated or unchanged and how many foods were new or matched, then anything it couldn't carry over exactly: inactive products (skipped), units that aren't in the unit table (counted in "each"), products with no price, a price it couldn't use, and prices Grocy wouldn't return. Fix those by hand in the app, or in Grocy and run again.
6. Clear the key afterwards: `Remove-Item Env:GROCY_API_KEY`, and delete it in Grocy once switch-over is done.

## Sample transactions in Dev (card $1)

Until Plaid is connected (card $2), the money screens have nothing to show. `pnpm --filter @kitchen/db import:sample-money` loads five made-up transactions on two made-up accounts (`packages/db/test-fixtures/plaid-transactions.json`) into a database, through the same import Plaid will use. Running it again updates them rather than adding copies. It refuses a server or database whose name says Prod.

1. **Sign in to Azure** (no database password): `az login`. The database needs the latest migrations (a deploy applies them) and your household (sign in to the app once).
2. **Set the environment** (PowerShell):

   ```powershell
   $env:SQL_SERVER = "<server>.database.windows.net"   # Dev's SQL server
   $env:SQL_DATABASE = "<database name>"
   ```

3. **Run it** from the repo root: `pnpm --filter @kitchen/db import:sample-money`, then open Money in the app: add a category and a rule, press "Run rules now", and split a transaction.

---

# mealie-home (legacy laptop setup)

Self-hosted kitchen apps running on a Windows laptop with Docker Desktop:

- [Mealie](https://mealie.io): recipes, meal plans, shopping lists
- [Grocy](https://grocy.info): pantry stock and what things cost
- [Actual Budget](https://actualbudget.org): budget and bank transactions
- Kitchen bridge (`legacy/bridge/`, our own code): imports bank transactions from Plaid into Actual every morning. More glue between the apps will go here later.

- **Tasks:** Trello → *Home Lab* board
- **How it's set up / what to do when it breaks:** Notion → *Home Server* page
- **This repo:** the config and the `mealie` command. No passwords: those go in `legacy/.env`, which git ignores.

## First-time setup

1. Install WSL: open **Terminal (Admin)**, run `wsl --install`, restart.
2. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). In **Settings → General**, turn on **Start Docker Desktop when you sign in**.
3. Clone this repo, open a terminal in its folder, and run:

   ```
   .\legacy\mealie.cmd setup
   ```

4. Log in to each app and change the default login right away:
   - Mealie, http://localhost:9925: `changeme@example.com` / `MyPassword`
   - Grocy, http://localhost:9283: `admin` / `admin`
   - Actual Budget, http://localhost:5006: set a server password the first time you open it
5. Keep the laptop awake and turn on weekly backups:

   ```
   .\legacy\mealie.cmd power
   .\legacy\mealie.cmd schedule-backup
   ```

## Moving to legacy/ (one time, on the laptop)

The laptop files moved into `legacy/`. Your data and `.env` settings carry over; do this once after the change reaches `main`:

1. `git pull`
2. `.\legacy\mealie.cmd status`: moves your old `.env` from the repo root into `legacy\` (it says so) and warns if a weekly task still points at the old path.
3. `.\legacy\mealie.cmd schedule-backup`: registers the Sunday backup and audit tasks again with the new path. Until you do, the weekly backups quietly stop.

## Everyday commands

| Command | What it does |
| --- | --- |
| `.\legacy\mealie.cmd status` | Are all the apps running and answering? |
| `.\legacy\mealie.cmd start` / `stop` / `restart` | Start, stop (data kept), restart after editing `.env` |
| `.\legacy\mealie.cmd logs` / `logs grocy` | Live logs for all apps or one (`mealie`, `grocy`, `actual`, `bridge`); Ctrl+C to exit |
| `.\legacy\mealie.cmd url` | Addresses for this laptop and your phone |
| `.\legacy\mealie.cmd backup` | Full copy of each app's data → `OneDrive\MealieBackups` (keeps newest 8 per app) |
| `.\legacy\mealie.cmd restore <file>` | Replace one app's data with a backup; the file name says which app (backs up current data first) |
| `.\legacy\mealie.cmd update` | Back up, then run the versions in `legacy/docker-compose.yml` |
| `.\legacy\mealie.cmd audit` | Check every Mealie recipe for data problems (see below) |
| `.\legacy\mealie.cmd staples` | Add the pantry staples in `legacy\grocy\staples.csv` to Grocy (see below) |

## Recipe audit

`.\legacy\mealie.cmd audit` reads every recipe through the Mealie API and lists problems: no directions, yield or times; unit words such as "clove" left in an ingredient's note; foods that differ only by capitals; and diet tags that clash with ingredients (Vegan with honey, Gluten-Free with orzo, nuts without a Contains Nuts tag). The report is saved to the backup folder as `mealie-audit_<date>.txt` (newest 8 kept). `schedule-backup` also runs it every Sunday at 3:30am.

It needs a Mealie API token: in Mealie open your profile > API Tokens, then in PowerShell run `[Environment]::SetEnvironmentVariable('MEALIE_API_TOKEN', '<token>', 'User')`. The token stays on the laptop, never in this repo.

When entering a recipe, use foods already in Mealie's list (it suggests them as you type), put clove/bunch/can in the unit box, and check the diet tags against the ingredients.

## Pantry staples in Grocy

Grocy tracks only the staples you buy most (about 50), not every jar in the kitchen; anything not tracked is treated as "assume we need it" on the shopping list. The list lives in `legacy/grocy/staples.csv`, one row per product:

- **Unit** is how you buy and count it (jar, bottle, can, head), not the recipe unit.
- **Min stock**: Grocy flags the product for the shopping list when you have less than this.
- **Have now**: what's in the kitchen today. `staples` sets Grocy's stock to this number; leave it blank to skip.

`.\legacy\mealie.cmd staples` creates any missing locations, units, product groups and products, matching by name, then applies the Have now counts. It never changes products that already exist, so it's safe to run again after adding rows. It needs a Grocy API key: in Grocy open the user menu (top right) > Manage API keys > Add, then run `[Environment]::SetEnvironmentVariable('GROCY_API_KEY', '<key>', 'User')` and open a new terminal.

## Updating

Each app's version is pinned in `legacy/docker-compose.yml`, so nothing changes by surprise.

1. Dependabot opens a pull request here when a new Mealie, Grocy or Actual Budget release is out.
2. Read the release notes linked in the PR, then merge it.
3. On the laptop: `git pull`, then `.\legacy\mealie.cmd update`.

## Settings

Copy `legacy/.env.example` to `legacy/.env` (`setup` does this for you) and edit:

- `MEALIE_PORT`, `GROCY_PORT`, `ACTUAL_PORT`: ports on the laptop (defaults 9925, 9283, 5006)
- `BASE_URL`: the address other devices use for Mealie; `setup` fills in the laptop's Wi-Fi address
- `BACKUP_DIR`, `BACKUP_KEEP`: where backups go and how many to keep
- `BACKUP_COPY_DIR`: optional second copy off the laptop, e.g. `G:\My Drive\MealieBackups` with Google Drive for desktop signed in to a personal account (same `BACKUP_KEEP`). If the drive isn't there the local backup still happens and the command reports the missed copy.
- `SMTP_*`: optional email for invites and password resets (Gmail app password works)

Run `.\legacy\mealie.cmd restart` after changing `.env`.

## Bank sync (Plaid)

SimpleFIN couldn't connect SoFi, so bank transactions come from a free Plaid Trial account instead (ADR-22). The bridge pulls new **posted** transactions once a day and imports them into Actual; pending ones wait until they post. Each one carries Plaid's id, so running the sync again never doubles anything.

1. In Plaid's dashboard (Developers > Keys), copy the `client_id` and **Production** secret into `.env` as `PLAID_CLIENT_ID` and `PLAID_SECRET`.
2. Also in `legacy/.env`: `ACTUAL_PASSWORD` (your Actual server password) and `ACTUAL_SYNC_ID` (Actual: Settings > Show advanced settings > Sync ID).
3. In Actual, add a new empty account for the bank (without bank sync), e.g. *SoFi Checking*.
4. Run `.\legacy\mealie.cmd restart`, open http://localhost:8787 on the laptop, click **Connect a bank**, and log in to the bank in Plaid's window.
5. Next to each bank account, pick the Actual account it goes into (or *Don't import*), then click **Sync now**.

After that it runs every day at `BANK_SYNC_HOUR` (default 6am). The page shows the last run and any problem, such as the bank needing you to log in again (`ITEM_LOGIN_REQUIRED`): click **Reconnect** under that bank. Don't use **Connect a bank** for a bank that's already listed, because a second connection would import everything again. If the bank withdraws a transaction it already sent, the sync reports it and leaves Actual alone for you to check.

If your bank sends you to its own website to log in (OAuth), Plaid needs a redirect address: add it under Developers > API > Allowed redirect URIs and put the same address in `PLAID_REDIRECT_URI`.

The page is only reachable from the laptop itself (127.0.0.1). Keys stay in `legacy/.env`; never paste them anywhere else.

## Reaching it from your phone

- **At home:** use the address from `.\legacy\mealie.cmd url` on the same Wi-Fi. If it doesn't load, make sure Windows has the Wi-Fi set as a **Private** network.
- **Away from home:** install [Tailscale](https://tailscale.com) on the laptop and phone, then use the laptop's Tailscale address. Don't open the ports on your router.
- **Actual Budget needs https** when opened from any device other than the laptop itself (plain `http://` only works at `localhost`). Tailscale can give it a private https address:
  1. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and **HTTPS Certificates**.
  2. On the laptop, run `tailscale serve --bg 5006` once.
  3. On your phone (with Tailscale on), open `https://<laptop name>.<your tailnet>.ts.net`. This stays private to your Tailscale devices; it is not Funnel.

## Good to know

- Docker starts only after you sign in to Windows, so after a reboot Mealie is down until someone logs in.
- Data lives in Docker volumes named `mealie-data`, `grocy-data`, `actual-data` and `bridge-data`. `bridge-data` holds the Plaid access token, so its backups are as private as the budget's. `docker compose down` keeps them; `docker volume rm <name>` deletes one.
- GitHub checks every change: the compose file must be valid, the PowerShell script must pass linting, all four containers must start, survive a backup and restore, and answer in test containers, and the bridge's tests must pass.
