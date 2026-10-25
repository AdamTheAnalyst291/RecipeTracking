# mealie-home

Self-hosted [Mealie](https://mealie.io) (recipes, meal plans, shopping lists) running on a Windows laptop with Docker Desktop.

- **Tasks:** Trello → *Home Lab* board
- **How it's set up / what to do when it breaks:** Notion → *Home Server* page
- **This repo:** the config and the `mealie` command. No passwords: those go in `.env`, which git ignores.

## First-time setup

1. Install WSL: open **Terminal (Admin)**, run `wsl --install`, restart.
2. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/). In **Settings → General**, turn on **Start Docker Desktop when you sign in**.
3. Clone this repo, open a terminal in its folder, and run:

   ```
   .\mealie.cmd setup
   ```

4. Open http://localhost:9925 and log in with `changeme@example.com` / `MyPassword`. Change both right away.
5. Keep the laptop awake and turn on weekly backups:

   ```
   .\mealie.cmd power
   .\mealie.cmd schedule-backup
   ```

## Everyday commands

| Command | What it does |
| --- | --- |
| `.\mealie.cmd status` | Is it running and answering? |
| `.\mealie.cmd start` / `stop` / `restart` | Start, stop (data kept), restart after editing `.env` |
| `.\mealie.cmd logs` | Live logs (Ctrl+C to exit) |
| `.\mealie.cmd url` | Addresses for this laptop and your phone |
| `.\mealie.cmd backup` | Full copy of Mealie's data → `OneDrive\MealieBackups` (keeps newest 8) |
| `.\mealie.cmd restore <file>` | Replace all data with a backup (backs up current data first) |
| `.\mealie.cmd update` | Back up, then run the version in `docker-compose.yml` |
| `.\mealie.cmd audit` | Check every recipe for data problems (see below) |

## Recipe audit

`.\mealie.cmd audit` reads every recipe through the Mealie API and lists problems: no directions, yield or times; unit words such as "clove" left in an ingredient's note; foods that differ only by capitals; and diet tags that clash with ingredients (Vegan with honey, Gluten-Free with orzo, nuts without a Contains Nuts tag). The report is saved to the backup folder as `mealie-audit_<date>.txt` (newest 8 kept). `schedule-backup` also runs it every Sunday at 3:30am.

It needs a Mealie API token: in Mealie open your profile > API Tokens, then in PowerShell run `[Environment]::SetEnvironmentVariable('MEALIE_API_TOKEN', '<token>', 'User')`. The token stays on the laptop, never in this repo.

When entering a recipe, use foods already in Mealie's list (it suggests them as you type), put clove/bunch/can in the unit box, and check the diet tags against the ingredients.

## Updating Mealie

The Mealie version is pinned in `docker-compose.yml`, so nothing changes by surprise.

1. Dependabot opens a pull request here when a new Mealie release is out.
2. Read the release notes linked in the PR, then merge it.
3. On the laptop: `git pull`, then `.\mealie.cmd update`.

## Settings

Copy `.env.example` to `.env` (`setup` does this for you) and edit:

- `MEALIE_PORT`: port on the laptop (default 9925)
- `BASE_URL`: the address other devices use; `setup` fills in the laptop's Wi-Fi address
- `BACKUP_DIR`, `BACKUP_KEEP`: where backups go and how many to keep
- `SMTP_*`: optional email for invites and password resets (Gmail app password works)

Run `.\mealie.cmd restart` after changing `.env`.

## Reaching it from your phone

- **At home:** use the address from `.\mealie.cmd url` on the same Wi-Fi. If it doesn't load, make sure Windows has the Wi-Fi set as a **Private** network.
- **Away from home:** install [Tailscale](https://tailscale.com) on the laptop and phone, then use the laptop's Tailscale address. Don't open the port on your router.

## Good to know

- Docker starts only after you sign in to Windows, so after a reboot Mealie is down until someone logs in.
- Data lives in a Docker volume named `mealie-data`. `docker compose down` keeps it; `docker volume rm mealie-data` deletes it.
- GitHub checks every change: the compose file must be valid, the PowerShell script must pass linting, and Mealie must start and answer in a test container.
