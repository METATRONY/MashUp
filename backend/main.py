"""
MashUp API: YouTube download → Demucs → 9-way mapping → mix → MP3.

Requires: ffmpeg and yt-dlp on PATH; Python deps from requirements.txt.
"""

from __future__ import annotations

from dotenv import load_dotenv
from pathlib import Path as _Path
load_dotenv(_Path(__file__).resolve().parent / ".env")

import json
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from threading import Lock

import numpy as np
import soundfile as sf

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .constants import VALID_COMPONENTS
from .download import download_youtube_audio
from .enrich import enrich_video
from .chord_analysis import extract_chords
from .midi_analysis import audio_to_midi
from .essence_schema import (
    AnalyzeRequest,
    AnalyzeResponse,
    ComposeRequest,
    ComposeResponse,
    RenderRequest,
    RenderResponse,
)
from .essence_stub import analyze_stub, compose_stub
from .catalog import load_catalog, search_yt_video_id, add_to_catalog
from .mapping import build_nine_stems
from .mix_audio import assemble_mix, build_dj_mix, wav_to_mp3, write_wav
from .separate import run_demucs
from .stem_cache import load as stem_cache_load, save as stem_cache_save
from . import metadata_cache
from .tempo_match import detect_bpm, detect_key_from_audio, time_stretch_stems, pitch_shift_stems, semitone_distance, beat_align_tracks
from .voice_process import VOICES_DIR, save_voice_upload, prepare_voice_stem, load_voice_as_array, append_training_clip
from .voice_convert import convert_voice_safe

OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
JOBS_FILE = OUTPUT_DIR / "jobs.json"
LIBRARY_FILE = OUTPUT_DIR / "library.json"

app = FastAPI(title="MashUp API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")
app.mount("/uploads/voices", StaticFiles(directory=str(VOICES_DIR)), name="voices")

jobs: dict[str, dict] = {}
jobs_lock = Lock()


def load_jobs() -> None:
    if not JOBS_FILE.exists():
        return
    try:
        raw = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return
    if isinstance(raw, dict):
        jobs.update(raw)


def save_jobs() -> None:
    tmp = JOBS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
    tmp.replace(JOBS_FILE)


def set_job(job_id: str, updates: dict) -> None:
    with jobs_lock:
        current = jobs.get(job_id, {})
        current.update(updates)
        jobs[job_id] = current
        save_jobs()


load_jobs()


class TrackIn(BaseModel):
    track_id: str
    video_id: str = Field(min_length=6)
    components: list[str]
    volume: float = 1.0
    muted: bool = False
    key: int | None = None       # Spotify key integer 0-11; None if unknown
    mode: int | None = None      # 1=major, 0=minor; None if unknown
    hint_bpm: float | None = None  # Spotify BPM for double-tempo correction


class MashupRequest(BaseModel):
    bpm: float = 120.0
    master_volume: float = 0.8
    sample: bool = False        # True → truncate output to 30 seconds
    mode: str = "mashup"        # "mashup" | "dj"
    segment_duration: int = 30  # DJ mode: seconds per track (manual timing)
    crossfade_duration: int = 4 # DJ mode: crossfade seconds
    dj_auto_timing: bool = False # DJ mode: auto-detect transition points
    dj_n_swaps: int = 4          # DJ mode: number of back-and-forth transitions
    tracks: list[TrackIn]


class VoiceReplaceRequest(BaseModel):
    video_id: str = Field(min_length=6)
    voice_id: str | None = None      # user recording (upload-voice flow)
    artist_id: str | None = None     # pre-trained artist model (catalog flow)
    pitch_shift: int = 0             # semitone adjustment for key matching
    sample: bool = False
    hint_bpm: float | None = None
    key: int | None = None
    mode: int | None = None
    vocal_gain: float = 2.0   # linear gain applied to converted vocals before mixing


class KaraokePrepRequest(BaseModel):
    video_id: str = Field(min_length=6)


class TestVoiceRequest(BaseModel):
    voice_id: str
    text: str = Field(min_length=1, max_length=500)


class TrainVoiceRequest(BaseModel):
    voice_id: str
    n_epochs: int = 100
    name: str = "My Voice"


class KaraokePitchCorrectRequest(BaseModel):
    video_id: str
    voice_id: str


def validate_request(req: MashupRequest) -> None:
    if len(req.tracks) < 2:
        raise HTTPException(status_code=400, detail="At least two tracks required")
    for t in req.tracks:
        if not t.video_id.strip():
            raise HTTPException(status_code=400, detail="video_id required for each track")

    if req.mode == "dj":
        return  # DJ mode uses all stems; no component exclusivity required

    # Mashup mode: each track must claim ≥1 component, no duplicates across tracks
    seen: set[str] = set()
    for t in req.tracks:
        if not t.components:
            raise HTTPException(status_code=400, detail="Each track must claim at least one component")
        for c in t.components:
            if c not in VALID_COMPONENTS:
                raise HTTPException(status_code=400, detail=f"Invalid component: {c}")
            if c in seen:
                raise HTTPException(
                    status_code=400,
                    detail=f"Component '{c}' may only be assigned to one track",
                )
            seen.add(c)


def run_pipeline(job_id: str, payload: dict) -> None:
    req = MashupRequest.model_validate(payload)
    mode_tag = f"{req.mode.upper()}{'-SAMPLE' if req.sample else ''}"
    print(f"[{job_id}] Pipeline mode={mode_tag} bpm={req.bpm} tracks={len(req.tracks)}", flush=True)
    if req.mode == "dj":
        print(f"[{job_id}] DJ segment={req.segment_duration}s crossfade={req.crossfade_duration}s auto={req.dj_auto_timing} swaps={req.dj_n_swaps}", flush=True)
    set_job(job_id, {"status": "running"})
    work = Path(tempfile.mkdtemp(prefix=f"mashup_{job_id}_"))
    try:
        track_inputs: list[dict] = []
        master = max(0.0, min(1.0, req.master_volume))
        track_analysis: list[dict] = []

        target_bpm = max(30.0, min(300.0, float(req.bpm)))

        # Sample mode: download only first 30 s — Demucs only needs 30 s to produce a 30 s output
        dl_max_dur = 30 if req.sample else None

        # ── Phase 1: Download / separate / BPM-stretch / detect key ──────────
        # Pitch-shifting is deferred until Phase 2 so that ref_key can be chosen
        # from ALL tracks' keys (including chromagram-detected fallbacks) before
        # any shifting happens.
        track_pending: list[dict] = []

        for t in req.tracks:
            demucs_model = "mdx_extra" if req.sample else "htdemucs"
            video_id = t.video_id.strip()
            wav_for_key: Path | None = None   # set only when a fresh download occurs

            cached = stem_cache_load(video_id, demucs_model)
            if cached is not None:
                nine, detected_bpm, chords = cached
                midi_path = None
                print(f"[{job_id}] Stem cache hit: {video_id} / {demucs_model}", flush=True)
            else:
                tdir = work / "dl" / t.track_id
                wav = download_youtube_audio(video_id, tdir, max_duration=dl_max_dur)
                wav_for_key = wav  # save full download for key detection (before trim)

                # Detect BPM on the full download — more audio → more accurate
                detected_bpm = detect_bpm(wav)

                # Librosa's beat_track often returns 2× or 0.5× the true tempo.
                # Snap to the nearest power-of-2 multiple closest to the Spotify hint.
                if t.hint_bpm and 30.0 < t.hint_bpm < 300.0:
                    hint = t.hint_bpm
                    candidates = [
                        detected_bpm * f
                        for f in (0.25, 0.5, 1.0, 2.0, 4.0)
                        if 30.0 < detected_bpm * f < 300.0
                    ]
                    best = min(candidates, key=lambda c: abs(c / hint - 1.0))
                    if abs(best - detected_bpm) > 0.5:
                        print(
                            f"[{job_id}] BPM snap: {detected_bpm:.1f} → {best:.1f} "
                            f"(Spotify hint {hint:.1f})",
                            flush=True,
                        )
                        detected_bpm = best

                if req.sample:
                    trimmed = tdir / f"{t.track_id}_trim.wav"
                    subprocess.run(
                        ["ffmpeg", "-y", "-i", str(wav), "-t", "30",
                         "-ac", "2", "-ar", "44100", str(trimmed)],
                        check=True, timeout=120,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                    wav = trimmed

                chords = extract_chords(wav)
                midi_out_dir = OUTPUT_DIR / job_id / t.track_id
                midi_path = audio_to_midi(wav, midi_out_dir)

                sep_root = work / "sep" / t.track_id
                stem_dir = run_demucs(wav, sep_root, model=demucs_model)
                nine = build_nine_stems(stem_dir)

                stem_cache_save(video_id, demucs_model, nine, detected_bpm, chords)

            # BPM-stretch immediately (doesn't affect key detection)
            nine = time_stretch_stems(nine, detected_bpm, target_bpm)

            # Key: prefer Spotify data; fall back to chromagram when absent
            effective_key: int | None = t.key
            effective_mode: int | None = t.mode
            if effective_key is None and wav_for_key is not None:
                ck, cm = detect_key_from_audio(wav_for_key)
                if ck is not None:
                    effective_key, effective_mode = ck, cm
                    print(
                        f"[{job_id}] Chromagram key {video_id}: {ck} "
                        f"({'major' if cm else 'minor'})",
                        flush=True,
                    )

            vol = max(0.0, min(1.0, t.volume)) * master
            track_pending.append({
                "track_req": t,
                "stems": nine,
                "volume": vol,
                "muted": t.muted,
                "detected_bpm": detected_bpm,
                "effective_key": effective_key,
                "effective_mode": effective_mode,
                "chords": chords,
                "midi_path": str(midi_path) if midi_path else None,
            })

        # ── Determine master key anchor from all tracks ───────────────────────
        # Priority: (1) vocal track, (2) first track with any key data
        ref_key: int | None = None
        for entry in track_pending:
            t_req = entry["track_req"]
            if "vocals" in (t_req.components or []) and entry["effective_key"] is not None:
                ref_key = entry["effective_key"]
                print(f"[{job_id}] Master key anchor: vocal track key={ref_key}", flush=True)
                break
        if ref_key is None:
            for entry in track_pending:
                if entry["effective_key"] is not None:
                    ref_key = entry["effective_key"]
                    print(f"[{job_id}] Master key anchor: first keyed track key={ref_key}", flush=True)
                    break

        # ── Phase 2: Pitch-shift and finalise track_inputs ───────────────────
        for entry in track_pending:
            t_req = entry["track_req"]
            nine = entry["stems"]
            eff_key = entry["effective_key"]
            semitones_applied = 0

            if ref_key is not None and eff_key is not None and eff_key != ref_key:
                dist = semitone_distance(eff_key, ref_key)
                nine = pitch_shift_stems(nine, dist)
                semitones_applied = dist

            track_analysis.append({
                "track_id": t_req.track_id,
                "detected_bpm": entry["detected_bpm"],
                "detected_key": entry["effective_key"],
                "detected_mode": entry["effective_mode"],
                "semitones_shifted": semitones_applied,
                "chords": entry["chords"],
                "midi_path": entry["midi_path"],
            })

            track_inputs.append({
                "track_id": t_req.track_id,
                "components": list(t_req.components),
                "stems": nine,
                "volume": entry["volume"],
                "muted": entry["muted"],
            })

        # Step 3: Beat-align — trim each track by at most one beat period so
        # all tracks share the same beat phase (max shift ~0.75 s at 80 BPM)
        stems_list = [t["stems"] for t in track_inputs]
        aligned_stems = beat_align_tracks(stems_list, target_bpm)
        for t, aligned in zip(track_inputs, aligned_stems):
            t["stems"] = aligned

        # Export per-stem WAVs for the timeline editor — written AFTER beat-align
        # (so phases are correct) and BEFORE length-equalize (so the full stem
        # audio is available for the user to shift into).
        stem_files: dict[str, dict[str, dict]] = {}
        stem_meta:  dict[str, dict] = {}
        if req.mode != "dj":
            stem_out = OUTPUT_DIR / job_id / "stems"
            stem_out.mkdir(parents=True, exist_ok=True)
            for t in track_inputs:
                if t["muted"]:
                    continue
                tid = t["track_id"]
                stem_files[tid] = {}
                stem_meta[tid] = {
                    "volume": t["volume"],
                    "components": list(t["components"]),
                }
                claimed_set = set(t["components"])
                for sname, audio in t["stems"].items():
                    if audio is None or audio.size == 0:
                        continue
                    path = stem_out / f"{tid}__{sname}.wav"
                    write_wav(path, audio, 44100)
                    stem_files[tid][sname] = {
                        "url": f"/outputs/{job_id}/stems/{tid}__{sname}.wav",
                        "duration": round(int(audio.size) / 44100, 3),
                        "claimed": sname in claimed_set,
                    }

        # Step 4: Equalise lengths — time-stretching changes each track's
        # duration (e.g. a 86 BPM track stretched to 80 BPM loses ~7% of its
        # samples).  Trim every active track to the shortest one so no track
        # goes silent while others are still playing.
        # Skip for DJ mode: each segment draws from a specific slice of each
        # track, so trimming to the shortest would cut off the search space.
        if req.mode != "dj":
            active = [t for t in track_inputs if not t.get("muted")]
            if len(active) > 1:
                min_len = min(
                    min(a.size for a in t["stems"].values() if a.size > 0)
                    for t in active
                )
                for t in active:
                    t["stems"] = {
                        name: audio[:min_len] if audio.size > min_len else audio
                        for name, audio in t["stems"].items()
                    }

        if req.mode == "dj":
            mix, sr = build_dj_mix(
                track_inputs,
                segment_duration=req.segment_duration,
                crossfade_duration=req.crossfade_duration,
                target_bpm=target_bpm,
                master_volume=master,
                auto_timing=req.dj_auto_timing,
                n_swaps=req.dj_n_swaps,
            )
        else:
            mix, sr = assemble_mix(track_inputs)

        if req.sample:
            mix = mix[:sr * 30]  # trim to 30 seconds

        wav_path = work / "mix.wav"
        write_wav(wav_path, mix, sr)
        mp3_path = OUTPUT_DIR / f"{job_id}.mp3"
        wav_to_mp3(wav_path, mp3_path)
        set_job(
            job_id,
            {
                "status": "done",
                "download_url": f"/outputs/{job_id}.mp3",
                "track_analysis": track_analysis,
                "stem_files": stem_files,
                "stem_meta": stem_meta,
                "error": None,
            },
        )
    except Exception as e:
        set_job(
            job_id,
            {
                "status": "error",
                "error": str(e),
                "download_url": None,
            },
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── Voice replace endpoints ────────────────────────────────────────────────────

@app.get("/api/artists")
async def get_artists() -> list[dict]:
    """Return the curated RVC artist catalog."""
    from .rvc_infer import load_catalog
    return load_catalog()


@app.post("/api/upload-voice")
async def upload_voice(
    file: UploadFile = File(...),
    voice_id: str | None = Query(None, description="Existing voice_id to append a training clip to"),
) -> dict:
    """Accept a voice recording and convert to 44100 Hz mono WAV.

    When voice_id is supplied the clip is appended to that session's clips/
    directory (for training data accumulation) instead of creating a new voice.
    """
    MAX = 50 * 1024 * 1024
    data = await file.read(MAX + 1)
    if len(data) > MAX:
        raise HTTPException(status_code=413, detail="File too large (max 50 MB)")

    # ── Training-clip accumulation path ───────────────────────────────────────
    if voice_id:
        wav_path, clip_idx = append_training_clip(voice_id, data, file.filename or "clip")
        audio, sr = sf.read(str(wav_path), dtype="float32", always_2d=False)
        duration = len(audio) / max(sr, 1)
        print(f"[upload-voice] training clip {clip_idx} for {voice_id}: {duration:.1f}s", flush=True)
        return {"voice_id": voice_id, "duration": round(duration, 2), "clip_index": clip_idx}

    # ── New voice session path (original flow) ────────────────────────────────
    voice_id = str(uuid.uuid4())
    voice_wav = save_voice_upload(voice_id, data, file.filename or "voice")

    audio, sr = sf.read(str(voice_wav), dtype="float32", always_2d=False)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    duration = len(audio) / sr
    rms = float(np.sqrt(np.mean(audio ** 2))) if audio.size else 0.0

    if duration < 5.0:
        shutil.rmtree(voice_wav.parent, ignore_errors=True)
        raise HTTPException(
            status_code=422,
            detail=f"Recording too short ({duration:.1f}s) — sing for at least 30 seconds.",
        )
    if rms < 5e-3:
        shutil.rmtree(voice_wav.parent, ignore_errors=True)
        raise HTTPException(
            status_code=422,
            detail="Recording is too quiet or silent — check that your microphone is working.",
        )

    frame_len = int(sr * 0.025)
    hop = frame_len // 2
    energies = [
        float(np.sqrt(np.mean(audio[i:i + frame_len] ** 2)))
        for i in range(0, len(audio) - frame_len, hop)
    ]
    voiced_pct = sum(1 for e in energies if e > 5e-3) / max(len(energies), 1)
    if voiced_pct < 0.15:
        shutil.rmtree(voice_wav.parent, ignore_errors=True)
        raise HTTPException(
            status_code=422,
            detail=(
                f"Recording is {voiced_pct * 100:.0f}% voiced — mostly silence. "
                "Move the microphone closer and try again."
            ),
        )

    print(
        f"[upload-voice] {voice_id}: {duration:.1f}s, RMS={rms:.4f}, voiced={voiced_pct * 100:.0f}%",
        flush=True,
    )
    return {"voice_id": voice_id, "duration": round(duration, 2)}


@app.post("/api/voice-replace")
async def voice_replace_endpoint(req: VoiceReplaceRequest, bg: BackgroundTasks) -> dict:
    """Start a voice-replacement job for a single song."""
    job_id = str(uuid.uuid4())
    set_job(job_id, {"status": "queued"})
    bg.add_task(run_voice_replace_pipeline, job_id, req.model_dump())
    return {"job_id": job_id}


def run_voice_replace_pipeline(job_id: str, payload: dict) -> None:
    req = VoiceReplaceRequest.model_validate(payload)
    print(f"[{job_id}] Voice-replace pipeline video_id={req.video_id} sample={req.sample}", flush=True)
    set_job(job_id, {"status": "running"})
    work = Path(tempfile.mkdtemp(prefix=f"voice_{job_id}_"))
    wav_for_key: Path | None = None
    try:
        demucs_model = "mdx_extra" if req.sample else "htdemucs"
        video_id = req.video_id.strip()

        # ── Step 1: Download + Demucs (use stem cache if available) ──────────
        cached = stem_cache_load(video_id, demucs_model)
        if cached is not None:
            nine, detected_bpm, _ = cached
            print(f"[{job_id}] Stem cache hit: {video_id}", flush=True)
        else:
            tdir = work / "dl"
            wav = download_youtube_audio(video_id, tdir, max_duration=30 if req.sample else None)
            wav_for_key = wav
            detected_bpm = detect_bpm(wav)

            if req.hint_bpm and 30.0 < req.hint_bpm < 300.0:
                hint = req.hint_bpm
                candidates = [
                    detected_bpm * f
                    for f in (0.25, 0.5, 1.0, 2.0, 4.0)
                    if 30.0 < detected_bpm * f < 300.0
                ]
                best = min(candidates, key=lambda c: abs(c / hint - 1.0))
                if abs(best - detected_bpm) > 0.5:
                    detected_bpm = best

            if req.sample:
                trimmed = tdir / "song_trim.wav"
                subprocess.run(
                    ["ffmpeg", "-y", "-i", str(wav), "-t", "30",
                     "-ac", "2", "-ar", "44100", str(trimmed)],
                    check=True, timeout=120,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                wav = trimmed

            sep_root = work / "sep"
            stem_dir = run_demucs(wav, sep_root, model=demucs_model)
            nine = build_nine_stems(stem_dir)
            stem_cache_save(video_id, demucs_model, nine, detected_bpm, [])

        # ── Step 2: Convert vocals stem ──────────────────────────────────────
        ref_len    = max(a.size for a in nine.values() if a.size > 0)
        song_vocals = nine.get("vocals")
        vocal_gain  = getattr(req, "vocal_gain", 2.0)

        if req.artist_id:
            # ── RVC artist model path ──────────────────────────────────────────
            from .rvc_infer import convert_with_rvc_safe, get_artist
            try:
                artist_info = get_artist(req.artist_id)
                artist_name = artist_info.get("name", req.artist_id)
            except Exception:
                artist_name = req.artist_id
            print(f"[{job_id}] ▶ RVC voice conversion — artist: {artist_name} (id={req.artist_id}) pitch_shift={req.pitch_shift:+d}st", flush=True)
            original_rms = float(np.sqrt(np.mean(song_vocals ** 2))) if song_vocals is not None and song_vocals.size > 0 else 0.0
            converted = convert_with_rvc_safe(
                song_vocals=song_vocals,
                artist_id=req.artist_id,
                sr=44100,
                pitch_shift=req.pitch_shift,
            )
            converted_rms = float(np.sqrt(np.mean(converted ** 2))) if converted.size > 0 else 0.0
            rvc_worked = abs(converted_rms - original_rms) > 0.005
            print(
                f"[{job_id}] ✔ RVC done — artist: {artist_name}  "
                f"original_rms={original_rms:.4f}  converted_rms={converted_rms:.4f}  "
                f"{'voice CHANGED ✓' if rvc_worked else 'WARNING: voice unchanged — model may have failed'}",
                flush=True,
            )
            # Normalize RVC output to match original vocal level
            if original_rms > 0 and converted_rms > 0:
                converted = (converted * (original_rms / converted_rms)).astype(np.float32)
            # Trim/pad to ref_len
            if converted.size >= ref_len:
                nine["vocals"] = converted[:ref_len].copy()
            else:
                nine["vocals"] = np.pad(converted, (0, ref_len - converted.size)).astype(np.float32)
        else:
            # ── User recording path (STFT spectral morphing) ──────────────────
            print(f"[{job_id}] ▶ STFT spectral morphing — voice_id={req.voice_id}", flush=True)
            voice_work = work / "voice"
            voice_work.mkdir(exist_ok=True)
            nine["vocals"] = prepare_voice_stem(
                voice_id=req.voice_id,
                work_dir=voice_work,
                target_samples=ref_len,
                semitones=0.0,
                song_vocals=song_vocals,
            )

        if nine["vocals"] is not None and nine["vocals"].size > 0:
            nine["vocals"] = (nine["vocals"] * vocal_gain).astype(np.float32)
        print(f"[{job_id}] Injected voice (len={ref_len} samples, gain={vocal_gain:.1f}x)", flush=True)

        # ── Step 3: Mix all 9 components from the single track ────────────────
        track_inputs = [{
            "track_id": "voice_track",
            "components": list(nine.keys()),
            "stems": nine,
            "volume": 1.0,
            "muted": False,
        }]
        mix, sr = assemble_mix(track_inputs)

        if req.sample:
            mix = mix[:sr * 30]

        wav_path = work / "mix.wav"
        write_wav(wav_path, mix, sr)
        mp3_path = OUTPUT_DIR / f"{job_id}.mp3"
        wav_to_mp3(wav_path, mp3_path)

        set_job(job_id, {
            "status": "done",
            "download_url": f"/outputs/{job_id}.mp3",
            "stem_files": {},
            "stem_meta": {},
            "track_analysis": [],
            "error": None,
        })
    except Exception as e:
        print(f"[{job_id}] Voice-replace error: {e}", flush=True)
        set_job(job_id, {"status": "error", "error": str(e), "download_url": None})
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── Karaoke prep ──────────────────────────────────────────────────────────────

def _detect_vocals_onset(vocal_arr: np.ndarray, sr: int = 44100,
                          window_secs: float = 0.5, threshold: float = 0.01) -> float:
    """Return seconds into the track when vocals are first sustained above threshold."""
    window = int(window_secs * sr)
    hop = window // 2
    prev_above = False
    for i in range(0, max(0, len(vocal_arr) - window), hop):
        rms = float(np.sqrt(np.mean(vocal_arr[i:i + window] ** 2)))
        above = rms > threshold
        if above and prev_above:
            onset = max(0.0, (i - hop) / sr)
            return round(onset, 2)
        prev_above = above
    return 0.0


@app.post("/api/karaoke-prep")
async def karaoke_prep(req: KaraokePrepRequest, bg: BackgroundTasks) -> dict:
    """Prepare a vocals-free instrumental for karaoke recording. Cached between calls."""
    inst_mp3 = OUTPUT_DIR / "karaoke" / req.video_id / "instrumental.mp3"
    meta_file = OUTPUT_DIR / "karaoke" / req.video_id / "meta.json"
    if inst_mp3.exists():
        vocals_start_secs = 0.0
        if meta_file.exists():
            try:
                vocals_start_secs = json.loads(meta_file.read_text(encoding="utf-8")).get("vocals_start_secs", 0.0)
            except Exception:
                pass
        return {
            "status": "done",
            "download_url": f"/outputs/karaoke/{req.video_id}/instrumental.mp3",
            "vocals_start_secs": vocals_start_secs,
        }
    job_id = str(uuid.uuid4())
    set_job(job_id, {"status": "queued"})
    bg.add_task(run_karaoke_prep, job_id, req.video_id)
    return {"job_id": job_id, "status": "queued"}


def run_karaoke_prep(job_id: str, video_id: str) -> None:
    set_job(job_id, {"status": "running"})
    work = Path(tempfile.mkdtemp(prefix=f"karaoke_{job_id}_"))
    try:
        model = "htdemucs"
        cached = stem_cache_load(video_id, model)
        if cached:
            nine, _, _ = cached
            print(f"[{job_id}] Karaoke: stem cache hit for {video_id}", flush=True)
        else:
            print(f"[{job_id}] Karaoke: running Demucs for {video_id}", flush=True)
            tdir = work / "dl"
            wav = download_youtube_audio(video_id, tdir)
            sep_root = work / "sep"
            stem_dir = run_demucs(wav, sep_root, model=model)
            nine = build_nine_stems(stem_dir)
            stem_cache_save(video_id, model, nine, 0.0, [])

        vocal_keys = {k for k in nine if "vocal" in k.lower()}
        inst_arrays = [v for k, v in nine.items() if k not in vocal_keys and v.size > 0]
        if not inst_arrays:
            raise RuntimeError("No non-vocal stems found")

        # Detect when vocals actually begin (skip instrumental intros)
        vocals_start_secs = 0.0
        for vk in vocal_keys:
            arr = nine.get(vk)
            if arr is not None and arr.size > 0:
                vocals_start_secs = _detect_vocals_onset(arr)
                break
        print(f"[{job_id}] Karaoke vocals onset: {vocals_start_secs:.1f}s", flush=True)

        max_len = max(a.size for a in inst_arrays)
        instrumental = np.zeros(max_len, dtype=np.float32)
        for arr in inst_arrays:
            instrumental[:arr.size] += arr

        peak = float(np.abs(instrumental).max())
        if peak > 0:
            instrumental *= 0.9 / peak

        karaoke_dir = OUTPUT_DIR / "karaoke" / video_id
        karaoke_dir.mkdir(parents=True, exist_ok=True)
        tmp_wav = work / "instrumental.wav"
        write_wav(tmp_wav, instrumental, 44100)
        wav_to_mp3(tmp_wav, karaoke_dir / "instrumental.mp3")

        # Persist onset so the fast-path cache hit can return it
        meta_file = karaoke_dir / "meta.json"
        meta_file.write_text(json.dumps({"vocals_start_secs": vocals_start_secs}), encoding="utf-8")

        print(f"[{job_id}] Karaoke instrumental ready for {video_id}", flush=True)
        set_job(job_id, {
            "status": "done",
            "download_url": f"/outputs/karaoke/{video_id}/instrumental.mp3",
            "vocals_start_secs": vocals_start_secs,
        })
    except Exception as e:
        print(f"[{job_id}] Karaoke-prep error: {e}", flush=True)
        set_job(job_id, {"status": "error", "error": str(e)})
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── Voice clone test ──────────────────────────────────────────────────────────

def _generate_tts_wav(text: str, work_dir: Path) -> Path:
    """macOS say → AIFF → ffmpeg → mono 44100 Hz WAV."""
    import platform
    if platform.system() != "Darwin":
        raise RuntimeError("TTS voice test requires macOS")
    aiff = work_dir / "tts.aiff"
    wav  = work_dir / "tts.wav"
    subprocess.run(["say", "-o", str(aiff), text], check=True, timeout=30)
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(aiff),
         "-ac", "1", "-ar", "44100", "-acodec", "pcm_f32le", str(wav)],
        check=True, timeout=30,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return wav


@app.post("/api/test-voice")
async def test_voice_endpoint(req: TestVoiceRequest) -> dict:
    """Generate TTS audio converted to the user's cloned voice for playback testing.

    If a trained RVC model exists for this voice_id, uses RVC inference for
    higher quality output. Otherwise falls back to STFT spectral morphing.
    """
    import os
    user_model_id  = f"user_{req.voice_id}"
    rvc_model_path = Path(__file__).resolve().parent / "models" / "rvc" / user_model_id / "model.pth"
    voice_wav      = VOICES_DIR / req.voice_id / "voice.wav"

    has_rvc   = rvc_model_path.exists() and os.getenv("MASHUP_USE_MODAL")
    has_voice = voice_wav.exists()
    if not has_rvc and not has_voice:
        raise HTTPException(status_code=404, detail="Voice not found")

    work = Path(tempfile.mkdtemp(prefix="tts_test_"))
    try:
        tts_wav   = _generate_tts_wav(req.text, work)
        tts_audio = load_voice_as_array(tts_wav)

        if has_rvc:
            from .rvc_infer import convert_with_rvc_safe
            print(f"[test-voice] using trained RVC model for {req.voice_id}", flush=True)
            converted = convert_with_rvc_safe(tts_audio, user_model_id, sr=44100)
        else:
            user_audio = load_voice_as_array(voice_wav)
            converted  = convert_voice_safe(
                song_vocals=tts_audio,
                user_voice=user_audio,
                song_sr=44100,
                user_sr=44100,
            )

        out_dir = OUTPUT_DIR / "test-voice"
        out_dir.mkdir(parents=True, exist_ok=True)
        tmp_wav = work / "result.wav"
        out_mp3 = out_dir / f"{req.voice_id}_{uuid.uuid4().hex[:8]}.mp3"
        write_wav(tmp_wav, converted, 44100)
        wav_to_mp3(tmp_wav, out_mp3)
        return {"audio_url": f"/outputs/test-voice/{out_mp3.name}"}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── Custom voice training endpoints ───────────────────────────────────────────

@app.get("/api/my-voice/{voice_id}/status")
async def my_voice_status(voice_id: str) -> dict:
    """Check whether a trained RVC model exists locally for this voice_id."""
    model_path = Path(__file__).resolve().parent / "models" / "rvc" / f"user_{voice_id}" / "model.pth"
    return {"trained": model_path.exists(), "voice_id": voice_id}


@app.get("/api/my-voices")
async def list_my_voices() -> dict:
    """Scan disk for all trained user voice models and return their ids + names."""
    rvc_dir = Path(__file__).resolve().parent / "models" / "rvc"
    voices = []
    for d in sorted(rvc_dir.iterdir()):
        if not d.is_dir() or not d.name.startswith("user_"):
            continue
        if not (d / "model.pth").exists():
            continue
        voice_id = d.name[len("user_"):]
        name_file = d / "name.txt"
        name = name_file.read_text().strip() if name_file.exists() else "My Voice"
        voices.append({"id": voice_id, "name": name})
    return {"voices": voices}


@app.delete("/api/my-voice/{voice_id}")
async def delete_my_voice(voice_id: str) -> dict:
    """Delete a trained user voice model from disk."""
    rvc_dir = Path(__file__).resolve().parent / "models" / "rvc" / f"user_{voice_id}"
    if rvc_dir.exists():
        shutil.rmtree(str(rvc_dir))
    return {"deleted": True}


@app.post("/api/train-voice")
async def train_voice(req: TrainVoiceRequest, bg: BackgroundTasks) -> dict:
    """Start async RVC model training for a user's accumulated voice clips."""
    clips_dir = VOICES_DIR / req.voice_id / "clips"
    if not clips_dir.exists() or not list(clips_dir.glob("clip_*.wav")):
        raise HTTPException(status_code=422, detail="No training clips found for this voice_id")
    job_id = str(uuid.uuid4())
    set_job(job_id, {"status": "queued", "type": "training", "voice_id": req.voice_id})
    bg.add_task(_run_voice_training, job_id, req.voice_id, req.n_epochs, req.name)
    return {"job_id": job_id}


def _run_voice_training(job_id: str, voice_id: str, n_epochs: int, name: str = "My Voice") -> None:
    from .rvc_train import launch_rvc_training
    launch_rvc_training(voice_id, job_id, n_epochs, name)


@app.post("/api/karaoke-pitch-correct")
async def karaoke_pitch_correct(req: KaraokePitchCorrectRequest, bg: BackgroundTasks) -> dict:
    """Pitch-correct a karaoke recording against the song's reference vocal stem."""
    voice_wav = VOICES_DIR / req.voice_id / "voice.wav"
    if not voice_wav.exists():
        raise HTTPException(status_code=404, detail="Voice recording not found")
    job_id = str(uuid.uuid4())
    set_job(job_id, {"status": "queued", "type": "pitch_correct"})
    bg.add_task(_run_pitch_correct, job_id, req.video_id, req.voice_id)
    return {"job_id": job_id}


def _run_pitch_correct(job_id: str, video_id: str, voice_id: str) -> None:
    try:
        set_job(job_id, {"status": "running"})
        from .pitch_correct import correct_karaoke_pitch
        import soundfile as sf_local

        voice_wav = VOICES_DIR / voice_id / "voice.wav"
        user_audio, _ = sf_local.read(str(voice_wav), dtype="float32", always_2d=False)
        if user_audio.ndim == 2:
            user_audio = user_audio.mean(axis=1)

        corrected = correct_karaoke_pitch(video_id, user_audio)

        out_dir = OUTPUT_DIR / "pitch_correct"
        out_dir.mkdir(parents=True, exist_ok=True)
        work = Path(tempfile.mkdtemp(prefix="pitchfix_"))
        try:
            tmp_wav = work / "corrected.wav"
            out_mp3 = out_dir / f"{job_id}.mp3"
            write_wav(tmp_wav, corrected, 44100)
            wav_to_mp3(tmp_wav, out_mp3)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        set_job(job_id, {"status": "done", "download_url": f"/outputs/pitch_correct/{job_id}.mp3"})
    except Exception as exc:
        print(f"[pitch-correct] {job_id} failed: {exc}", flush=True)
        set_job(job_id, {"status": "error", "error": str(exc)})


@app.get("/api/library")
def get_library():
    """Return the persisted song library."""
    if not LIBRARY_FILE.exists():
        return []
    try:
        return json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


@app.post("/api/library")
def save_library(songs: list[dict]):
    """Persist the full song library to disk."""
    tmp = LIBRARY_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(songs, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(LIBRARY_FILE)
    return {"ok": True, "count": len(songs)}


@app.get("/api/catalog")
def get_catalog():
    """Return the full curated song catalog."""
    return load_catalog()


@app.get("/api/search-yt")
def search_yt(artist: str = Query(default=""), title: str = Query(default="", min_length=1)):
    """Find a YouTube video ID for a given artist + title via yt-dlp search."""
    vid = search_yt_video_id(artist.strip(), title.strip())
    if not vid:
        raise HTTPException(status_code=404, detail="No video found on YouTube")
    return {"video_id": vid}


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/enrich")
def enrich_song(video_id: str = Query(..., min_length=6, max_length=20)):
    """
    Enrich a YouTube video ID with song metadata.

    Resolves artist/title from oEmbed, fetches Spotify audio features
    (BPM, key, mode, energy, valence, danceability, album art), and retrieves
    lyrics from Genius or lrclib.net. All external calls are non-fatal;
    unresolvable fields are returned as null.

    Results are cached by video_id so repeated lookups skip all external API calls.
    """
    vid = video_id.strip()
    if not vid:
        raise HTTPException(status_code=400, detail="video_id is required")

    cached = metadata_cache.get(vid)
    if cached is not None:
        add_to_catalog(vid, cached)
        return cached

    result = enrich_video(vid)
    metadata_cache.put(vid, result)
    add_to_catalog(vid, result)
    return result


@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze_track_essence(req: AnalyzeRequest):
    """
    Analyze sources into TrackEssence payloads (9 components + global BPM/key).

    Current response is a deterministic stub for contract testing; replace with
    preview/upload pipelines and licensed data where applicable.
    """
    return analyze_stub(req)


@app.post("/api/compose", response_model=ComposeResponse)
def compose_from_essence(req: ComposeRequest):
    """
    Merge multiple TrackEssence analyses under exclusive component assignments.

    Returns a synthesis recipe (timeline + target BPM). Stub until audio engine is connected.
    """
    try:
        return compose_stub(req)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/render", response_model=RenderResponse)
def render_essence_recipe(req: RenderRequest):
    """
    Turn a compose recipe into rendered audio (MP3/WAV).

    Not implemented yet: wire internal_synth or export to DAW; mashup remains /api/mashup.
    """
    parts = [
        "Essence render engine not connected.",
        "Use /api/mashup for waveform-based stem mix from YouTube, or implement synthesis from recipe.timeline.",
    ]
    if req.compose is not None:
        parts.append(f"Stub accepted recipe_id={req.compose.recipe_id}.")
    elif req.recipe_id:
        parts.append(
            f"recipe_id={req.recipe_id} has no server-side store yet; POST the full compose payload on this request."
        )
    return RenderResponse(
        stub=True,
        job_id=None,
        status="not_implemented",
        download_url=None,
        message=" ".join(parts),
    )


@app.post("/api/mashup")
def create_mashup(req: MashupRequest, background_tasks: BackgroundTasks):
    validate_request(req)
    job_id = str(uuid.uuid4())
    set_job(
        job_id,
        {
            "status": "queued",
            "error": None,
            "download_url": None,
        },
    )
    background_tasks.add_task(run_pipeline, job_id, req.model_dump())
    return {"job_id": job_id}


@app.get("/api/mashup/job/{job_id}")
def mashup_job_status(job_id: str):
    j = jobs.get(job_id)
    if j is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    return {
        "status": j["status"],
        "error": j.get("error"),
        "download_url": j.get("download_url"),
        "track_analysis": j.get("track_analysis"),
        "stem_files": j.get("stem_files"),
        "stem_meta": j.get("stem_meta"),
    }


class StemEditIn(BaseModel):
    offset: float = 0.0        # seconds; positive = delay, negative = advance
    start_trim: float = 0.0   # seconds to cut from start of stem audio
    end_trim: float = 0.0     # seconds to cut from end of stem audio
    volume: float = 1.0       # per-stem multiplier (0.0–1.5)


class RemixRequest(BaseModel):
    edits: dict[str, StemEditIn] = {}  # { track_id: edit } — one edit per track, applied to all its stems


@app.post("/api/mashup/remix/{job_id}")
def remix_mashup(job_id: str, req: RemixRequest):
    """Re-assemble the mix with per-stem time offsets, trims, and volumes."""
    try:
        import soundfile as sf
    except ImportError:
        raise HTTPException(status_code=500, detail="soundfile not installed — run: pip install soundfile")

    j = jobs.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="Job not found")

    stem_files = j.get("stem_files") or {}
    stem_meta  = j.get("stem_meta")  or {}

    if not stem_files:
        raise HTTPException(status_code=400, detail="No stems saved for this job — regenerate first")

    try:
        sr = 44100
        track_inputs: list[dict] = []

        for tid, stems in stem_files.items():
            meta = stem_meta.get(tid, {})
            track_edit = req.edits.get(tid, StemEditIn())  # one edit per track
            track_stems: dict[str, np.ndarray] = {}

            for sname, stem_info in stems.items():
                # Skip unclaimed stems — they are exported for visual reference only
                if stem_info.get("claimed") is False:
                    continue
                wav_path = OUTPUT_DIR / job_id / "stems" / f"{tid}__{sname}.wav"
                if not wav_path.exists():
                    continue

                audio, file_sr = sf.read(str(wav_path), dtype="float32", always_2d=False)
                # Ensure mono
                if audio.ndim > 1:
                    audio = audio.mean(axis=1)

                # Apply track-level edit to all stems of this track
                # Trim start
                start_s = max(0, int(track_edit.start_trim * file_sr))
                if start_s > 0:
                    audio = audio[start_s:]

                # Trim end
                if track_edit.end_trim > 0:
                    end_s = max(1, len(audio) - int(track_edit.end_trim * file_sr))
                    audio = audio[:end_s]

                # Volume
                stem_vol = max(0.0, min(1.5, track_edit.volume))
                audio = audio * stem_vol

                # Offset: positive = prepend silence (delayed start), negative = advance (trim from start)
                if track_edit.offset > 0:
                    silence = np.zeros(int(track_edit.offset * file_sr), dtype=np.float32)
                    audio = np.concatenate([silence, audio])
                elif track_edit.offset < 0:
                    skip = min(int(abs(track_edit.offset) * file_sr), max(0, len(audio) - 1))
                    audio = audio[skip:]

                track_stems[sname] = audio.astype(np.float32)

            if track_stems:
                # Only list components whose WAVs were actually loaded — guards
                # against KeyError in assemble_mix when files are missing on disk.
                claimed_components = [
                    c for c in (meta.get("components") or list(track_stems.keys()))
                    if c in track_stems
                ]
                if not claimed_components:
                    continue
                track_inputs.append({
                    "components": claimed_components,
                    "stems": track_stems,
                    "volume": 1.0,  # volume already baked in
                    "muted": False,
                })

        if not track_inputs:
            raise HTTPException(status_code=400, detail="No stems could be loaded")

        mix, sr_out = assemble_mix(track_inputs)

        remix_wav = OUTPUT_DIR / f"{job_id}_remix.wav"
        remix_mp3 = OUTPUT_DIR / f"{job_id}_remix.mp3"
        write_wav(remix_wav, mix, sr_out)
        wav_to_mp3(remix_wav, remix_mp3)
        remix_wav.unlink(missing_ok=True)

        return {"download_url": f"/outputs/{job_id}_remix.mp3"}

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Remix failed: {exc}") from exc
