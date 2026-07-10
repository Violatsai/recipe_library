import { useEffect, useState } from "react";
import {
  api,
  type GroceryItem,
  type MealPlan,
  type PlanRecipeIngredients,
  type RecipeDetail,
  type SearchResult,
} from "./api";

/** Modal overlay showing a full recipe — click a card/plan row anywhere to open. */
export function RecipeOverlay({ recipeId, onClose }: { recipeId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setDetail(null);
    setFailed(false);
    api.recipe(recipeId).then(setDetail).catch(() => setFailed(true));
  }, [recipeId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
        <button className="overlay-close" onClick={onClose} aria-label="Close">×</button>
        {failed && <div className="empty">Couldn’t load this recipe (it may have been deleted).</div>}
        {!failed && !detail && <div className="empty">Loading…</div>}
        {detail && <RecipeDetailView detail={detail} />}
      </div>
    </div>
  );
}

export function EstBadge() {
  return <span className="badge-est" title="Macros are rough LLM estimates">≈ estimated</span>;
}

export function Macros({ m }: { m: { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null } }) {
  return (
    <span className="num">
      ≈{m.kcal ?? "?"} kcal · {m.protein_g ?? "?"}p / {m.carbs_g ?? "?"}c / {m.fat_g ?? "?"}f
    </span>
  );
}

/** Compact result cards for search_recipes tool events. Clickable when onOpen given. */
export function RecipeCards({
  results,
  onOpen,
}: {
  results: SearchResult[];
  onOpen?: (recipeId: string) => void;
}) {
  if (results.length === 0) return <div className="card empty">No matching recipes.</div>;
  return (
    <div className="card-grid">
      {results.map((r) => (
        <div
          className={`card${onOpen ? " clickable" : ""}`}
          key={r.id}
          {...(onOpen && {
            role: "button" as const,
            tabIndex: 0,
            onClick: () => onOpen(r.id),
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen(r.id);
              }
            },
          })}
        >
          <h3>{onOpen ? <span className="title-link">{r.title}</span> : r.title}</h3>
          <div className="meta-row">
            {r.cuisine.map((c) => (
              <span className="chip" key={c}>{c}</span>
            ))}
            {r.dish_type.map((d) => (
              <span className="chip dietary" key={d}>{d}</span>
            ))}
          </div>
          <div className="meta-row" style={{ marginTop: 6 }}>
            {r.total_time_min != null && <span className="num">{r.total_time_min} min</span>}
            {r.macros && <Macros m={r.macros} />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Full recipe view — used by get_recipe events and the library detail. */
export function RecipeDetailView({ detail }: { detail: RecipeDetail }) {
  return (
    <div className="card detail">
      <h2>{detail.title}</h2>
      <div className="meta-row">
        {detail.tags.map((t) => (
          <span className={`chip${t.category === "cuisine" ? "" : " dietary"}`} key={t.category + t.value}>
            {t.value}
          </span>
        ))}
        {detail.servings != null && <span>{detail.servings} servings</span>}
        {detail.total_time_min != null && <span className="num">{detail.total_time_min} min</span>}
        {detail.extraction_partial && (
          <span className="badge-partial" title="The source was thin — details may be incomplete">partial</span>
        )}
      </div>
      <div className="meta-row" style={{ marginTop: 6 }}>
        {detail.macros_per_serving && (
          <>
            <Macros m={detail.macros_per_serving} />
            <EstBadge />
          </>
        )}
      </div>
      <div className="detail-cols">
        <div>
          <h4>Ingredients</h4>
          <ul>
            {detail.ingredients.map((i, idx) => (
              <li key={idx}>{i.raw_text}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Steps</h4>
          <ol>
            {(detail.steps ?? []).map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ol>
        </div>
      </div>
      <p style={{ marginBottom: 0 }}>
        <a className="src-link" href={detail.source_url} target="_blank" rel="noreferrer">
          View original source ↗
        </a>
        {detail.source_detail && (
          <>
            {" · "}
            <a className="src-link" href={detail.source_detail} target="_blank" rel="noreferrer">
              recipe page ↗
            </a>
          </>
        )}
      </p>
    </div>
  );
}

/** Meal plan card — fetches by id (rows exist by the time the reply renders).
 *  Recipe titles become links when onOpenRecipe is provided; day cells become
 *  date inputs when editableDays is set (Plans tab). */
export function MealPlanCard({
  planId,
  onOpenRecipe,
  editableDays = false,
  onViewInPlans,
}: {
  planId: string;
  onOpenRecipe?: (recipeId: string) => void;
  editableDays?: boolean;
  /** chat only: renders the "Saved ✓ / View in Plans →" footer */
  onViewInPlans?: () => void;
}) {
  const [plan, setPlan] = useState<MealPlan | null>(null);
  const load = () => api.mealPlan(planId).then(setPlan).catch(() => setPlan(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  const setDay = (entryId: string, day: string | null) => {
    void api.updatePlanEntry(entryId, day).then(load).catch(load);
  };

  if (!plan) return null;
  return (
    <div className="card">
      <h3>
        📅 {plan.title}
        {plan.start_date && <span className="plan-date num"> · {plan.start_date}</span>}
      </h3>
      <table className="plan">
        <thead>
          <tr>
            <th>Day</th>
            <th>Slot</th>
            <th>Recipe</th>
            <th>Servings</th>
          </tr>
        </thead>
        <tbody>
          {plan.entries.map((e, idx) => (
            <tr key={e.entry_id ?? idx}>
              <td>
                {editableDays ? (
                  <input
                    className="day-input"
                    type="date"
                    value={e.day ?? ""}
                    onChange={(ev) => setDay(e.entry_id, ev.target.value === "" ? null : ev.target.value)}
                  />
                ) : (
                  e.day ?? "—"
                )}
              </td>
              <td>{e.meal_slot ?? "—"}</td>
              <td>
                {onOpenRecipe ? (
                  <button className="link-btn" onClick={() => onOpenRecipe(e.recipe_id)}>
                    {e.title}
                  </button>
                ) : (
                  e.title
                )}
              </td>
              <td className="num">{e.servings ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onViewInPlans && (
        <div className="card-foot">
          <span className="saved-note">✓ Saved — this plan is kept even after the chat is gone</span>
          <button className="mini-btn" onClick={onViewInPlans}>View in Plans →</button>
        </div>
      )}
    </div>
  );
}

/** Checkable grocery list with two views:
 *  - "By section": the persisted, consolidated list (checkboxes — the shopping view)
 *  - "By recipe": derived per-recipe lines, read-only (the cooking-prep view) */
export function GroceryListCard({ listId }: { listId: string }) {
  const [items, setItems] = useState<GroceryItem[] | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [mode, setMode] = useState<"section" | "recipe">("section");
  const [perRecipe, setPerRecipe] = useState<PlanRecipeIngredients[] | null>(null);

  useEffect(() => {
    api
      .groceryList(listId)
      .then((l) => {
        setItems(l.items);
        setPlanId(l.meal_plan_id);
      })
      .catch(() => setItems(null));
  }, [listId]);

  useEffect(() => {
    if (mode === "recipe" && planId && perRecipe === null) {
      api.planIngredients(planId).then(setPerRecipe).catch(() => setPerRecipe([]));
    }
  }, [mode, planId, perRecipe]);

  if (!items) return null;

  const toggle = (item: GroceryItem) => {
    const next = !item.checked;
    setItems((cur) => cur?.map((i) => (i.id === item.id ? { ...i, checked: next } : i)) ?? null);
    api.toggleItem(item.id, next).catch(() => {
      // revert on failure
      setItems((cur) => cur?.map((i) => (i.id === item.id ? { ...i, checked: !next } : i)) ?? null);
    });
  };

  // group by store section (agent-assigned); legacy rows without one → "other"
  const sections = new Map<string, GroceryItem[]>();
  for (const i of items) {
    const cat = i.category ?? "other";
    sections.set(cat, [...(sections.get(cat) ?? []), i]);
  }

  return (
    <div className="card">
      <div className="grocery-head">
        <h3>🛒 Grocery list</h3>
        <div className="seg" role="tablist" aria-label="Grocery view">
          <button
            role="tab"
            aria-selected={mode === "section"}
            className={mode === "section" ? "on" : ""}
            onClick={() => setMode("section")}
          >
            By section
          </button>
          <button
            role="tab"
            aria-selected={mode === "recipe"}
            className={mode === "recipe" ? "on" : ""}
            onClick={() => setMode("recipe")}
          >
            By recipe
          </button>
        </div>
      </div>

      {mode === "section" &&
        [...sections.entries()].map(([cat, group]) => (
          <div key={cat}>
            <div className="grocery-section">{cat}</div>
            <ul className="grocery">
              {group.map((i) => (
                <li key={i.id}>
                  <input
                    type="checkbox"
                    checked={i.checked}
                    onChange={() => toggle(i)}
                    id={`gi-${i.id}`}
                  />
                  <label htmlFor={`gi-${i.id}`} className={i.checked ? "done" : ""}>
                    {i.name}
                  </label>
                  <span className="qty">
                    {i.quantity != null ? i.quantity : ""} {i.unit ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}

      {mode === "recipe" && perRecipe === null && <div className="empty">Loading…</div>}
      {mode === "recipe" &&
        perRecipe?.map((r) => (
          <div key={r.recipe_id + (r.servings ?? "")}>
            <div className="grocery-section">
              {r.title}
              {r.servings != null && <span className="plan-date"> · {r.servings} servings</span>}
            </div>
            <ul className="grocery">
              {r.items.map((i, idx) => (
                <li key={idx}>
                  <span className="dot">•</span>
                  <span>{i.name}</span>
                  <span className="qty">
                    {i.quantity != null ? i.quantity : ""} {i.unit ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {mode === "recipe" && (
        <p className="grocery-note">
          Raw per-recipe amounts (incl. pantry staples), scaled to planned servings — check items
          off in the “By section” view.
        </p>
      )}
    </div>
  );
}
