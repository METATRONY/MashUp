"""Catalog helpers: load curated song list and search YouTube for video IDs."""
from __future__ import annotations
import json
import logging
import subprocess
import sys
from pathlib import Path

_CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"
logger = logging.getLogger(__name__)


def load_catalog() -> list[dict]:
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))


def _save_catalog(entries: list[dict]) -> None:
    tmp = _CATALOG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entries, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(_CATALOG_PATH)


def add_to_catalog(video_id: str, metadata: dict) -> None:
    """Append a user-added song to the catalog if its video_id isn't already present."""
    try:
        entries = load_catalog()
        if any(e.get("video_id") == video_id for e in entries):
            return
        entry: dict = {"video_id": video_id}
        for field in ("artist", "title", "bpm", "key_name", "album_art", "spotify_id"):
            val = metadata.get(field)
            if val is not None:
                entry[field] = val
        entries.append(entry)
        _save_catalog(entries)
        logger.info("catalog: added %s (%s – %s)", video_id, entry.get("artist"), entry.get("title"))
    except Exception as exc:
        logger.warning("catalog add error for %s: %s", video_id, exc)

def _ytdlp_bin() -> str:
    p = Path(sys.executable).parent / "yt-dlp"
    return str(p) if p.exists() else "yt-dlp"

def search_yt_video_id(artist: str, title: str) -> str | None:
    """Use yt-dlp to find the best matching YouTube video ID."""
    query = f"{artist} {title}".strip()
    try:
        result = subprocess.run(
            [_ytdlp_bin(), f"ytsearch1:{query}", "--get-id", "--no-playlist", "--quiet"],
            capture_output=True, text=True, timeout=30,
        )
        vid = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
        return vid if len(vid) >= 8 else None
    except Exception:
        return None
