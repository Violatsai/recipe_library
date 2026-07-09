import { useEffect, useState } from "react";
import {
  api,
  type GroceryItem,
  type MealPlan,
  type RecipeDetail,
  type SearchResult,
} from "./api";

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

/** Compact result cards for search_recipes tool events. */
export function RecipeCards({ results }: { results: SearchResult[] }) {
  if (results.length === 0) return <div className="card empty">No matching recipes.</div>;
  return (
    <div className="card-grid">
      {results.map((r) => (
        <div className="card" key={r.id}>
          <h3>{r.title}</h3>
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

/** Meal plan card — fetches by id (rows exist by the time the reply renders). */
export function MealPlanCard({ planId }: { planId: string }) {
  const [plan, setPlan] = useState<MealPlan | null>(null);
  useEffect(() => {
    api.mealPlan(planId).then(setPlan).catch(() => setPlan(null));
  }, [planId]);
  if (!plan) return null;
  return (
    <div className="card">
      <h3>📅 {plan.title}</h3>
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
            <tr key={idx}>
              <td>{e.day ?? "—"}</td>
              <td>{e.meal_slot ?? "—"}</td>
              <td>{e.title}</td>
              <td className="num">{e.servings ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Checkable grocery list — persists checkbox state via PATCH. */
export function GroceryListCard({ listId }: { listId: string }) {
  const [items, setItems] = useState<GroceryItem[] | null>(null);
  useEffect(() => {
    api.groceryList(listId).then((l) => setItems(l.items)).catch(() => setItems(null));
  }, [listId]);
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
      <h3>🛒 Grocery list</h3>
      {[...sections.entries()].map(([cat, group]) => (
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
    </div>
  );
}
