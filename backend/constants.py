"""Must match js/constants/components.js COMPONENT_IDS order."""

COMPONENT_IDS = [
    "melody",
    "harmony",
    "bass",
    "drums",
    "vocals",
    "pads",
    "percussion",
    "fx",
    "other",
]

VALID_COMPONENTS = frozenset(COMPONENT_IDS)

DEMUCS_STEMS = ("drums", "bass", "other", "vocals")
