# kitchen

Two halves live in this repo while the move happens (ADR-25):

- **The new kitchen app** (`apps/`, `packages/`): a pnpm + turbo monorepo that will replace Mealie, Grocy and Actual Budget. `apps/web` is React + Vite, `apps/api` is Azure Functions on Node 24, and `packages/shared` holds types both use. From the repo root: `pnpm install`, then `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. CI (`.github/workflows/pull-request.yml`) runs the same on each pull request.
- **The legacy laptop setup** (`legacy/`): everything below. It is still the live system until switch-over (card S3), then it is deleted. Run its commands from the repo root as `.\legacy\mealie.cmd <command>`.

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
