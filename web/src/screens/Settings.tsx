import { useEffect, useState } from "react";
import { api, type Staple, type Tag } from "../api";

const CATEGORY_LABELS: Record<string, string> = {
  cuisine: "Cuisine",
  dish_type: "Dish type",
  dietary: "Dietary",
};

function TagRow({
  tag,
  siblings,
  onChanged,
}: {
  tag: Tag;
  siblings: Tag[];
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "merge">("idle");
  const [value, setValue] = useState(tag.value);
  const [error, setError] = useState<string | null>(null);

  // On success, reset local row state BEFORE reloading: the component instance
  // survives the reload (same key), so mode/error would otherwise stick.
  const act = (p: Promise<unknown>) =>
    p
      .then(() => {
        setMode("idle");
        setError(null);
        onChanged();
      })
      .catch((e) => setError(e instanceof Error ? e.message : "failed"));

  return (
    <tr>
      <td>
        {mode === "rename" ? (
          <input
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void act(api.renameTag(tag.id, value.trim()));
              if (e.key === "Escape") setMode("idle");
            }}
          />
        ) : (
          tag.value
        )}
        {error && <div className="error-note">{error}</div>}
      </td>
      <td className="count num">{tag.usage_count} recipe{tag.usage_count === 1 ? "" : "s"}</td>
      <td>
        <div className="tag-actions">
          {mode === "merge" ? (
            <select
              autoFocus
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) void act(api.mergeTag(tag.id, e.target.value));
              }}
            >
              <option value="" disabled>merge into…</option>
              {siblings
                .filter((s) => s.id !== tag.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>{s.value}</option>
                ))}
            </select>
          ) : (
            <>
              <button
                onClick={() => {
                  setValue(tag.value); // re-sync in case the tag changed since mount
                  setMode("rename");
                }}
              >
                Rename
              </button>
              <button onClick={() => setMode("merge")}>Merge</button>
              <button
                onClick={() => {
                  if (confirm(`Delete tag "${tag.value}"? It will be removed from ${tag.usage_count} recipe(s).`)) {
                    void act(api.deleteTag(tag.id));
                  }
                }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

export function Settings({ active }: { active: boolean }) {
  const [staples, setStaples] = useState<Staple[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [newStaple, setNewStaple] = useState("");

  const reload = () => {
    void api.pantry().then(setStaples);
    void api.tags().then(setTags);
  };
  // refresh whenever the tab becomes visible (screens stay mounted now)
  useEffect(() => {
    if (active) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const addStaple = async () => {
    const name = newStaple.trim();
    if (!name) return;
    await api.addStaple(name);
    setNewStaple("");
    reload();
  };

  const categories = ["cuisine", "dish_type", "dietary"] as const;

  return (
    <div className="container settings">
      <h2>Pantry staples</h2>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Assumed always on hand — the agent leaves these off grocery lists.
      </p>
      <div className="staple-row">
        {staples.map((s) => (
          <span className="staple" key={s.id}>
            {s.name}
            <button
              title={`Remove ${s.name}`}
              onClick={() => void api.removeStaple(s.id).then(reload)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="add-row">
        <input
          placeholder="Add a staple (e.g. rice)"
          value={newStaple}
          onChange={(e) => setNewStaple(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void addStaple()}
        />
        <button onClick={() => void addStaple()}>Add</button>
      </div>

      <h2>Tags</h2>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        The controlled vocabulary the agent classifies into. Rename or merge to clean up;
        new tags are added automatically when a recipe needs one.
      </p>
      <table className="tag-table">
        <tbody>
          {categories.map((cat) => {
            const group = tags.filter((t) => t.category === cat);
            return [
              <tr key={cat}>
                <td className="cat" colSpan={3}>{CATEGORY_LABELS[cat]}</td>
              </tr>,
              ...group.map((t) => (
                <TagRow key={t.id} tag={t} siblings={group} onChanged={reload} />
              )),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
