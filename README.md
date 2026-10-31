# Background Remover

A local web app that removes image backgrounds. The AI model runs on your machine, so images never leave it.

## Run

```bash
npm install
npm start
```

Then open http://localhost:5178.

## Files

- `server.mjs`: HTTP server. `POST /api/upload` runs the model once and caches the mask; `GET /api/render` applies the clean-up settings and returns a PNG.
- `process.mjs`: mask clean-up (upscaling, recovering faint areas, hole filling, speck removal, edge trim and feathering).
- `index.html`: the page (upload, settings, preview, before/after compare, download).
- `output/`: cutouts made before the app existed.
