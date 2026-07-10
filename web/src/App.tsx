import { useState } from "react";
import { Chat } from "./screens/Chat";
import { Library } from "./screens/Library";
import { Plans } from "./screens/Plans";
import { Settings } from "./screens/Settings";

type Tab = "chat" | "library" | "plans" | "settings";

const TAB_LABELS: Record<Tab, string> = {
  chat: "Chat",
  library: "Library",
  plans: "Plans",
  settings: "Settings",
};

export function App() {
  const [tab, setTab] = useState<Tab>("chat");
  // set when chat's "View in Plans" is clicked; Plans consumes it to preselect
  const [planToOpen, setPlanToOpen] = useState<string | null>(null);

  const viewPlan = (planId: string) => {
    setPlanToOpen(planId);
    setTab("plans");
  };

  // All screens stay mounted (hidden via CSS) so chat history and screen state
  // survive tab switches — required for "View in Plans" to be a round trip.
  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark">Recipe Library</span>
        <nav className="tabs">
          {(["chat", "library", "plans", "settings"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </header>
      <main className="screen">
        <div className="tab-panel" hidden={tab !== "chat"}>
          <Chat onViewPlan={viewPlan} />
        </div>
        <div className="tab-panel" hidden={tab !== "library"}>
          <Library active={tab === "library"} />
        </div>
        <div className="tab-panel" hidden={tab !== "plans"}>
          <Plans
            active={tab === "plans"}
            openPlanId={planToOpen}
            onOpenConsumed={() => setPlanToOpen(null)}
          />
        </div>
        <div className="tab-panel" hidden={tab !== "settings"}>
          <Settings active={tab === "settings"} />
        </div>
      </main>
    </div>
  );
}
