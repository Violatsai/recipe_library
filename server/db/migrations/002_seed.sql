-- Starter taxonomy + pantry staples (ARCHITECTURE.md / execution-plan Appendix C).
-- All tags seed as 'approved' (status default). ON CONFLICT keeps this idempotent.

INSERT INTO tag_categories (id, label) VALUES
  ('cuisine',   'Cuisine'),
  ('dish_type', 'Dish type'),
  ('dietary',   'Dietary')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tags (category, value) VALUES
  -- cuisine
  ('cuisine', 'Mediterranean'),
  ('cuisine', 'Japanese'),
  ('cuisine', 'Taiwanese'),
  ('cuisine', 'Chinese'),
  ('cuisine', 'Korean'),
  ('cuisine', 'Thai'),
  ('cuisine', 'Vietnamese'),
  ('cuisine', 'Indian'),
  ('cuisine', 'Italian'),
  ('cuisine', 'French'),
  ('cuisine', 'Mexican'),
  ('cuisine', 'American'),
  -- dish_type
  ('dish_type', 'breakfast'),
  ('dish_type', 'salad'),
  ('dish_type', 'soup'),
  ('dish_type', 'main'),
  ('dish_type', 'side'),
  ('dish_type', 'dessert'),
  ('dish_type', 'snack'),
  ('dish_type', 'drink'),
  -- dietary
  ('dietary', 'vegetarian'),
  ('dietary', 'vegan'),
  ('dietary', 'gluten-free'),
  ('dietary', 'dairy-free'),
  ('dietary', 'nut-free'),
  ('dietary', 'pescatarian')
ON CONFLICT (category, value) DO NOTHING;

INSERT INTO pantry_staples (name) VALUES
  ('salt'),
  ('black pepper'),
  ('olive oil'),
  ('neutral oil'),
  ('sugar'),
  ('flour'),
  ('butter'),
  ('soy sauce'),
  ('garlic'),
  ('water')
ON CONFLICT (name) DO NOTHING;
