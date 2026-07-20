-- Photo-sourced recipes (extracted from an uploaded image via Claude vision).
-- photo_path: relative path under the server's served /uploads directory —
-- the recipe detail view shows the actual photo instead of a source link.
ALTER TABLE recipes ADD COLUMN photo_path text;

ALTER TABLE recipes DROP CONSTRAINT recipes_source_type_check;
ALTER TABLE recipes ADD CONSTRAINT recipes_source_type_check
  CHECK (source_type IN ('web', 'youtube', 'photo'));
