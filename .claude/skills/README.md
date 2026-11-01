# Engineering skills

From Matt Pocock's [Skills For Real Engineers](https://github.com/mattpocock/skills) (MIT, see `LICENSE-mattpocock-skills`), copied at upstream commit `5beb35b040e3de97e54fa9e386d7e42d15c295c2`. Decision: ADR-21.

| Skill | Use it for |
|---|---|
| `/grill-me`, `/grill-with-docs` | A question session before building, so the plan matches what Adam wants. `grill-with-docs` also updates `GLOSSARY.md` and proposes ADRs. |
| `/to-spec` | Turn the conversation into a spec on a Trello card. |
| `/to-tickets` | Break a plan or spec into Trello cards with Steps checklists. |
| `tdd` | Red-green-refactor, one vertical slice at a time (the kitchen bridge). |
| `diagnosing-bugs` | A disciplined loop for hard bugs. |
| `codebase-design`, `/improve-codebase-architecture` | Keep modules deep and seams clean. |
| `code-review` | Review a branch against the repo's standards and its Trello card. |
| `pr` | Shape of a PR body. |
| `grilling`, `domain-modeling` | Helpers the skills above call. |

Skills with a leading `/` run only when typed; the others Claude can pick up on its own.

## Changes from upstream

Every change is marked with a `RecipeTracking adaptation` comment or points to `docs/agents/`:

- Tickets go to Trello, not GitHub Issues (`docs/agents/issue-tracker.md`).
- ADRs go to the Notion Decisions database, never `docs/adr/` (`docs/agents/domain.md`, `domain-modeling/ADR-FORMAT.md`).
- PR bodies keep the repo's PR template (`pr/SKILL.md`).
- Codex-only `agents/openai.yaml` files are left out. `setup-matt-pocock-skills` isn't included; its output is the two files in `docs/agents/`.

## Updating

Re-copy the folders from upstream, then re-apply the changes above (`git diff` against the "unmodified" commit shows them).
