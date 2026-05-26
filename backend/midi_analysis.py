"""
Monophonic melody transcription using librosa pyin + mido.

Extracts the dominant pitch contour from an audio file and writes it as a
single-track MIDI file. No TensorFlow or GPU required.
"""

from __future__ import annotations

import logging
import math
from pathlib import Path

logger = logging.getLogger(__name__)

_TICKS_PER_BEAT = 480


def _hz_to_midi(hz: float) -> int:
    """Convert a frequency in Hz to the nearest MIDI note number (0–127)."""
    return int(round(69 + 12 * math.log2(hz / 440.0)))


def audio_to_midi(wav_path: Path, out_dir: Path) -> Path | None:
    """
    Transcribe the dominant melody of an audio file to MIDI using librosa pyin.

    Returns the path to the generated .mid file, or None on failure.
    """
    try:
        import librosa
        import mido
        import numpy as np
    except ImportError as exc:
        logger.warning("librosa or mido not installed; skipping MIDI transcription: %s", exc)
        return None

    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        midi_path = out_dir / (wav_path.stem + ".mid")

        # Load at a lower sample rate — sufficient for pitch detection
        y, sr = librosa.load(str(wav_path), sr=22050, mono=True)

        # Probabilistic YIN pitch estimation
        f0, voiced_flag, _ = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C7"),
            sr=sr,
        )

        # Frame duration in seconds
        hop_length = 512
        frame_dur = hop_length / sr

        # Tempo for MIDI timing
        tempo_bpm = 120.0
        try:
            tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop_length)
            tempo_bpm = float(np.atleast_1d(tempo_arr)[0]) if tempo_arr is not None else 120.0
        except Exception:
            pass
        tempo_us = int(60_000_000 / max(tempo_bpm, 20))  # microseconds per beat
        ticks_per_sec = _TICKS_PER_BEAT * tempo_bpm / 60.0

        # Convert frame-level pitch to MIDI note events
        mid = mido.MidiFile(ticks_per_beat=_TICKS_PER_BEAT)
        track = mido.MidiTrack()
        mid.tracks.append(track)
        track.append(mido.MetaMessage("set_tempo", tempo=tempo_us, time=0))

        prev_note: int | None = None
        prev_tick = 0

        for i, (hz, voiced) in enumerate(zip(f0, voiced_flag)):
            current_tick = int(i * frame_dur * ticks_per_sec)
            dt = current_tick - prev_tick

            note = _hz_to_midi(float(hz)) if (voiced and hz is not None and not math.isnan(hz)) else None

            if note != prev_note:
                if prev_note is not None:
                    track.append(mido.Message("note_off", note=prev_note, velocity=0, time=dt))
                    dt = 0
                if note is not None:
                    track.append(mido.Message("note_on", note=note, velocity=80, time=dt))
                    dt = 0
                prev_note = note
                prev_tick = current_tick

        if prev_note is not None:
            track.append(mido.Message("note_off", note=prev_note, velocity=0, time=0))

        mid.save(str(midi_path))
        logger.info("MIDI written to %s", midi_path)
        return midi_path

    except Exception as exc:
        logger.warning("MIDI transcription failed: %s", exc)
        return None
