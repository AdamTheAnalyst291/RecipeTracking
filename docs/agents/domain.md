# Domain docs

How the engineering skills should read and write this repo's domain documentation.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, if it exists. It's created lazily by `/domain-modeling` the first time a term is resolved.
- **Decisions**: the Notion database "Decisions" under the Home Server page (https://app.notion.com/p/9ff4eae7895e41f5b290222abad9a118). Read the ADRs whose Area matches what you're touching (Home server, Recipes, Pantry, Budget, Kitchen bridge, Security, Ways of working).

There is no `docs/adr/` in this repo, and there must never be one: decisions live only in Notion (ADR-14). Wherever a skill says `docs/adr/`, use the Notion database instead.

If `GLOSSARY.md` doesn't exist, proceed silently.

## Use the glossary's vocabulary

When your output names a domain concept (a card title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary avoids.

## Flag ADR conflicts

If your output contradicts an existing ADR, say so explicitly rather than silently overriding it:

> _Contradicts ADR-9 (laptop home server, no cloud database), but worth reopening because…_

A changed decision is a **new** ADR that supersedes the old one, never an edit to an accepted ADR.
