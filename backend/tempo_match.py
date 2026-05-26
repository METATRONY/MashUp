"""
BPM detection, tempo-matching, and pitch-shifting via Rubber Band Library.

Applies time-stretch (to target BPM) and pitch-shift (to match key) using
pyrubberband, which wraps the high-quality Rubber Band Library. Falls back
to librosa if pyrubberband is unavailable.

Hard limits enforced:
  - Time-stretch: ≤ 15% BPM difference (beyond this, audio distorts noticeably)
  - Pitch-shift:  ≤ 2 semitones (beyond this, vocals sound unnatural)
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_STRETCH_SKIP_THRESHOLD = 0.02   # skip stretch if within 2% of target
_MAX_STRETCH_PCT = 0.15          # hard limit: >15% stretch degrades audio quality
_MAX_PITCH_SEMITONES = 2         # hard limit: >2 semitones of pitch shift sounds unnatural


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


def _rubberband_stretch(audio: np.ndarray, sr: int, ratio: float) -> np.ndarray:
    """Time-stretch using Rubber Band Library (high quality). Ratio > 1 = faster."""
    import pyrubberband as rb
    return rb.time_stretch(audio, sr, ratio)


def _librosa_stretch(audio: np.ndarray, ratio: float) -> np.ndarray:
    """Librosa fallback for time-stretch."""
    import librosa
    return librosa.effects.time_stretch(audio.astype(np.float32), rate=ratio)


def time_stretch_stems(
    stems: dict[str, np.ndarray],
    detected_bpm: float,
    target_bpm: float,
    sr: int = 44100,
) -> dict[str, np.ndarray]:
    """
    Stretch every stem from detected_bpm to target_bpm.

    Uses Rubber Band Library (pyrubberband) for high-quality stretching,
    falls back to librosa if unavailable.

    Enforces a hard 15% limit — returns original stems unchanged if the
    required stretch would exceed this threshold to avoid audible distortion.
    """
    if not (30.0 < detected_bpm < 300.0 and 30.0 < target_bpm < 300.0):
        return stems

    ratio = target_bpm / detected_bpm
    stretch_pct = abs(ratio - 1.0)

    if stretch_pct < _STRETCH_SKIP_THRESHOLD:
        logger.info(
            "Skipping time-stretch: %.1f → %.1f BPM (within 2%% threshold)",
            detected_bpm, target_bpm,
        )
        return stems

    if stretch_pct > _MAX_STRETCH_PCT:
        logger.warning(
            "Time-stretch %.1f → %.1f BPM requires %.0f%% stretch — exceeds 15%% quality limit, skipping",
            detected_bpm, target_bpm, stretch_pct * 100,
        )
        return stems

    logger.info(
        "Time-stretching %.1f → %.1f BPM (%.0f%%) across %d stems",
        detected_bpm, target_bpm, stretch_pct * 100, len(stems),
    )

    stretched: dict[str, np.ndarray] = {}
    for name, audio in stems.items():
        if audio.size == 0:
            stretched[name] = audio
            continue
        mono = audio.astype(np.float32)
        try:
            stretched[name] = _rubberband_stretch(mono, sr, ratio)
        except ImportError:
            stretched[name] = _librosa_stretch(mono, ratio)
        except Exception as exc:
            logger.warning("Time-stretch failed for stem %s: %s", name, exc)
            stretched[name] = mono
    return stretched


def semitone_distance(key1: int, key2: int) -> int:
    """
    Minimal signed semitone distance from key1 to key2 (both 0-11, Spotify integers).
    Returns a value in [-6, 6] — positive means shift up, negative means shift down.
    """
    raw = (key2 - key1) % 12
    return raw if raw <= 6 else raw - 12


def pitch_shift_stems(
    stems: dict[str, np.ndarray],
    semitones: float,
    sr: int = 44100,
) -> dict[str, np.ndarray]:
    """
    Pitch-shift every stem by the given number of semitones.

    Uses Rubber Band Library for high quality. Enforces ±2 semitone hard limit
    to prevent unnatural-sounding vocals. Returns original stems if limit exceeded
    or if no library is available.

    Args:
        stems: stem name → mono float32 array
        semitones: amount to shift (positive = up, negative = down)
        sr: sample rate of the audio

    Returns:
        Dict of pitch-shifted stems (or originals on limit violation / error).
    """
    if semitones == 0:
        return stems

    if abs(semitones) > _MAX_PITCH_SEMITONES:
        logger.warning(
            "Pitch shift of %.1f semitones exceeds ±2 quality limit — skipping",
            semitones,
        )
        return stems

    logger.info("Pitch-shifting %d stems by %+.1f semitones", len(stems), semitones)

    shifted: dict[str, np.ndarray] = {}
    for name, audio in stems.items():
        if audio.size == 0:
            shifted[name] = audio
            continue
        mono = audio.astype(np.float32)
        try:
            import pyrubberband as rb
            shifted[name] = rb.pitch_shift(mono, sr, semitones)
        except ImportError:
            try:
                import librosa
                shifted[name] = librosa.effects.pitch_shift(mono, sr=sr, n_steps=semitones)
            except Exception as exc:
                logger.warning("Pitch shift failed for stem %s (librosa): %s", name, exc)
                shifted[name] = mono
        except Exception as exc:
            logger.warning("Pitch shift failed for stem %s: %s", name, exc)
            shifted[name] = mono
    return shifted
