"""Assemble final mix from per-track stem dictionaries."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .constants import COMPONENT_IDS, VALID_COMPONENTS


def assemble_mix(
    track_inputs: list[dict],
) -> tuple[np.ndarray, int]:
    """
    track_inputs: each dict has keys: components (list[str]), stems (dict id -> ndarray), volume (float), muted (bool)
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
    sr = 44100
    for c in COMPONENT_IDS:
        if c not in owner:
            continue
        t = owner[c]
        y = t["stems"][c]
        max_len = max(max_len, len(y))

    if max_len == 0:
        return np.zeros(44100, dtype=np.float32), sr

    mix = np.zeros(max_len, dtype=np.float64)
    for c in COMPONENT_IDS:
        if c not in owner:
            continue
        t = owner[c]
        vol = float(t.get("volume", 1.0))
        y = t["stems"][c].astype(np.float64)
        if len(y) < max_len:
            y = np.pad(y, (0, max_len - len(y)))
        else:
            y = y[:max_len]
        mix += y * vol

    peak = np.max(np.abs(mix)) + 1e-9
    if peak > 1.0:
        mix /= peak
    mix *= 0.98
    return mix.astype(np.float32), sr


def write_wav(path: Path, y: np.ndarray, sr: int = 44100) -> None:
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
