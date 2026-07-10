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
        {tab === "chat" && <Chat />}
        {tab === "library" && <Library />}
        {tab === "plans" && <Plans />}
        {tab === "settings" && <Settings />}
      </main>
    </div>
  );
}
