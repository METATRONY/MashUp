"""
Chord progression extraction using librosa chroma features.

Estimates the nearest major/minor chord per beat segment from an audio file.
Runs as a post-download step in the mashup pipeline.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Major and minor chord templates (12-dimensional chroma vectors)
_MAJOR_TEMPLATE = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]
_MINOR_TEMPLATE = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _build_templates() -> list[tuple[str, list[float]]]:
    """Build 24 chord templates (12 major + 12 minor) by rotating the base templates."""
    templates: list[tuple[str, list[float]]] = []
    for i, name in enumerate(NOTE_NAMES):
        major = _MAJOR_TEMPLATE[i:] + _MAJOR_TEMPLATE[:i]
        minor = _MINOR_TEMPLATE[i:] + _MINOR_TEMPLATE[:i]
        templates.append((f"{name}maj", major))
        templates.append((f"{name}min", minor))
    return templates


_TEMPLATES = _build_templates()


def _nearest_chord(chroma: "list[float]") -> str:
    """Return the chord name whose template best matches the given chroma vector."""
    import numpy as np

    c = np.array(chroma, dtype=float)
    norm = np.linalg.norm(c)
    if norm < 1e-6:
        return "N"
    c = c / norm

    best_score = -1.0
    best_name = "N"
    for name, template in _TEMPLATES:
        t = np.array(template, dtype=float)
        t = t / np.linalg.norm(t)
        score = float(np.dot(c, t))
        if score > best_score:
            best_score = score
            best_name = name
    return best_name


def extract_chords(wav_path: Path, sr: int = 22050, hop_length: int = 512) -> list[dict]:
    """
    Analyse a WAV file and return a list of chord estimates over time.

    Each entry: {"time_sec": float, "chord": str}
    Chords are estimated per beat using chroma energy.

    Returns an empty list if librosa is unavailable or the file cannot be read.
    """
    try:
        import librosa
        import numpy as np
    except ImportError:
        logger.warning("librosa not installed; skipping chord analysis")
        return []

    try:
        y, sr_loaded = librosa.load(str(wav_path), sr=sr, mono=True)
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr_loaded, hop_length=hop_length)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr_loaded, hop_length=hop_length)

        chroma = librosa.feature.chroma_cqt(y=y, sr=sr_loaded, hop_length=hop_length)

        chords: list[dict] = []
        for i, beat_frame in enumerate(beat_frames):
            end_frame = beat_frames[i + 1] if i + 1 < len(beat_frames) else chroma.shape[1]
            segment_chroma = chroma[:, beat_frame:end_frame].mean(axis=1)
            chord_name = _nearest_chord(segment_chroma.tolist())
            chords.append({"time_sec": round(float(beat_times[i]), 3), "chord": chord_name})

        # Deduplicate consecutive identical chords for compactness
        deduped: list[dict] = []
        for entry in chords:
            if not deduped or deduped[-1]["chord"] != entry["chord"]:
                deduped.append(entry)

        return deduped
    except Exception as exc:
        logger.warning("Chord extraction failed: %s", exc)
        return []
