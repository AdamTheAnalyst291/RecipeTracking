# Issue tracker: Trello

Tickets for this repo live on Trello, not GitHub Issues (ADR-14, ADR-20). Use the Trello connector.

- **Home Lab** board: the repo itself, the laptop, `mealie.cmd`, backups, tooling.
- **Personal Finance & Meal Planning System** board: the bigger plan (bank sync, pantry, kitchen bridge, MCP connector), one list per phase plus Doing and Done.

## Shape of a ticket

- A **card** is one task: one outcome that can be finished.
- The description holds context, links (ADR, plan) and a `Done when:` line. Steps never go in the description.
- Subtasks are a checklist named **Steps**. Each item starts with who does it, `[Adam]` or `[Claude]`. The last item is `Verify: <the Done when line>`.
- A task bigger than about 8 steps or one work session becomes several cards. The parent card keeps a **Parts** checklist whose items are the child cards' URLs.
- Never edit or delete comments. Add a dated comment instead.

## Labels

| Label | Meaning |
|---|---|
| red `Needs Adam` | the next unchecked step is Adam's |
| green `Claude can do` | the next unchecked step is Claude's (this is `ready-for-agent`) |
| orange `Blocked` | waiting on another card or something outside the project |
| purple `Decision` | needs a decision (an ADR) before work goes on |

## When a skill says "publish to the issue tracker"

- **A spec** (`/to-spec`): create a card in the right list with the spec as its description, label `Claude can do`.
- **Tickets** (`/to-tickets`): one card per ticket, in dependency order, in the same list as the parent. Trello has no native blocking links, so start each description with `Needs: <card names or URLs>` (or `Needs: nothing`). Give each card a Steps checklist built from its acceptance criteria. If the work came from an existing card, add the new cards' URLs to that card's Parts checklist; don't otherwise change the parent.
- Show Adam the breakdown and get his OK before creating cards.

## When a skill says "fetch the relevant ticket"

Read the card (description, checklists and comments) with the Trello connector. Adam will usually pass the card URL. PR descriptions start with `Card: <url>`, so a branch's card can be found from its PR.
