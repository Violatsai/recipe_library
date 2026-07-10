import { useEffect, useRef, useState } from "react";
import { api, type RecipeDetail, type SearchResult, type ToolEvent } from "../api";
import {
  GroceryListCard,
  MealPlanCard,
  RecipeCards,
  RecipeDetailView,
  RecipeOverlay,
} from "../components";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  events?: ToolEvent[];
}

/** Render the cards for one assistant turn's tool events. */
function EventCards({
  events,
  onOpenRecipe,
  onViewPlan,
}: {
  events: ToolEvent[];
  onOpenRecipe: (recipeId: string) => void;
  onViewPlan: (planId: string) => void;
}) {
  const cards: React.ReactNode[] = [];
  events.forEach((e, idx) => {
    if (e.tool === "search_recipes") {
      const out = e.output as { results?: SearchResult[] };
      cards.push(<RecipeCards key={idx} results={out.results ?? []} onOpen={onOpenRecipe} />);
    } else if (e.tool === "get_recipe") {
      const out = e.output as RecipeDetail | { error: string };
      if (!("error" in out)) cards.push(<RecipeDetailView key={idx} detail={out} />);
    } else if (e.tool === "create_meal_plan") {
      const out = e.output as { meal_plan_id: string };
      cards.push(
        <MealPlanCard
          key={idx}
          planId={out.meal_plan_id}
          onOpenRecipe={onOpenRecipe}
          onViewInPlans={() => onViewPlan(out.meal_plan_id)}
        />,
      );
    } else if (e.tool === "save_grocery_list") {
      const out = e.output as { grocery_list_id: string };
      cards.push(<GroceryListCard key={idx} listId={out.grocery_list_id} />);
    }
    // add_recipe_to_plan / generate_grocery_list are intermediate steps —
    // covered by the plan and grocery cards above.
  });
  if (cards.length === 0) return null;
  return <div className="cards">{cards}</div>;
}

export function Chat({ onViewPlan }: { onViewPlan: (planId: string) => void }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewRecipe, setViewRecipe] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const send = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    setError(null);
    const history = [...turns, { role: "user" as const, content }];
    setTurns(history);
    setBusy(true);
    try {
      const resp = await api.chat(history.map(({ role, content }) => ({ role, content })));
      setTurns([...history, { role: "assistant", content: resp.reply, events: resp.toolEvents }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
      setTurns(history); // keep the user's message; they can retry
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-screen">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-log">
          {turns.length === 0 && (
            <div className="empty">
              Ask your library anything — “What can I make with eggplant and miso?” or
              “Plan three dinners for next week and build me a grocery list.”
            </div>
          )}
          {turns.map((t, idx) =>
            t.role === "user" ? (
              <div className="bubble user" key={idx}>{t.content}</div>
            ) : (
              <div className="bubble assistant" key={idx}>
                {t.events && (
                  <EventCards events={t.events} onOpenRecipe={setViewRecipe} onViewPlan={onViewPlan} />
                )}
                <div className="reply">{t.content}</div>
              </div>
            ),
          )}
          {busy && <div className="bubble assistant thinking">Cooking up an answer…</div>}
          {error && <div className="bubble assistant error-note">Error: {error} — try again.</div>}
        </div>
      </div>
      {viewRecipe && <RecipeOverlay recipeId={viewRecipe} onClose={() => setViewRecipe(null)} />}
      <div className="composer">
        <div className="composer-inner">
          <textarea
            value={draft}
            placeholder="What do you feel like cooking?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button onClick={() => void send()} disabled={busy || draft.trim().length === 0}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
