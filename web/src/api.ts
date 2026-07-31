/** Types mirror the server's route/tool payloads. */

export interface Tag {
  id: string;
  category: "cuisine" | "dish_type" | "dietary";
  value: string;
  status: string;
  usage_count: number;
}

export interface RecipeSummary {
  id: string;
  title: string;
  source_type: string;
  total_time_min: number | null;
  kcal: number | null;
  extraction_partial: boolean;
  created_at: string;
  tags: { category: string; value: string }[];
  ingredient_names: string[];
}

export interface RecipeDetail {
  id: string;
  title: string;
  servings: number | null;
  total_time_min: number | null;
  steps: string[];
  ingredients: { name: string; quantity: number | null; unit: string | null; raw_text: string }[];
  tags: { category: string; value: string }[];
  macros_per_serving: { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null } | null;
  macros_estimated: boolean;
  extraction_partial: boolean;
  source_type: string;
  source_url: string;
  source_detail: string | null;
  photo_path: string | null;
}

export interface IngestResult {
  status: "saved" | "updated";
  source: "web" | "youtube" | "photo";
  recipeId: string;
  title: string;
  partial: boolean;
}

export interface IngestionJob {
  id: string;
  source_url: string;
  source_type: "web" | "youtube";
  captured_title: string;
  status: "queued" | "processing" | "failed";
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  submitted_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  recipe_ids: string[];
}

export interface SearchResult {
  id: string;
  title: string;
  cuisine: string[];
  dish_type: string[];
  total_time_min: number | null;
  macros: { kcal: number; protein_g: number; carbs_g: number; fat_g: number } | null;
}

export interface ToolEvent {
  tool: string;
  input: unknown;
  output: unknown;
}

export interface ChatResponse {
  reply: string;
  toolEvents: ToolEvent[];
}

export interface MealPlan {
  id: string;
  title: string;
  start_date: string | null;
  entries: {
    entry_id: string;
    recipe_id: string;
    title: string;
    day: string | null;
    meal_slot: string | null;
    servings: number | null;
  }[];
}

export interface MealPlanSummary {
  id: string;
  title: string;
  start_date: string | null;
  created_at: string;
  recipe_count: number;
  latest_grocery_list_id: string | null;
}

export interface PlanRecipeIngredients {
  recipe_id: string;
  title: string;
  servings: number | null;
  items: { name: string; quantity: number | null; unit: string | null }[];
}

export interface GroceryItem {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  checked: boolean;
  category: string | null;
}

export interface Staple {
  id: string;
  name: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  chat: (messages: { role: "user" | "assistant"; content: string }[]) =>
    req<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ messages }) }),
  recipes: () => req<RecipeSummary[]>("/api/recipes"),
  recipe: (id: string) => req<RecipeDetail>(`/api/recipes/${id}`),
  deleteRecipe: (id: string) => req(`/api/recipes/${id}`, { method: "DELETE" }),
  ingestionJobs: () => req<IngestionJob[]>("/api/ingestion-jobs"),
  retryIngestionJob: (id: string) =>
    req<IngestionJob>(`/api/ingestion-jobs/${id}/retry`, { method: "POST" }),
  dismissIngestionJob: (id: string) =>
    req<{ ok: true }>(`/api/ingestion-jobs/${id}`, { method: "DELETE" }),
  ingestPhoto: (imageBase64: string, mediaType: string) =>
    req<IngestResult[]>("/api/ingest-photo", { method: "POST", body: JSON.stringify({ imageBase64, mediaType }) }),
  tags: () => req<Tag[]>("/api/tags"),
  renameTag: (id: string, value: string) =>
    req(`/api/tags/${id}`, { method: "PATCH", body: JSON.stringify({ value }) }),
  deleteTag: (id: string) => req(`/api/tags/${id}`, { method: "DELETE" }),
  mergeTag: (id: string, into: string) =>
    req(`/api/tags/${id}/merge`, { method: "POST", body: JSON.stringify({ into_tag_id: into }) }),
  pantry: () => req<Staple[]>("/api/pantry"),
  addStaple: (name: string) => req("/api/pantry", { method: "POST", body: JSON.stringify({ name }) }),
  removeStaple: (id: string) => req(`/api/pantry/${id}`, { method: "DELETE" }),
  mealPlan: (id: string) => req<MealPlan>(`/api/meal-plans/${id}`),
  mealPlans: () => req<MealPlanSummary[]>("/api/meal-plans"),
  updateMealPlan: (id: string, patch: { title?: string; start_date?: string | null }) =>
    req(`/api/meal-plans/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteMealPlan: (id: string) => req(`/api/meal-plans/${id}`, { method: "DELETE" }),
  updatePlanEntry: (entryId: string, day: string | null) =>
    req(`/api/meal-plan-recipes/${entryId}`, { method: "PATCH", body: JSON.stringify({ day }) }),
  planIngredients: (id: string) => req<PlanRecipeIngredients[]>(`/api/meal-plans/${id}/ingredients`),
  groceryList: (id: string) =>
    req<{ id: string; meal_plan_id: string; items: GroceryItem[] }>(`/api/grocery-lists/${id}`),
  toggleItem: (id: string, checked: boolean) =>
    req(`/api/grocery-items/${id}`, { method: "PATCH", body: JSON.stringify({ checked }) }),
  sendListToReminders: (listId: string) =>
    req<{ sent: number; list: string }>(`/api/grocery-lists/${listId}/send-to-reminders`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};
