# ADR Format

<!-- RecipeTracking adaptation: ADRs live in Notion, not docs/adr/ (ADR-14). See docs/agents/domain.md. -->

ADRs live in the Notion database "Decisions" under the Home Server page (https://app.notion.com/p/9ff4eae7895e41f5b290222abad9a118), one page per decision. Never create `docs/adr/` in the repo.

The `ADR` number is assigned automatically by Notion. Refer to decisions as `ADR-<n>`.

## Properties

- **Title**: short title of the decision
- **Status**: `Proposed` when created; set to `Accepted` only after Adam agrees. Also `Superseded` or `Rejected`.
- **Area**: one or more of Home server, Recipes, Pantry, Budget, Kitchen bridge, Security, Ways of working
- **Decided on**: the date
- **Trello card**, **GitHub** (PR URL), **Plan page**: links, when they exist
- **Supersedes** / **Superseded by**: relations to other ADRs

## Body

Match the existing pages:

```md
## Context

{why this came up}

## Decision

{what we decided, as short bullets}

## Options considered

{only alternatives worth remembering}

## Consequences

{only non-obvious downstream effects}

## Revisit when

{optional: the signal that should reopen it}
```

An ADR can be short. The value is in recording *that* a decision was made and *why*.

## Changing a decision

Never edit an accepted ADR's decision. Write a new ADR that supersedes it, and set the old one to `Superseded`.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it: you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library: just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it; otherwise someone will suggest GraphQL again in six months.
