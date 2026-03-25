# MashUp backend

FastAPI service that downloads YouTube audio, separates stems with **Demucs** (`htdemucs`), maps four stems into **nine UI components** (approximate frequency splits on the “other” stem), and mixes a single **MP3**.

## Requirements

- **Python** 3.10+
- **ffmpeg** on your `PATH` (for yt-dlp post-process and MP3 encode)
- **yt-dlp** is installed via pip (`requirements.txt`)

## Legal

Downloading or processing YouTube content may be restricted by **YouTube’s Terms of Service** and by copyright. Only use sources you have the right to use. This software is provided as a technical demo.

## Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Demucs will download model weights on first run. **GPU** (CUDA) is optional but much faster.

## Run

```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Run from the **repository root** so the `backend` package resolves:

```bash
cd /path/to/MashUp
uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Outputs are written to `backend/outputs/` and served at `http://127.0.0.1:8000/outputs/<job_id>.mp3`.

## Frontend

Set the API base URL if needed:

```js
window.MASHUP_API_BASE = 'http://127.0.0.1:8000';
```

Default in `js/api.js` is `http://127.0.0.1:8000`.

## API

### Mashup (waveform pipeline)

- `GET /api/health` — liveness
- `POST /api/mashup` — JSON body `{ tracks: [{ track_id, video_id, components, volume, muted }], master_volume, bpm }` (bpm reserved for future use)
- `GET /api/mashup/job/{job_id}` — `{ status, download_url?, error? }`

Jobs run in the background; the frontend polls every 2 seconds.

### Essence pipeline (feature → recipe → future render)

These routes share the same **nine component IDs** as the frontend (`backend/constants.py` ↔ `js/constants/components.js`). They are the contract for a **non–waveform-cloning** path: analyze sources into descriptors, merge assignments under **global exclusivity** (each component claimed by at most one track), then (later) synthesize audio from a recipe.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/analyze` | Resolve `TrackSourceIn` list → `TrackEssence` per track (global BPM/key + per-component stats; **stub** until real analyzers are wired). |
| `POST` | `/api/compose` | Body: `analyses` (`TrackEssence`[]) + `assignments` (`track_ref` + `components`[]) + optional `target_bpm` → `ComposeResponse` (`recipe_id`, `resolved_bpm`, `timeline`, `provenance`). Validates exclusivity server-side. |
| `POST` | `/api/render` | Accepts `recipe_id` or inline `compose` payload + `output_format`; returns **`not_implemented`** until a synthesis/export engine is connected. Does not replace `/api/mashup`. |

**Schemas** live in `backend/essence_schema.py` (`schema_version` `1.0.0`). **Stub logic** is in `backend/essence_stub.py` (deterministic placeholders for OpenAPI and UI integration).

Interactive docs: `http://127.0.0.1:8000/docs`.

**Frontend helpers:** `js/essence-api.js` — `analyzeTracks`, `composeFromAnalyses`, `renderEssenceRecipe` (same `MASHUP_API_BASE` as `js/api.js`).

Do not use `--reload` in this project while Demucs/Torch is installed in `.venv` under the repo, because file watching can trigger continuous restarts.

## Docker

From the `backend` folder:

```bash
docker build -t mashup-api .
docker run -p 8000:8000 mashup-api
```

The image is large (PyTorch + Demucs). Mount a volume on `/app/backend/outputs` if you want to persist exports.
