"""
Essence pipeline schema: high-level musical representation aligned to COMPONENT_IDS.

Used by /api/analyze, /api/compose, /api/render. These endpoints are stubbed until
a real feature-extraction and synthesis stack is connected (librosa, previews,
licensed catalogs, etc.).

Must stay compatible with js/constants/components.js (same component IDs).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .constants import COMPONENT_IDS, VALID_COMPONENTS

ESSENCE_SCHEMA_VERSION = "1.0.0"

SourceType = Literal["youtube", "preview_url", "upload", "streaming", "isrc"]
KeyMode = Literal["major", "minor", "unknown"]
OutputFormat = Literal["wav", "mp3"]
RenderEngine = Literal["stub", "internal_synth", "external_daw"]

MAX_EMBEDDING_DIM = 128


class AnalyzeOptions(BaseModel):
    """Optional knobs for a future analyzer."""

    model_config = ConfigDict(extra="forbid")

    clip_start_sec: float | None = Field(default=None, ge=0.0, description="Analyze from this offset (e.g. preview window).")
    clip_duration_sec: float | None = Field(
        default=None,
        ge=0.5,
        le=600.0,
        description="Max duration to analyze; None = full source or API default.",
    )
    include_embeddings: bool = Field(default=True, description="If false, omit optional embedding vectors.")


class TrackSourceIn(BaseModel):
    """One logical song/reference the client wants analyzed."""

    model_config = ConfigDict(extra="forbid")

    track_ref: str = Field(min_length=1, description="Client track id; must match mixer/UI track id.")
    source_type: SourceType
    source_id: str = Field(
        min_length=1,
        description="YouTube video id, preview URL, ISRC, or opaque upload id.",
    )


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(default=ESSENCE_SCHEMA_VERSION)
    tracks: list[TrackSourceIn] = Field(min_length=1)
    options: AnalyzeOptions = Field(default_factory=AnalyzeOptions)


class GlobalMusicalFeatures(BaseModel):
    """Tempo, key, meter, and coarse loudness/energy (DAW-agnostic)."""

    model_config = ConfigDict(extra="forbid")

    bpm: float | None = Field(default=None, gt=0, description="Tempo in quarter-note BPM.")
    bpm_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    musical_key_root: str | None = Field(
        default=None,
        description="Pitch class of key root, e.g. C, C#, D, ...",
    )
    mode: KeyMode = "unknown"
    time_signature: str | None = Field(default=None, description='e.g. "4/4", "6/8".')
    duration_sec: float | None = Field(default=None, ge=0.0)
    loudness_lufs: float | None = Field(default=None, description="Integrated loudness estimate (LUFS).")
    energy: float | None = Field(default=None, ge=0.0, le=1.0)
    danceability: float | None = Field(default=None, ge=0.0, le=1.0)


class ComponentEssence(BaseModel):
    """
    Per-slot descriptor for one of the nine components.

    Intended mapping (conceptual):
    - melody / harmony / bass: harmonic & pitch content
    - drums / percussion: onset / transient stats
    - vocals: formant / separation confidence–weighted stats
    - pads / fx / other: residual energy & texture
    """

    model_config = ConfigDict(extra="forbid")

    presence: float = Field(default=0.0, ge=0.0, le=1.0, description="How strongly this component is present.")
    spectral_centroid_mean_hz: float | None = Field(default=None, ge=0.0)
    harmonic_density: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="How busy the harmonic content is in this band/slot.",
    )
    rhythmic_density: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Onset / fluctuation density for percussive slots.",
    )
    embedding: list[float] | None = Field(
        default=None,
        description=f"Optional fixed-length embedding (max {MAX_EMBEDDING_DIM}).",
    )
    symbolic_hint: str | None = Field(
        default=None,
        description="Machine-readable hint for synthesis, e.g. monophonic_melody, four_on_floor.",
    )

    @field_validator("embedding")
    @classmethod
    def cap_embedding(cls, v: list[float] | None) -> list[float] | None:
        if v is not None and len(v) > MAX_EMBEDDING_DIM:
            raise ValueError(f"embedding length must be <= {MAX_EMBEDDING_DIM}")
        return v


class TrackEssence(BaseModel):
    """Full per-track analysis payload returned from /api/analyze and fed to /api/compose."""

    model_config = ConfigDict(extra="forbid")

    track_ref: str = Field(min_length=1)
    source_type: SourceType
    source_id: str = Field(min_length=1)
    global_features: GlobalMusicalFeatures
    components: dict[str, ComponentEssence] = Field(
        default_factory=dict,
        description=f"Subset of {COMPONENT_IDS}; omitted slots treated as absent.",
    )

    @field_validator("components")
    @classmethod
    def component_keys_valid(cls, v: dict[str, ComponentEssence]) -> dict[str, ComponentEssence]:
        bad = set(v) - VALID_COMPONENTS
        if bad:
            raise ValueError(f"Unknown component keys: {sorted(bad)}")
        return v


class AnalyzeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = ESSENCE_SCHEMA_VERSION
    stub: bool = Field(default=True, description="True until a real analyzer is connected.")
    tracks: list[TrackEssence]
    warnings: list[str] = Field(default_factory=list)


class ComposeAssignment(BaseModel):
    """Which exclusive components to take from which analyzed track (same rules as mashup)."""

    model_config = ConfigDict(extra="forbid")

    track_ref: str = Field(min_length=1)
    components: list[str] = Field(min_length=1)


class ComposeOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantize_grid: Literal["1/4", "1/8", "1/16"] | None = None
    crossfade_bars_at_boundaries: int = Field(default=0, ge=0, le=16)


class ComposeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(default=ESSENCE_SCHEMA_VERSION)
    analyses: list[TrackEssence] = Field(min_length=1, description="Typically output of /api/analyze.")
    assignments: list[ComposeAssignment] = Field(min_length=1)
    target_bpm: float | None = Field(default=None, gt=0, description="Warp recipe to this BPM; None = infer.")
    key_policy: str | None = Field(
        default=None,
        description='e.g. "follow:track_ref_123" or "C:major".',
    )
    options: ComposeOptions = Field(default_factory=ComposeOptions)


class TimelineSegment(BaseModel):
    """High-level arrangement slice for synthesis / DAW export."""

    model_config = ConfigDict(extra="forbid")

    label: str = Field(description="intro, verse, chorus, bridge, outro, …")
    start_bar: int = Field(ge=0)
    end_bar: int = Field(ge=0)
    component_owner: dict[str, str] = Field(
        description="component_id -> track_ref supplying that slot in this segment.",
    )

    @field_validator("component_owner")
    @classmethod
    def owners_valid(cls, v: dict[str, str]) -> dict[str, str]:
        bad = set(v) - VALID_COMPONENTS
        if bad:
            raise ValueError(f"Unknown component keys: {sorted(bad)}")
        return v


class ComposeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = ESSENCE_SCHEMA_VERSION
    stub: bool = Field(default=True)
    recipe_id: str = Field(min_length=1)
    resolved_bpm: float = Field(gt=0)
    musical_key_hint: str | None = Field(default=None, description="Human-readable key suggestion for rendering.")
    timeline: list[TimelineSegment]
    provenance: list[str] = Field(
        default_factory=list,
        description="Notes on which sources contributed which slots (for compliance / UX).",
    )


class RenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(default=ESSENCE_SCHEMA_VERSION)
    recipe_id: str | None = None
    compose: ComposeResponse | None = None
    output_format: OutputFormat = "mp3"
    engine: RenderEngine = "stub"

    @model_validator(mode="after")
    def recipe_present(self) -> RenderRequest:
        if self.recipe_id is None and self.compose is None:
            raise ValueError("Provide recipe_id (from prior compose) or inline compose payload.")
        return self


class RenderResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: str = ESSENCE_SCHEMA_VERSION
    stub: bool = True
    job_id: str | None = None
    status: Literal["queued", "running", "done", "error", "not_implemented"] = "not_implemented"
    download_url: str | None = None
    message: str = Field(description="Human-readable status; synthesis engine wiring TBD.")


def validate_exclusive_assignments(assignments: list[ComposeAssignment]) -> None:
    """Same exclusivity rule as mashup: each component appears at most once globally."""
    seen: set[str] = set()
    for a in assignments:
        for c in a.components:
            if c not in VALID_COMPONENTS:
                raise ValueError(f"Invalid component: {c}")
            if c in seen:
                raise ValueError(f"Component '{c}' assigned more than once")
            seen.add(c)
