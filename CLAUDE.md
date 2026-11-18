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

## Working with agents

A ticket is a Trello card labelled `Claude can do`, shaped as in `docs/agents/issue-tracker.md`. A card can start only when every card on its `Needs:` line is in Done.

### Roles

- **Parent session (quarterback).** Picks the next startable cards, proposes a child session for each, answers the children's questions or passes them to Adam, reviews each pull request, and keeps the Trello cards and the Notion Home Server page up to date. It never writes ticket code. The only files it changes itself are agent and planning docs such as this one.
- **Child session.** Builds exactly one card, on one branch, ending in one pull request.
- **Subagents.** Short helper jobs inside a turn only: checking a fact on a web page, searching the code, an independent review. Never a card.

### Starting children

- The parent proposes each child session with its brief, and Adam starts it. Children start only when Adam starts them, unless he changes this rule.
- At most two children run at once, each on its own files.
- Each child runs locally in its own git worktree, branched from the latest `main`, with a fresh context. The brief gives the card URL and lists the steps below.
- Models: the parent uses Claude Opus 5.5. Children use Claude Sonnet 5.5, or Claude Opus 5.5 when the parent judges the card needs it. Subagents use Claude Haiku 5.5 or Claude Sonnet 5.5.

### How a child builds a card

1. Move the card to Doing. Read it (description, Steps, comments), its parent card, the ADRs it links, `GLOSSARY.md` and this file.
2. Do the card's `[Claude]` steps. Build test-first with the `tdd` skill where the code has a seam to test; for `mealie.ps1` and `docker-compose.yml`, run the same checks CI runs (`.github/workflows/check.yml`) that need no containers.
3. Review the diff with the `code-review` skill and fix what it finds.
4. Rebase onto the latest `main`, fix any conflicts, and rerun the checks.
5. Commit, push, and open a pull request named after the card, using `.github/pull_request_template.md` (`Card:`, `Decision:`), with the card's `Done when:` line as a checklist. Check off the card's finished `[Claude]` steps.
6. Turn on Auto-fix for the pull request, wait for CI to pass, then report back to the parent.

### When a child stops and asks

A child decides everything else itself, but asks the parent first:

- before running `docker compose` or any `mealie.cmd` command that starts, stops, updates or restores apps: the project and volume names are fixed, so it acts on Adam's real Mealie, Grocy and Actual Budget from any worktree
- before touching real app data, bank sync, `.env`, API tokens or anything else secret
- before creating or changing anything that could cost money (paid services, Anthropic API calls)
- before changing GitHub, Trello board, Notion or Tailscale settings
- before anything destructive (deleting data, volumes, cards or branches, force pushes)
- when the card is unclear, or conflicts with an ADR or the glossary; a new decision goes to the parent as a proposed ADR
- when the same blocker has failed twice

The parent passes on to Adam whatever only he can decide.

### Review and merge

- The parent reviews every pull request:
  - CI checks pass
  - the card's `Done when:` line is met
  - a `code-review` run against `main` covers the repo's standards and the card
  - for changes to the running apps, Adam has the `[Adam]` steps he needs to try it on the laptop
- The parent reports the result to Adam in one short message, recommending merge or fix first. Nothing is posted on GitHub unless Adam asks.
- Findings go back to the child that built the card, which fixes them on the same branch and reports again.
- Only Adam decides to merge. Children never merge.

### After a merge

Adam has given the parent standing permission to do these without asking each time:

- pull `main`
- delete the merged branch locally and on GitHub
- remove the child's worktree
- archive the child session
