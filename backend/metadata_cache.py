"""Persistent file-based cache for song metadata returned by enrich_video().

Storage: backend/outputs/metadata_cache.json — a flat JSON dict keyed by video_id.

# TODO (Phase 3): replace with Firestore songs/{video_id}.
# get()  →  db.collection("songs").document(video_id).get()
# put()  →  db.collection("songs").document(video_id).set(data)

NOTE: the load-modify-save pattern is only safe for a single-worker process.
Under multi-worker deployments (uvicorn --workers N > 1) concurrent writes
could race. Switch to Firestore in Phase 3 to eliminate this.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_CACHE_FILE = Path(__file__).resolve().parent / "outputs" / "metadata_cache.json"


def get(video_id: str) -> dict | None:
    """Return cached metadata for video_id, or None on miss or read error."""
    if not _CACHE_FILE.exists():
        return None
    try:
        cache: dict = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        entry = cache.get(video_id)
        if entry is not None:
            logger.info("metadata cache HIT: %s", video_id)
        return entry
    except Exception as exc:
        logger.warning("metadata cache read error: %s", exc)
        return None


def put(video_id: str, data: dict) -> None:
    """Persist metadata for video_id. Skips empty/error results. Never raises."""
    if not data.get("video_id"):
        return
    try:
        cache: dict = {}
        if _CACHE_FILE.exists():
            try:
                cache = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass  # corrupt cache — start fresh
        cache[video_id] = data
        tmp = _CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_CACHE_FILE)  # atomic on POSIX / macOS
        logger.info("metadata cache SAVED: %s", video_id)
    except Exception as exc:
        logger.warning("metadata cache write error for %s: %s", video_id, exc)
