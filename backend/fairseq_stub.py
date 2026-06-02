"""
Minimal fairseq stub for RVC inference.

Patches sys.modules['fairseq'] before infer_rvc_python imports it,
replacing it with a torchaudio-based HuBERT implementation.

torchaudio.pipelines.HUBERT_BASE downloads the actual fairseq weights
(hubert_fairseq_base_ls960.pth) — the same checkpoint RVC models were
trained against — so features should match exactly.

Import this module BEFORE importing infer_rvc_python.
"""
from __future__ import annotations

import logging
import sys
import types
from pathlib import Path

import torch
import torch.nn as nn

logger = logging.getLogger(__name__)

_BASE_MODEL_DIR = Path(__file__).resolve().parent / "models" / "base"
_BASE_MODEL_DIR.mkdir(parents=True, exist_ok=True)
_HUBERT_PT = _BASE_MODEL_DIR / "hubert_base.pt"


class _HuBERTWrapper(nn.Module):
    """
    Wraps torchaudio.pipelines.HUBERT_BASE to match the fairseq extract_features
    interface used by infer_rvc_python's pipeline:

        logits = model.extract_features(source=..., padding_mask=..., output_layer=9/12)
        feats  = model.final_proj(logits[0])   # v1: 768→256
               = logits[0]                     # v2: 768-dim, no projection

    torchaudio's HUBERT_BASE carries the exact same weights as the official
    fairseq hubert_base.pt release, avoiding the subtle feature-extraction
    differences that arise with the transformers HubertModel port.

    final_proj weights are loaded from the fairseq hubert_base.pt checkpoint
    if it is on disk; otherwise a random projection is used (only affects v1
    models — v2 models skip final_proj entirely).
    """

    def __init__(self):
        super().__init__()
        import torchaudio
        logger.info("[fairseq_stub] Loading HuBERT via torchaudio.pipelines.HUBERT_BASE…")
        bundle = torchaudio.pipelines.HUBERT_BASE
        self._model = bundle.get_model()
        self._model.eval()
        self.final_proj = self._init_final_proj()

    # ── internal helpers ──────────────────────────────────────────────────────

    def _init_final_proj(self) -> nn.Linear:
        proj = nn.Linear(768, 256, bias=True)
        if _HUBERT_PT.exists():
            try:
                cpt   = torch.load(_HUBERT_PT, map_location="cpu", weights_only=False)
                state = cpt.get("model", {})
                if "final_proj.weight" in state:
                    proj.weight.data = state["final_proj.weight"]
                    if "final_proj.bias" in state:
                        proj.bias.data = state["final_proj.bias"]
                    logger.info("[fairseq_stub] Loaded final_proj from hubert_base.pt")
            except Exception as exc:
                logger.warning("[fairseq_stub] Could not load final_proj: %s", exc)
        return proj

    # ── fairseq-compatible interface ──────────────────────────────────────────

    def extract_features(
        self,
        source,
        padding_mask=None,
        output_layer: int | None = None,
    ):
        # torchaudio requires float32; guard against half-precision input
        source = source.float()

        with torch.no_grad():
            # num_layers=output_layer stops computation at the requested layer
            features, _ = self._model.extract_features(source, num_layers=output_layer)

        # features is a list of [batch, T, 768] tensors, one per transformer layer.
        # features[-1] is the final computed layer (= output_layer when specified).
        return [features[-1]]

    # ── device / dtype management ─────────────────────────────────────────────

    def to(self, device, **kwargs):
        self._model     = self._model.to(device)
        self.final_proj = self.final_proj.to(device)
        return self

    def half(self):
        self._model     = self._model.half()
        self.final_proj = self.final_proj.half()
        return self

    def float(self):
        self._model     = self._model.float()
        self.final_proj = self.final_proj.float()
        return self

    def eval(self):
        self._model.eval()
        self.final_proj.eval()
        return self

    def train(self, mode: bool = True):
        self._model.train(mode)
        return self


_hubert_singleton: _HuBERTWrapper | None = None


def _load_model_ensemble_and_task(filenames, suffix="", **kwargs):
    """Drop-in for fairseq.checkpoint_utils.load_model_ensemble_and_task."""
    global _hubert_singleton
    if _hubert_singleton is None:
        _hubert_singleton = _HuBERTWrapper()
    return [_hubert_singleton], None, None


# ── Inject stub into sys.modules ──────────────────────────────────────────────

def _install() -> None:
    if "fairseq" in sys.modules and getattr(sys.modules["fairseq"], "_is_stub", False):
        return  # already patched

    fairseq_mod  = types.ModuleType("fairseq")
    cp_utils_mod = types.ModuleType("fairseq.checkpoint_utils")

    fairseq_mod._is_stub = True
    cp_utils_mod.load_model_ensemble_and_task = _load_model_ensemble_and_task
    fairseq_mod.checkpoint_utils = cp_utils_mod

    sys.modules["fairseq"]                  = fairseq_mod
    sys.modules["fairseq.checkpoint_utils"] = cp_utils_mod
    logger.info("[fairseq_stub] Installed fairseq stub (torchaudio back-end)")


_install()
