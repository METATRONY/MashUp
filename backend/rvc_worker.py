"""
Standalone RVC worker — called as a subprocess by rvc_infer.py.

Usage:
    python -m backend.rvc_worker <model_pth> <input_npy> <output_npy> <sr> <pitch_shift>

Reads float32 mono audio from <input_npy>, runs RVC with the given model,
writes float32 mono audio to <output_npy>, exits 0 on success.
"""
import sys
import numpy as np


def main():
    if len(sys.argv) != 6:
        print("Usage: rvc_worker <model_pth> <input_npy> <output_npy> <sr> <pitch_shift>", file=sys.stderr)
        sys.exit(1)

    model_pth, input_npy, output_npy, sr_str, pitch_str = sys.argv[1:]
    sr = int(sr_str)
    pitch_shift = int(pitch_str)

    # Patch torch.load to use weights_only=False BEFORE fairseq imports it.
    # PyTorch 2.6 changed the default to weights_only=True, which breaks
    # fairseq's checkpoint loading (uses pickle with custom classes).
    import torch
    _orig_torch_load = torch.load
    def _patched_load(*args, **kwargs):
        kwargs.setdefault('weights_only', False)
        return _orig_torch_load(*args, **kwargs)
    torch.load = _patched_load

    from infer_rvc_python.main import BaseLoader
    from pathlib import Path

    base_dir = Path(__file__).resolve().parent / "models" / "base"

    audio = np.load(input_npy).astype(np.float32)
    print(f"[rvc_worker] input: {len(audio)} samples at {sr} Hz, shift={pitch_shift:+d}", flush=True)

    rmvpe_path = base_dir / "rmvpe.pt"

    loader = BaseLoader(
        only_cpu=True,
        hubert_path=str(base_dir / "hubert_base.pt"),
        rmvpe_path=str(rmvpe_path) if rmvpe_path.exists() else None,
    )
    loader.apply_conf(
        tag="artist",
        file_model=model_pth,
        pitch_algo="rmvpe" if rmvpe_path.exists() else "harvest",
        pitch_lvl=pitch_shift,
        file_index="",
        index_influence=0.75,
        respiration_median_filtering=3,
        envelope_ratio=0.25,
        consonant_breath_protection=0.33,
        resample_sr=0,
    )

    # rmvpe/harvest require a file path (not an in-memory array)
    import soundfile as sf
    import os
    wav_tmp = output_npy.replace(".npy", "_input.wav")
    sf.write(wav_tmp, audio, sr)
    result = loader.generate_from_cache(audio_data=wav_tmp, tag="artist")
    os.unlink(wav_tmp)

    if isinstance(result, tuple):
        out_audio, out_sr = result
    else:
        out_audio, out_sr = result[0], sr

    out_audio = np.asarray(out_audio, dtype=np.float32)

    # infer_rvc_python returns int16-scale audio (multiplied by 32768).
    # Normalise back to float32 [-1, 1] so the caller can mix it directly.
    if np.abs(out_audio).max() > 1.0:
        out_audio = out_audio / 32768.0

    # Resample if needed
    if out_sr != sr:
        import librosa
        out_audio = librosa.resample(out_audio, orig_sr=out_sr, target_sr=sr)

    # Trim/pad to original length
    if out_audio.size > audio.size:
        out_audio = out_audio[:audio.size]
    elif out_audio.size < audio.size:
        out_audio = np.pad(out_audio, (0, audio.size - out_audio.size))

    np.save(output_npy, out_audio)
    print(f"[rvc_worker] done — rms={float(np.sqrt(np.mean(out_audio**2))):.4f}", flush=True)


if __name__ == "__main__":
    main()
