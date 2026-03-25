"""
Stub implementations for analyze / compose until ML + synthesis are wired.
"""

from __future__ import annotations

import hashlib
import uuid

from .constants import COMPONENT_IDS
from .essence_schema import (
    AnalyzeOptions,
    AnalyzeRequest,
    AnalyzeResponse,
    ComponentEssence,
    ComposeRequest,
    ComposeResponse,
    GlobalMusicalFeatures,
    KeyMode,
    TimelineSegment,
    TrackEssence,
    TrackSourceIn,
    validate_exclusive_assignments,
)


def _stub_seed(s: str) -> int:
    h = hashlib.sha256(s.encode("utf-8")).digest()
    return int.from_bytes(h[:4], "big")


def _fract(seed: int, idx: int) -> float:
    x = ((seed * 7919) ^ (idx * 104729)) % 1_000_000
    return x / 1_000_000


def stub_component_essence(component_id: str, track_ref: str, include_embedding: bool) -> ComponentEssence:
    seed = _stub_seed(f"{track_ref}:{component_id}")
    presence = 0.15 + 0.65 * _fract(seed, 1)
    centroid = 800.0 + 3500.0 * _fract(seed, 2)
    emb = None
    if include_embedding:
        dim = 32
        emb = [(_fract(seed, k + 10) - 0.5) * 2.0 for k in range(dim)]
    return ComponentEssence(
        presence=presence,
        spectral_centroid_mean_hz=centroid,
        harmonic_density=_fract(seed, 3),
        rhythmic_density=_fract(seed, 4),
        embedding=emb,
        symbolic_hint=f"stub:{component_id}",
    )


def stub_track_essence(src: TrackSourceIn, options: AnalyzeOptions) -> TrackEssence:
    seed = _stub_seed(src.track_ref)
    bpm = 72.0 + 84.0 * _fract(seed, 11)
    roots = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    root = roots[int(_fract(seed, 12) * len(roots)) % len(roots)]
    mode: KeyMode = "major" if _fract(seed, 13) > 0.45 else "minor"
    comps = {
        cid: stub_component_essence(cid, src.track_ref, options.include_embeddings)
        for cid in COMPONENT_IDS
    }
    return TrackEssence(
        track_ref=src.track_ref,
        source_type=src.source_type,
        source_id=src.source_id,
        global_features=GlobalMusicalFeatures(
            bpm=round(bpm, 2),
            bpm_confidence=0.35,
            musical_key_root=root,
            mode=mode,
            time_signature="4/4",
            duration_sec=None,
            loudness_lufs=-14.0 - 6.0 * _fract(seed, 14),
            energy=_fract(seed, 15),
            danceability=_fract(seed, 16),
        ),
        components=comps,
    )


def analyze_stub(req: AnalyzeRequest) -> AnalyzeResponse:
    tracks = [stub_track_essence(t, req.options) for t in req.tracks]
    return AnalyzeResponse(
        stub=True,
        tracks=tracks,
        warnings=[
            "Stub analyzer: BPM/key/component stats are deterministic placeholders from track_ref.",
            "Replace with preview-based or upload-based analysis for production.",
        ],
    )


def compose_stub(req: ComposeRequest) -> ComposeResponse:
    validate_exclusive_assignments(req.assignments)
    refs_assign = {a.track_ref for a in req.assignments}
    refs_analysis = {t.track_ref for t in req.analyses}
    missing = refs_assign - refs_analysis
    if missing:
        raise ValueError(f"assignments reference unknown track_ref: {sorted(missing)}")

    by_ref = {t.track_ref: t for t in req.analyses}
    bpms = [by_ref[a.track_ref].global_features.bpm for a in req.assignments]
    bpms_valid = [b for b in bpms if b is not None]
    resolved = req.target_bpm if req.target_bpm is not None else (sum(bpms_valid) / len(bpms_valid) if bpms_valid else 120.0)

    key_hints = []
    for a in req.assignments:
        t = by_ref[a.track_ref]
        g = t.global_features
        if g.musical_key_root and g.mode != "unknown":
            key_hints.append(f"{g.musical_key_root}:{g.mode}")

    first = req.assignments[0]
    owner: dict[str, str] = {}
    for a in req.assignments:
        for c in a.components:
            owner[c] = a.track_ref

    timeline = [
        TimelineSegment(
            label="full_length",
            start_bar=0,
            end_bar=128,
            component_owner=owner,
        )
    ]
    prov = [f"{cid} ← {tr} (essence snapshot)" for cid, tr in owner.items()]
    recipe_id = str(uuid.uuid4())
    return ComposeResponse(
        stub=True,
        recipe_id=recipe_id,
        resolved_bpm=max(1.0, float(resolved)),
        musical_key_hint=key_hints[0] if key_hints else None,
        timeline=timeline,
        provenance=prov,
    )
