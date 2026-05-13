import { useEffect, useState } from "react";
import { api, type Workspace } from "./api";
import { MemoryTab } from "./tabs/MemoryTab";
import { QueueTab } from "./tabs/QueueTab";
import { RecallTab } from "./tabs/RecallTab";

type TabId = "memory" | "queue" | "recall";

const TABS: { id: TabId; label: string }[] = [
  { id: "memory", label: "Memory" },
  { id: "queue", label: "Queue" },
  { id: "recall", label: "Recall" },
];

export function App() {
  const [tab, setTab] = useState<TabId>("memory");
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspace, setWorkspace] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listWorkspaces()
      .then((r) => {
        setWorkspaces(r.items);
        if (r.items.length > 0 && !workspace) setWorkspace(r.items[0].name);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <h1>honcho · observability</h1>
        <div className="ws-picker">
          <label htmlFor="ws">workspace</label>
          <select
            id="ws"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            disabled={!workspaces?.length}
          >
            {workspaces?.map((w) => (
              <option key={w.name} value={w.name}>
                {w.name} ({w.peer_count}p / {w.session_count}s)
              </option>
            ))}
          </select>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab tab--active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {error && <div className="error">failed to load workspaces — {error}</div>}
        {!workspace && !error && <div className="empty">no workspaces.</div>}
        {workspace && tab === "memory" && <MemoryTab workspace={workspace} />}
        {workspace && tab === "queue" && <QueueTab workspace={workspace} />}
        {workspace && tab === "recall" && <RecallTab workspace={workspace} />}
      </main>
    </div>
  );
}
