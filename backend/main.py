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
from .catalog import load_catalog, search_yt_video_id
from .mapping import build_nine_stems
from .mix_audio import assemble_mix, wav_to_mp3, write_wav
from .separate import run_demucs
from .tempo_match import detect_bpm, time_stretch_stems, pitch_shift_stems, semitone_distance

OUTPUT_DIR = Path(__file__).resolve().parent / "outputs"
OUTPUT_DIR.mkdir(exist_ok=True)
JOBS_FILE = OUTPUT_DIR / "jobs.json"

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
    key: int | None = None    # Spotify key integer 0-11; None if unknown
    mode: int | None = None   # 1=major, 0=minor; None if unknown


class MashupRequest(BaseModel):
    bpm: float = 120.0
    master_volume: float = 0.8
    sample: bool = False   # True → truncate output to 30 seconds
    tracks: list[TrackIn]


def validate_request(req: MashupRequest) -> None:
    if len(req.tracks) < 2:
        raise HTTPException(status_code=400, detail="At least two tracks required")
    seen: set[str] = set()
    for t in req.tracks:
        if not t.video_id.strip():
            raise HTTPException(status_code=400, detail="video_id required for each track")
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
    mode = "SAMPLE" if req.sample else "FULL"
    print(f"[{job_id}] Pipeline mode={mode} bpm={req.bpm} tracks={len(req.tracks)}", flush=True)
    set_job(job_id, {"status": "running"})
    work = Path(tempfile.mkdtemp(prefix=f"mashup_{job_id}_"))
    try:
        track_inputs: list[dict] = []
        master = max(0.0, min(1.0, req.master_volume))
        track_analysis: list[dict] = []

        target_bpm = max(30.0, min(300.0, float(req.bpm)))

        # Determine the reference key for pitch shifting:
        # Use the track that claims "vocals" (vocal track sets the key standard).
        # If no track has vocals, use the first track with known key data.
        ref_key: int | None = None
        vocal_track = next(
            (t for t in req.tracks if "vocals" in t.components and t.key is not None),
            None,
        )
        if vocal_track:
            ref_key = vocal_track.key
        else:
            first_keyed = next((t for t in req.tracks if t.key is not None), None)
            if first_keyed:
                ref_key = first_keyed.key

        # Sample mode: download only first 30 s — Demucs only needs 30 s to produce a 30 s output
        dl_max_dur = 30 if req.sample else None

        for t in req.tracks:
            tdir = work / "dl" / t.track_id
            wav = download_youtube_audio(t.video_id.strip(), tdir, max_duration=dl_max_dur)

            # Detect actual BPM before trimming — more audio = more accurate reading
            detected_bpm = detect_bpm(wav)

            # Hard-trim to 30 s before Demucs — this is the key speedup.
            # Demucs processing time scales with audio length; 30 s is all it
            # needs to produce a 30 s output. yt-dlp may return slightly more
            # than requested so ffmpeg enforces the hard limit.
            if req.sample:
                trimmed = tdir / f"{t.track_id}_trim.wav"
                subprocess.run(
                    ["ffmpeg", "-y", "-i", str(wav), "-t", "30",
                     "-ac", "2", "-ar", "44100", str(trimmed)],
                    check=True, timeout=120,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                wav = trimmed

            # Chord + MIDI analysis on the raw download (non-fatal)
            chords = extract_chords(wav)
            midi_out_dir = OUTPUT_DIR / job_id / t.track_id
            midi_path = audio_to_midi(wav, midi_out_dir)

            sep_root = work / "sep" / t.track_id
            # mdx_extra is 2-3× faster than htdemucs on CPU — acceptable for a preview
            demucs_model = "mdx_extra" if req.sample else "htdemucs"
            stem_dir = run_demucs(wav, sep_root, model=demucs_model)
            nine = build_nine_stems(stem_dir)

            # Step 1: Stretch stems to target BPM (≤15% hard limit enforced inside)
            nine = time_stretch_stems(nine, detected_bpm, target_bpm)

            # Step 2: Pitch-shift non-reference tracks to match the reference key.
            # Only shifts if the track has key data AND is not the vocal/reference track.
            semitones_applied = 0
            if ref_key is not None and t.key is not None and t.key != ref_key:
                dist = semitone_distance(t.key, ref_key)
                nine = pitch_shift_stems(nine, dist)
                semitones_applied = dist

            track_analysis.append(
                {
                    "track_id": t.track_id,
                    "detected_bpm": detected_bpm,
                    "semitones_shifted": semitones_applied,
                    "chords": chords,
                    "midi_path": str(midi_path) if midi_path else None,
                }
            )

            vol = max(0.0, min(1.0, t.volume)) * master
            track_inputs.append(
                {
                    "components": list(t.components),
                    "stems": nine,
                    "volume": vol,
                    "muted": t.muted,
                }
            )

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
    """
    if not video_id.strip():
        raise HTTPException(status_code=400, detail="video_id is required")
    return enrich_video(video_id.strip())


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
    }
