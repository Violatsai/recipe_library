import { useState } from "react";
import { Chat } from "./screens/Chat";
import { Library } from "./screens/Library";
import { Settings } from "./screens/Settings";

type Tab = "chat" | "library" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("chat");
  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark">Recipe Library</span>
        <nav className="tabs">
          {(["chat", "library", "settings"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "chat" ? "Chat" : t === "library" ? "Library" : "Settings"}
            </button>
          ))}
        </nav>
      </header>
      <main className="screen">
        {tab === "chat" && <Chat />}
        {tab === "library" && <Library />}
        {tab === "settings" && <Settings />}
      </main>
    </div>
  );
}
