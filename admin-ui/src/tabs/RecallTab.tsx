import { useEffect, useState } from "react";
import {
  api,
  type Peer,
  type ReasoningLevel,
  type Session,
  type ToolCall,
  type TraceResponse,
} from "../api";
import { ObservationList } from "../components/ObservationList";

const LEVELS: ReasoningLevel[] = ["minimal", "low", "medium", "high", "max"];

interface Props {
  workspace: string;
}

// Stable React node from anything (string, number, object). Strings render
// as-is; everything else gets JSON.stringify'd. Lets us show tool results
// regardless of whether they're plain text (most search tools) or nested
// objects.
function renderUnknown(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

export function RecallTab({ workspace }: Props) {
  const [peers, setPeers] = useState<Peer[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [observer, setObserver] = useState("");
  const [target, setTarget] = useState("");
  const [session, setSession] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<ReasoningLevel>("minimal");

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TraceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reset when the workspace changes — old peer/session names are
    // meaningless for the new workspace.
    setPeers([]);
    setSessions([]);
    setObserver("");
    setTarget("");
    setSession("");
    setResult(null);
    setError(null);

    api
      .listPeers(workspace)
      .then((r) => setPeers(r.items))
      .catch((e) => setError(String(e)));
    api
      .listSessions(workspace)
      .then((r) => setSessions(r.items))
      .catch((e) => setError(String(e)));
  }, [workspace]);

  async function run() {
    if (!observer || !target || !query.trim()) {
      setError("observer, target, and query are required");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.dialecticTrace(workspace, {
        observer,
        target,
        query,
        session: session || null,
        reasoning_level: level,
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="recall">
      <div className="form">
        <div className="form-row">
          <label>
            observer
            <select value={observer} onChange={(e) => setObserver(e.target.value)}>
              <option value="">— pick —</option>
              {peers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            target
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">— pick —</option>
              {peers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            session (optional)
            <select value={session} onChange={(e) => setSession(e.target.value)}>
              <option value="">all sessions (global)</option>
              {sessions.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            reasoning
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value as ReasoningLevel)}
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          placeholder="query — what do you want to ask about the target peer?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={2}
        />
        <button type="button" onClick={run} disabled={loading}>
          {loading ? "running…" : "run trace"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {result && (
        <div className="trace">
          <header className="trace-answer">
            <h2>Answer</h2>
            <pre>{result.answer}</pre>
            <div className="trace-stats">
              {result.iterations} iter · {result.tool_calls.length} tool call
              {result.tool_calls.length === 1 ? "" : "s"} ·{" "}
              {Math.round(result.elapsed_ms)} ms · input {result.tokens.input} /
              output {result.tokens.output} / cache_read{" "}
              {result.tokens.cache_read} tokens · level {result.reasoning_level}
            </div>
          </header>

          <h3 className="trace-section-title">
            Prefetched observations{" "}
            <span className="muted">
              — {result.prefetch.explicit.length} explicit ·{" "}
              {result.prefetch.deductive.length} deductive ·{" "}
              {result.prefetch.inductive.length} inductive ·{" "}
              {result.prefetch.contradiction.length} contradiction
            </span>
          </h3>
          <ObservationList data={result.prefetch} />

          <h3 className="trace-section-title">
            Tool calls <span className="muted">— in execution order</span>
          </h3>
          <div className="tool-calls">
            {result.tool_calls.length === 0 && (
              <p className="muted">No tool calls were made.</p>
            )}
            {result.tool_calls.map((tc, i) => (
              <ToolCallCard key={i} idx={i} call={tc} />
            ))}
          </div>

          {result.thinking && (
            <>
              <h3 className="trace-section-title">Thinking</h3>
              <pre className="thinking">{result.thinking}</pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ToolCallCard({ idx, call }: { idx: number; call: ToolCall }) {
  return (
    <details className="tool-call">
      <summary>
        <span className="tool-idx">#{idx + 1}</span>
        <code>{call.tool_name}</code>
        <span className="muted">
          {Object.entries(call.tool_input)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(" · ")}
        </span>
      </summary>
      <pre className="tool-result">{renderUnknown(call.tool_result)}</pre>
    </details>
  );
}
