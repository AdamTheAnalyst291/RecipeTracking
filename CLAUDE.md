# Notes for Claude

- Runs on Adam's Windows laptop with Docker Desktop. Users run `.\mealie.cmd <command>`; all logic is in `mealie.ps1` (keep it Windows PowerShell 5.1 compatible).
- Mealie version is pinned in `docker-compose.yml`; Dependabot bumps it. Don't switch to `latest`.
- Data lives in the Docker volume `mealie-data` (fixed name; backup/restore depend on it). SQLite, not Postgres.
- Never commit `.env` or secrets.
- Tasks: Trello board "Home Lab". Docs: Notion page "Home Server". Update both when something changes.
