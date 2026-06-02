"""
Singing voice conversion via STFT spectral envelope morphing.

Converts a song's vocal stem to sound like a user's voice while preserving
the original melody, lyrics, timing, and dynamics.

Approach: estimate the mean spectral envelope of both voices, compute their
ratio as a frequency-domain filter, apply to each STFT frame of the song
vocals, then ISTFT back to audio.  The original waveform phase is preserved,
so there are zero resynthesis artifacts (unlike WORLD/vocoder approaches which
break down on Demucs-separated stems at SNR ≈ −4 dB).

Main entry point: convert_voice_safe()
"""

from __future__ import annotations

import logging
import math

import numpy as np
from scipy import signal
from scipy.ndimage import uniform_filter1d
from scipy.ndimage import gaussian_filter1d

logger = logging.getLogger(__name__)

_MIN_VOICED_FRAMES = 10   # kept for legacy callers


# ── Resampling ────────────────────────────────────────────────────────────────

def _resample(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return audio
    g = math.gcd(src_sr, dst_sr)
    return signal.resample_poly(audio, dst_sr // g, src_sr // g).astype(np.float32)


# ── Spectral envelope estimation ──────────────────────────────────────────────

def _spectral_envelope(audio: np.ndarray, sr: int,
                        n_fft: int = 2048, hop: int = 512,
                        smooth_hz: float = 150.0) -> np.ndarray:
    """
    Mean log-magnitude spectrum of `audio`, smoothed to a coarse spectral
    envelope (captures formants, not individual harmonics).

    Returns a (n_fft//2 + 1,) array in linear (amplitude) scale.
    """
    nperseg  = n_fft
    noverlap = n_fft - hop
    _, _, Z = signal.stft(
        audio.astype(np.float64),
        fs=sr, nperseg=nperseg, noverlap=noverlap,
        window='hann', padded=True,
    )
    # Mean magnitude across all frames
    mag = np.mean(np.abs(Z), axis=1)            # (n_freqs,)
    log_mag = np.log(mag + 1e-8)

    # Gaussian smooth in frequency — bandwidth σ expressed in FFT bins
    sigma_bins = max(1.0, smooth_hz / (sr / n_fft))
    smoothed = gaussian_filter1d(log_mag, sigma=sigma_bins)

    return np.exp(smoothed).astype(np.float64)  # back to linear amplitude


# ── Envelope following ────────────────────────────────────────────────────────

def _envelope_follow(original: np.ndarray, converted: np.ndarray,
                     sr: int = 44100, win_secs: float = 0.4) -> np.ndarray:
    """
    Scale `converted` so its amplitude envelope matches `original` at the
    musical-phrase level (verse vs. chorus), not at the note-transient level.

    Window: 400 ms — tracks slow dynamic changes, ignores note-by-note peaks.
    Gain cap: 3× — prevents wild boosts in near-silent frames.
    Gain is smoothed a second time (200 ms) to remove zipper artefacts.
    """
    win  = max(1, int(win_secs * sr))
    win2 = max(1, int(0.2 * sr))

    orig_sq = original.astype(np.float64) ** 2
    conv_sq = converted.astype(np.float64) ** 2
    orig_env = np.sqrt(np.maximum(uniform_filter1d(orig_sq, size=win,  mode="reflect"), 0.0))
    conv_env = np.sqrt(np.maximum(uniform_filter1d(conv_sq, size=win,  mode="reflect"), 0.0))

    raw_gain = np.where(conv_env > 1e-6, np.clip(orig_env / (conv_env + 1e-16), 0.0, 3.0), 1.0)
    gain = uniform_filter1d(raw_gain, size=win2, mode="reflect")

    return (converted * gain).astype(np.float32)


# ── STFT voice morphing ───────────────────────────────────────────────────────

def _stft_morph(
    song_vocals: np.ndarray,
    user_voice: np.ndarray,
    song_sr: int = 44100,
    user_sr: int = 44100,
    morph_alpha: float = 1.0,
    n_fft: int = 2048,
    hop: int = 512,
) -> np.ndarray:
    """
    Apply a voice-identity filter derived from the spectral envelope ratio
    (user_env / song_env) to each STFT frame of `song_vocals`.

    The original waveform phase is preserved → no resynthesis artifacts.
    Only the magnitude envelope (formant structure / timbre) is modified.
    """
    nperseg  = n_fft
    noverlap = n_fft - hop

    # Resample user voice to song SR
    if user_sr != song_sr:
        user_resampled = _resample(user_voice, user_sr, song_sr)
    else:
        user_resampled = user_voice

    # Spectral envelopes (smoothed mean magnitude spectrum)
    song_env = _spectral_envelope(song_vocals, song_sr, n_fft=n_fft, hop=hop)
    user_env = _spectral_envelope(user_resampled, song_sr, n_fft=n_fft, hop=hop)

    # Morphing filter H = (user_env / song_env)^alpha, applied only in voice range
    bin_lo = max(1, int(80.0   / (song_sr / n_fft)))   # ~4 bins  — skip DC + sub-bass
    bin_hi = min(len(song_env) - 1, int(8000.0 / (song_sr / n_fft)))  # ~371 bins

    # Normalise each envelope to its in-range mean so the ratio captures shape,
    # not absolute level differences between a quiet user mic and a studio vocal.
    song_slice = song_env[bin_lo:bin_hi]
    user_slice = user_env[bin_lo:bin_hi]

    # Plain ratio — captures formant shape AND level difference.
    # Level difference is corrected downstream by _envelope_follow.
    # Mean normalization was tried but made the filter flat (H ≈ 1) because
    # 150 Hz-smoothed envelopes of two human voices have nearly equal shapes.
    ratio = user_slice / (song_slice + 1e-10)

    H_full = np.ones(len(song_env), dtype=np.float64)
    raw = np.power(ratio, morph_alpha)
    raw = np.where(np.isfinite(raw), raw, 1.0)
    H_full[bin_lo:bin_hi] = raw

    # Clamp to sane gain range so a divergent envelope doesn't blow up the signal
    H_full = np.clip(H_full, 0.1, 10.0)

    print(
        f"[voice_convert] Spectral envelopes (in-range): "
        f"song peak at {(np.argmax(song_env[bin_lo:bin_hi]) + bin_lo) * song_sr / n_fft:.0f} Hz  "
        f"user peak at {(np.argmax(user_env[bin_lo:bin_hi]) + bin_lo) * song_sr / n_fft:.0f} Hz  "
        f"H range [{H_full[bin_lo:bin_hi].min():.3f}, {H_full[bin_lo:bin_hi].max():.3f}]",
        flush=True,
    )

    # Apply filter to every STFT frame of the song vocals
    _, _, Z = signal.stft(
        song_vocals.astype(np.float64),
        fs=song_sr, nperseg=nperseg, noverlap=noverlap,
        window='hann', padded=True,
    )
    Z_morphed = Z * H_full[:, np.newaxis]

    _, converted = signal.istft(
        Z_morphed,
        fs=song_sr, nperseg=nperseg, noverlap=noverlap,
        window='hann',
    )
    return np.asarray(converted, dtype=np.float32)[:len(song_vocals)]


# ── Public API ────────────────────────────────────────────────────────────────

def convert_voice(
    song_vocals: np.ndarray,
    user_voice: np.ndarray,
    song_sr: int = 44100,
    user_sr: int = 44100,
    morph_alpha: float = 1.0,
    f0_scale: float = 1.0,   # kept for API compat; not used by STFT engine
) -> np.ndarray:
    """
    Convert song_vocals to sound like user_voice while preserving melody/timing.

    Args:
        song_vocals: mono float32 at song_sr — Demucs vocal stem
        user_voice:  mono float32 at user_sr — ~10-30s reference recording
        song_sr:     sample rate of song_vocals
        user_sr:     sample rate of user_voice
        morph_alpha: 0.0 = no change, 1.0 = full user voice identity

    Returns:
        float32 array at song_sr, same length as song_vocals
    """
    if song_vocals.size == 0 or float(np.sqrt(np.mean(song_vocals ** 2))) < 1e-5:
        raise ValueError("song_vocals is silent or empty")
    if user_voice.size == 0 or float(np.sqrt(np.mean(user_voice ** 2))) < 1e-5:
        raise ValueError("user_voice is silent or empty")
    if user_voice.size < user_sr:
        raise ValueError("user_voice too short — need at least 1 second")

    song_rms = float(np.sqrt(np.mean(song_vocals ** 2)))
    user_rms = float(np.sqrt(np.mean(user_voice ** 2)))
    print(
        f"[voice_convert] Input: song={song_vocals.size/song_sr:.1f}s RMS={song_rms:.4f}  "
        f"user={user_voice.size/user_sr:.1f}s RMS={user_rms:.4f}",
        flush=True,
    )

    # STFT spectral morphing — preserves original audio quality
    print("[voice_convert] STFT spectral morphing…", flush=True)
    converted = _stft_morph(song_vocals, user_voice, song_sr=song_sr, user_sr=user_sr,
                             morph_alpha=morph_alpha)

    # Match the original singer's phrase-level dynamics (verse / chorus)
    converted = _envelope_follow(song_vocals, converted, sr=song_sr)

    # Soft saturation — transparent below 0.8, smooth tanh knee to ±1.0
    knee = 0.8
    abs_c = np.abs(converted)
    over  = abs_c > knee
    converted[over] = (
        np.sign(converted[over])
        * (knee + (1.0 - knee) * np.tanh((abs_c[over] - knee) / (1.0 - knee)))
    )

    out_rms = float(np.sqrt(np.mean(converted ** 2)))
    print(
        f"[voice_convert] Done. Output RMS={out_rms:.4f}  "
        f"peak={float(np.abs(converted).max()):.4f}",
        flush=True,
    )
    return converted.astype(np.float32)


def convert_voice_safe(
    song_vocals: np.ndarray,
    user_voice: np.ndarray,
    song_sr: int = 44100,
    user_sr: int = 44100,
    morph_alpha: float = 1.0,
) -> np.ndarray:
    """
    convert_voice with full error handling.
    On any failure returns song_vocals unchanged so the pipeline never crashes.
    """
    try:
        return convert_voice(song_vocals, user_voice, song_sr=song_sr, user_sr=user_sr,
                             morph_alpha=morph_alpha)
    except Exception as exc:
        logger.warning("Voice conversion failed (%s); returning original vocals", exc)
        print(f"[voice_convert] FALLBACK to original vocals: {exc}", flush=True)
        return song_vocals
