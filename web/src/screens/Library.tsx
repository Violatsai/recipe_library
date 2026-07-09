import { useEffect, useMemo, useState } from "react";
import { api, type RecipeDetail, type RecipeSummary } from "../api";
import { EstBadge, RecipeDetailView } from "../components";

export function Library() {
  const [recipes, setRecipes] = useState<RecipeSummary[] | null>(null);
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set()); // "category:value"

  const load = () => {
    api.recipes().then(setRecipes).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  // Only offer tags that are actually in use, grouped for the filter row.
  const usedTags = useMemo(() => {
    const seen = new Map<string, { category: string; value: string; count: number }>();
    for (const r of recipes ?? []) {
      for (const t of r.tags) {
        const key = `${t.category}:${t.value}`;
        const cur = seen.get(key);
        if (cur) cur.count++;
        else seen.set(key, { ...t, count: 1 });
      }
    }
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [recipes]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (recipes ?? []).filter((r) => {
      if (needle) {
        const inTitle = r.title.toLowerCase().includes(needle);
        const inIngredients = r.ingredient_names.some((n) => n.toLowerCase().includes(needle));
        if (!inTitle && !inIngredients) return false;
      }
      for (const key of activeTags) {
        // recipe must carry every selected tag
        if (!r.tags.some((t) => `${t.category}:${t.value}` === key)) return false;
      }
      return true;
    });
  }, [recipes, q, activeTags]);

  const toggleTag = (key: string) => {
    setActiveTags((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const deleteRecipe = async (r: { id: string; title: string }) => {
    if (!confirm(`Delete "${r.title}" from your library? This also removes it from any meal plans.`)) {
      return;
    }
    try {
      await api.deleteRecipe(r.id);
      setDetail(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete failed");
    }
  };

  if (error) return <div className="container empty">Something went wrong: {error}</div>;
  if (!recipes) return <div className="container empty">Loading…</div>;

  if (detail) {
    return (
      <div className="container">
        <div className="detail-toolbar">
          <button className="back-btn" onClick={() => setDetail(null)}>← Back to library</button>
          <button className="danger-btn" onClick={() => void deleteRecipe(detail)}>
            Delete recipe
          </button>
        </div>
        <RecipeDetailView detail={detail} />
      </div>
    );
  }

  return (
    <div className="container">
      <div className="lib-toolbar">
        <input
          className="lib-search"
          type="search"
          placeholder="Search title or ingredient…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="filter-row">
          {usedTags.map(([key, t]) => (
            <button
              key={key}
              className={`filter-chip${activeTags.has(key) ? " on" : ""}`}
              onClick={() => toggleTag(key)}
              title={`${t.category} — ${t.count} recipe${t.count === 1 ? "" : "s"}`}
            >
              {t.value}
            </button>
          ))}
          {(activeTags.size > 0 || q) && (
            <button
              className="filter-chip clear"
              onClick={() => {
                setActiveTags(new Set());
                setQ("");
              }}
            >
              clear ×
            </button>
          )}
        </div>
      </div>

      {recipes.length === 0 && (
        <div className="empty">No recipes yet — save one with the browser extension.</div>
      )}
      {recipes.length > 0 && filtered.length === 0 && (
        <div className="empty">Nothing matches those filters.</div>
      )}
      <div className="lib-grid">
        {filtered.map((r) => {
          const open = () => api.recipe(r.id).then(setDetail).catch((e) => setError(e.message));
          return (
          // div, not button: the delete control inside must be a real <button>,
          // and buttons can't nest. Keyboard access preserved via role + Enter/Space.
          <div
            className="lib-card"
            key={r.id}
            role="button"
            tabIndex={0}
            onClick={open}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                void open();
              }
            }}
          >
            <button
              className="card-delete"
              title={`Delete "${r.title}"`}
              aria-label={`Delete ${r.title}`}
              onClick={(e) => {
                e.stopPropagation(); // don't open the detail view
                void deleteRecipe(r);
              }}
            >
              ×
            </button>
            <h3 style={{ margin: "0 0 6px", fontSize: 15, paddingRight: 22 }}>{r.title}</h3>
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
          </div>
          );
        })}
      </div>
    </div>
  );
}
