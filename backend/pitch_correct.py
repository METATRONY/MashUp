"""
Karaoke pitch correction (autotune) against the original song's vocal melody.

Entry point: correct_karaoke_pitch(video_id, user_audio, sr, strength)

Algorithm:
  1. Load the song's separated vocal stem from the stem cache (Demucs output).
  2. Extract F0 contour from both reference and user recording via librosa.pyin.
  3. Compute per-frame semitone delta (ref_f0 / user_f0), voiced frames only.
  4. Smooth deltas (median filter + Gaussian), clamp to ±12 st, scale by strength.
  5. Apply per-chunk pyrubberband pitch shift with Hann overlap-add crossfade.
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_SR = 44100
_HOP = 512          # pyin hop length (≈11.6 ms per frame)
_CHUNK = 4096       # correction chunk size in samples (≈93 ms)
_CHUNK_HOP = 2048   # 50% overlap


def _extract_f0(audio: np.ndarray, sr: int = _SR) -> tuple[np.ndarray, np.ndarray]:
    """Return (f0_hz, voiced_flag) arrays via librosa.pyin."""
    import librosa
    f0, voiced_flag, _ = librosa.pyin(
        audio.astype(np.float32),
        fmin=65.0,
        fmax=1100.0,
        sr=sr,
        hop_length=_HOP,
        fill_na=0.0,
    )
    return f0.astype(np.float32), voiced_flag.astype(bool)


def _smooth_deltas(deltas: np.ndarray) -> np.ndarray:
    """Median filter then Gaussian smooth the per-frame semitone delta array."""
    from scipy.ndimage import median_filter, gaussian_filter1d
    smoothed = median_filter(deltas, size=11)   # ≈128 ms window
    smoothed = gaussian_filter1d(smoothed, sigma=3)
    return np.clip(smoothed, -12.0, 12.0)


def _apply_correction(
    audio: np.ndarray,
    deltas: np.ndarray,
    sr: int = _SR,
    strength: float = 0.8,
) -> np.ndarray:
    """
    Apply per-chunk pitch shifting using pyrubberband.
    Each chunk maps to a window of the delta array; if the mean delta is
    negligible (< 0.1 st) or zero (unvoiced), the chunk is passed through.
    Chunks are overlap-added with a 50% Hann window to avoid discontinuities.
    """
    import pyrubberband as rb

    n = len(audio)
    output = np.zeros(n, dtype=np.float32)
    window = np.hanning(_CHUNK).astype(np.float32)
    norm = np.zeros(n, dtype=np.float32)

    for start in range(0, n, _CHUNK_HOP):
        end = min(start + _CHUNK, n)
        chunk = audio[start:end]
        if len(chunk) < 64:
            break

        # Map chunk to F0 frame range
        frame_start = start * len(deltas) // n
        frame_end   = end   * len(deltas) // n
        if frame_end <= frame_start:
            frame_end = frame_start + 1
        mean_delta = float(np.mean(deltas[frame_start:min(frame_end, len(deltas))]))
        mean_delta *= strength

        if abs(mean_delta) > 0.1:
            try:
                chunk_shifted = rb.pitch_shift(
                    chunk, sr=sr, n_steps=mean_delta,
                    rbargs={"--formant": None},
                )
                chunk_shifted = chunk_shifted[:len(chunk)]
            except Exception as exc:
                logger.warning("pyrubberband pitch_shift failed: %s", exc)
                chunk_shifted = chunk
        else:
            chunk_shifted = chunk

        chunk_shifted = chunk_shifted.astype(np.float32)
        w = window[:len(chunk_shifted)]
        output[start:start + len(chunk_shifted)] += chunk_shifted * w
        norm[start:start + len(chunk_shifted)] += w

    # Avoid division by zero for tails
    safe_norm = np.where(norm > 1e-6, norm, 1.0)
    output /= safe_norm

    return np.clip(output, -1.0, 1.0).astype(np.float32)


def correct_karaoke_pitch(
    video_id: str,
    user_audio: np.ndarray,
    sr: int = _SR,
    strength: float = 0.8,
) -> np.ndarray:
    """
    Pitch-correct user_audio against the original song's vocal stem.

    Loads the reference vocal stem from the stem cache (Demucs htdemucs).
    If no cached stem is found, returns user_audio unchanged.
    """
    from .stem_cache import load as stem_cache_load

    # Load reference vocal stem from Demucs cache
    try:
        cached = stem_cache_load(video_id, "htdemucs")
        if cached is None:
            raise ValueError("stem cache miss")
        stems, _bpm, _keys = cached
        ref_vocals = stems.get("vocals")
        if ref_vocals is None or ref_vocals.size == 0:
            raise ValueError("vocals stem empty")
    except Exception as exc:
        logger.warning("[pitch_correct] could not load ref vocals for %s: %s", video_id, exc)
        print(f"[pitch_correct] no reference stem — returning original recording", flush=True)
        return user_audio

    # High-pass both signals to remove bass bleed before pitch extraction
    try:
        from scipy.signal import butter, sosfilt
        sos = butter(4, 80.0 / (sr / 2), btype="high", output="sos")
        ref_hp  = sosfilt(sos, ref_vocals).astype(np.float32)
        user_hp = sosfilt(sos, user_audio).astype(np.float32)
    except Exception:
        ref_hp  = ref_vocals
        user_hp = user_audio

    # Extract pitch curves
    ref_f0,  ref_voiced  = _extract_f0(ref_hp,  sr)
    user_f0, user_voiced = _extract_f0(user_hp, sr)

    # Align to the shorter of the two (user may have recorded less than the full song)
    n_frames = min(len(ref_f0), len(user_f0))
    ref_f0   = ref_f0[:n_frames]
    ref_voiced  = ref_voiced[:n_frames]
    user_f0  = user_f0[:n_frames]
    user_voiced = user_voiced[:n_frames]

    # Compute per-frame semitone delta (only where both are voiced)
    deltas = np.zeros(n_frames, dtype=np.float32)
    both_voiced = ref_voiced & user_voiced & (ref_f0 > 0) & (user_f0 > 0)
    if both_voiced.any():
        deltas[both_voiced] = 12.0 * np.log2(
            ref_f0[both_voiced] / user_f0[both_voiced]
        ).astype(np.float32)

    deltas = _smooth_deltas(deltas)

    voiced_pct = both_voiced.mean() * 100
    mean_shift = float(np.mean(np.abs(deltas[both_voiced]))) if both_voiced.any() else 0.0
    print(
        f"[pitch_correct] voiced={voiced_pct:.0f}%  mean_delta={mean_shift:.2f}st",
        flush=True,
    )

    # Trim user_audio to match frame coverage, then apply correction
    max_samples = min(len(user_audio), n_frames * _HOP)
    user_trimmed = user_audio[:max_samples]
    corrected = _apply_correction(user_trimmed, deltas, sr=sr, strength=strength)

    # Pad/trim back to original user length
    if corrected.size < len(user_audio):
        corrected = np.pad(corrected, (0, len(user_audio) - corrected.size))
    else:
        corrected = corrected[:len(user_audio)]

    return corrected.astype(np.float32)
