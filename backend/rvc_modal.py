"""
Modal.com GPU inference for RVC voice conversion.

Runs RVC on a remote A10G GPU, returning converted audio in ~10-30 s.
Models are cached in a persistent Modal volume (downloaded once, reused).

Setup:
    1. pip install modal
    2. modal setup          (one-time browser auth)
    3. Set MASHUP_USE_MODAL=1 in backend/.env
    4. First call per artist downloads the model to the Modal volume (~60-120 s).
       Subsequent calls are fast.
"""
from __future__ import annotations

import modal

# ── Image ─────────────────────────────────────────────────────────────────────
# Built once by Modal; all GPU calls reuse the cached image.
#
# Dependency tangle we're working around:
#   infer-rvc-python → fairseq==0.12.2 → omegaconf<2.1
#   But omegaconf 2.0.5 (the only <2.1 release) has invalid PyYAML metadata
#   that pip>=24.1 refuses to install.
#
# Fix: install both infer-rvc-python and the Tps-F fairseq fork with
# --no-deps, then manually supply their runtime deps using modern omegaconf.
_image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "libsndfile1", "git")
    .run_commands(
        # torch first so subsequent --no-deps installs find it
        "pip install torch torchaudio",
        # infer-rvc-python without its fairseq dep (fairseq 0.12.2 → broken omegaconf)
        "pip install --no-deps infer-rvc-python",
        # all of infer-rvc-python's declared runtime deps (minus fairseq, handled separately)
        "pip install ffmpeg-python numpy scipy soundfile librosa resampy torchcrepe praat-parselmouth faiss-cpu pyworld gradio typeguard",
        # Tps-F fairseq fork (Python 3.10 compatible, no omegaconf pin)
        "pip install --no-deps git+https://github.com/Tps-F/fairseq.git",
        # fairseq runtime deps — modern omegaconf 2.1+ has valid metadata
        "pip install 'hydra-core>=1.3.0' 'omegaconf>=2.1.0' bitarray sacrebleu",
    )
)

# ── Persistent model volume ───────────────────────────────────────────────────
_model_volume = modal.Volume.from_name("mashup-rvc-models", create_if_missing=True)

app = modal.App("mashup-rvc")

# ── Training image (extends inference image + RVC WebUI) ──────────────────────
_training_image = (
    _image
    .run_commands(
        # Full single-branch clone so we have git history to pin against.
        "git clone --single-branch --branch main "
        "https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI /rvc_webui",
        # Checkout the FULL old commit where both training scripts AND lib/slicer2.py
        # existed together. HEAD's lib/ was reorganized and no longer has slicer2.py.
        # lib.infer_pack is handled at runtime by adding infer_rvc_python to PYTHONPATH.
        "HASH=$(git -C /rvc_webui log --diff-filter=D --format='%P' "
        "-- trainset_preprocess_pipeline_print.py | awk '{print $1}' | head -1) "
        "&& [ -n \"$HASH\" ] "
        "&& git -C /rvc_webui checkout \"$HASH\" "
        "&& echo \"[train-image] pinned to $HASH\" "
        "|| echo \"[train-image] training scripts still at HEAD\"",
        "pip install tensorboard",
    )
)


# ── GPU inference function ─────────────────────────────────────────────────────

@app.function(
    image=_image,
    gpu="A10G",
    timeout=900,
    volumes={"/models": _model_volume},
)
def run_rvc_inference(
    audio_bytes: bytes,
    model_url: str,
    artist_id: str,
    sr: int = 44100,
    pitch_shift: int = 0,
) -> bytes:
    """
    Convert audio with RVC on an A10G GPU.
    audio_bytes: float32 numpy array serialized to bytes (.tobytes())
    Returns: float32 numpy array as bytes, same length as input.
    """
    import os
    import tempfile
    import urllib.request
    import zipfile
    from pathlib import Path

    import numpy as np
    import soundfile as sf

    # Patch torch.load before any fairseq/RVC import so legacy checkpoints load.
    import torch
    _orig_load = torch.load
    def _patched_load(*args, **kw):
        kw.setdefault("weights_only", False)
        return _orig_load(*args, **kw)
    torch.load = _patched_load

    # ── Model cache in persistent volume ──────────────────────────────────────
    model_dir = Path(f"/models/rvc/{artist_id}")
    model_dir.mkdir(parents=True, exist_ok=True)
    model_path = model_dir / "model.pth"
    index_path = model_dir / "model.index"

    if not model_path.exists():
        print(f"[modal-rvc] downloading model for {artist_id} …", flush=True)
        tmp_zip = model_dir / "_download.zip"
        urllib.request.urlretrieve(model_url, tmp_zip)

        with zipfile.ZipFile(tmp_zip) as z:
            names = z.namelist()
            pth_files = [n for n in names if n.endswith(".pth") and not n.startswith("__")]
            idx_files = [n for n in names if n.endswith(".index") and not n.startswith("__")]

            if not pth_files:
                tmp_zip.unlink(missing_ok=True)
                raise RuntimeError(f"No .pth found in zip for {artist_id}")

            with z.open(pth_files[0]) as src, open(model_path, "wb") as dst:
                dst.write(src.read())
            if idx_files:
                with z.open(idx_files[0]) as src, open(index_path, "wb") as dst:
                    dst.write(src.read())

        tmp_zip.unlink(missing_ok=True)
        _model_volume.commit()
        print(f"[modal-rvc] ✔ model cached ({model_path.stat().st_size / 1e6:.1f} MB)", flush=True)

    # Auto-patch user models missing `sr` in their config list.
    # infer_rvc_python unpacks config as *args and its SynthesizerTrnMs768NSFsid
    # requires sr as a positional arg; models trained before this fix lack it.
    if artist_id.startswith("user_"):
        _ckpt = torch.load(str(model_path), map_location="cpu")
        _cfg  = _ckpt.get("config", [])
        _sr_values = {16000, 22050, 32000, 40000, 44100, 48000}
        if _cfg and (not isinstance(_cfg[-1], int) or _cfg[-1] not in _sr_values):
            _sr_int = {"48k": 48000, "44k": 44100, "40k": 40000, "32k": 32000}.get(
                str(_ckpt.get("sr", "48k")), 48000)
            _cfg.append(_sr_int)
            _ckpt["config"] = _cfg
            torch.save(_ckpt, str(model_path))
            _model_volume.commit()
            print(f"[modal-rvc] patched config for {artist_id} — added sr={_sr_int}", flush=True)

    # ── Base models (HuBERT + RMVPE) ──────────────────────────────────────────
    base_dir = Path("/models/base")
    base_dir.mkdir(exist_ok=True)

    hubert_path = base_dir / "hubert_base.pt"
    if not hubert_path.exists():
        print("[modal-rvc] downloading hubert_base.pt …", flush=True)
        urllib.request.urlretrieve(
            "https://huggingface.co/r3gm/sonitranslate_voice_models/resolve/main/hubert_base.pt",
            hubert_path,
        )
        _model_volume.commit()

    rmvpe_path = base_dir / "rmvpe.pt"
    if not rmvpe_path.exists():
        print("[modal-rvc] downloading rmvpe.pt …", flush=True)
        urllib.request.urlretrieve(
            "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt",
            rmvpe_path,
        )
        _model_volume.commit()

    # ── RVC inference ──────────────────────────────────────────────────────────
    from infer_rvc_python.main import BaseLoader

    audio = np.frombuffer(audio_bytes, dtype=np.float32).copy()
    print(f"[modal-rvc] input: {len(audio)} samples @ {sr} Hz, shift={pitch_shift:+d}st", flush=True)

    loader = BaseLoader(
        only_cpu=False,
        hubert_path=str(hubert_path),
        rmvpe_path=str(rmvpe_path),
    )
    loader.apply_conf(
        tag="artist",
        file_model=str(model_path),
        pitch_algo="rmvpe",
        pitch_lvl=pitch_shift,
        file_index=str(index_path) if index_path.exists() else "",
        index_influence=0.75,
        respiration_median_filtering=3,
        envelope_ratio=0.25,
        consonant_breath_protection=0.33,
        resample_sr=0,
    )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_tmp = f.name
    sf.write(wav_tmp, audio, sr)

    result = loader.generate_from_cache(audio_data=wav_tmp, tag="artist")
    os.unlink(wav_tmp)

    if isinstance(result, tuple):
        out_audio, out_sr = result
    else:
        out_audio, out_sr = result[0], sr

    out_audio = np.asarray(out_audio, dtype=np.float32)
    if np.abs(out_audio).max() > 1.0:
        out_audio /= 32768.0

    if out_sr != sr:
        import librosa
        out_audio = librosa.resample(out_audio, orig_sr=out_sr, target_sr=sr)

    if out_audio.size > audio.size:
        out_audio = out_audio[:audio.size]
    elif out_audio.size < audio.size:
        out_audio = np.pad(out_audio, (0, audio.size - out_audio.size))

    print(
        f"[modal-rvc] ✔ done — rms={float(np.sqrt(np.mean(out_audio**2))):.4f}"
        f"  peak={float(np.abs(out_audio).max()):.4f}",
        flush=True,
    )
    return out_audio.tobytes()


# Stub for lib/train/utils.py — used when the historical commit lacks the file.
# Implements the subset of functions that train_nsf_sim_cache_sid_load_pretrain.py calls.
_TRAIN_UTILS_STUB = r'''
import os, sys, glob, json, logging, argparse
import numpy as np
import torch

class HParams:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            if type(v) == dict:
                v = HParams(**v)
            self[k] = v
    def keys(self): return self.__dict__.keys()
    def items(self): return self.__dict__.items()
    def values(self): return self.__dict__.values()
    def __len__(self): return len(self.__dict__)
    def __getitem__(self, key): return getattr(self, key)
    def __setitem__(self, key, value): return setattr(self, key, value)
    def __contains__(self, key): return key in self.__dict__
    def __repr__(self): return self.__dict__.__repr__()

def get_hparams(init=True):
    parser = argparse.ArgumentParser()
    parser.add_argument("-se", "--save_every_epoch", required=True, type=int)
    parser.add_argument("-te", "--total_epoch", required=True, type=int)
    parser.add_argument("-pg", "--pretrained_G", type=str, default="")
    parser.add_argument("-pd", "--pretrained_D", type=str, default="")
    parser.add_argument("-g",  "--gpus", type=str, default="0")
    parser.add_argument("-bs", "--batch_size", type=int, default=4)
    parser.add_argument("-e",  "--experiment_dir", type=str, required=True)
    parser.add_argument("-sr", "--sample_rate", type=str, required=True)
    parser.add_argument("-sw", "--save_every_weights", type=str, default="0")
    parser.add_argument("-v",  "--version", type=str, required=True)
    parser.add_argument("-f0", "--if_f0", type=int, required=True)
    parser.add_argument("-l",  "--if_latest", type=int, required=True)
    parser.add_argument("-c",  "--if_cache_data_in_gpu", type=int, required=True)
    args = parser.parse_args()
    now_dir = os.getcwd()
    config_path = os.path.join(now_dir, "configs", f"{args.sample_rate}_{args.version}.json")
    with open(config_path) as f:
        config = json.load(f)
    hps = HParams(**config)
    hps.model_dir = os.path.join(now_dir, "logs", args.experiment_dir)
    hps.save_every_epoch = args.save_every_epoch
    hps.name = args.experiment_dir
    hps.pretrainG = args.pretrained_G
    hps.pretrainD = args.pretrained_D
    hps.version = args.version
    hps.gpus = args.gpus
    hps.train.batch_size = args.batch_size
    hps.sample_rate = args.sample_rate
    hps.if_f0 = args.if_f0
    hps.total_epoch = args.total_epoch
    hps.save_every_weights = args.save_every_weights
    hps.if_latest = args.if_latest
    hps.if_retrain_collapse = False
    hps.if_cache_data_in_gpu = args.if_cache_data_in_gpu
    return hps

def get_logger(model_dir, filename="train.log"):
    logger = logging.getLogger(os.path.basename(model_dir))
    logger.setLevel(logging.DEBUG)
    os.makedirs(model_dir, exist_ok=True)
    fh = logging.FileHandler(os.path.join(model_dir, filename))
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(asctime)s\t%(name)s\t%(levelname)s\t%(message)s"))
    logger.addHandler(fh)
    return logger

def load_checkpoint(checkpoint_path, model, optimizer=None, skip_optimizer=False):
    ckpt = torch.load(checkpoint_path, map_location="cpu")
    iteration = ckpt.get("iteration", 0)
    learning_rate = ckpt.get("learning_rate", 0.0001)
    if optimizer is not None and not skip_optimizer and ckpt.get("optimizer") is not None:
        try:
            optimizer.load_state_dict(ckpt["optimizer"])
        except Exception:
            pass
    saved = ckpt.get("model", ckpt)
    target = model.module.state_dict() if hasattr(model, "module") else model.state_dict()
    new_sd = {}
    for k, v in target.items():
        new_sd[k] = saved.get(k, v)
    if hasattr(model, "module"):
        model.module.load_state_dict(new_sd)
    else:
        model.load_state_dict(new_sd)
    logging.info(f"Loaded checkpoint '{checkpoint_path}' (iter {iteration})")
    return model, optimizer, learning_rate, iteration

def save_checkpoint(model, optimizer, learning_rate, iteration, checkpoint_path):
    sd = model.module.state_dict() if hasattr(model, "module") else model.state_dict()
    torch.save({"model": sd, "iteration": iteration,
                "optimizer": optimizer.state_dict(), "learning_rate": learning_rate},
               checkpoint_path)
    logging.info(f"Saved checkpoint '{checkpoint_path}' (iter {iteration})")

def summarize(writer, global_step, scalars={}, histograms={}, images={}, audios={}, audio_sampling_rate=22050):
    for k, v in scalars.items(): writer.add_scalar(k, v, global_step)
    for k, v in histograms.items(): writer.add_histogram(k, v, global_step)
    for k, v in images.items(): writer.add_image(k, v, global_step, dataformats="HWC")
    for k, v in audios.items(): writer.add_audio(k, v, global_step, audio_sampling_rate)

def latest_checkpoint_path(dir_path, regex="G_*.pth"):
    f_list = glob.glob(os.path.join(dir_path, regex))
    f_list.sort(key=lambda f: int("".join(filter(str.isdigit, os.path.basename(f))) or "0"))
    return f_list[-1] if f_list else None

def load_wav_to_torch(full_path):
    import soundfile as sf
    data, sr = sf.read(full_path, dtype="float32", always_2d=False)
    if data.ndim == 2:
        data = data.mean(axis=1)
    return torch.FloatTensor(data), sr

def load_filepaths_and_text(filename, split="|"):
    with open(filename, encoding="utf-8") as f:
        return [line.strip().split(split) for line in f if line.strip()]

def plot_spectrogram_to_numpy(spectrogram):
    try:
        import matplotlib; matplotlib.use("Agg")
        from matplotlib import pyplot as plt
        fig, ax = plt.subplots(figsize=(10, 2))
        im = ax.imshow(spectrogram, aspect="auto", origin="lower", interpolation="none")
        plt.colorbar(im, ax=ax); plt.tight_layout()
        fig.canvas.draw()
        data = np.frombuffer(fig.canvas.tostring_rgb(), dtype=np.uint8)
        data = data.reshape(fig.canvas.get_width_height()[::-1] + (3,))
        plt.close(); return data
    except Exception:
        return np.zeros((20, 100, 3), dtype=np.uint8)
'''


# ── Voice model training function ─────────────────────────────────────────────

@app.function(
    image=_training_image,
    gpu="A10G",
    timeout=7200,
    volumes={"/models": _model_volume},
)
def run_rvc_training(
    audio_bytes: bytes,
    voice_id: str,
    sr: int = 44100,
    n_epochs: int = 100,
) -> bytes:
    """
    Train an RVC v2 voice model from raw audio.

    Pipeline:
      1. Write audio to /rvc_webui/logs/{exp}/raw_input/full_audio.wav
      2. trainset_preprocess_pipeline_print.py → 40kHz sliced segments
      3. extract_feature_hubert40k.py → HuBERT phoneme features
      4. extract_f0_print.py (rmvpe) → pitch curves
      5. train_nsf_sim.py → fine-tune pretrained G/D for n_epochs
      6. Copy inference weight to Modal volume + return bytes

    Base models (HuBERT, RMVPE, pretrained G/D) are downloaded once and
    cached in the shared volume so subsequent training runs skip downloads.
    """
    import os
    import shutil
    import subprocess
    import sys
    import urllib.request
    from pathlib import Path

    import numpy as np
    import soundfile as sf
    import torch

    _orig_load = torch.load
    def _patched_load(*args, **kw):
        kw.setdefault("weights_only", False)
        return _orig_load(*args, **kw)
    torch.load = _patched_load

    rvc_dir = Path("/rvc_webui")
    exp_name = f"user_{voice_id}"
    exp_dir  = rvc_dir / "logs" / exp_name
    if exp_dir.exists():
        shutil.rmtree(exp_dir)   # clean slate — avoids reusing stale features on warm containers
    exp_dir.mkdir(parents=True, exist_ok=True)

    # Debug: show top-level scripts so we can catch WebUI renames early
    py_scripts = [p.name for p in rvc_dir.glob("*.py")]
    print(f"[train] WebUI root scripts: {py_scripts}", flush=True)

    # Write training audio
    audio = np.frombuffer(audio_bytes, dtype=np.float32).copy()
    raw_dir = exp_dir / "raw_input"
    raw_dir.mkdir(exist_ok=True)
    raw_wav = raw_dir / "full_audio.wav"
    sf.write(str(raw_wav), audio, sr)
    print(f"[train] audio: {len(audio)/sr:.1f}s @ {sr}Hz → {raw_wav}", flush=True)

    # ── Download / cache base models ───────────────────────────────────────────
    base_dir = Path("/models/base")
    base_dir.mkdir(exist_ok=True)
    _need_commit = False

    def _ensure(url: str, vol_path: Path, link_path: Path | None = None) -> None:
        nonlocal _need_commit
        if not vol_path.exists():
            print(f"[train] downloading {vol_path.name} …", flush=True)
            urllib.request.urlretrieve(url, vol_path)
            _need_commit = True
            print(f"[train] ✔ {vol_path.name} ({vol_path.stat().st_size/1e6:.1f} MB)", flush=True)
        if link_path and not link_path.exists():
            link_path.parent.mkdir(parents=True, exist_ok=True)
            link_path.symlink_to(vol_path)

    HF = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main"

    _ensure(
        "https://huggingface.co/r3gm/sonitranslate_voice_models/resolve/main/hubert_base.pt",
        base_dir / "hubert_base.pt",
        rvc_dir / "assets" / "hubert" / "hubert_base.pt",
    )
    _ensure(
        f"{HF}/rmvpe.pt",
        base_dir / "rmvpe.pt",
        rvc_dir / "assets" / "rmvpe" / "rmvpe.pt",
    )
    # v2 uses 48k (no v2/40k config exists); pretrained models are f0G48k / f0D48k
    _ensure(
        f"{HF}/pretrained_v2/f0G48k.pth",
        base_dir / "f0G48k.pth",
        rvc_dir / "assets" / "pretrained_v2" / "f0G48k.pth",
    )
    _ensure(
        f"{HF}/pretrained_v2/f0D48k.pth",
        base_dir / "f0D48k.pth",
        rvc_dir / "assets" / "pretrained_v2" / "f0D48k.pth",
    )
    if _need_commit:
        _model_volume.commit()

    # The feature-extraction script at commit 101deef loads models by bare filename
    # from the cwd (/rvc_webui/), not from assets/. Symlink both models into the root.
    for _fname in ["hubert_base.pt", "rmvpe.pt"]:
        _root_link = rvc_dir / _fname
        if not _root_link.exists():
            _root_link.symlink_to(base_dir / _fname)
            print(f"[train] symlinked {_fname} in rvc root", flush=True)

    # ── Config file: training script uses flat 'configs/{sr}.json' ─────────────
    # v2 configs live at configs/v2/48k.json; create flat symlink expected by script.
    # Script constructs path as configs/{sr}_{version}.json → configs/48k_v2.json
    config_dir = rvc_dir / "configs"
    config_flat = config_dir / "48k_v2.json"
    if not config_flat.exists():
        available = [str(p.relative_to(rvc_dir)) for p in config_dir.rglob("*.json")]
        print(f"[train] configs/48k_v2.json missing; available: {available}", flush=True)
        for candidate in [config_dir / "v2" / "48k.json"]:
            if candidate.exists():
                config_flat.symlink_to(candidate.resolve())
                print(f"[train] linked configs/48k_v2.json → {candidate}", flush=True)
                break
        if not config_flat.exists():
            raise RuntimeError(f"Cannot find 48k_v2.json config. Available: {available}")

    # ── Build unified lib/ and set env BEFORE any _run call ──────────────────
    # The conflict at commit 101deef: training scripts need both lib.train.utils
    # (not in repo) and lib.infer_pack (in infer_rvc_python but not rvc_webui).
    # Solution: copy infer_pack INTO /rvc_webui/lib/ and write our train stub,
    # making one self-contained lib package. PYTHONPATH = just rvc_dir.
    import importlib.util as _ilu
    lib_dir = rvc_dir / "lib"
    lib_dir.mkdir(exist_ok=True)
    (lib_dir / "__init__.py").touch()

    _spec2 = _ilu.find_spec("infer_rvc_python")
    if _spec2:
        infer_src = Path(_spec2.origin).parent / "lib" / "infer_pack"
        infer_dst = lib_dir / "infer_pack"
        if infer_src.exists() and not infer_dst.exists():
            shutil.copytree(str(infer_src), str(infer_dst))
            print(f"[train] copied infer_pack from {infer_src}", flush=True)
        elif not infer_src.exists():
            print(f"[train] WARNING: infer_rvc_python has no lib/infer_pack at {infer_src}", flush=True)

    train_dir = lib_dir / "train"
    train_dir.mkdir(exist_ok=True)
    (train_dir / "__init__.py").touch()
    (train_dir / "utils.py").write_text(_TRAIN_UTILS_STUB)
    print(f"[train] lib/ ready: {sorted(p.name for p in lib_dir.iterdir())}", flush=True)

    env    = {**os.environ, "PYTHONPATH": str(rvc_dir)}
    python = sys.executable
    print(f"[train] root .py files: {sorted(p.name for p in rvc_dir.glob('*.py'))}", flush=True)

    # Patch fairseq's checkpoint_utils.py directly so all subprocesses loading
    # legacy HuBERT/fairseq checkpoints don't fail with the PyTorch 2.6 default
    # of weights_only=True. Editing the installed source file is the only reliable
    # way to reach code running in a subprocess.
    import fairseq.checkpoint_utils as _fsc_module
    _fsc_file = Path(_fsc_module.__file__)
    _fsc_text = _fsc_file.read_text()
    _fsc_patched = _fsc_text.replace(
        'state = torch.load(f, map_location=torch.device("cpu"))',
        'state = torch.load(f, map_location=torch.device("cpu"), weights_only=False)',
    )
    if _fsc_patched != _fsc_text:
        _fsc_file.write_text(_fsc_patched)
        print("[train] patched fairseq/checkpoint_utils.py → weights_only=False", flush=True)
    else:
        print("[train] fairseq/checkpoint_utils.py already patched or pattern not found", flush=True)

    def _find(name: str) -> str:
        """Return absolute path of a training script; search root then common subdirs."""
        for candidate in [rvc_dir / name,
                          rvc_dir / "tools" / name,
                          rvc_dir / "infer" / name,
                          *list(rvc_dir.rglob(name))]:
            if candidate.exists():
                return str(candidate)
        raise FileNotFoundError(
            f"Script '{name}' not found in {rvc_dir}. "
            f"Root scripts: {sorted(p.name for p in rvc_dir.glob('*.py'))}"
        )

    def _run(script_name: str, args: list[str], desc: str) -> str:
        script = _find(script_name)
        cmd = [python, script] + args
        print(f"[train] {desc}  [{script_name}]", flush=True)
        result = subprocess.run(
            cmd,
            cwd=str(rvc_dir),
            env=env,
            timeout=3600,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        output = result.stdout.decode("utf-8", errors="replace") if result.stdout else ""
        if output:
            print(output, flush=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"'{desc}' failed (returncode={result.returncode})\n"
                f"Output tail:\n{output[-3000:]}"
            )
        return output

    # ── Step 1: Preprocess (Python, no slicer2 dependency) ────────────────────
    import librosa
    print("[train] Preprocessing audio → 48kHz segments …", flush=True)
    target_sr = 48000
    audio48k = librosa.resample(audio, orig_sr=sr, target_sr=target_sr) if sr != target_sr else audio.copy()
    max_amp = float(np.abs(audio48k).max())
    if max_amp > 0.9:
        audio48k = audio48k * (0.9 / max_amp)

    gt_dir  = exp_dir / "0_gt_wavs"
    k16_dir = exp_dir / "1_16k_wavs"
    gt_dir.mkdir(parents=True, exist_ok=True)
    k16_dir.mkdir(parents=True, exist_ok=True)

    intervals = librosa.effects.split(audio48k, top_db=20, frame_length=512, hop_length=128)
    min_chunk = int(0.3 * target_sr)
    seg_count = 0
    for seg_start, seg_end in intervals:
        chunk = audio48k[seg_start:seg_end]
        if len(chunk) < min_chunk:
            continue
        fname = f"{seg_count:04d}.wav"
        sf.write(str(gt_dir / fname), chunk, target_sr)
        chunk16k = librosa.resample(chunk, orig_sr=target_sr, target_sr=16000)
        sf.write(str(k16_dir / fname), chunk16k, 16000)
        seg_count += 1
    print(f"[train] preprocessing: {seg_count} segments from {len(audio)/sr:.1f}s audio", flush=True)
    if seg_count == 0:
        raise RuntimeError("Preprocessing produced 0 segments — check audio quality/volume")

    # ── Step 2: HuBERT feature extraction ─────────────────────────────────────
    feat_out = _run("extract_feature_print.py",
                    ["0", "1", "0", str(exp_dir), "v2"],
                    "Extracting HuBERT features")

    feat_dir = exp_dir / "3_feature768"
    feat_files = sorted(feat_dir.glob("*.npy")) if feat_dir.exists() else []
    all_exp = sorted(str(p.relative_to(exp_dir)) for p in exp_dir.rglob("*") if p.is_file())
    print(f"[train] after feature extract: {len(feat_files)} npy in {feat_dir.name}, all={all_exp[:20]}", flush=True)
    if not feat_files:
        raise RuntimeError(
            f"extract_feature_print.py produced no output in {feat_dir}.\n"
            f"Script output:\n{feat_out[-2000:]}\n"
            f"Exp dir files: {all_exp[:30]}"
        )

    # ── Step 3: F0 extraction (rmvpe) ─────────────────────────────────────────
    _run("extract_f0_print.py",
         [str(exp_dir), "2", "rmvpe"],
         "Extracting F0")

    # ── Generate filelists + patch config with training_files ─────────────────
    # The training script reads hps.data.training_files to find its dataset.
    # We bypassed the preprocessing script, so we create the filelist ourselves.
    # Format: gt_wav|feature_npy|f0_npy|f0nsf_npy|speaker_id (5 columns).
    import json as _json

    gt_wavs = sorted(gt_dir.glob("*.wav"))
    n_val   = max(1, len(gt_wavs) // 10)
    train_wavs = gt_wavs[n_val:]
    val_wavs   = gt_wavs[:n_val]

    feat_dir_path = exp_dir / "3_feature768"
    f0_dir        = exp_dir / "2a_f0"
    f0nsf_dir     = exp_dir / "2b-f0nsf"

    def _resolve_derived(stem: str, directory: Path) -> Path | None:
        for candidate in [directory / f"{stem}.npy", directory / f"{stem}.wav.npy"]:
            if candidate.exists():
                return candidate
        return None

    def _write_filelist(wavs: list, out_path: Path) -> int:
        written = 0
        with open(out_path, "w") as fh:
            for wav in wavs:
                stem  = wav.stem
                feat  = _resolve_derived(stem, feat_dir_path)
                f0    = _resolve_derived(stem, f0_dir)
                f0nsf = _resolve_derived(stem, f0nsf_dir)
                if feat and f0 and f0nsf:
                    fh.write(f"{wav}|{feat}|{f0}|{f0nsf}|0\n")
                    written += 1
        return written

    filelist_train = exp_dir / "filelist_train.txt"
    filelist_val   = exp_dir / "filelist_val.txt"
    n_train = _write_filelist(train_wavs, filelist_train)
    n_val   = _write_filelist(val_wavs,   filelist_val)
    print(f"[train] filelists: train={n_train} val={n_val}", flush=True)
    if n_train == 0:
        _f0_names   = sorted(p.name for p in f0_dir.glob("*.npy"))         if f0_dir.exists()    else []
        _feat_names = sorted(p.name for p in feat_dir_path.glob("*.npy"))  if feat_dir_path.exists() else []
        raise RuntimeError(
            f"Filelist empty — no entries matched feature/f0/f0nsf files.\n"
            f"2a_f0 (first 5): {_f0_names[:5]}\n"
            f"3_feature768 (first 5): {_feat_names[:5]}"
        )

    # Patch the config JSON to add training_files / validation_files.
    # The symlink configs/48k_v2.json → configs/v2/48k.json is replaced with
    # a real file that includes the dataset paths for this run.
    _cfg_src = rvc_dir / "configs" / "v2" / "48k.json"
    _cfg_flat = rvc_dir / "configs" / "48k_v2.json"
    with open(_cfg_src) as _fj:
        _cfg = _json.load(_fj)
    _cfg.setdefault("data", {})
    _cfg["data"]["training_files"]   = str(filelist_train)
    _cfg["data"]["validation_files"] = str(filelist_val)
    if _cfg_flat.is_symlink() or _cfg_flat.exists():
        _cfg_flat.unlink()
    with open(_cfg_flat, "w") as _fj:
        _json.dump(_cfg, _fj, indent=2)
    print(f"[train] config patched with training_files={filelist_train}", flush=True)

    # ── Step 4: Training ───────────────────────────────────────────────────────
    pretrained_g = rvc_dir / "assets" / "pretrained_v2" / "f0G48k.pth"
    pretrained_d = rvc_dir / "assets" / "pretrained_v2" / "f0D48k.pth"
    train_out = _run("train_nsf_sim_cache_sid_load_pretrain.py",
         ["-e", exp_name,
          "-sr", "48k",
          "-f0", "1",
          "-bs", "4",
          "-g", "0",
          "-te", str(n_epochs),
          "-se", str(min(n_epochs, 10)),
          "-v", "v2",
          "-l", "1",           # save latest checkpoint only
          "-c", "0",           # don't cache full dataset in GPU VRAM
          "-sw", "1",          # save inference weight after each checkpoint save
          "-pg", str(pretrained_g),
          "-pd", str(pretrained_d),
         ],
         f"Training {n_epochs} epochs")

    # ── Locate G checkpoint and convert to inference weight ───────────────────
    # The -sw 1 flag's export step relies on lib functions we don't have, so
    # we convert the raw G_ checkpoint to the format infer_rvc_python expects:
    # {"weight": state_dict, "config": arch_list, "sr", "f0", "version", "info"}
    weights_dir = rvc_dir / "weights"
    g_chkpts = sorted(
        list(exp_dir.glob("G_*.pth")) + list(weights_dir.glob(f"{exp_name}_*.pth")),
        key=lambda p: p.stat().st_mtime,
    )
    if not g_chkpts:
        all_pth = sorted(str(p.relative_to(rvc_dir)) for p in rvc_dir.rglob("*.pth"))
        raise RuntimeError(
            f"Training produced no .pth files\n"
            f"All .pth under rvc_dir: {all_pth[:20]}\n"
            f"Train output tail:\n{train_out[-3000:]}"
        )
    g_src = g_chkpts[-1]
    print(f"[train] converting {g_src.name} → inference weight …", flush=True)

    import json as _json2
    g_raw = torch.load(str(g_src), map_location="cpu")

    # Raw checkpoint has {model, iteration, optimizer, learning_rate}.
    # An already-converted inference weight has {weight, config, sr, f0, version}.
    if "weight" in g_raw and "config" in g_raw:
        infer_weight = g_raw          # already the right format
        print(f"[train] checkpoint already in inference-weight format", flush=True)
    else:
        # Read architecture params from the config JSON we wrote
        with open(str(_cfg_flat)) as _f:
            _cfg2 = _json2.load(_f)
        d = _cfg2.get("data",  {})
        m = _cfg2.get("model", {})
        t = _cfg2.get("train", {})
        # Config list matches SynthesizerTrnMs768NSFsid positional args
        config_list = [
            d.get("filter_length", 2048) // 2 + 1,            # spec_channels
            t.get("segment_size", 12800) // d.get("hop_length", 512),  # segment_size
            m.get("inter_channels", 192),
            m.get("hidden_channels", 192),
            m.get("filter_channels", 768),
            m.get("n_heads", 2),
            m.get("n_layers", 6),
            m.get("kernel_size", 3),
            m.get("p_dropout", 0),
            m.get("resblock", "1"),
            m.get("resblock_kernel_sizes", [3, 7, 11]),
            m.get("resblock_dilation_sizes", [[1,3,5],[1,3,5],[1,3,5]]),
            m.get("upsample_rates", [10, 4, 2, 2, 2]),
            m.get("upsample_initial_channel", 512),
            m.get("upsample_kernel_sizes", [20, 8, 4, 4, 4]),
            d.get("spk_embed_dim", 109),
            m.get("gin_channels", 256),
            48000,  # sr — required positional arg in infer_rvc_python's SynthesizerTrnMs768NSFsid
        ]
        model_state = g_raw.get("model", g_raw)
        epoch_num   = g_raw.get("iteration", n_epochs)
        infer_weight = {
            "weight":  model_state,
            "config":  config_list,
            "info":    f"epoch={epoch_num}",
            "sr":      "48k",
            "f0":      1,
            "version": "v2",
        }
        print(f"[train] built inference weight: epoch={epoch_num} config={config_list[:4]}…", flush=True)

    infer_path = exp_dir / "infer_model.pth"
    torch.save(infer_weight, str(infer_path))

    # ── Persist to volume ──────────────────────────────────────────────────────
    vol_dir   = Path(f"/models/rvc/user_{voice_id}")
    vol_dir.mkdir(parents=True, exist_ok=True)
    vol_model = vol_dir / "model.pth"
    shutil.copy2(infer_path, vol_model)
    _model_volume.commit()
    print(f"[train] ✔ model committed to volume ({vol_model.stat().st_size/1e6:.1f} MB)", flush=True)

    return vol_model.read_bytes()
