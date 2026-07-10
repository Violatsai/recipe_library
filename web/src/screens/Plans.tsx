import { useEffect, useState } from "react";
import { api, type MealPlanSummary } from "../api";
import { GroceryListCard, MealPlanCard, RecipeOverlay } from "../components";

/** Persistent home for meal plans + grocery lists — everything the chat agent
 *  creates lands here, editable and checkable after the conversation is gone. */
export function Plans({
  active,
  openPlanId,
  onOpenConsumed,
}: {
  active: boolean;
  openPlanId: string | null;
  onOpenConsumed: () => void;
}) {
  const [plans, setPlans] = useState<MealPlanSummary[] | null>(null);
  const [selected, setSelected] = useState<MealPlanSummary | null>(null);
  const [viewRecipe, setViewRecipe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bump to force MealPlanCard re-fetch after title/date edits
  const [version, setVersion] = useState(0);

  const load = () => {
    api
      .mealPlans()
      .then((p) => {
        setPlans(p);
        // keep the selected plan's summary fresh after edits
        setSelected((cur) => (cur ? p.find((x) => x.id === cur.id) ?? null : cur));
      })
      .catch((e) => setError(e.message));
  };
  // refresh whenever the tab becomes visible (screens stay mounted now)
  useEffect(() => {
    if (active) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // chat's "View in Plans →" lands here: preselect once the list has loaded
  useEffect(() => {
    if (openPlanId && plans) {
      const p = plans.find((x) => x.id === openPlanId);
      if (p) setSelected(p);
      onOpenConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPlanId, plans]);

  const patchPlan = async (id: string, patch: { title?: string; start_date?: string | null }) => {
    try {
      await api.updateMealPlan(id, patch);
      setVersion((v) => v + 1);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
    }
  };

  const deletePlan = async (p: MealPlanSummary) => {
    if (!confirm(`Delete the plan "${p.title}" and its grocery list? Recipes stay in your library.`)) {
      return;
    }
    try {
      await api.deleteMealPlan(p.id);
      setSelected(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  };

  if (error) return <div className="container empty">Something went wrong: {error}</div>;
  if (!plans) return <div className="container empty">Loading…</div>;

  if (selected) {
    return (
      <div className="container">
        <div className="detail-toolbar">
          <button className="back-btn" onClick={() => setSelected(null)}>← All plans</button>
          <button className="danger-btn" onClick={() => void deletePlan(selected)}>
            Delete plan
          </button>
        </div>

        <div className="plan-edit card">
          <label>
            <span className="field-label">Title</span>
            <input
              key={`t-${selected.id}`}
              defaultValue={selected.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== selected.title) void patchPlan(selected.id, { title: v });
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </label>
          <label>
            <span className="field-label">Start date</span>
            <input
              key={`d-${selected.id}`}
              type="date"
              defaultValue={selected.start_date ?? ""}
              onChange={(e) =>
                void patchPlan(selected.id, { start_date: e.target.value === "" ? null : e.target.value })
              }
            />
          </label>
        </div>

        <div className="cards">
          <MealPlanCard
            key={`p-${version}`}
            planId={selected.id}
            onOpenRecipe={setViewRecipe}
            editableDays
          />
          {selected.latest_grocery_list_id ? (
            <GroceryListCard listId={selected.latest_grocery_list_id} />
          ) : (
            <div className="card empty">
              No grocery list yet — ask the chat agent to build one for this plan.
            </div>
          )}
        </div>
        {viewRecipe && <RecipeOverlay recipeId={viewRecipe} onClose={() => setViewRecipe(null)} />}
      </div>
    );
  }

  return (
    <div className="container">
      {plans.length === 0 && (
        <div className="empty">
          No meal plans yet — ask the chat agent to plan your week and they’ll be saved here.
        </div>
      )}
      <div className="lib-grid">
        {plans.map((p) => (
          <div
            className="lib-card"
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => setSelected(p)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelected(p);
              }
            }}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>📅 {p.title}</h3>
            <div className="meta-row">
              {p.start_date && <span className="num">{p.start_date}</span>}
              <span>{p.recipe_count} recipe{p.recipe_count === 1 ? "" : "s"}</span>
              {p.latest_grocery_list_id && <span className="chip">🛒 grocery list</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
