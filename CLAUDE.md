# Notes for Claude

- Runs on Adam's Windows laptop with Docker Desktop: Mealie (recipes), Grocy (pantry), Actual Budget (money). Users run `.\mealie.cmd <command>`; all logic is in `mealie.ps1` (keep it Windows PowerShell 5.1 compatible). The `$Apps` table there lists each app's service, volume, port and health URL.
- Image versions are pinned in `docker-compose.yml`; Dependabot bumps them. Don't switch to `latest`.
- Data lives in the Docker volumes `mealie-data`, `grocy-data`, `actual-data` (fixed names; backup/restore depend on them). All SQLite, not Postgres.
- Bigger plan (meal plan → pantry → budget loop, kitchen bridge, MCP connector): Trello board "Personal Finance & Meal Planning System".
- Never commit `.env` or secrets.
- Tasks: Trello board "Home Lab". Docs: Notion page "Home Server". Update both when something changes.
- Decisions: Notion database "Decisions" under Home Server (https://app.notion.com/p/9ff4eae7895e41f5b290222abad9a118). Check it before changing how things work; a new decision is a new ADR page (Proposed, then Accepted), never an edit to an accepted one. Cite the ADR number and Trello card in PR descriptions.

## Agent skills

Engineering skills from Matt Pocock's set live in `.claude/skills` (see its README; ADR-21).

### Issue tracker

Trello: cards are tasks, a "Steps" checklist holds the subtasks (ADR-20). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root (created lazily); ADRs only in the Notion Decisions database. See `docs/agents/domain.md`.
