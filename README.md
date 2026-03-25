# MashUp

Web app for building **exclusive-component mashups**: add YouTube tracks, assign each of nine musical components (melody, harmony, bass, drums, vocals, pads, percussion, FX, other) to **at most one** track, then generate a mixed **MP3** on the server.

## Run locally

### Frontend (static)

From the repository root:

```bash
python3 -m http.server 8080
```

Open `http://127.0.0.1:8080/` (or the port you chose). Optionally set the API URL in the browser console or app bootstrap:

```js
window.MASHUP_API_BASE = 'http://127.0.0.1:8000';
```

### Backend (FastAPI + Demucs)

See **[backend/README.md](backend/README.md)** for Python version, `ffmpeg`, setup, and how to run `uvicorn`. The backend exposes:

- **Mashup export:** `POST /api/mashup` (YouTube → stems → nine-way map → mix → MP3)
- **Essence pipeline (stub):** `POST /api/analyze`, `POST /api/compose`, `POST /api/render` — documented in the backend README and `backend/essence_schema.py`

## Project layout

- `index.html`, `css/`, `js/` — static UI and client logic (`js/api.js`, `js/essence-api.js`)
- `backend/` — FastAPI app, Demucs pipeline, job persistence under `backend/outputs/`

## Legal

Use only content you have the right to process. YouTube and other sources may restrict downloading or derivative use in their terms.
