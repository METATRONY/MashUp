"""Assemble final mix from per-track stem dictionaries."""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .constants import COMPONENT_IDS, VALID_COMPONENTS
from .mapping import _highpass
from .tempo_match import find_best_entry_point, find_best_transition

_TARGET_RMS = 0.08       # per-track RMS target (default / fallback)
# Components whose low-end should be kept intact; all others get high-passed
_KEEP_LOW_END = {"bass", "drums"}

# Per-component loudness targets — louder for rhythmic anchors, quieter for
# atmospheric layers so pads don't overpower the mix.
_COMPONENT_RMS = {
    "drums":      0.10,
    "bass":       0.10,
    "vocals":     0.09,
    "melody":     0.08,
    "percussion": 0.08,
    "harmony":    0.07,
    "other":      0.07,
    "pads":       0.06,
    "fx":         0.05,
}
_FADE_IN_SEC = 0.5       # seconds of linear fade-in on final mix
_FADE_OUT_SEC = 1.0      # seconds of linear fade-out on final mix
_SR = 44100


def _rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)) + 1e-9)


def _normalize_rms(audio: np.ndarray, target: float = _TARGET_RMS) -> np.ndarray:
    """Scale audio so its RMS matches target."""
    current = _rms(audio)
    return (audio.astype(np.float64) * (target / current))


def _apply_fades(mix: np.ndarray, sr: int) -> np.ndarray:
    """Apply linear fade-in and fade-out to the mix."""
    fade_in = int(sr * _FADE_IN_SEC)
    fade_out = int(sr * _FADE_OUT_SEC)
    n = len(mix)

    if fade_in > 0 and n > fade_in:
        mix[:fade_in] *= np.linspace(0.0, 1.0, fade_in)

    if fade_out > 0 and n > fade_out:
        mix[-fade_out:] *= np.linspace(1.0, 0.0, fade_out)

    return mix


def assemble_mix(
    track_inputs: list[dict],
) -> tuple[np.ndarray, int]:
    """
    track_inputs: each dict has keys:
      components (list[str]), stems (dict id -> ndarray), volume (float), muted (bool)

    Each track's active stems are RMS-normalised before summing so louder
    recordings don't overpower quieter ones. The final mix gets fade-in/out.
    Returns (mono_float32, sample_rate).
    """
    owner: dict[str, dict] = {}
    for t in track_inputs:
        if t.get("muted"):
            continue
        for c in t.get("components") or []:
            if c not in VALID_COMPONENTS:
                continue
            if c in owner:
                raise ValueError(f"Duplicate component claim: {c}")
            owner[c] = t

    max_len = 0
    sr = _SR
    for c in COMPONENT_IDS:
        if c not in owner:
            continue
        y = owner[c]["stems"][c]
        max_len = max(max_len, len(y))

    if max_len == 0:
        return np.zeros(_SR, dtype=np.float32), sr

    # Per-track RMS normalisation: compute a scale factor per track using
    # all its active stems combined. Target RMS is the average of the per-component
    # targets so quieter components (pads, fx) don't get boosted to drum level.
    track_scales: dict[int, float] = {}
    for t in track_inputs:
        if t.get("muted"):
            continue
        tid = id(t)
        active_components = [c for c in (t.get("components") or []) if c in owner and owner[c] is t]
        if not active_components:
            continue
        # Combine active stems into a single signal to estimate loudness
        combined = np.zeros(max_len, dtype=np.float64)
        for c in active_components:
            y = t["stems"][c].astype(np.float64)
            if len(y) < max_len:
                y = np.pad(y, (0, max_len - len(y)))
            else:
                y = y[:max_len]
            combined += y
        current_rms = _rms(combined)
        target_rms = sum(_COMPONENT_RMS.get(c, _TARGET_RMS) for c in active_components) / len(active_components)
        track_scales[tid] = target_rms / current_rms

    mix = np.zeros(max_len, dtype=np.float64)
    for c in COMPONENT_IDS:
        if c not in owner:
            continue
        t = owner[c]
        vol = float(t.get("volume", 1.0))
        scale = track_scales.get(id(t), 1.0)
        y = t["stems"][c].astype(np.float64)
        if len(y) < max_len:
            y = np.pad(y, (0, max_len - len(y)))
        else:
            y = y[:max_len]
        # High-pass at 100 Hz to remove low-frequency mud from non-bass components
        if c not in _KEEP_LOW_END:
            y = _highpass(y.astype(np.float32), sr, 100.0).astype(np.float64)
        mix += y * scale * vol

    mix = _apply_fades(mix, sr)

    peak = np.max(np.abs(mix)) + 1e-9
    if peak > 1.0:
        mix /= peak
    mix *= 0.98
    return mix.astype(np.float32), sr


def build_dj_mix(
    track_inputs: list[dict],
    segment_duration: float,
    crossfade_duration: float,
    target_bpm: float,
    master_volume: float = 0.8,
    sr: int = _SR,
    auto_timing: bool = False,
    n_swaps: int = 4,
) -> tuple[np.ndarray, int]:
    """
    Sequential DJ mix: each track plays for segment_duration seconds, with a
    crossfade_duration-second linear crossfade between tracks. Segment boundaries
    are snapped to beat boundaries so cuts are always on the beat.

    track_inputs: same shape as assemble_mix — {stems, volume, muted}.
    All stems from each track are summed (DJ mode doesn't use component claims).
    """
    # Beat-snap segment length so every cut lands on a beat
    beat_samples = max(1, int(60.0 / max(target_bpm, 1.0) * sr))
    beats_per_seg = max(4, round(segment_duration * target_bpm / 60.0))
    seg_samples = beats_per_seg * beat_samples
    cf_samples = min(int(crossfade_duration * sr), seg_samples // 2)

    # Build a mono mix per track (all stems summed, RMS-normalised)
    track_audio: list[np.ndarray] = []
    for t in track_inputs:
        if t.get("muted"):
            track_audio.append(np.zeros(seg_samples, dtype=np.float64))
            continue
        stems = t.get("stems") or {}
        vol = float(t.get("volume", 1.0))
        if not stems:
            track_audio.append(np.zeros(seg_samples, dtype=np.float64))
            continue
        max_stem = max(len(v) for v in stems.values())
        combined = np.zeros(max_stem, dtype=np.float64)
        for v in stems.values():
            arr = v.astype(np.float64)
            if len(arr) < max_stem:
                arr = np.pad(arr, (0, max_stem - len(arr)))
            combined += arr
        combined = _normalize_rms(combined) * vol
        track_audio.append(combined)

    n = len(track_audio)

    # ── Auto-timing: find transition points via correlation, back-and-forth ──
    if auto_timing and n >= 2:
        min_seg_samples = 8 * 4 * beat_samples  # 8 bars minimum per segment

        # plan entries: (track_index, start_sample, duration_samples)
        plan: list[tuple[int, int, int]] = []
        track_cursors = [0] * n
        current_idx = 0

        for swap in range(n_swaps):
            next_idx = (current_idx + 1) % n
            curr_drums = track_inputs[current_idx]["stems"].get("drums", np.zeros(1, dtype=np.float32))
            next_drums = track_inputs[next_idx]["stems"].get("drums", np.zeros(1, dtype=np.float32))

            exit_s, entry_s = find_best_transition(
                current_drums=curr_drums,
                current_start=track_cursors[current_idx],
                incoming_drums=next_drums,
                incoming_min_start=track_cursors[next_idx],
                beat_samples=beat_samples,
                min_segment=min_seg_samples,
                sr=sr,
            )

            duration = exit_s - track_cursors[current_idx]
            if duration <= 0:
                duration = min_seg_samples
                exit_s = track_cursors[current_idx] + min_seg_samples

            plan.append((current_idx, track_cursors[current_idx], duration))
            track_cursors[current_idx] = exit_s
            track_cursors[next_idx] = entry_s
            current_idx = next_idx

        # Final segment: play from cursor to end of current track
        final_audio = track_audio[current_idx]
        final_start = track_cursors[current_idx]
        final_dur = max(min_seg_samples, len(final_audio) - final_start)
        plan.append((current_idx, final_start, final_dur))

        # Resolve actual durations (clamp to available audio)
        actual_durs: list[int] = []
        for t_idx, t_start, t_dur in plan:
            avail = max(0, len(track_audio[t_idx]) - t_start)
            actual_durs.append(min(t_dur, avail) if avail > 0 else t_dur)

        n_xfades = len(plan) - 1
        out_len = max(sr, sum(actual_durs) - cf_samples * n_xfades)
        output = np.zeros(out_len, dtype=np.float64)

        fade_in_ramp = np.linspace(0.0, 1.0, cf_samples) if cf_samples > 0 else np.ones(0)
        fade_out_ramp = np.linspace(1.0, 0.0, cf_samples) if cf_samples > 0 else np.ones(0)

        write_pos = 0
        for i, (t_idx, t_start, _) in enumerate(plan):
            dur = actual_durs[i]
            audio = track_audio[t_idx]
            sliced = audio[t_start : t_start + dur]
            if len(sliced) < dur:
                sliced = np.pad(sliced, (0, dur - len(sliced)))
            segment = sliced.copy()

            if i > 0 and cf_samples > 0 and len(segment) >= cf_samples:
                segment[:cf_samples] *= fade_in_ramp
            if i < n_xfades and cf_samples > 0 and len(segment) >= cf_samples:
                segment[-cf_samples:] *= fade_out_ramp

            end_pos = write_pos + dur
            if end_pos > out_len:
                segment = segment[:out_len - write_pos]
                end_pos = out_len
            output[write_pos:end_pos] += segment

            if i < n_xfades:
                write_pos += dur - cf_samples
            else:
                write_pos += dur

        output *= master_volume * 0.98
        output = _apply_fades(output, sr)
        peak = np.max(np.abs(output)) + 1e-9
        if peak > 1.0:
            output /= peak
        return output.astype(np.float32), sr

    # ── Find the best entry offset for each track via beat-level correlation ──
    # Track 0 always starts at 0. For each subsequent track, cross-correlate the
    # drum onset envelope of the exiting track (at its exit point) against the
    # drum stem of the entering track to find the most rhythmically similar cue.
    entry_offsets: list[int] = [0]
    for i in range(1, n):
        prev_stems = track_inputs[i - 1].get("stems") or {}
        curr_stems = track_inputs[i].get("stems") or {}
        prev_drums = prev_stems.get("drums", np.zeros(1, dtype=np.float32))
        # Exit point = where the previous track's segment ends (from its own offset)
        exit_offset = min(entry_offsets[i - 1] + seg_samples, len(prev_drums))
        offset = find_best_entry_point(
            exit_drums=prev_drums,
            entry_stems=curr_stems,
            exit_offset=exit_offset,
            beat_samples=beat_samples,
            min_remaining=seg_samples,
            sr=sr,
        )
        entry_offsets.append(offset)

    # Output length with overlapping crossfades
    out_len = seg_samples + (n - 1) * (seg_samples - cf_samples)
    output = np.zeros(out_len, dtype=np.float64)

    fade_in_ramp = np.linspace(0.0, 1.0, cf_samples)
    fade_out_ramp = np.linspace(1.0, 0.0, cf_samples)

    for i, audio in enumerate(track_audio):
        start = i * (seg_samples - cf_samples)
        # Slice from the best entry offset found by correlation
        offset = entry_offsets[i]
        sliced = audio[offset : offset + seg_samples] if len(audio) > offset else audio
        if len(sliced) < seg_samples:
            sliced = np.pad(sliced, (0, seg_samples - len(sliced)))
        segment = sliced.copy()

        # Fade-in at the start of this segment (all tracks except the first)
        if i > 0:
            segment[:cf_samples] *= fade_in_ramp

        # Fade-out at the end (all tracks except the last)
        if i < n - 1:
            segment[-cf_samples:] *= fade_out_ramp

        end = start + seg_samples
        if end > out_len:
            segment = segment[:out_len - start]
            end = out_len
        output[start:end] += segment

    output *= master_volume * 0.98
    output = _apply_fades(output, sr)
    peak = np.max(np.abs(output)) + 1e-9
    if peak > 1.0:
        output /= peak
    return output.astype(np.float32), sr


def write_wav(path: Path, y: np.ndarray, sr: int = _SR) -> None:
    sf.write(str(path), y, sr, subtype="PCM_16")


def wav_to_mp3(wav_path: Path, mp3_path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_path),
            "-codec:a",
            "libmp3lame",
            "-qscale:a",
            "2",
            str(mp3_path),
        ],
        check=True,
        timeout=600,
    )
