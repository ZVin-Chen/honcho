// Thin fetch wrapper. All admin endpoints live on the same origin as the
// SPA (FastAPI serves both), so there is no base URL — relative paths just
// work. Errors throw with the response body so the UI can surface them.

async function request<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export interface Workspace {
  name: string;
  created_at: string;
  peer_count: number;
  session_count: number;
}

export interface Peer {
  name: string;
  created_at: string;
  message_count: number;
}

export interface Session {
  name: string;
  created_at: string;
  is_active: boolean;
  peer_names: string[];
}

export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";

export interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result: unknown;
}

export interface ObservationBase {
  id: string;
  created_at: string;
  session_name: string | null;
  message_ids: number[];
}

export interface ExplicitObs extends ObservationBase {
  content: string;
}
export interface DeductiveObs extends ObservationBase {
  conclusion: string;
  premises: string[];
  source_ids: string[];
}
export interface InductiveObs extends ObservationBase {
  conclusion: string;
  sources: string[];
  pattern_type: string;
  confidence: string;
  source_ids: string[];
}
export interface ContradictionObs extends ObservationBase {
  content: string;
  sources: string[];
  source_ids: string[];
}

export interface TraceResponse {
  answer: string;
  elapsed_ms: number;
  run_id: string;
  reasoning_level: string;
  iterations: number;
  prefetch: {
    explicit: ExplicitObs[];
    deductive: DeductiveObs[];
    inductive: InductiveObs[];
    contradiction: ContradictionObs[];
  };
  tool_calls: ToolCall[];
  thinking: string | null;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
}

export interface TraceRequest {
  observer: string;
  target: string;
  query: string;
  session?: string | null;
  reasoning_level: ReasoningLevel;
}

export interface PeerCard {
  observer: string;
  observed: string;
  bullets: string[];
}

export interface QueueSummary {
  workspace: string;
  by_task_type: Record<
    string,
    { pending: number; processed: number; errored: number }
  >;
  active_work_units: string[];
}

export interface QueueItem {
  id: number;
  task_type: string;
  work_unit_key: string;
  parsed: {
    task_type: string;
    workspace_name?: string | null;
    session_name?: string | null;
    observer?: string | null;
    observed?: string | null;
    dream_type?: string | null;
  } | null;
  session_id: string | null;
  message_id: number | null;
  processed: boolean;
  error: string | null;
  created_at: string;
  payload_summary: Record<string, unknown>;
}

export interface QueueItemsResponse {
  workspace: string;
  total: number;
  items: QueueItem[];
}

export type QueueItemState = "pending" | "processed" | "errored";

export interface ObservationsResponse {
  observer: string;
  observed: string;
  session: string | null;
  query: string | null;
  observations: {
    explicit: ExplicitObs[];
    deductive: DeductiveObs[];
    inductive: InductiveObs[];
    contradiction: ContradictionObs[];
  };
}

export const api = {
  listWorkspaces: () => request<{ items: Workspace[] }>("/admin/workspaces"),
  listPeers: (workspace: string, search?: string) => {
    const q = new URLSearchParams();
    if (search) q.set("search", search);
    return request<{ total: number; items: Peer[] }>(
      `/admin/workspaces/${encodeURIComponent(workspace)}/peers?${q}`,
    );
  },
  listSessions: (workspace: string, peer?: string) => {
    const q = new URLSearchParams();
    if (peer) q.set("peer", peer);
    return request<{ total: number; items: Session[] }>(
      `/admin/workspaces/${encodeURIComponent(workspace)}/sessions?${q}`,
    );
  },
  getPeerCard: (workspace: string, observer: string, target?: string) => {
    const q = new URLSearchParams();
    if (target) q.set("target", target);
    return request<PeerCard>(
      `/admin/workspaces/${encodeURIComponent(workspace)}/peers/${encodeURIComponent(observer)}/card?${q}`,
    );
  },
  listObservations: (
    workspace: string,
    observer: string,
    opts: {
      target?: string;
      session?: string;
      query?: string;
      limit?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.target) q.set("target", opts.target);
    if (opts.session) q.set("session", opts.session);
    if (opts.query) q.set("query", opts.query);
    if (opts.limit) q.set("limit", String(opts.limit));
    return request<ObservationsResponse>(
      `/admin/workspaces/${encodeURIComponent(workspace)}/peers/${encodeURIComponent(observer)}/observations?${q}`,
    );
  },
  queueSummary: (workspace: string) =>
    request<QueueSummary>(
      `/admin/workspaces/${encodeURIComponent(workspace)}/queue/summary`,
    ),
  queueItems: (
    workspace: string,
    opts: {
      task_type?: string;
      state?: QueueItemState;
      work_unit_key?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.task_type) q.set("task_type", opts.task_type);
    if (opts.state) q.set("state", opts.state);
    if (opts.work_unit_key) q.set("work_unit_key", opts.work_unit_key);
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.offset) q.set("offset", String(opts.offset));
    return request<QueueItemsResponse>(
      `/admin/workspaces/${encodeURIComponent(workspace)}/queue/items?${q}`,
    );
  },
  dialecticTrace: async (workspace: string, body: TraceRequest) => {
    const res = await fetch(
      `/admin/workspaces/${encodeURIComponent(workspace)}/dialectic/trace`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as TraceResponse;
  },
};
