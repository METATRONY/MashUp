# MashUp — Claude Code Instructions

## After every change, tell the user:

- **Frontend-only changes** (HTML, CSS, JS): no server restart needed — hard-refresh the browser (`Cmd+Shift+R`).
- **Backend changes** (anything under `backend/`): restart the uvicorn server (`uvicorn backend.main:app --reload` or kill & rerun), then refresh the browser.

Always state which category the change falls into after making it.

## Project structure

- `index.html`, `css/`, `js/` — static frontend; served by a simple HTTP server (e.g. `python3 -m http.server 8080`).
- `backend/` — FastAPI app; run with `uvicorn backend.main:app --reload --port 8000`.
- Frontend talks to backend via `window.MASHUP_API_BASE` (default `http://127.0.0.1:8000`).

## Key files

- `js/app.js` — entry point; wires store, modules, subscriptions.
- `js/state.js` — pub-sub store; all app state lives here.
- `js/mixer.js` — mixer grid UI, transport, generation buttons.
- `js/api.js` — mashup generation API calls and job polling.
- `js/ui.js` — song cards, toasts, modal helpers.
- `js/prompt.js` — AI music prompt generator (client-side, no backend needed).
- `js/compatibility.js` — BPM/key compatibility logic, Camelot helpers.
- `js/constants/components.js` — nine exclusive component IDs and validation.
- `backend/main.py` — FastAPI routes and mashup pipeline orchestration.
- `backend/tempo_match.py` — BPM detection, time-stretch, pitch-shift.
- `css/mixer.css` — mixer-specific styles including prompt modal.
