"""
Map Demucs 4 stems into 9 UI components using frequency splits on the "other" stem.
Approximate — documented for users.
"""

from __future__ import annotations

import numpy as np
from scipy import signal

from .constants import DEMUCS_STEMS


def load_wav_mono(path) -> tuple[np.ndarray, int]:
    import soundfile as sf

    y, sr = sf.read(path, always_2d=True)
    y = np.mean(y, axis=1).astype(np.float32)
    return y, int(sr)


def _lowpass(y: np.ndarray, sr: int, hz: float) -> np.ndarray:
    if hz >= sr / 2 - 1:
        return y.copy()
    sos = signal.butter(6, hz, btype="low", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, y).astype(np.float32)


def _highpass(y: np.ndarray, sr: int, hz: float) -> np.ndarray:
    sos = signal.butter(6, hz, btype="high", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, y).astype(np.float32)


def _bandpass(y: np.ndarray, sr: int, low: float, high: float) -> np.ndarray:
    high = min(high, sr / 2 - 1)
    if low >= high:
        return np.zeros_like(y)
    sos = signal.butter(6, [low, high], btype="band", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, y).astype(np.float32)


def pad_to(n: int, y: np.ndarray) -> np.ndarray:
    if len(y) >= n:
        return y[:n].copy()
    out = np.zeros(n, dtype=np.float32)
    out[: len(y)] = y
    return out


def build_nine_stems(stem_dir, sr_hint: int | None = None) -> dict[str, np.ndarray]:
    """
    stem_dir: directory containing drums.wav bass.wav other.wav vocals.wav
    """
    stems_raw: dict[str, np.ndarray] = {}
    sr = sr_hint or 44100

    for name in DEMUCS_STEMS:
        p = stem_dir / f"{name}.wav"
        if not p.exists():
            raise FileNotFoundError(f"Missing stem file: {p}")
        y, sr = load_wav_mono(p)
        stems_raw[name] = y

    lengths = [len(v) for v in stems_raw.values()]
    n = max(lengths)
    drums = pad_to(n, stems_raw["drums"])
    bass = pad_to(n, stems_raw["bass"])
    other = pad_to(n, stems_raw["other"])
    vocals = pad_to(n, stems_raw["vocals"])

    # Split "other" into five approximate layers (plus direct drum/bass/vocal maps).
    pads = _lowpass(other, sr, 380)
    harmony = _bandpass(other, sr, 380, 2200)
    melody = _bandpass(other, sr, 2200, 6500)
    fx = _highpass(other, sr, 6500)
    percussion = _bandpass(other, sr, 900, 4500)
    other_slot = _bandpass(other, sr, 200, 12000) * 0.35 + other.astype(np.float32) * 0.12

    return {
        "drums": drums,
        "bass": bass,
        "vocals": vocals,
        "melody": melody,
        "harmony": harmony,
        "pads": pads,
        "percussion": percussion,
        "fx": fx,
        "other": other_slot.astype(np.float32),
    }

