# Glossary

Terms the kitchen app uses, so code, cards and tests say the same thing. Decisions live in the Notion Decisions database, not here.

- **Household**: the group of people who share one kitchen: its recipes, pantry, shopping lists and money. There is one household for now (ADR-25), and every API request acts within it.
- **Household member**: someone allowed into a household, identified by their Microsoft Entra object ID (`oid`). Today the only member is Adam. A signed-in account that isn't a member is refused (403).
- **Product**: something the household buys or keeps, tied to one food (several products can share a food, such as two brands of flour). It holds current stock in a unit and the latest price with its date.
- **Staple**: a product flagged as tracked. Only staples are tracked; a food with no staple product, or whose staples have run out, counts as "assume we need it" when planning a shop.
- **Pantry snapshot**: the one row per product per day (UTC) holding its stock and price that day, written by a daily timer. Running again the same day overwrites that day's row; a missed day can't be rebuilt (ADR-28).
- **Cooked event**: one row each time someone presses "I made this" on a recipe: the household, recipe (name copied in), servings made and when. Pressing it also uses up pantry stock: each ingredient, scaled to servings made, comes off the matching products. Foods with no product are ignored and stock stops at 0; what ran short is reported as a shortfall.
- **Meal plan**: the household's planned meals. The week view shows seven days (Monday to Sunday), today's meals first.
- **Planned meal**: one recipe set for a date and a meal slot, with a servings count. It starts at the recipe's own servings (1 if the recipe has none). The same recipe may be planned twice in a slot. Deleting a recipe removes its planned meals.
- **Meal slot**: which meal of the day a planned meal is for: breakfast, lunch, dinner or snack, shown in that order.
- **Import link**: a row in `import_source` remembering which kitchen row an item imported from another system (today Mealie, card K3) became, plus a fingerprint of what was imported. A second import run uses it to skip unchanged items, update changed ones and never duplicate. Mealie meal plan entries become planned meals; entries that are only a note are skipped and reported.
