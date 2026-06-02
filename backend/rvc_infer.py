"""
RVC (Retrieval-based Voice Conversion) inference for the artist catalog.

Entry point: convert_with_rvc(song_vocals, artist_id, sr, pitch_shift)

Models are downloaded from the URLs in rvc_catalog.json on first use and
cached at backend/models/rvc/{artist_id}/.  Model URLs may point to a .pth
file directly or to a .zip archive (Fonre / QuickWick style); both are
handled transparently.

Inference runs in a subprocess (rvc_worker.py) to isolate native crashes
that occur when infer_rvc_python is loaded inside uvicorn's thread pool.
"""
from __future__ import annotations

import json
import logging
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_CATALOG_PATH  = Path(__file__).resolve().parent / "rvc_catalog.json"
_MODEL_DIR     = Path(__file__).resolve().parent / "models" / "rvc"
_BASE_DIR      = Path(__file__).resolve().parent / "models" / "base"
_MODEL_DIR.mkdir(parents=True, exist_ok=True)
_BASE_DIR.mkdir(parents=True, exist_ok=True)

_HUBERT_URL = "https://huggingface.co/r3gm/sonitranslate_voice_models/resolve/main/hubert_base.pt"

_catalog: list[dict] | None = None


# ── Catalog helpers ───────────────────────────────────────────────────────────

def load_catalog() -> list[dict]:
    global _catalog
    if _catalog is None:
        with open(_CATALOG_PATH) as f:
            _catalog = json.load(f)
    return _catalog


def get_artist(artist_id: str) -> dict:
    if artist_id.startswith("user_"):
        model_path = _MODEL_DIR / artist_id / "model.pth"
        if not model_path.exists():
            raise KeyError(f"No trained model found for {artist_id}")
        return {"id": artist_id, "name": "My Voice", "model_url": None}
    for a in load_catalog():
        if a["id"] == artist_id:
            return a
    raise KeyError(f"Artist '{artist_id}' not found in catalog")


# ── Download helpers ──────────────────────────────────────────────────────────

def _download(url: str, dest: Path) -> bool:
    """Download url → dest; return True on success, False on error."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    try:
        print(f"[rvc] Downloading {dest.name} …", flush=True)
        t0 = time.time()
        urllib.request.urlretrieve(url, tmp)
        size_mb = tmp.stat().st_size / 1_048_576
        tmp.rename(dest)
        print(f"[rvc] ✔ {dest.name} ({size_mb:.1f} MB) in {time.time()-t0:.1f}s", flush=True)
        return True
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        print(f"[rvc] ✖ Download failed for {dest.name}: {exc}", flush=True)
        return False


def _download_zip(url: str, art_dir: Path) -> bool:
    """
    Download a zip archive and extract the first .pth (and optional .index)
    into art_dir as model.pth / model.index.  Works for both Fonre-style
    (model.pth at root) and QuickWick-style (artist-named .pth in subdir).
    """
    tmp_zip = art_dir / "_download.zip"
    if not _download(url, tmp_zip):
        return False
    try:
        with zipfile.ZipFile(tmp_zip) as z:
            names = z.namelist()
            pth_files = [n for n in names if n.endswith(".pth") and not n.startswith("__")]
            idx_files = [n for n in names if n.endswith(".index") and not n.startswith("__")]

            if not pth_files:
                print(f"[rvc] ✖ No .pth found in zip from {url}", flush=True)
                return False

            # model.pth
            with z.open(pth_files[0]) as src, open(art_dir / "model.pth", "wb") as dst:
                dst.write(src.read())
            print(f"[rvc] ✔ Extracted {pth_files[0]} → model.pth", flush=True)

            # model.index (optional)
            if idx_files:
                with z.open(idx_files[0]) as src, open(art_dir / "model.index", "wb") as dst:
                    dst.write(src.read())
                print(f"[rvc] ✔ Extracted {idx_files[0]} → model.index", flush=True)

        return True
    except Exception as exc:
        print(f"[rvc] ✖ Zip extraction failed: {exc}", flush=True)
        return False
    finally:
        tmp_zip.unlink(missing_ok=True)


# ── Model management ──────────────────────────────────────────────────────────

def _ensure_hubert() -> None:
    hubert = _BASE_DIR / "hubert_base.pt"
    if not hubert.exists():
        _download(_HUBERT_URL, hubert)


def ensure_artist_model(artist_id: str) -> tuple[Path, Path | None]:
    """Download and cache the artist model if not already present."""
    if artist_id.startswith("user_"):
        art_dir = _MODEL_DIR / artist_id
        model_path = art_dir / "model.pth"
        if not model_path.exists():
            raise RuntimeError(f"No trained user model at {model_path}")
        index_path = art_dir / "model.index"
        return model_path, index_path if index_path.exists() else None

    artist  = get_artist(artist_id)
    art_dir = _MODEL_DIR / artist_id
    art_dir.mkdir(exist_ok=True)

    model_path = art_dir / "model.pth"
    index_path = art_dir / "model.index"

    if not model_path.exists():
        url = artist["model_url"]
        if url.lower().endswith(".zip"):
            if not _download_zip(url, art_dir):
                raise RuntimeError(f"Could not download model zip for {artist_id}")
        else:
            if not _download(url, model_path):
                raise RuntimeError(f"Could not download model for {artist_id}")
            # legacy: separate index_url field
            if not index_path.exists() and artist.get("index_url"):
                _download(artist["index_url"], index_path)

    return model_path, index_path if index_path.exists() else None


# ── RVC inference via subprocess ──────────────────────────────────────────────

def convert_with_rvc(
    song_vocals: np.ndarray,
    artist_id: str,
    sr: int = 44100,
    pitch_shift: int = 0,
) -> np.ndarray:
    """
    Convert song_vocals to sound like the specified artist using RVC.

    Runs infer_rvc_python in a fresh subprocess to avoid native crashes
    that occur when PyTorch is loaded inside uvicorn's thread pool on macOS.

    Returns float32 mono array at sr, same length as song_vocals.
    """
    t0 = time.time()
    logger.info("[rvc] convert_with_rvc: artist=%s sr=%d shift=%d", artist_id, sr, pitch_shift)

    _ensure_hubert()
    model_path, _ = ensure_artist_model(artist_id)

    with tempfile.TemporaryDirectory(prefix="rvc_") as tmp:
        input_npy  = Path(tmp) / "input.npy"
        output_npy = Path(tmp) / "output.npy"

        np.save(str(input_npy), song_vocals.astype(np.float32))

        python = sys.executable

        print(f"[rvc] launching subprocess for artist={artist_id} …", flush=True)
        result = subprocess.run(
            [python, "-m", "backend.rvc_worker",
             str(model_path), str(input_npy), str(output_npy),
             str(sr), str(pitch_shift)],
            capture_output=False,
            timeout=900,
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"rvc_worker subprocess exited with code {result.returncode}"
            )

        out_audio = np.load(str(output_npy)).astype(np.float32)

    # Trim/pad to original length
    if out_audio.size > song_vocals.size:
        out_audio = out_audio[:song_vocals.size]
    elif out_audio.size < song_vocals.size:
        out_audio = np.pad(out_audio, (0, song_vocals.size - out_audio.size))

    logger.info("[rvc] inference done in %.1fs — output RMS=%.4f peak=%.4f",
                time.time() - t0,
                float(np.sqrt(np.mean(out_audio ** 2))),
                float(np.abs(out_audio).max()))

    return out_audio


def convert_with_rvc_modal(
    song_vocals: np.ndarray,
    artist_id: str,
    sr: int = 44100,
    pitch_shift: int = 0,
) -> np.ndarray:
    """Run RVC on Modal.com A10G GPU.

    Requires:
        1. modal setup          (one-time auth)
        2. modal deploy backend/rvc_modal.py   (deploys the GPU function)
        3. MASHUP_USE_MODAL=1 in .env
    """
    import modal

    artist = get_artist(artist_id)
    t0 = time.time()
    logger.info("[rvc/modal] submitting — artist=%s sr=%d shift=%d", artist_id, sr, pitch_shift)
    print(f"[rvc/modal] submitting to Modal GPU — artist={artist_id}", flush=True)

    # Look up the already-deployed Modal function by app + function name.
    fn = modal.Function.from_name("mashup-rvc", "run_rvc_inference")
    result_bytes = fn.remote(
        audio_bytes=song_vocals.astype(np.float32).tobytes(),
        model_url=artist["model_url"],
        artist_id=artist_id,
        sr=sr,
        pitch_shift=pitch_shift,
    )
    out = np.frombuffer(result_bytes, dtype=np.float32).copy()
    logger.info("[rvc/modal] done in %.1fs", time.time() - t0)
    return out


def convert_with_rvc_safe(
    song_vocals: np.ndarray,
    artist_id: str,
    sr: int = 44100,
    pitch_shift: int = 0,
) -> np.ndarray:
    """convert_with_rvc with full error handling; returns song_vocals on failure.

    If MASHUP_USE_MODAL=1 is set, tries Modal GPU first and falls back to local CPU.
    """
    import os

    if os.getenv("MASHUP_USE_MODAL"):
        try:
            return convert_with_rvc_modal(song_vocals, artist_id, sr=sr, pitch_shift=pitch_shift)
        except Exception as exc:
            logger.warning("[rvc] Modal failed (%s); falling back to local CPU", exc)
            print(f"[rvc] Modal FAILED ({exc}); trying local CPU …", flush=True)

    try:
        return convert_with_rvc(song_vocals, artist_id, sr=sr, pitch_shift=pitch_shift)
    except Exception as exc:
        logger.error("[rvc] Conversion failed (%s); returning original vocals", exc)
        print(f"[rvc] FALLBACK to original vocals: {exc}", flush=True)
        return song_vocals
