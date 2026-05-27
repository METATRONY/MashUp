"""Run Demucs separation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def run_demucs(wav_path: Path, out_root: Path, model: str = "htdemucs") -> Path:
    out_root.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            model,
            "-o",
            str(out_root),
            str(wav_path),
        ],
        check=False,
        timeout=3600,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        output = ((result.stderr or "") + "\n" + (result.stdout or "")).strip()
        if "No module named 'torchcodec'" in output or "TorchCodec is required" in output:
            raise RuntimeError(
                "Demucs failed: missing dependency 'torchcodec'. "
                "Run: .venv/bin/pip install torchcodec"
            )
        tail = "\n".join([line for line in output.splitlines() if line.strip()][-20:])
        raise RuntimeError(
            f"Demucs failed with exit code {result.returncode}.\n{tail}"
        )

    htd = out_root / model
    if not htd.is_dir():
        raise FileNotFoundError(f"Demucs output missing: {htd}")
    stem_name = wav_path.stem
    target = htd / stem_name
    if target.is_dir():
        return target
    for d in htd.iterdir():
        if d.is_dir():
            return d
    raise FileNotFoundError("Could not locate demucs stem folder")
