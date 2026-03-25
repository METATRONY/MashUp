"""Run Demucs separation."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def run_demucs(wav_path: Path, out_root: Path) -> Path:
    out_root.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "demucs",
            "-n",
            "htdemucs",
            "-o",
            str(out_root),
            str(wav_path),
        ],
        check=True,
        timeout=3600,
    )
    htd = out_root / "htdemucs"
    if not htd.is_dir():
        raise FileNotFoundError(f"Demucs output missing: {htd}")
    # Folder name matches input basename without extension
    stem_name = wav_path.stem
    target = htd / stem_name
    if target.is_dir():
        return target
    for d in htd.iterdir():
        if d.is_dir():
            return d
    raise FileNotFoundError("Could not locate demucs stem folder")
