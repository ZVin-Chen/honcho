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

import logging

from fastapi import APIRouter, Body, HTTPException, Path, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src import crud, models, schemas
from src.config import ReasoningLevel
from src.dependencies import db, tracked_db
from src.dialectic.core import DialecticAgent
from src.embedding_client import embedding_client
from src.utils.config_helpers import get_configuration
from src.utils.work_unit import parse_work_unit_key

logger = logging.getLogger(__name__)

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


# --- Observations + peer cards ----------------------------------------------


@router.get("/workspaces/{workspace_name}/peers/{observer}/card")
async def get_peer_card(
    workspace_name: str = Path(...),
    observer: str = Path(...),
    target: str | None = Query(
        None,
        description=(
            "Peer being described. Omit (or set to observer) for the "
            "observer's self-card."
        ),
    ),
    db: AsyncSession = db,
):
    """Return the observer's peer card for `target` (defaults to self).

    Honcho stores cards in `peers.internal_metadata` under a key derived
    from the (observer, observed) pair, maintained by the deriver/dreamer.
    Returns an empty list when no card has been accumulated yet.
    """
    observed = target if target else observer
    try:
        bullets = await crud.get_peer_card(
            db, workspace_name, observer=observer, observed=observed
        )
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"peer not found: {e}") from e
    return {
        "observer": observer,
        "observed": observed,
        "bullets": bullets or [],
    }


@router.get("/workspaces/{workspace_name}/peers/{observer}/observations")
async def list_observations(
    workspace_name: str = Path(...),
    observer: str = Path(...),
    target: str | None = Query(
        None,
        description=(
            "Peer being observed. Omit (or set to observer) for the "
            "observer's omniscient view of themselves."
        ),
    ),
    session: str | None = Query(
        None,
        description=(
            "Restrict observations to those produced inside this session. "
            "Omit for the cross-session (working-representation-global) view."
        ),
    ),
    query: str | None = Query(
        None,
        description=(
            "Semantic search query — when set, results are filtered to the "
            "top-k vector-search matches and an opaque relevance score is "
            "included in each entry."
        ),
    ),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = db,
):
    """List observations honcho has accumulated for (observer → target).

    Returns all four observation levels in separate buckets, matching the
    shape used by /dialectic/trace's prefetch field — same renderer can
    handle both.

    Internally delegates to crud.get_working_representation, the same
    function the dialectic agent uses for its retrieval step.
    """
    observed = target if target else observer

    embedding = None
    if query:
        try:
            embedding = await embedding_client.embed(query)
        except Exception as e:
            logger.warning("admin.list_observations: embed failed (%s); falling back to recency", e)

    try:
        representation = await crud.get_working_representation(
            workspace_name,
            db=db,
            observer=observer,
            observed=observed,
            session_name=session,
            include_semantic_query=query,
            embedding=embedding,
            semantic_search_top_k=limit if query else None,
            include_most_derived=False,
            max_observations=limit,
        )
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"lookup failed: {e}") from e

    return {
        "observer": observer,
        "observed": observed,
        "session": session,
        "query": query,
        "observations": {
            "explicit": [o.model_dump(mode="json") for o in representation.explicit],
            "deductive": [o.model_dump(mode="json") for o in representation.deductive],
            "inductive": [o.model_dump(mode="json") for o in representation.inductive],
            "contradiction": [
                o.model_dump(mode="json") for o in representation.contradiction
            ],
        },
    }


# --- Queue (deriver / summary / dream / reconciler) -------------------------


@router.get("/workspaces/{workspace_name}/queue/summary")
async def queue_summary(
    workspace_name: str = Path(...),
    db: AsyncSession = db,
):
    """Aggregate queue counts for this workspace.

    Returns a {task_type: {pending, processed, errored}} dict plus the
    set of in-flight work_unit_keys (anything currently in
    active_queue_sessions). Manual refresh — no polling.
    """
    # Per-task-type counts. Three states we care about:
    #   pending  = processed=false AND error IS NULL
    #   processed= processed=true
    #   errored  = error IS NOT NULL (could be still in queue or already
    #             marked processed; treated as its own bucket either way)
    rows = (
        await db.execute(
            select(
                models.QueueItem.task_type,
                func.count().filter(
                    (models.QueueItem.processed.is_(False))
                    & (models.QueueItem.error.is_(None))
                ).label("pending"),
                func.count().filter(models.QueueItem.processed.is_(True)).label("processed"),
                func.count().filter(models.QueueItem.error.isnot(None)).label("errored"),
            )
            .where(models.QueueItem.workspace_name == workspace_name)
            .group_by(models.QueueItem.task_type)
        )
    ).all()

    by_task_type = {
        r.task_type: {
            "pending": r.pending,
            "processed": r.processed,
            "errored": r.errored,
        }
        for r in rows
    }

    # Active work units (deriver is currently claiming them). Joined to
    # QueueItem to scope by workspace; otherwise active_queue_sessions
    # has no workspace_name column.
    active_rows = (
        await db.execute(
            select(models.ActiveQueueSession.work_unit_key)
            .join(
                models.QueueItem,
                models.QueueItem.work_unit_key == models.ActiveQueueSession.work_unit_key,
            )
            .where(models.QueueItem.workspace_name == workspace_name)
            .distinct()
        )
    ).all()

    return {
        "workspace": workspace_name,
        "by_task_type": by_task_type,
        "active_work_units": [r.work_unit_key for r in active_rows],
    }


@router.get("/workspaces/{workspace_name}/queue/items")
async def queue_items(
    workspace_name: str = Path(...),
    task_type: str | None = Query(None),
    state: str | None = Query(
        None,
        description="pending | processed | errored — filters the items list",
        pattern="^(pending|processed|errored)$",
    ),
    work_unit_key: str | None = Query(
        None,
        description=(
            "Exact-match filter on work_unit_key — useful for chasing a "
            "specific representation/dream that you've seen in summary."
        ),
    ),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = db,
):
    """Raw queue items, newest first, with filter knobs.

    payload_summary trims the JSONB payload down to the keys we know are
    safe to show (message_id, content head, observer/observed/session,
    dream_type). The full payload is opaque per-task-type and can be
    huge — operators rarely need everything.
    """
    stmt = select(models.QueueItem).where(
        models.QueueItem.workspace_name == workspace_name
    )
    if task_type:
        stmt = stmt.where(models.QueueItem.task_type == task_type)
    if state == "pending":
        stmt = stmt.where(
            models.QueueItem.processed.is_(False),
            models.QueueItem.error.is_(None),
        )
    elif state == "processed":
        stmt = stmt.where(models.QueueItem.processed.is_(True))
    elif state == "errored":
        stmt = stmt.where(models.QueueItem.error.isnot(None))
    if work_unit_key:
        stmt = stmt.where(models.QueueItem.work_unit_key == work_unit_key)

    total = (
        await db.execute(select(func.count()).select_from(stmt.subquery()))
    ).scalar_one()

    stmt = stmt.order_by(models.QueueItem.id.desc()).offset(offset).limit(limit)
    items = (await db.execute(stmt)).scalars().all()

    def _summarize(payload: dict) -> dict:
        # Trim payload to the few keys that are universally useful for
        # debugging across task types. The remaining keys (raw vectors,
        # internal flags, etc.) are noise in this view.
        keep = (
            "observer",
            "observed",
            "session_name",
            "message_id",
            "dream_type",
            "reconciler_type",
            "deletion_type",
            "resource_id",
        )
        out = {k: payload[k] for k in keep if k in payload}
        # If there's a "content" key (deriver representation tasks carry
        # the source message), include just the first 120 chars.
        if isinstance(payload.get("content"), str):
            out["content_head"] = payload["content"][:120]
        return out

    def _parse_key(key: str) -> dict | None:
        # Don't blow up if the format ever shifts — work_unit_key is
        # producer-side data we don't strictly control.
        try:
            return parse_work_unit_key(key).model_dump(exclude_none=True)
        except Exception:
            return None

    return {
        "workspace": workspace_name,
        "total": total,
        "items": [
            {
                "id": i.id,
                "task_type": i.task_type,
                "work_unit_key": i.work_unit_key,
                "parsed": _parse_key(i.work_unit_key),
                "session_id": i.session_id,
                "message_id": i.message_id,
                "processed": i.processed,
                "error": i.error,
                "created_at": i.created_at.isoformat(),
                "payload_summary": _summarize(i.payload or {}),
            }
            for i in items
        ],
    }


# --- Dialectic trace --------------------------------------------------------


class DialecticTraceRequest(BaseModel):
    observer: str = Field(..., description="peer making the query")
    target: str = Field(..., description="peer being queried about")
    query: str = Field(..., min_length=1)
    session: str | None = Field(
        None,
        description=(
            "Pin retrieval to a single session. Omit for cross-session "
            "(global) recall — the typical case."
        ),
    )
    reasoning_level: ReasoningLevel = "low"


@router.post("/workspaces/{workspace_name}/dialectic/trace")
async def dialectic_trace(
    workspace_name: str = Path(...),
    body: DialecticTraceRequest = Body(...),
):
    """Run a dialectic query and return the structured trace.

    Mirrors src.dialectic.chat.agentic_chat's preflight (peer existence
    check + peer-card fetch), then calls DialecticAgent.answer_with_trace
    instead of .answer so the prefetched observations, tool calls, and
    token counts come back to the caller.

    Errors are surfaced as HTTPException; everything else propagates to
    the global handler in main.py.
    """
    # Preflight: validate peers + session exist, gather peer cards.
    # Same shape as agentic_chat — kept verbatim so the trace path stays
    # behaviourally identical to production recall.
    async with tracked_db("admin.dialectic_trace.preflight") as session:
        try:
            await crud.get_peer(
                session, workspace_name, schemas.PeerCreate(name=body.observer)
            )
            if body.observer != body.target:
                await crud.get_peer(
                    session, workspace_name, schemas.PeerCreate(name=body.target)
                )
        except Exception as e:
            raise HTTPException(status_code=404, detail=f"peer not found: {e}") from e

        session_row = None
        if body.session:
            try:
                session_row = await crud.get_session(
                    session,
                    workspace_name=workspace_name,
                    session_name=body.session,
                )
            except Exception as e:
                raise HTTPException(
                    status_code=404, detail=f"session not found: {e}"
                ) from e

        try:
            workspace = await crud.get_workspace(
                session, workspace_name=workspace_name
            )
        except Exception as e:
            raise HTTPException(
                status_code=404, detail=f"workspace not found: {e}"
            ) from e

        configuration = get_configuration(None, session_row, workspace)

        observer_peer_card = None
        target_peer_card = None
        if configuration.peer_card.use:
            observer_peer_card = await crud.get_peer_card(
                session, workspace_name, observer=body.observer, observed=body.observer
            )
            if body.observer != body.target:
                target_peer_card = await crud.get_peer_card(
                    session,
                    workspace_name,
                    observer=body.observer,
                    observed=body.target,
                )

    agent = DialecticAgent(
        workspace_name=workspace_name,
        session_name=body.session,
        observer=body.observer,
        observed=body.target,
        observer_peer_card=observer_peer_card,
        observed_peer_card=target_peer_card,
        reasoning_level=body.reasoning_level,
    )
    return await agent.answer_with_trace(body.query)
