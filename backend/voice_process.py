"""
Voice upload processing: convert any audio format to a mono 44100 Hz WAV,
pitch-shift to match the song's key, and fit to the target stem length.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)

try:
    from . import voice_convert as _vc
    _HAS_WORLD = True
except Exception:
    _vc = None  # type: ignore[assignment]
    _HAS_WORLD = False

VOICES_DIR = Path(__file__).resolve().parent / "uploads" / "voices"
VOICES_DIR.mkdir(parents=True, exist_ok=True)


def append_training_clip(voice_id: str, data: bytes, original_filename: str) -> tuple[Path, int]:
    """
    Save an audio clip to uploads/voices/{voice_id}/clips/clip_N.wav.
    Creates the clips/ dir if needed. Returns (wav_path, clip_index).
    """
    clips_dir = VOICES_DIR / voice_id / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    existing = sorted(clips_dir.glob("clip_*.wav"))
    clip_idx = len(existing)

    ext = Path(original_filename).suffix.lower() or ".bin"
    raw_path = clips_dir / f"clip_{clip_idx}{ext}"
    raw_path.write_bytes(data)

    wav_path = clips_dir / f"clip_{clip_idx}.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(raw_path),
         "-ac", "1", "-ar", str(_SR), "-acodec", "pcm_f32le", str(wav_path)],
        check=True, timeout=120,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if raw_path != wav_path:
        raw_path.unlink(missing_ok=True)

    return wav_path, clip_idx

_SR = 44100
_TARGET_RMS = 0.08   # match assemble_mix normalization target


def save_voice_upload(voice_id: str, file_bytes: bytes, original_filename: str) -> Path:
    """
    Write raw upload bytes to disk and convert to mono 44100 Hz WAV.
    Returns path to VOICES_DIR/<voice_id>/voice.wav.
    """
    voice_dir = VOICES_DIR / voice_id
    voice_dir.mkdir(parents=True, exist_ok=True)

    ext = Path(original_filename).suffix.lower() or ".bin"
    raw_path = voice_dir / f"original{ext}"
    raw_path.write_bytes(file_bytes)

    wav_path = voice_dir / "voice.wav"
    subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", str(raw_path),
            "-ac", "1",
            "-ar", str(_SR),
            "-acodec", "pcm_f32le",
            str(wav_path),
        ],
        check=True,
        timeout=120,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return wav_path


def load_voice_as_array(voice_wav: Path) -> np.ndarray:
    """Load voice.wav as mono float32 numpy array at 44100 Hz."""
    audio, sr = sf.read(str(voice_wav), dtype="float32", always_2d=False)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if sr != _SR:
        try:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr, target_sr=_SR)
        except Exception as exc:
            logger.warning("Voice resample failed: %s", exc)
    return audio.astype(np.float32)


def fit_voice_to_length(voice: np.ndarray, target_samples: int, sr: int = _SR) -> np.ndarray:
    """
    Trim voice to target_samples if longer.
    Loop+crossfade if shorter (0.1s crossfade between repetitions).
    """
    if voice.size == 0:
        return np.zeros(target_samples, dtype=np.float32)

    if voice.size >= target_samples:
        return voice[:target_samples].copy()

    fade_len = min(int(0.1 * sr), voice.size // 4)
    fade_out = np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
    fade_in  = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)

    result = voice.copy()
    while result.size < target_samples:
        tail = result[-fade_len:] * fade_out
        head = voice[:fade_len] * fade_in
        xfade = tail + head
        chunk = np.concatenate([result[:-fade_len], xfade, voice[fade_len:]])
        result = np.concatenate([result, chunk])

    return result[:target_samples].copy()


def prepare_voice_stem(
    voice_id: str,
    work_dir: Path,
    target_samples: int,
    semitones: float = 0.0,
    song_vocals: np.ndarray | None = None,
    morph_alpha: float = 1.0,
) -> np.ndarray:
    """
    Full voice preparation. When song_vocals is provided, uses STFT spectral
    envelope morphing to preserve the song's melody and lyric timing while
    applying the user's voice timbre. Falls back to loop+pitch-shift if
    voice_convert is unavailable.

    Raises FileNotFoundError if voice_id not found.
    """
    voice_wav = VOICES_DIR / voice_id / "voice.wav"
    if not voice_wav.exists():
        raise FileNotFoundError(f"Voice file not found for voice_id={voice_id}")

    user_audio = load_voice_as_array(voice_wav)

    # ── Voice conversion path (STFT spectral morphing) ────────────────────────
    if song_vocals is not None and _HAS_WORLD and _vc is not None:
        print("[voice] STFT spectral morphing voice conversion", flush=True)
        converted = _vc.convert_voice_safe(
            song_vocals=song_vocals,
            user_voice=user_audio,
            song_sr=_SR,
            user_sr=_SR,
            morph_alpha=morph_alpha,
        )
        # voice_convert already runs _envelope_follow (preserves verse/chorus
        # dynamics) and tanh soft saturation — do NOT renormalize or hard-clip here
        # Trim/pad to exactly target_samples
        if converted.size >= target_samples:
            return converted[:target_samples].copy()
        return np.pad(converted, (0, target_samples - converted.size)).astype(np.float32)

    # ── Fallback: loop + pitch-shift raw recording ─────────────────────────────
    audio = user_audio
    if semitones != 0.0:
        try:
            import pyrubberband as rb
            audio = rb.pitch_shift(audio, _SR, semitones, rbargs=["--formant"])
        except ImportError:
            try:
                import librosa
                audio = librosa.effects.pitch_shift(audio, sr=_SR, n_steps=semitones)
            except Exception as exc:
                logger.warning("Voice pitch shift failed (librosa): %s", exc)
        except Exception as exc:
            logger.warning("Voice pitch shift failed: %s", exc)

    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms > 1e-6:
        audio = audio * (_TARGET_RMS / rms)

    audio = np.clip(audio, -1.0, 1.0).astype(np.float32)
    return fit_voice_to_length(audio, target_samples)
