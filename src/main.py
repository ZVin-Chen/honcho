import logging
import re
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import sentry_sdk
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi_pagination import add_pagination
from pydantic import ValidationError
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from src.cache.client import close_cache, init_cache
from src.config import settings
from src.db import engine, request_context
from src.exceptions import HonchoException
from src.routers import (
    admin,
    conclusions,
    keys,
    messages,
    peers,
    sessions,
    webhooks,
    workspaces,
)
from src.telemetry import (
    initialize_telemetry_async,
    metrics_endpoint,
    prometheus_metrics,
    shutdown_telemetry,
)
from src.telemetry.logging import get_route_template
from src.telemetry.sentry import initialize_sentry

if TYPE_CHECKING:
    from sentry_sdk._types import Event, Hint


def get_log_level() -> int:
    """
    Convert log level string from settings to logging module constant.

    Returns:
        int: The logging level constant (e.g., logging.INFO)
    """
    log_level_str = settings.LOG_LEVEL.upper()

    log_levels = {
        "CRITICAL": logging.CRITICAL,  # 50
        "ERROR": logging.ERROR,  # 40
        "WARNING": logging.WARNING,  # 30
        "INFO": logging.INFO,  # 20
        "DEBUG": logging.DEBUG,  # 10
        "NOTSET": logging.NOTSET,  # 0
    }

    return log_levels.get(log_level_str, logging.INFO)


# Configure logging
logging.basicConfig(
    level=get_log_level(),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Suppress cashews Redis error logs (NoScriptError, ConnectionError, etc.)
# These are handled gracefully by SafeRedis and don't need full tracebacks
logging.getLogger("cashews.backends.redis.client").setLevel(logging.CRITICAL)


class MetricsAccessFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return "GET /metrics" not in msg


logging.getLogger("uvicorn.access").addFilter(MetricsAccessFilter())


def before_send(event: "Event", hint: "Hint | None") -> "Event | None":
    """Filter out events raised from known non-actionable exceptions before Sentry sees them."""
    if not hint:
        return event

    exc_info = hint.get("exc_info")
    if not exc_info:
        return event

    _, exc_value, _ = exc_info
    if isinstance(exc_value, HonchoException):
        return None

    # Filters out ValidationErrors and RequestValidationErrors (typically coming from Pydantic)
    if isinstance(exc_value, ValidationError | RequestValidationError):
        logger.info(f"Filtering out validation error from Sentry: {exc_value}")
        return None

    return event


# Sentry Setup
SENTRY_ENABLED = settings.SENTRY.ENABLED
if SENTRY_ENABLED:
    initialize_sentry(
        integrations=[
            StarletteIntegration(
                transaction_style="endpoint",
            ),
            FastApiIntegration(
                transaction_style="endpoint",
            ),
        ],
        before_send=before_send,
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Initialize CloudEvents telemetry
    await initialize_telemetry_async()

    try:
        await init_cache()
    except Exception as e:
        logger.warning(
            "Error initializing cache in api process; proceeding without cache: %s", e
        )

    try:
        yield
    finally:
        # Import here to avoid circular import at module load time
        from src.vector_store import close_external_vector_store

        await close_external_vector_store()
        await close_cache()
        await engine.dispose()
        # Shutdown telemetry (flush CloudEvents buffer)
        await shutdown_telemetry()


app = FastAPI(
    lifespan=lifespan,
    servers=[
        {"url": "https://api.honcho.dev", "description": "Production SaaS Platform"},
        {"url": "http://localhost:8000", "description": "Local Development Server"},
    ],
    title="Honcho API",
    summary="The Identity Layer for the Agentic World",
    description="""Honcho is a platform for giving agents user-centric memory and social cognition.""",
    version="3.0.6",
    contact={
        "name": "Plastic Labs",
        "url": "https://honcho.dev",
        "email": "hello@plasticlabs.ai",
    },
    license_info={
        "name": "GNU Affero General Public License v3.0",
        "identifier": "AGPL-3.0-only",
        "url": "https://github.com/plastic-labs/honcho/blob/main/LICENSE",
    },
)

origins = [
    "http://localhost",
    "http://127.0.0.1:8000",
    "https://api.honcho.dev",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


add_pagination(app)

app.include_router(admin.router)
app.include_router(workspaces.router, prefix="/v3")
app.include_router(peers.router, prefix="/v3")
app.include_router(sessions.router, prefix="/v3")
app.include_router(messages.router, prefix="/v3")
app.include_router(conclusions.router, prefix="/v3")
app.include_router(keys.router, prefix="/v3")
app.include_router(webhooks.router, prefix="/v3")

# Prometheus metrics endpoint
app.add_route("/metrics", metrics_endpoint, methods=["GET"])

# Admin observability SPA. Mounted only if (a) the feature is enabled and
# (b) the build artifacts actually exist on disk — that way running honcho
# without having built admin-ui (e.g. local dev with `fastapi run` from a
# fresh checkout) doesn't 500 on import. The JSON endpoints under /admin
# stay available either way.
if settings.ADMIN.UI_ENABLED:
    import os
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    _admin_dist = settings.ADMIN.UI_DIST_PATH
    if os.path.isdir(_admin_dist):
        app.mount(
            "/admin/ui/assets",
            StaticFiles(directory=os.path.join(_admin_dist, "assets")),
            name="admin-ui-assets",
        )

        @app.get("/admin/ui", include_in_schema=False)
        @app.get("/admin/ui/", include_in_schema=False)
        @app.get("/admin/ui/{full_path:path}", include_in_schema=False)
        async def _admin_ui_index(full_path: str = ""):  # noqa: D401, ARG001
            """Serve the SPA's index.html for any /admin/ui/* path so the
            client-side router can take over."""
            return FileResponse(os.path.join(_admin_dist, "index.html"))
    else:
        logger.info(
            "admin: UI_ENABLED=true but %s missing — JSON endpoints active, SPA not mounted",
            _admin_dist,
        )


@app.get("/health")
async def health_check():
    """Health check endpoint for monitoring and container orchestration."""
    return {"status": "ok"}


# Global exception handlers
@app.exception_handler(HonchoException)
async def honcho_exception_handler(_request: Request, exc: HonchoException):
    """Handle all Honcho-specific exceptions."""
    logger.error(f"{exc.__class__.__name__}: {exc.detail}", exc_info=exc)

    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )


@app.exception_handler(Exception)
async def global_exception_handler(_request: Request, exc: Exception):
    """Handle all unhandled exceptions."""
    logger.error(f"Unhandled exception: {str(exc)}", exc_info=True)

    if SENTRY_ENABLED:
        sentry_sdk.capture_exception(exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected error occurred"},
    )


@app.middleware("http")
async def track_request(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
):
    # Create a request ID that includes endpoint information
    endpoint = re.sub(r"/[A-Za-z0-9_-]{21}", "", request.url.path).replace("/", "_")
    request_id = f"{request.method}:{endpoint}:{str(uuid.uuid4())[:8]}"

    # Store in request state and context var
    request.state.request_id = request_id
    token = request_context.set(f"api:{request_id}")

    try:
        response = await call_next(request)

        # Track metrics if enabled
        if settings.METRICS.ENABLED:
            template = get_route_template(request)
            prometheus_metrics.record_api_request(
                method=request.method,
                endpoint=template,
                status_code=str(response.status_code),
            )

        return response
    finally:
        request_context.reset(token)
