import { useEffect, useState } from "react";
import { api, type RecipeDetail, type RecipeSummary } from "../api";
import { EstBadge, RecipeDetailView } from "../components";

export function Library() {
  const [recipes, setRecipes] = useState<RecipeSummary[] | null>(null);
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.recipes().then(setRecipes).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  if (error) return <div className="container empty">Couldn’t load the library: {error}</div>;
  if (!recipes) return <div className="container empty">Loading…</div>;

  if (detail) {
    return (
      <div className="container">
        <button className="back-btn" onClick={() => setDetail(null)}>← Back to library</button>
        <RecipeDetailView detail={detail} />
      </div>
    );
  }

  return (
    <div className="container">
      {recipes.length === 0 && (
        <div className="empty">No recipes yet — save one with the browser extension.</div>
      )}
      <div className="lib-grid">
        {recipes.map((r) => (
          <button
            className="lib-card"
            key={r.id}
            onClick={() => api.recipe(r.id).then(setDetail).catch((e) => setError(e.message))}
          >
            <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{r.title}</h3>
            <div className="meta-row">
              {r.tags.map((t) => (
                <span
                  className={`chip${t.category === "cuisine" ? "" : " dietary"}`}
                  key={t.category + t.value}
                >
                  {t.value}
                </span>
              ))}
            </div>
            <div className="meta-row" style={{ marginTop: 8 }}>
              {r.total_time_min != null && <span className="num">{r.total_time_min} min</span>}
              {r.kcal != null && (
                <>
                  <span className="num">≈{r.kcal} kcal</span>
                  <EstBadge />
                </>
              )}
              {r.extraction_partial && <span className="badge-partial">partial</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
