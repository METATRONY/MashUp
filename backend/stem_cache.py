"""Persistent disk cache for Demucs-separated stems, keyed by (video_id, model).

Stores raw stems (before time-stretch / pitch-shift) so the same track can be
re-mixed at different BPMs or keys without re-downloading or re-running Demucs.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_CACHE_DIR = Path(__file__).resolve().parent / "outputs" / "stems_cache"


def _slot(video_id: str, model: str) -> Path:
    safe = video_id.replace("/", "_").replace("\\", "_").replace(".", "_")
    return _CACHE_DIR / f"{safe}__{model}"


def load(
    video_id: str, model: str
) -> tuple[dict[str, np.ndarray], float, list] | None:
    """Return (stems, detected_bpm, chords) from cache, or None on miss."""
    slot = _slot(video_id, model)
    meta_path = slot / "meta.json"
    if not meta_path.exists():
        return None
    try:
        with open(meta_path) as f:
            meta = json.load(f)
        stems: dict[str, np.ndarray] = {}
        for name in meta["stems"]:
            p = slot / f"{name}.npy"
            if not p.exists():
                logger.warning("Stem cache incomplete for %s/%s — %s missing", video_id, model, name)
                return None
            stems[name] = np.load(str(p))
        logger.info("Stem cache HIT: %s / %s", video_id, model)
        return stems, float(meta["bpm"]), meta.get("chords", [])
    except Exception as exc:
        logger.warning("Stem cache read error for %s/%s: %s", video_id, model, exc)
        return None


def save(
    video_id: str,
    model: str,
    stems: dict[str, np.ndarray],
    bpm: float,
    chords: list,
) -> None:
    """Persist stems + metadata to disk. Errors are logged but not raised."""
    slot = _slot(video_id, model)
    try:
        slot.mkdir(parents=True, exist_ok=True)
        for name, audio in stems.items():
            np.save(str(slot / f"{name}.npy"), audio)
        with open(slot / "meta.json", "w") as f:
            json.dump({"stems": list(stems.keys()), "bpm": bpm, "chords": chords}, f)
        logger.info("Stem cache SAVED: %s / %s (%d stems)", video_id, model, len(stems))
    except Exception as exc:
        logger.warning("Stem cache write error for %s/%s: %s", video_id, model, exc)
