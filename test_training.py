"""
Quick CLI test for run_rvc_training — bypasses the web UI entirely.
Usage:  .venv/bin/python test_training.py [audio_file] [n_epochs]

Defaults to the first .webm in the ai_interviews folder, 3 epochs.
"""
import sys
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

INTERVIEWS_DIR = Path("/Users/ehudriesenberg/Downloads/Yaacov_Riesenberg/ai_interviews")
SR = 44100
VOICE_ID = "debug_test"


def load_audio(path: Path) -> np.ndarray:
    """Convert any format to float32 mono via ffmpeg then soundfile."""
    if path.suffix.lower() != ".wav":
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            wav_path = f.name
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(path), "-ar", str(SR), "-ac", "1", wav_path],
            check=True, capture_output=True,
        )
        audio, _ = sf.read(wav_path, dtype="float32")
        Path(wav_path).unlink(missing_ok=True)
    else:
        audio, sr_in = sf.read(str(path), dtype="float32", always_2d=False)
        if audio.ndim == 2:
            audio = audio.mean(axis=1)
        if sr_in != SR:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr_in, target_sr=SR)
    return audio.astype(np.float32)


def main():
    audio_arg = sys.argv[1] if len(sys.argv) > 1 else None
    n_epochs  = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    if audio_arg:
        src_files = [Path(audio_arg)]
    else:
        src_files = sorted(INTERVIEWS_DIR.glob("*.webm"))[:10]  # use up to 10 files
        if not src_files:
            raise SystemExit(f"No .webm files in {INTERVIEWS_DIR}")
        print(f"No file specified — concatenating {len(src_files)} files for training data")

    segments = []
    for src in src_files:
        print(f"  Loading {src.name} …")
        segments.append(load_audio(src))
    audio = np.concatenate(segments)
    print(f"Audio: {len(audio)/SR:.1f}s  ({len(audio)} samples)")

    audio_bytes = audio.tobytes()
    print(f"Bytes: {len(audio_bytes):,}")

    print(f"\nCalling run_rvc_training.remote(voice_id={VOICE_ID!r}, n_epochs={n_epochs}) …\n")

    import modal
    fn = modal.Function.from_name("mashup-rvc", "run_rvc_training")
    try:
        model_bytes: bytes = fn.remote(
            audio_bytes=audio_bytes,
            voice_id=VOICE_ID,
            sr=SR,
            n_epochs=n_epochs,
        )
        out = Path(f"/tmp/test_model_{VOICE_ID}.pth")
        out.write_bytes(model_bytes)
        print(f"\n✅  Training succeeded!  Model: {out}  ({len(model_bytes)/1e6:.1f} MB)")
    except Exception as e:
        print(f"\n❌  Training failed:\n{e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
