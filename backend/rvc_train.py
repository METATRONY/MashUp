"""
RVC voice model training orchestrator.

Entry point: launch_rvc_training(voice_id, job_id, n_epochs)

Collects all WAV clips from uploads/voices/{voice_id}/clips/,
concatenates them, submits to the Modal A10G training function,
and saves the returned model bytes to backend/models/rvc/user_{voice_id}/model.pth.

The Modal volume also gets the model (written inside run_rvc_training),
so subsequent GPU inference calls skip re-uploading.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)

_VOICES_DIR = Path(__file__).resolve().parent / "uploads" / "voices"
_MODEL_DIR  = Path(__file__).resolve().parent / "models" / "rvc"
_SR = 44100


def prepare_training_audio(voice_id: str) -> np.ndarray:
    """
    Concatenate all WAVs in uploads/voices/{voice_id}/clips/ into one float32 array.
    Returns mono audio at 44100 Hz. Raises FileNotFoundError if no clips exist.
    """
    clips_dir = _VOICES_DIR / voice_id / "clips"
    wavs = sorted(clips_dir.glob("clip_*.wav"))
    if not wavs:
        raise FileNotFoundError(f"No training clips found for voice_id={voice_id}")

    segments: list[np.ndarray] = []
    for wav_path in wavs:
        audio, sr = sf.read(str(wav_path), dtype="float32", always_2d=False)
        if audio.ndim == 2:
            audio = audio.mean(axis=1)
        if sr != _SR:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr, target_sr=_SR)
        segments.append(audio.astype(np.float32))

    combined = np.concatenate(segments)
    total_secs = len(combined) / _SR
    logger.info("[rvc_train] %d clips → %.1f s of training audio", len(wavs), total_secs)
    print(f"[rvc_train] {len(wavs)} clips, {total_secs:.1f}s total training audio", flush=True)
    return combined


def launch_rvc_training(voice_id: str, job_id: str, n_epochs: int = 100, name: str = "My Voice") -> None:
    """
    Background task: prepare training audio, dispatch to Modal GPU, save model locally.
    Writes job progress updates via set_job() so the frontend can poll status.
    """
    from .main import set_job

    def _progress(msg: str) -> None:
        set_job(job_id, {"status": "running", "progress": msg})
        print(f"[rvc_train] {job_id}: {msg}", flush=True)

    try:
        _progress("Preparing training audio…")
        audio = prepare_training_audio(voice_id)
        total_secs = len(audio) / _SR

        _progress(f"Submitting to Modal GPU ({total_secs:.0f}s of audio, {n_epochs} epochs)…")

        import modal
        fn = modal.Function.from_name("mashup-rvc", "run_rvc_training")
        t0 = time.time()

        model_bytes: bytes = fn.remote(
            audio_bytes=audio.astype(np.float32).tobytes(),
            voice_id=voice_id,
            sr=_SR,
            n_epochs=n_epochs,
        )

        elapsed = time.time() - t0
        _progress(f"Training complete ({elapsed:.0f}s). Saving model…")

        # Save the returned model bytes to local disk
        out_dir = _MODEL_DIR / f"user_{voice_id}"
        out_dir.mkdir(parents=True, exist_ok=True)
        model_path = out_dir / "model.pth"
        model_path.write_bytes(model_bytes)
        (out_dir / "name.txt").write_text(name)
        logger.info("[rvc_train] model saved to %s (%d bytes)", model_path, len(model_bytes))
        print(f"[rvc_train] model saved → {model_path} ({len(model_bytes) / 1e6:.1f} MB)", flush=True)

        set_job(job_id, {
            "status": "done",
            "progress": "Model ready!",
            "voice_id": voice_id,
        })

    except Exception as exc:
        logger.exception("[rvc_train] training failed for %s", voice_id)
        print(f"[rvc_train] FAILED: {exc}", flush=True)
        set_job(job_id, {"status": "error", "error": str(exc)})
