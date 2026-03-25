"""Download best audio from YouTube via yt-dlp with network fallbacks."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


PROXY_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)


def _run(cmd: list[str], timeout: int, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        cmd,
        timeout=timeout,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    output = (result.stdout or "").strip()
    if result.returncode == 0:
        return output
    if len(output) > 6000:
        output = output[-6000:]
    raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(cmd)}\n{output}")


def download_youtube_audio(video_id: str, dest_dir: Path) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    url = f"https://www.youtube.com/watch?v={video_id}"
    pattern = str(dest_dir / f"{video_id}.%(ext)s")

    # Base invocation shared by all network strategies.
    base_cmd = [
        "yt-dlp",
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "--extractor-retries",
        "3",
        "--retries",
        "3",
        "--no-progress",
        "-o",
        pattern,
        url,
    ]

    # Strategy A: use environment as-is (works in networks that require proxy).
    # Strategy B: force direct connection with proxies disabled (works when proxy blocks YouTube).
    env_as_is = os.environ.copy()
    env_no_proxy = os.environ.copy()
    for key in PROXY_KEYS:
        env_no_proxy.pop(key, None)

    attempts: list[tuple[str, list[str], dict[str, str]]] = [
        (
            "env+android-web-client",
            base_cmd + ["--extractor-args", "youtube:player_client=android,web"],
            env_as_is,
        ),
        (
            "env+ios-android-client",
            base_cmd + ["--extractor-args", "youtube:player_client=ios,android"],
            env_as_is,
        ),
        (
            "env+cookies-chrome",
            base_cmd + ["--cookies-from-browser", "chrome"],
            env_as_is,
        ),
        (
            "env+cookies-safari",
            base_cmd + ["--cookies-from-browser", "safari"],
            env_as_is,
        ),
        (
            "force-direct+android-web-client",
            base_cmd + ["--extractor-args", "youtube:player_client=android,web", "--proxy", ""],
            env_no_proxy,
        ),
        (
            "force-direct+cookies-chrome",
            base_cmd + ["--cookies-from-browser", "chrome", "--proxy", ""],
            env_no_proxy,
        ),
    ]

    errors: list[str] = []
    for label, cmd, env in attempts:
        try:
            _run(cmd, timeout=900, env=env)
            break
        except Exception as e:
            errors.append(f"[{label}] {e}")
    else:
        raise RuntimeError(
            "yt-dlp failed for all network strategies.\n" + "\n\n".join(errors)
        )

    candidates = sorted(
        [p for p in dest_dir.glob(f"{video_id}.*") if p.suffix.lower() != ".part"],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not candidates:
        raise FileNotFoundError(f"No file downloaded for {video_id}")
    src = candidates[0]
    if src.suffix.lower() == ".wav":
        return src
    wav = dest_dir / f"{video_id}.wav"
    _run(["ffmpeg", "-y", "-i", str(src), "-ac", "2", "-ar", "44100", str(wav)], timeout=600)
    return wav
