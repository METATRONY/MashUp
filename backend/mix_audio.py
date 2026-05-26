"""Assemble final mix from per-track stem dictionaries."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .constants import COMPONENT_IDS, VALID_COMPONENTS

_TARGET_RMS = 0.08       # per-track RMS target before summing
_FADE_IN_SEC = 0.5       # seconds of linear fade-in on final mix
_FADE_OUT_SEC = 1.0      # seconds of linear fade-out on final mix
_SR = 44100


def _rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)) + 1e-9)


def _normalize_rms(audio: np.ndarray, target: float = _TARGET_RMS) -> np.ndarray:
    """Scale audio so its RMS matches target."""
    current = _rms(audio)
    return (audio.astype(np.float64) * (target / current))


def _apply_fades(mix: np.ndarray, sr: int) -> np.ndarray:
    """Apply linear fade-in and fade-out to the mix."""
    fade_in = int(sr * _FADE_IN_SEC)
    fade_out = int(sr * _FADE_OUT_SEC)
    n = len(mix)

    if fade_in > 0 and n > fade_in:
        mix[:fade_in] *= np.linspace(0.0, 1.0, fade_in)

    if fade_out > 0 and n > fade_out:
        mix[-fade_out:] *= np.linspace(1.0, 0.0, fade_out)

    return mix


def assemble_mix(
    track_inputs: list[dict],
) -> tuple[np.ndarray, int]:
    """
    track_inputs: each dict has keys:
      components (list[str]), stems (dict id -> ndarray), volume (float), muted (bool)

    Each track's active stems are RMS-normalised before summing so louder
    recordings don't overpower quieter ones. The final mix gets fade-in/out.
    Returns (mono_float32, sample_rate).
    """
    owner: dict[str, dict] = {}
    for t in track_inputs:
        if t.get("muted"):
            continue
        for c in t.get("components") or []:
            if c not in VALID_COMPONENTS:
                continue
            if c in owner:
                raise ValueError(f"Duplicate component claim: {c}")
            owner[c] = t

    max_len = 0
    sr = _SR
    for c in COMPONENT_IDS:
        if c not in owner:
            continue
        y = owner[c]["stems"][c]
        max_len = max(max_len, len(y))

    if max_len == 0:
        return np.zeros(_SR, dtype=np.float32), sr

    # Per-track RMS normalisation: compute a scale factor per track using
    # all its active stems combined, then apply it consistently.
    track_scales: dict[int, float] = {}
    for t in track_inputs:
        if t.get("muted"):
            continue
        tid = id(t)
        active_components = [c for c in (t.get("components") or []) if c in owner and owner[c] is t]
        if not active_components:
            continue
        # Combine active stems into a single signal to estimate loudness
        combined = np.zeros(max_len, dtype=np.float64)
        for c in active_components:
            y = t["stems"][c].astype(np.float64)
            if len(y) < max_len:
                y = np.pad(y, (0, max_len - len(y)))
            else:
                y = y[:max_len]
            combined += y
        current_rms = _rms(combined)
        track_scales[tid] = _TARGET_RMS / current_rms

    mix = np.zeros(max_len, dtype=np.float64)
    for c in COMPONENT_IDS:
        if c not in owner:
            continue
        t = owner[c]
        vol = float(t.get("volume", 1.0))
        scale = track_scales.get(id(t), 1.0)
        y = t["stems"][c].astype(np.float64)
        if len(y) < max_len:
            y = np.pad(y, (0, max_len - len(y)))
        else:
            y = y[:max_len]
        mix += y * scale * vol

    mix = _apply_fades(mix, sr)

    peak = np.max(np.abs(mix)) + 1e-9
    if peak > 1.0:
        mix /= peak
    mix *= 0.98
    return mix.astype(np.float32), sr


def write_wav(path: Path, y: np.ndarray, sr: int = _SR) -> None:
    sf.write(str(path), y, sr, subtype="PCM_16")


def wav_to_mp3(wav_path: Path, mp3_path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            "-codec:a",
            "libmp3lame",
            "-qscale:a",
            "2",
            str(mp3_path),
        ],
        check=True,
        timeout=600,
    )
