# Glossary

Terms the kitchen app uses, so code, cards and tests say the same thing. Decisions live in the Notion Decisions database, not here.

- **Household**: the group of people who share one kitchen: its recipes, pantry, shopping lists and money. There is one household for now (ADR-25), and every API request acts within it.
- **Household member**: someone allowed into a household, identified by their Microsoft Entra object ID (`oid`). Today the only member is Adam. A signed-in account that isn't a member is refused (403).
