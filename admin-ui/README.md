# honcho admin UI

Minimal Vite + React SPA for the `/admin/*` observability endpoints.

In production it is built into `admin-ui/dist/` by honcho's Dockerfile and
served by the FastAPI app at `/admin/ui/` (see
`src/main.py` and `AdminSettings.UI_DIST_PATH` in `src/config.py`).

## Local dev

```
cd admin-ui
npm ci
npm run dev      # vite on :5173, proxies /admin/* to honcho-api on :8000
```

Then open http://127.0.0.1:5173/admin/ui/. The `base` is set to `/admin/ui/`
in `vite.config.ts` so the dev server's URL matches the path used in
production.

## Build

```
npm run build    # type-check + emit dist/
```

`dist/` is gitignored; the Dockerfile produces it inside the image.
