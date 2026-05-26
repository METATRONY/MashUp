"""
BPM detection and tempo-matching via librosa time-stretch.

Detects the tempo of a downloaded audio file and stretches all 9 stems
to a target BPM so tracks lock together in the final mix.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_STRETCH_SKIP_THRESHOLD = 0.02  # skip stretch if within 2% of target


def detect_bpm(wav_path: Path) -> float:
    """
    Estimate the BPM of an audio file using librosa beat tracking.
    Returns 120.0 on failure so the pipeline can continue gracefully.
    """
    try:
        import librosa

        y, sr = librosa.load(str(wav_path), sr=22050, mono=True, duration=60.0)
        tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo_arr)[0])
        if 30.0 < bpm < 300.0:
            logger.info("Detected BPM %.1f for %s", bpm, wav_path.name)
            return round(bpm, 1)
    except Exception as exc:
        logger.warning("BPM detection failed for %s: %s", wav_path.name, exc)
    return 120.0


def time_stretch_stems(
    stems: dict[str, np.ndarray],
    detected_bpm: float,
    target_bpm: float,
    sr: int = 44100,
) -> dict[str, np.ndarray]:
    """
    Stretch every stem from detected_bpm to target_bpm using librosa.

    Skips processing if:
    - Either BPM is invalid (<30 or >300)
    - The ratio is within _STRETCH_SKIP_THRESHOLD (avoids degrading near-matching tracks)

    Returns the original stems dict if stretching is skipped or fails.
    """
    if not (30.0 < detected_bpm < 300.0 and 30.0 < target_bpm < 300.0):
        return stems

    ratio = target_bpm / detected_bpm
    if abs(ratio - 1.0) < _STRETCH_SKIP_THRESHOLD:
        logger.info(
            "Skipping time-stretch: %.1f → %.1f BPM (ratio %.3f within threshold)",
            detected_bpm,
            target_bpm,
            ratio,
        )
        return stems

    try:
        import librosa

        logger.info(
            "Time-stretching %.1f → %.1f BPM (ratio %.3f) across %d stems",
            detected_bpm,
            target_bpm,
            ratio,
            len(stems),
        )
        stretched: dict[str, np.ndarray] = {}
        for name, audio in stems.items():
            if audio.size == 0:
                stretched[name] = audio
                continue
            # librosa.effects.time_stretch expects mono float32
            mono = audio.astype(np.float32)
            stretched[name] = librosa.effects.time_stretch(mono, rate=ratio)
        return stretched
    except Exception as exc:
        logger.warning("Time-stretch failed: %s — using original stems", exc)
        return stems
