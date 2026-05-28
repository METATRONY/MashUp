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

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
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
