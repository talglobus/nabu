"""Quarantined CosyVoice2 inference implementation (ADR 0059, superseded by ADR 0090).

The CLI is disabled. Do not import and run this legacy environment; see the adjacent README.

The pipeline starts it as a subprocess (nabu.audio.providers.CosyVoiceWorker) and talks to it in
JSON lines. Its first line on stdin says what to load:

    {"runtime": {"url": <git URL>, "revision": <40 hex>},
     "base": {"repo": <HF repo>, "revision": <40 hex>},
     "checkpoint": {"repo": <HF repo>, "revision": <40 hex>, "file": <.pt>, "sha256": <64 hex>},
     "normalizer": <module of the checkpoint repo with normalize(text, mode="infer")> | null}

and it answers {"ready": {"sampleRate": 24000, "torch": <version>, "source": <the checkout>}}.
Every later line asks for one clip:

    {"text": ..., "instruct": ..., "prompt": <WAV path>, "seed": n, "speed": 1.0}

answered {"pcm": <base64 s16le, mono>, "text": <what the model read>} or {"error": ...}.

It follows the checkpoint's own inference.py (aisha-org/navoiy-tts): the base model at its pinned
revision, the fine-tuned LLM loaded over it, inference_instruct2 with the instruction and a
prompt recording. Two differences: it runs in float32, on a GPU too (upstream uses float16
there), and it skips CosyVoice's English/Chinese text frontend (the checkpoint's normalizer does
that work for its language). Seeds are set per clip, so a clip does not depend on earlier ones.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import os
import random
import subprocess
import sys
from pathlib import Path
from typing import Any

CACHE = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "nabu" / "cosyvoice"
#: What CosyVoice2 loads of its base model (not the TensorRT and batch exports beside them).
BASE_FILES = [
    "cosyvoice2.yaml",
    "llm.pt",
    "flow.pt",
    "hift.pt",
    "campplus.onnx",
    "speech_tokenizer_v2.onnx",
    "CosyVoice-BlankEN/*",
]


def source(url: str, revision: str) -> Path:
    """The CosyVoice source at that commit, with its Matcha-TTS submodule (cached)."""
    root = CACHE / revision
    if (root / ".nabu-ready").exists():
        return root
    root.mkdir(parents=True, exist_ok=True)

    def git(*args: str, cwd: Path = root) -> None:
        subprocess.run(["git", *args], cwd=cwd, check=True, stdout=sys.stderr)

    if not (root / ".git").exists():
        git("init", "-q")
        git("remote", "add", "origin", url)
    git("fetch", "-q", "--filter=blob:none", "origin", revision)
    git("checkout", "-q", "--force", revision)
    git("submodule", "update", "-q", "--init", "--recursive")
    (root / ".nabu-ready").write_text(revision + "\n", encoding="utf-8")
    return root


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def unwrap_state_dict(value: Any) -> Any:
    """As inference.py: a checkpoint may nest the LLM's weights under state_dict, model or llm."""
    if not isinstance(value, dict):
        return value
    for key in ("state_dict", "model", "llm"):
        nested = value.get(key)
        if isinstance(nested, dict):
            return unwrap_state_dict(nested)
    return value


def release_memory() -> None:
    """Hands the heap that loading freed (the base LLM's weights, replaced) back to the system:
    the model is used beside others on machines without much memory to spare."""
    import contextlib
    import ctypes
    import gc

    gc.collect()
    with contextlib.suppress(OSError, AttributeError):  # not glibc
        ctypes.CDLL("libc.so.6").malloc_trim(0)


class Engine:
    def __init__(self, config: dict[str, Any]) -> None:
        from huggingface_hub import hf_hub_download, snapshot_download

        self.source = runtime = source(config["runtime"]["url"], config["runtime"]["revision"])
        sys.path[:0] = [str(runtime), str(runtime / "third_party" / "Matcha-TTS")]
        import torch
        from cosyvoice.cli.cosyvoice import CosyVoice2

        self.torch = torch
        base = snapshot_download(
            config["base"]["repo"], revision=config["base"]["revision"], allow_patterns=BASE_FILES
        )
        ckpt = config["checkpoint"]
        weights = Path(hf_hub_download(ckpt["repo"], ckpt["file"], revision=ckpt["revision"]))
        if sha256_of(weights) != ckpt["sha256"]:
            raise ValueError(f"{ckpt['repo']}/{ckpt['file']}: sha256 differs from the pinned one")
        self.normalize = None
        if config.get("normalizer"):
            code = snapshot_download(
                ckpt["repo"], revision=ckpt["revision"], allow_patterns=["*.py", "**/*.py"]
            )
            sys.path.insert(0, code)
            self.normalize = importlib.import_module(config["normalizer"]).normalize
        # float32 on a GPU too (upstream: float16), so a clip does not depend on the machine.
        self.model = CosyVoice2(base, load_jit=False, load_trt=False, fp16=False)
        # Mapped, not read: the 2 GB checkpoint is copied into the model, never held twice.
        state = torch.load(weights, map_location="cpu", weights_only=True, mmap=True)
        result = self.model.model.llm.load_state_dict(unwrap_state_dict(state), strict=False)
        if result.missing_keys or result.unexpected_keys:
            print(
                f"checkpoint: {len(result.missing_keys)} missing, "
                f"{len(result.unexpected_keys)} unexpected keys",
                file=sys.stderr,
            )
        self.model.model.llm.eval()
        del state
        release_memory()
        self.sample_rate = int(self.model.sample_rate)

    def speak(
        self, text: str, instruct: str, prompt: str, seed: int, speed: float
    ) -> tuple[bytes, str]:
        torch = self.torch
        read = self.normalize(text, mode="infer") if self.normalize else text
        random.seed(seed)
        torch.manual_seed(seed)
        chunks = []
        with torch.inference_mode():
            for out in self.model.inference_instruct2(
                read,
                instruct.strip() + "<|endofprompt|>",
                prompt,
                stream=False,
                speed=speed,
                text_frontend=False,
            ):
                chunks.append(out["tts_speech"].detach().cpu())
        if not chunks:
            return b"", read
        audio = torch.cat(chunks, dim=1)[0].clamp(-1.0, 1.0)
        pcm = (audio * 32767.0).round().to(torch.int16).numpy().astype("<i2").tobytes()
        return pcm, read


def main() -> None:
    # The protocol owns the real stdout; anything the libraries print goes to stderr.
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)

    def send(message: dict[str, Any]) -> None:
        proto.write(json.dumps(message, ensure_ascii=False) + "\n")
        proto.flush()

    config = json.loads(sys.stdin.readline())
    engine = Engine(config)
    send(
        {
            "ready": {
                "sampleRate": engine.sample_rate,
                "torch": engine.torch.__version__,
                "source": str(engine.source),
            }
        }
    )
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            pcm, read = engine.speak(
                req["text"], req["instruct"], req["prompt"], int(req["seed"]), float(req["speed"])
            )
            send({"pcm": base64.b64encode(pcm).decode("ascii"), "text": read})
        except Exception as error:  # one bad clip does not end the run
            send({"error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    sys.exit(
        "CosyVoice generation is disabled: the legacy environment has known code-execution "
        "vulnerabilities. Use committed audio; see pipeline/runtimes/cosyvoice/README.md."
    )
