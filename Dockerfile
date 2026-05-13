# https://pythonspeed.com/articles/base-image-python-docker-images/
# https://testdriven.io/blog/docker-best-practices/

# ---------- admin-ui build stage ----------
# Builds the Vite/React SPA that the FastAPI app mounts at /admin/ui/.
# Kept in a separate stage so changes to admin-ui/ don't bust the python
# dependency cache and so node tooling isn't shipped in the runtime image.
FROM node:20-slim AS admin-ui-build
WORKDIR /admin-ui
COPY admin-ui/package.json admin-ui/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY admin-ui/ ./
RUN npm run build

# ---------- runtime stage ----------
FROM python:3.13-slim-bookworm

# 用 pip 安装 uv，而不是 COPY --from=ghcr.io/astral-sh/uv:0.9.24。
# 受限网络（企业 mirror / 墙后 CI）拉 ghcr.io 容易 403，pip 走 PyPI 更稳。
RUN pip install --no-cache-dir "uv==0.9.24"

# Set Working directory
WORKDIR /app

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy from the cache instead of linking since it's a mounted volume
ENV UV_LINK_MODE=copy

# Python optimizations
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Install the project's dependencies using the lockfile and settings
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project --no-group dev

# Copy only requirements to cache them in docker layer
COPY uv.lock pyproject.toml /app/

# Sync the project
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-group dev

# Place executables in the environment at the front of the path
ENV PATH="/app/.venv/bin:$PATH"
ENV HOME=/app
ENV UV_CACHE_DIR=/tmp/uv-cache

# Create non-root user and set ownership
RUN addgroup --system app && adduser --system --group app && mkdir -p /tmp/uv-cache && chown -R app:app /app /tmp/uv-cache

COPY --chown=app:app src/ /app/src/
COPY --chown=app:app migrations/ /app/migrations/
COPY --chown=app:app scripts/ /app/scripts/
COPY --chown=app:app docker/ /app/docker/
COPY --chown=app:app alembic.ini /app/alembic.ini
# Copy config files - this will copy config.toml if it exists, and config.toml.example
COPY --chown=app:app config.toml* /app/

# Admin observability SPA — built in the admin-ui-build stage and copied
# in as static assets. AdminSettings.UI_DIST_PATH defaults to admin-ui/dist
# (resolved relative to WORKDIR=/app), so this path must match.
COPY --chown=app:app --from=admin-ui-build /admin-ui/dist /app/admin-ui/dist

# Switch to non-root user
USER app

EXPOSE 8000

CMD ["fastapi", "run", "--host", "0.0.0.0", "src/main.py"]
