# Notes for Claude

- **Where this is going (ADR-25):** one kitchen app of our own replaces Mealie, Grocy and Actual Budget. Recipes, meal plans, pantry staples with prices, shopping lists, money (ADR-27), a warehouse (ADR-28) and an MCP endpoint for Claude (ADR-26). Plan and tickets: Trello board "Personal Finance & Meal Planning System", one list per milestone.
- **Stack, copied from Setlist:** pnpm + turbo monorepo; `apps/web` (React + Vite, installable mobile-first) on Static Web Apps Free; `apps/api` (Node 24 Functions, Flex Consumption); Azure SQL free tier; Key Vault; Terraform in `infra/`, deployed through GitHub OIDC. Subscription My-VibeCode, region `centralus`, resource groups `rg-kitchen-<env>`. Sign-in is Microsoft Entra, Adam only; the data model has a `household`.
- **Environments:** merges to `main` deploy to Dev on their own. Every Prod deploy waits for Adam's approval in the `prod` GitHub Environment.
- **Until switch-over (card S3):** the old laptop setup still runs and is the live system. Mealie, Grocy, Actual Budget and the kitchen bridge (`bridge/`, Plaid sync into Actual, from ADR-22) run under Docker Desktop through `.\mealie.cmd` and `mealie.ps1` (keep it Windows PowerShell 5.1 compatible). Card F1 moves these files to `legacy/`; S3 deletes them. Their data is in fixed-name Docker volumes (`mealie-data`, `grocy-data`, `actual-data`, `bridge-data`). Reuse the bridge's Plaid logic (`bridge/src/plaid.ts`, `sync.ts`, `convert.ts`) as prior art for card $2.
- Pinned versions only: Docker images, npm packages, Terraform providers. Dependabot bumps them. Never `latest`.
- Secrets live in Key Vault (cloud) or `.env` (legacy laptop). Never in git, chat, app settings or skills.
- Docs: Notion page "Home Server". Update it, and the Trello cards, when something changes.
- Decisions: Notion database "Decisions" under Home Server (https://app.notion.com/p/9ff4eae7895e41f5b290222abad9a118). Check it before changing how things work; a new decision is a new ADR page (Proposed, then Accepted), never an edit to an accepted one. Cite the ADR number and Trello card in PR descriptions.

## Agent skills

Engineering skills from Matt Pocock's set live in `.claude/skills` (see its README; ADR-21).

### Issue tracker

Trello: cards are tasks, a "Steps" checklist holds the subtasks (ADR-20). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root (created lazily); ADRs only in the Notion Decisions database. See `docs/agents/domain.md`.

## Working with agents

A ticket is a Trello card labelled `Claude can do`, shaped as in `docs/agents/issue-tracker.md`. A card is startable when every card on its `Needs:` line has its PR merged (ADR-29).

### Roles

- **Parent session (quarterback).** Runs the board, proposes or starts child sessions, answers the children's questions or passes them to Adam, reviews each pull request, and keeps the Trello cards and the Notion Home Server page up to date. It never writes ticket code. The only files it changes itself are agent and planning docs such as this one.
- **Child session.** Builds exactly one card, on one branch, ending in one pull request.
- **Subagents.** Short helper jobs inside a turn only: checking a fact on a web page, searching the code, an independent review. Never a card.

### Running the board

- When Adam says **"run the board"**, the parent starts a child for each startable `Claude can do` card, oldest milestone first, and starts the next one after each merge. It stops when nothing is startable or everything left needs Adam, and reports what's waiting on him. Nothing runs on a schedule.
- At most two children run at once, each on its own files.
- Each child runs locally in its own git worktree, branched from the latest `main`, with a fresh context. The brief gives the card URL and lists the steps below.
- Models: the parent uses Claude Opus 5.5. Children use Claude Sonnet 5.5, or Claude Opus 5.5 when the parent judges the card needs it (auth, money, infra). Subagents use Claude Haiku 5.5 or Claude Sonnet 5.5.

### How a child builds a card

1. Move the card to Doing. Read it (description, Steps, comments), the ADRs it links, `GLOSSARY.md` and this file.
2. Do the card's `[Claude]` steps. Build test-first with the `tdd` skill against fixtures. Typecheck and run single test files often, and the full suite at the end.
3. Review the diff with the `code-review` skill and fix what it finds.
4. Rebase onto the latest `main`, fix any conflicts, and rerun the tests.
5. Commit, push, and open a pull request named after the card, using `.github/pull_request_template.md` (`Card:`, `Decision:`), with the card's `Done when:` line as a checklist. Check off the card's finished `[Claude]` steps.
6. Turn on Auto-fix for the pull request, wait for CI to pass, then report back to the parent.

### When a child stops and asks

A child decides everything else itself, but asks the parent first:

- before running Terraform `apply`, or anything that touches Prod
- before running `docker compose` or any `mealie.cmd` command that starts, stops, updates or restores apps: the project and volume names are fixed, so it acts on Adam's real legacy apps from any worktree
- before touching real data, bank sync, Key Vault, `.env`, API tokens or anything else secret
- before creating or changing anything that could cost money (Azure resources, paid services, Anthropic API calls)
- before changing GitHub, Azure, Trello board or Notion settings
- before anything destructive (deleting data, resources, cards or branches, data-dropping migrations, force pushes)
- when the card is unclear, or conflicts with an ADR or the glossary; a new decision goes to the parent as a proposed ADR
- when the same blocker has failed twice

The parent passes on to Adam whatever only he can decide.

### Review and merge

- The parent reviews every pull request:
  - CI checks pass
  - the card's `Done when:` line is met
  - a `code-review` run against `main` covers the repo's standards and the card
- **Files Adam merges himself:** `infra/`, `.github/workflows/`, database migrations that drop or rewrite data, money and Plaid code, and authentication (sign-in, OAuth, the MCP auth layer). A PR that touches any of them waits for Adam, whatever its labels say.
- **Auto-merge:** a PR whose card has the `Auto-merge OK` label and touches none of those files merges once CI and the review pass. The parent turns on GitHub auto-merge for it and tells Adam in one line.
- **Everything else:** the parent reports the result to Adam in one short message, recommending merge or fix first. Nothing is posted on GitHub unless Adam asks.
- Findings go back to the child that built the card, which fixes them on the same branch and reports again. Children never merge.
- After a merge, the card stays out of Done until its `[Adam] Verify` step is checked.

### After a merge

Adam has given the parent standing permission to do these without asking each time:

- pull `main`
- delete the merged branch locally and on GitHub
- remove the child's worktree
- archive the child session
