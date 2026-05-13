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
};
