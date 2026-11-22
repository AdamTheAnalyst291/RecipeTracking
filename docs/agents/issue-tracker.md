# Issue tracker: Trello

Tickets for this repo live on Trello, not GitHub Issues (ADR-14, ADR-20). Use the Trello connector.

- **Personal Finance & Meal Planning System** board: the kitchen app (ADR-25). One list per milestone (`M1: Foundation` … `M7: Later`), plus `Content channel`, Doing and Done. Cards are named by code (`F1`, `K3`, `$2`, `W2a`, `C1`…).
- **Home Lab** board: the laptop and the legacy apps until switch-over (S3), and repo tooling.

## Shape of a ticket

- A **card** is one task: one outcome that can be finished.
- The description starts with `Needs: <card codes>` (or `Needs: nothing`), then context, the `Decision:` ADR links, an `Auto-merge: yes/no (reason)` line, and a `Done when:` line that fixtures and CI can prove. Steps never go in the description.
- Subtasks are a checklist named **Steps**. Each item starts with who does it, `[Adam]` or `[Claude]`. The last item is `[Adam] Verify: <the live check>`, done after merge (ADR-29).
- A card is **startable** when every card on its `Needs:` line has its PR merged. It moves to **Done** only after its Verify step is checked.
- Checklists named "Old plan (replaced …, ignore)" are history; work from **Steps**.
- A task bigger than about 8 steps or one work session becomes several cards. The parent card keeps a **Parts** checklist whose items are the child cards' URLs.
- Never edit or delete comments. Add a dated comment instead.

## Labels

| Label | Meaning |
|---|---|
| red `Needs Adam` | the next unchecked step is Adam's |
| green `Claude can do` | the next unchecked step is Claude's (this is `ready-for-agent`) |
| orange `Blocked` | waiting on another card or something outside the project |
| purple `Decision` | needs a decision (an ADR) before work goes on |
| blue `Auto-merge OK` | the PR may merge on its own once CI and `code-review` pass, unless the diff touches a file Adam merges (see CLAUDE.md) |

## When a skill says "publish to the issue tracker"

- **A spec** (`/to-spec`): create a card in the right list with the spec as its description, label `Claude can do`.
- **Tickets** (`/to-tickets`): one card per ticket, in dependency order, in the same list as the parent. Trello has no native blocking links, so start each description with `Needs: <card names or URLs>` (or `Needs: nothing`). Give each card a Steps checklist built from its acceptance criteria, and give it `Auto-merge OK` only when nothing it changes is on CLAUDE.md's list of files Adam merges. If the work came from an existing card, add the new cards' URLs to that card's Parts checklist; don't otherwise change the parent.
- Show Adam the breakdown and get his OK before creating cards.

## When a skill says "fetch the relevant ticket"

Read the card (description, checklists and comments) with the Trello connector. Adam will usually pass the card URL. PR descriptions start with `Card: <url>`, so a branch's card can be found from its PR.
