"""Catalog helpers: load curated song list and search YouTube for video IDs."""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

_CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"

def load_catalog() -> list[dict]:
    return json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))

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
