-- Grocery list store-section categorization. Assigned by the agent during
-- consolidation (save_grocery_list); the UI groups items under these headers.
-- Plain text (constrained by the tool's zod enum, not a DB CHECK) so the
-- category set can evolve without a migration. Pre-existing rows stay NULL
-- and render under "other".

ALTER TABLE grocery_items ADD COLUMN category text;
