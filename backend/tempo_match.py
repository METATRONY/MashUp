"""
BPM detection, key detection, tempo-matching, and pitch-shifting via Rubber Band Library.

Applies time-stretch (to target BPM) and pitch-shift (to match key) using
pyrubberband, which wraps the high-quality Rubber Band Library. Falls back
to librosa if pyrubberband is unavailable.

Hard limits enforced:
  - Time-stretch: ≤ 15% BPM difference (beyond this, audio distorts noticeably)
  - Pitch-shift:  ≤ 6 semitones (half an octave; beyond this, timbre distorts badly)
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

_STRETCH_SKIP_THRESHOLD = 0.02   # skip stretch if within 2% of target
_MAX_STRETCH_PCT = 0.15          # hard limit: >15% stretch degrades audio quality
_MAX_PITCH_SEMITONES = 6         # raised from 2: ±6 st = half octave, still acceptable
_VOCAL_STEMS = {"vocals"}
_VOCAL_PITCH_LIMIT = 2.0         # vocals degrade above ±2 st without formant preservation


def detect_bpm(wav_path: Path) -> float:
    """
    Estimate the BPM of an audio file using librosa beat tracking.
    Returns 120.0 on failure so the pipeline can continue gracefully.
    """
    try:
        import librosa

        y, sr = librosa.load(str(wav_path), sr=22050, mono=True, duration=60.0)
        tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo_arr)[0])
        if 30.0 < bpm < 300.0:
            logger.info("Detected BPM %.1f for %s", bpm, wav_path.name)
            return round(bpm, 1)
    except Exception as exc:
        logger.warning("BPM detection failed for %s: %s", wav_path.name, exc)
    return 120.0


def detect_key_from_audio(wav_path: Path) -> tuple[int | None, int | None]:
    """
    Detect musical key using chromagram analysis (Krumhansl-Schmuckler algorithm).

    Returns (key, mode) in Spotify format: key 0-11 (C=0 … B=11), mode 1=major / 0=minor.
    Returns (None, None) on any failure so callers can fall back gracefully.
    """
    # Krumhansl-Kessler 1990 key-profile templates, C-rooted (indices 0-11 = C…B)
    _MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
                       2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    _MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
                       2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    try:
        import librosa

        y, sr = librosa.load(str(wav_path), sr=22050, mono=True, duration=60.0)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)   # (12, n_frames)
        profile = chroma.mean(axis=1)                       # energy per pitch class

        # Z-score normalise both profiles and the input
        def _norm(v: np.ndarray) -> np.ndarray:
            std = v.std()
            return (v - v.mean()) / (std if std > 0 else 1.0)

        profile_n = _norm(profile)
        major_n = _norm(_MAJOR)
        minor_n = _norm(_MINOR)

        best_score = -np.inf
        best_key = 0
        best_mode = 1

        for k in range(12):
            # Rotate the template so it applies to key k (C+k semitones)
            maj_score = float(np.dot(profile_n, np.roll(major_n, k)))
            min_score = float(np.dot(profile_n, np.roll(minor_n, k)))
            if maj_score > best_score:
                best_score, best_key, best_mode = maj_score, k, 1
            if min_score > best_score:
                best_score, best_key, best_mode = min_score, k, 0

        logger.info(
            "Chromagram key for %s: %d (%s)",
            wav_path.name, best_key, "major" if best_mode else "minor",
        )
        return best_key, best_mode

    except Exception as exc:
        logger.warning("Key detection failed for %s: %s", wav_path.name, exc)
        return None, None


def _rubberband_stretch(audio: np.ndarray, sr: int, ratio: float) -> np.ndarray:
    """Time-stretch using Rubber Band Library (high quality). Ratio > 1 = faster."""
    import pyrubberband as rb
    return rb.time_stretch(audio, sr, ratio)


def _librosa_stretch(audio: np.ndarray, ratio: float) -> np.ndarray:
    """Librosa fallback for time-stretch."""
    import librosa
    return librosa.effects.time_stretch(audio.astype(np.float32), rate=ratio)


def time_stretch_stems(
    stems: dict[str, np.ndarray],
    detected_bpm: float,
    target_bpm: float,
    sr: int = 44100,
) -> dict[str, np.ndarray]:
    """
    Stretch every stem from detected_bpm to target_bpm.

    Uses Rubber Band Library (pyrubberband) for high-quality stretching,
    falls back to librosa if unavailable.

    Enforces a hard 15% limit — returns original stems unchanged if the
    required stretch would exceed this threshold to avoid audible distortion.
    """
    if not (30.0 < detected_bpm < 300.0 and 30.0 < target_bpm < 300.0):
        return stems

    ratio = target_bpm / detected_bpm
    stretch_pct = abs(ratio - 1.0)

    if stretch_pct < _STRETCH_SKIP_THRESHOLD:
        logger.info(
            "Skipping time-stretch: %.1f → %.1f BPM (within 2%% threshold)",
            detected_bpm, target_bpm,
        )
        return stems

    if stretch_pct > _MAX_STRETCH_PCT:
        logger.warning(
            "Time-stretch %.1f → %.1f BPM requires %.0f%% stretch — exceeds 15%% quality limit, skipping",
            detected_bpm, target_bpm, stretch_pct * 100,
        )
        return stems

    logger.info(
        "Time-stretching %.1f → %.1f BPM (%.0f%%) across %d stems",
        detected_bpm, target_bpm, stretch_pct * 100, len(stems),
    )

    stretched: dict[str, np.ndarray] = {}
    for name, audio in stems.items():
        if audio.size == 0:
            stretched[name] = audio
            continue
        mono = audio.astype(np.float32)
        try:
            stretched[name] = _rubberband_stretch(mono, sr, ratio)
        except ImportError:
            stretched[name] = _librosa_stretch(mono, ratio)
        except Exception as exc:
            logger.warning("Time-stretch failed for stem %s: %s", name, exc)
            stretched[name] = mono
    return stretched


def find_first_beat_offset(stems: dict[str, np.ndarray], sr: int = 44100) -> int:
    """
    Return the sample index of the first detected beat.
    Always sums all stems so rhythm is detected even when drums are absent
    early in the track (e.g. a long piano intro before drums enter).
    Returns 0 on failure.
    """
    try:
        import librosa

        parts = [s.astype(np.float32) for s in stems.values() if s.size > 0]
        if not parts:
            return 0
        max_len = max(len(p) for p in parts)
        audio = np.zeros(max_len, dtype=np.float32)
        for p in parts:
            audio[:len(p)] += p

        analysis_sr = 22050
        audio_down = librosa.resample(audio, orig_sr=sr, target_sr=analysis_sr)
        _, beat_frames = librosa.beat.beat_track(y=audio_down, sr=analysis_sr)
        if len(beat_frames) == 0:
            return 0
        first_beat_sec = float(librosa.frames_to_time(beat_frames[0], sr=analysis_sr))
        offset = int(first_beat_sec * sr)
        logger.info("First beat offset: %d samples (%.3f s)", offset, first_beat_sec)
        return offset
    except Exception as exc:
        logger.warning("Beat offset detection failed: %s", exc)
        return 0


def beat_align_tracks(
    track_stems_list: list[dict[str, np.ndarray]],
    target_bpm: float,
    sr: int = 44100,
) -> list[dict[str, np.ndarray]]:
    """
    Phase-align all tracks within one beat period.

    Since every track has already been stretched to target_bpm, the beat
    period T is identical for all. We compute each track's beat phase
    (first_beat_offset % T) and trim the start by at most T samples so
    every track's beats land on the same grid.

    Maximum trim: T = 60/target_bpm seconds (e.g. ~0.75 s at 80 BPM).
    This avoids chopping long intros or adding seconds of silence — contrast
    with aligning on the raw first-beat offset which caused 13 s of silence
    when one song had a piano intro before the drums entered.
    """
    beat_period = int(round(sr * 60.0 / target_bpm))
    abs_offsets = [find_first_beat_offset(stems, sr) for stems in track_stems_list]
    phases = [off % beat_period for off in abs_offsets]
    ref_phase = phases[0]

    logger.info(
        "Beat alignment: period=%d samples (%.3f s), phases=%s",
        beat_period, beat_period / sr, [f"{p / sr:.3f}s" for p in phases],
    )

    aligned: list[dict[str, np.ndarray]] = []
    for stems, phase in zip(track_stems_list, phases):
        trim = (phase - ref_phase) % beat_period
        if trim == 0:
            aligned.append(stems)
        else:
            logger.info("Beat-aligning: trimming %d samples (%.3f s)", trim, trim / sr)
            aligned.append({
                name: audio[trim:].copy() if audio.size > trim else audio
                for name, audio in stems.items()
            })
    return aligned


def find_best_entry_point(
    exit_drums: np.ndarray,
    entry_stems: dict[str, np.ndarray],
    exit_offset: int,
    beat_samples: int,
    min_remaining: int,
    sr: int = 44100,
    window_bars: int = 4,
) -> int:
    """
    Find the sample offset in the entering track whose rhythmic content best
    matches the exit window of the outgoing track.

    Both tracks are already BPM-matched (time-stretched), so their onset
    envelopes share the same beat period — cross-correlation at beat resolution
    is directly meaningful.

    exit_drums:   drum stem of the outgoing track (full array, already stretched)
    entry_stems:  9-stem dict of the incoming track
    exit_offset:  sample in exit_drums where the crossfade begins
    beat_samples: samples per beat at target BPM
    min_remaining: the entry offset + min_remaining must fit in the incoming track
    window_bars:  how many bars to use as the correlation template (default 4)

    Returns the best sample offset to start the incoming track, snapped to a
    beat boundary. Falls back to 0 on any error.
    """
    try:
        import librosa

        hop = 512  # ~86 frames/sec at 44100 Hz — beat-resolution sufficient

        # ── Template: last window_bars bars of the outgoing drum stem ──────
        window_samples = window_bars * beat_samples
        tmpl_start = max(0, exit_offset - window_samples)
        template_audio = exit_drums[tmpl_start:exit_offset].astype(np.float32)
        if template_audio.size < hop:
            return 0

        onset_tmpl = librosa.onset.onset_strength(y=template_audio, sr=sr, hop_length=hop)
        onset_tmpl = onset_tmpl - onset_tmpl.mean()

        # ── Search signal: drum stem of the incoming track ──────────────────
        entry_drums = entry_stems.get("drums", np.zeros(1, dtype=np.float32))
        if entry_drums.size < min_remaining:
            return 0  # track too short — fall back to 0

        onset_entry = librosa.onset.onset_strength(
            y=entry_drums.astype(np.float32), sr=sr, hop_length=hop
        )
        onset_entry = onset_entry - onset_entry.mean()

        if len(onset_entry) <= len(onset_tmpl):
            return 0  # search space is empty

        # ── Cross-correlation (valid mode: slide template over full track) ──
        corr = np.correlate(onset_entry, onset_tmpl, mode="valid")

        # Constrain: the entry point must leave at least min_remaining samples
        max_valid_frame = max(1, (len(entry_drums) - min_remaining) // hop)
        if max_valid_frame < len(corr):
            corr[max_valid_frame:] = -np.inf

        best_frame = int(np.argmax(corr))
        best_sample = best_frame * hop

        # Snap to nearest beat boundary
        snapped = int(round(best_sample / beat_samples)) * beat_samples
        # Final clamp
        snapped = max(0, min(snapped, max(0, len(entry_drums) - min_remaining)))

        logger.info(
            "DJ entry: best frame=%d → %d samples (%.2f s), snapped to %d (%.2f s)",
            best_frame, best_sample, best_sample / sr, snapped, snapped / sr,
        )
        return snapped

    except Exception as exc:
        logger.warning("find_best_entry_point failed, using offset 0: %s", exc)
        return 0


def find_best_transition(
    current_drums: np.ndarray,
    current_start: int,
    incoming_drums: np.ndarray,
    incoming_min_start: int,
    beat_samples: int,
    min_segment: int,
    sr: int = 44100,
    window_bars: int = 4,
    search_step_bars: int = 4,
    max_search_bars: int = 64,
) -> tuple[int, int]:
    """
    Find the best (exit_sample, entry_sample) pair for an auto DJ transition.

    Scans candidate exit frames every search_step_bars bars from
    current_start + min_segment and cross-correlates the outgoing drum onset
    envelope with the incoming drum onset envelope. Both tracks must already be
    BPM-matched. Returns the exit/entry pair that maximises correlation score,
    snapped to beat boundaries. Falls back to (current_start + min_segment,
    incoming_min_start) on any error.
    """
    try:
        import librosa

        hop = 512
        beats_per_bar = 4

        window_samples = window_bars * beats_per_bar * beat_samples
        window_frames = max(1, window_samples // hop)
        step_frames = max(1, search_step_bars * beats_per_bar * beat_samples // hop)

        onset_curr = librosa.onset.onset_strength(
            y=current_drums.astype(np.float32), sr=sr, hop_length=hop
        )
        onset_curr -= onset_curr.mean()

        onset_inc = librosa.onset.onset_strength(
            y=incoming_drums.astype(np.float32), sr=sr, hop_length=hop
        )
        onset_inc -= onset_inc.mean()

        min_exit_frame = (current_start + min_segment) // hop + window_frames
        max_exit_frame = min(
            min_exit_frame + max_search_bars * beats_per_bar * beat_samples // hop,
            len(onset_curr) - 1,
        )

        if min_exit_frame > max_exit_frame or onset_inc.size <= window_frames:
            return current_start + min_segment, incoming_min_start

        min_entry_frame = incoming_min_start // hop
        max_entry_frame = max(1, (len(incoming_drums) - min_segment) // hop)

        best_score = -np.inf
        best_exit = current_start + min_segment
        best_entry = incoming_min_start

        for exit_frame in range(min_exit_frame, max_exit_frame + 1, step_frames):
            tmpl_start = max(0, exit_frame - window_frames)
            template = onset_curr[tmpl_start:exit_frame].copy()
            if template.size == 0:
                continue
            if template.size < window_frames:
                template = np.pad(template, (window_frames - template.size, 0))

            if onset_inc.size <= template.size:
                continue

            corr = np.correlate(onset_inc, template, mode="valid")

            if min_entry_frame > 0 and min_entry_frame < len(corr):
                corr[:min_entry_frame] = -np.inf
            if max_entry_frame < len(corr):
                corr[max_entry_frame:] = -np.inf
            if np.all(np.isneginf(corr)):
                continue

            best_j = int(np.argmax(corr))
            score = float(corr[best_j])

            if score > best_score:
                best_score = score
                raw_exit = exit_frame * hop
                snapped_exit = int(round(raw_exit / beat_samples)) * beat_samples
                snapped_exit = max(current_start + min_segment, snapped_exit)

                raw_entry = best_j * hop
                snapped_entry = int(round(raw_entry / beat_samples)) * beat_samples
                snapped_entry = max(incoming_min_start, snapped_entry)

                best_exit = snapped_exit
                best_entry = snapped_entry

        logger.info(
            "find_best_transition: exit=%d (%.2fs) entry=%d (%.2fs) score=%.3f",
            best_exit, best_exit / sr, best_entry, best_entry / sr, best_score,
        )
        return best_exit, best_entry

    except Exception as exc:
        logger.warning("find_best_transition failed: %s", exc)
        return current_start + min_segment, incoming_min_start


def semitone_distance(key1: int, key2: int) -> int:
    """
    Minimal signed semitone distance from key1 to key2 (both 0-11, Spotify integers).
    Returns a value in [-6, 6] — positive means shift up, negative means shift down.
    """
    raw = (key2 - key1) % 12
    return raw if raw <= 6 else raw - 12


def pitch_shift_stems(
    stems: dict[str, np.ndarray],
    semitones: float,
    sr: int = 44100,
    stem_limits: dict[str, float] | None = None,
) -> dict[str, np.ndarray]:
    """
    Pitch-shift every stem by the given number of semitones, with per-stem limits.

    Per-stem limits applied when stem_limits is None (auto-defaults):
      - Vocal stems ("vocals"): capped at ±2 st; Rubber Band --formant flag applied
        to preserve the vocal tract character during pitch transposition.
      - Instrument stems: capped at ±6 st (_MAX_PITCH_SEMITONES).

    Stems whose individual limit would be exceeded are returned unshifted rather
    than skipping the whole batch.

    Args:
        stems: stem name → mono float32 array
        semitones: amount to shift (positive = up, negative = down)
        sr: sample rate of the audio
        stem_limits: override per-stem limits (stem name → max abs semitones)

    Returns:
        Dict of pitch-shifted stems (unshifted stems passed through on limit/error).
    """
    if semitones == 0:
        return stems

    default_limits: dict[str, float] = {
        name: (_VOCAL_PITCH_LIMIT if name in _VOCAL_STEMS else _MAX_PITCH_SEMITONES)
        for name in stems
    }
    limits = stem_limits if stem_limits is not None else default_limits

    logger.info("Pitch-shifting %d stems by %+.1f semitones", len(stems), semitones)

    shifted: dict[str, np.ndarray] = {}
    for name, audio in stems.items():
        limit = limits.get(name, _MAX_PITCH_SEMITONES)
        if abs(semitones) > limit:
            logger.info(
                "Stem '%s': shift %+.1f st exceeds limit ±%.1f st — passing through unshifted",
                name, semitones, limit,
            )
            shifted[name] = audio
            continue

        if audio.size == 0:
            shifted[name] = audio
            continue

        mono = audio.astype(np.float32)
        use_formant = name in _VOCAL_STEMS
        try:
            import pyrubberband as rb
            rbargs = ["--formant"] if use_formant else []
            shifted[name] = rb.pitch_shift(mono, sr, semitones, rbargs=rbargs)
        except ImportError:
            try:
                import librosa
                shifted[name] = librosa.effects.pitch_shift(mono, sr=sr, n_steps=semitones)
            except Exception as exc:
                logger.warning("Pitch shift failed for stem %s (librosa): %s", name, exc)
                shifted[name] = mono
        except Exception as exc:
            logger.warning("Pitch shift failed for stem %s: %s", name, exc)
            shifted[name] = mono
    return shifted
