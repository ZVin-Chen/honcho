import { useEffect, useState } from "react";
import {
  api,
  type QueueItem,
  type QueueItemState,
  type QueueSummary,
} from "../api";
import { formatLocalTime } from "../utils/format";

interface Props {
  workspace: string;
}

const STATE_OPTIONS: { value: "" | QueueItemState; label: string }[] = [
  { value: "", label: "all" },
  { value: "pending", label: "pending" },
  { value: "processed", label: "processed" },
  { value: "errored", label: "errored" },
];

export function QueueTab({ workspace }: Props) {
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [total, setTotal] = useState(0);

  const [taskTypeFilter, setTaskTypeFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<"" | QueueItemState>("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [s, i] = await Promise.all([
        api.queueSummary(workspace),
        api.queueItems(workspace, {
          task_type: taskTypeFilter || undefined,
          state: stateFilter || undefined,
          limit: 100,
        }),
      ]);
      setSummary(s);
      setItems(i.items);
      setTotal(i.total);
      setLastRefresh(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // First load on mount / workspace change. Manual refresh after.
  useEffect(() => {
    setSummary(null);
    setItems(null);
    setTotal(0);
    setLastRefresh(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  // Filter changes trigger a refresh too — filters live server-side.
  useEffect(() => {
    if (summary !== null) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskTypeFilter, stateFilter]);

  return (
    <section className="queue">
      <div className="queue-toolbar">
        <button type="button" onClick={refresh} disabled={loading}>
          {loading ? "refreshing…" : "Refresh"}
        </button>
        {lastRefresh && (
          <span className="muted">
            last refresh: {lastRefresh.toLocaleTimeString()}
          </span>
        )}
        <label>
          task_type
          <select
            value={taskTypeFilter}
            onChange={(e) => setTaskTypeFilter(e.target.value)}
          >
            <option value="">all</option>
            {summary &&
              Object.keys(summary.by_task_type).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
          </select>
        </label>
        <label>
          state
          <select
            value={stateFilter}
            onChange={(e) =>
              setStateFilter(e.target.value as "" | QueueItemState)
            }
          >
            {STATE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <div className="error">{error}</div>}

      {summary && (
        <div className="summary-grid">
          {Object.entries(summary.by_task_type)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([taskType, counts]) => (
              <div className="summary-card" key={taskType}>
                <h4>{taskType}</h4>
                <div className="summary-counts">
                  <CountChip
                    label="pending"
                    n={counts.pending}
                    muted={counts.pending === 0}
                  />
                  <CountChip
                    label="processed"
                    n={counts.processed}
                    muted={counts.processed === 0}
                  />
                  <CountChip
                    label="errored"
                    n={counts.errored}
                    danger={counts.errored > 0}
                  />
                </div>
              </div>
            ))}
        </div>
      )}

      {summary?.active_work_units.length ? (
        <div className="active-units">
          <h4>Active right now</h4>
          <ul>
            {summary.active_work_units.map((k) => (
              <li key={k}>
                <code>{k}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {items && (
        <>
          <h3 className="trace-section-title">
            Items{" "}
            <span className="muted">
              — showing {items.length} of {total}
              {(taskTypeFilter || stateFilter) && " (filtered)"}
            </span>
          </h3>
          {items.length === 0 ? (
            <p className="muted">No items match.</p>
          ) : (
            <table className="queue-table">
              <thead>
                <tr>
                  <th>id</th>
                  <th>task_type</th>
                  <th>state</th>
                  <th>work_unit_key</th>
                  <th>session</th>
                  <th>msg</th>
                  <th>created_at</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <QueueRow key={i.id} item={i} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function CountChip({
  label,
  n,
  muted,
  danger,
}: {
  label: string;
  n: number;
  muted?: boolean;
  danger?: boolean;
}) {
  const cls = [
    "chip",
    muted ? "chip--muted" : "",
    danger ? "chip--danger" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls}>
      <span className="chip-label">{label}</span>
      <span className="chip-n">{n}</span>
    </span>
  );
}

function QueueRow({ item }: { item: QueueItem }) {
  // Errored items are loud — operators want to see the error inline
  // without having to expand a detail panel.
  const stateLabel = item.error
    ? "errored"
    : item.processed
    ? "processed"
    : "pending";
  const stateClass = "state-" + stateLabel;

  return (
    <>
      <tr className={item.error ? "row-error" : ""}>
        <td>{item.id}</td>
        <td>{item.task_type}</td>
        <td>
          <span className={`state-pill ${stateClass}`}>{stateLabel}</span>
        </td>
        <td>
          <code className="wuk">{item.work_unit_key}</code>
        </td>
        <td>{item.parsed?.session_name ?? item.session_id ?? "—"}</td>
        <td>{item.message_id ?? "—"}</td>
        <td className="ts">{formatLocalTime(item.created_at)}</td>
      </tr>
      {item.error && (
        <tr className="row-error-detail">
          <td colSpan={7}>
            <pre>{item.error}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
