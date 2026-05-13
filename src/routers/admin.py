"""Admin / observability router.

Exposes read-only inspection endpoints under /admin so operators can see
what honcho has stored and what its background workers are doing without
needing to query Postgres directly. No auth — gated by
settings.ADMIN.UI_ENABLED at the app-wiring layer.

PR 1 surface (this file): list endpoints for workspaces / peers /
sessions, used by the SPA shell to populate dropdowns. Later PRs add:
  - observations + cards (memory tab)
  - queue summary + items (queue tab)
  - dialectic trace (recall tab)
"""

from __future__ import annotations

from fastapi import APIRouter, Path, Query
from sqlalchemy import func, select

from src import models
from src.dependencies import db
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/workspaces")
async def list_workspaces(db: AsyncSession = db):
    """List all workspaces with peer / session counts."""
    peer_counts = (
        select(
            models.Peer.workspace_name.label("ws"),
            func.count().label("n"),
        )
        .group_by(models.Peer.workspace_name)
        .subquery()
    )
    session_counts = (
        select(
            models.Session.workspace_name.label("ws"),
            func.count().label("n"),
        )
        .group_by(models.Session.workspace_name)
        .subquery()
    )
    stmt = (
        select(
            models.Workspace.name,
            models.Workspace.created_at,
            func.coalesce(peer_counts.c.n, 0).label("peer_count"),
            func.coalesce(session_counts.c.n, 0).label("session_count"),
        )
        .outerjoin(peer_counts, peer_counts.c.ws == models.Workspace.name)
        .outerjoin(session_counts, session_counts.c.ws == models.Workspace.name)
        .order_by(models.Workspace.created_at.desc())
    )
    rows = (await db.execute(stmt)).all()
    return {
        "items": [
            {
                "name": r.name,
                "created_at": r.created_at.isoformat(),
                "peer_count": r.peer_count,
                "session_count": r.session_count,
            }
            for r in rows
        ]
    }


@router.get("/workspaces/{workspace_name}/peers")
async def list_peers(
    workspace_name: str = Path(...),
    search: str | None = Query(None, description="case-insensitive substring match on peer name"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = db,
):
    """List peers in a workspace, with optional name substring filter."""
    message_counts = (
        select(
            models.Message.peer_name.label("peer_name"),
            models.Message.workspace_name.label("ws"),
            func.count().label("n"),
        )
        .group_by(models.Message.peer_name, models.Message.workspace_name)
        .subquery()
    )

    base = select(models.Peer).where(models.Peer.workspace_name == workspace_name)
    if search:
        base = base.where(models.Peer.name.ilike(f"%{search}%"))

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

    stmt = (
        select(
            models.Peer.name,
            models.Peer.created_at,
            func.coalesce(message_counts.c.n, 0).label("message_count"),
        )
        .outerjoin(
            message_counts,
            (message_counts.c.peer_name == models.Peer.name)
            & (message_counts.c.ws == models.Peer.workspace_name),
        )
        .where(models.Peer.workspace_name == workspace_name)
        .order_by(models.Peer.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    if search:
        stmt = stmt.where(models.Peer.name.ilike(f"%{search}%"))

    rows = (await db.execute(stmt)).all()
    return {
        "total": total,
        "items": [
            {
                "name": r.name,
                "created_at": r.created_at.isoformat(),
                "message_count": r.message_count,
            }
            for r in rows
        ],
    }


@router.get("/workspaces/{workspace_name}/sessions")
async def list_sessions(
    workspace_name: str = Path(...),
    peer: str | None = Query(None, description="restrict to sessions containing this peer"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = db,
):
    """List sessions in a workspace, optionally filtered by peer membership."""
    base = select(models.Session).where(models.Session.workspace_name == workspace_name)
    if peer:
        base = base.join(models.Session.peers).where(models.Peer.name == peer)

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()

    stmt = base.order_by(models.Session.created_at.desc()).offset(offset).limit(limit)
    sessions = (await db.execute(stmt)).scalars().unique().all()

    # Fetch peer names per session in one extra round-trip (avoids N+1).
    session_names = [s.name for s in sessions]
    peers_by_session: dict[str, list[str]] = {n: [] for n in session_names}
    if session_names:
        peer_stmt = (
            select(models.Session.name, models.Peer.name)
            .join(models.Session.peers)
            .where(models.Session.name.in_(session_names))
            .where(models.Session.workspace_name == workspace_name)
        )
        for sname, pname in (await db.execute(peer_stmt)).all():
            peers_by_session.setdefault(sname, []).append(pname)

    return {
        "total": total,
        "items": [
            {
                "name": s.name,
                "created_at": s.created_at.isoformat(),
                "is_active": s.is_active,
                "peer_names": peers_by_session.get(s.name, []),
            }
            for s in sessions
        ],
    }
