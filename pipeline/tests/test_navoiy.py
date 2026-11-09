"""Navoiy (ADR 0059): a CosyVoice2 fine-tune as the uz course's voice.

A stand-in engine tests the plumbing: what the model is asked (the style instruction, the
reference to clone, a seed per clip, the rate), the reference's bookkeeping, and the worker
protocol. Its samples are silence, never presented as the model's speech. Real synthesis needs
the CosyVoice runtime (pipeline/runtimes/cosyvoice) and the checkpoint, and runs only with
NABU_NAVOIY=1 (`test_live_*`).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
import yaml

from nabu.audio import espeak, providers
from nabu.audio.course import (
    align_course,
    audio_dir,
    cast_reference,
    read_index,
    reference_of,
    synthesize_course,
)
from nabu.audio.providers import (
    CosyVoiceWorker,
    NavoiyProvider,
    ProviderError,
    Reference,
    Request,
    seed_of,
)
from nabu.compiler import compile_course
from nabu.schema.models import AudioVoice, Provenance

from .conftest import ROOT, CoreCli

REVISION = "9445f41ee5f38bd3a34eb16b0279dc05f9997fc2"


def voice(**extra: Any) -> AudioVoice:
    return AudioVoice.model_validate(
        {
            "id": "navoiy",
            "provider": "navoiy",
            "voice": "toshkent-f",
            "model": f"aisha-org/navoiy-tts@{REVISION}",
            "orthography": "uz-Latn/standard",
            "reading": "text",
            "license": "Apache-2.0",
            **extra,
        }
    )


class FakeEngine:
    """Records what it is asked; speaks silence."""

    sampling_rate = 24000

    def __init__(self, source: Path = Path("/nowhere")) -> None:
        self.source = source
        self.calls: list[dict[str, Any]] = []

    def speak(self, text: str, instruct: str, prompt: Path, seed: int, speed: float) -> bytes:
        self.calls.append(
            {"text": text, "instruct": instruct, "prompt": prompt, "seed": seed, "speed": speed}
        )
        return b"\0\0" * 2400


def fake(engine: FakeEngine, v: AudioVoice, ref: Reference | None) -> NavoiyProvider:
    return NavoiyProvider(v, ref, load=lambda _repo, _rev: engine)


REF = Reference(Path("voices/toshkent-f.wav"), "Salom!", "b" * 64)


def test_a_voice_needs_its_reference() -> None:
    with pytest.raises(ValueError, match="nabu audio cast"):
        fake(FakeEngine(), voice(), None)


def test_every_clip_clones_the_reference_calmly_with_a_seed_of_its_own() -> None:
    engine = FakeEngine()
    tts = fake(engine, voice(), REF)
    requests = [
        Request("Choy iching!", "toshkent-f", 1.0),
        Request("Choy iching!", "toshkent-f", 0.67),
    ]
    clips = tts.synthesize(requests)
    assert [c["seed"] for c in engine.calls] == [seed_of(r) for r in requests]
    assert {c["prompt"] for c in engine.calls} == {REF.path}
    assert {c["instruct"] for c in engine.calls} == {NavoiyProvider.INSTRUCT}
    assert [c["speed"] for c in engine.calls] == [1.0, 0.67]
    assert [(c.sample_rate, len(c.pcm), c.words) for c in clips] == [(24000, 4800, None)] * 2


def test_version_and_settings_name_the_checkpoint_its_runtime_and_the_reference() -> None:
    tts = fake(FakeEngine(), voice(), REF)
    assert tts.version() == f"aisha-org/navoiy-tts#{REVISION}+cosyvoice-074ca6dc9e80"
    assert tts.settings() == {
        "base": "FunAudioLLM/CosyVoice2-0.5B#eec1ae6c79877dbd9379285cf8789c9e0879293d",
        "style": "calm",
        "dtype": "float32",
        "reference": REF.sha256,
    }
    Provenance.model_validate({"author": f"generated:navoiy@{tts.version()}", "status": "draft"})


def test_only_known_checkpoints_load() -> None:
    with pytest.raises(ValueError, match="not a known Navoiy checkpoint"):
        providers.load_navoiy("someone/else", REVISION)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_casting_clones_the_pinned_prompt_recording(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    course = tmp_path / "uz"
    shutil.copytree(ROOT / "courses" / "uz", course, ignore=shutil.ignore_patterns("audio"))
    source = tmp_path / "cosyvoice"
    (source / "asset").mkdir(parents=True)
    prompt = source / "asset" / "zero_shot_prompt.wav"
    prompt.write_bytes(b"a stand-in prompt")
    digest = hashlib.sha256(prompt.read_bytes()).hexdigest()
    monkeypatch.setattr(
        providers, "NAVOIY_PROMPT", ("asset/zero_shot_prompt.wav", digest, "Apache-2.0")
    )
    engine = FakeEngine(source)
    v = voice()
    ref = cast_reference(
        course, v, "Salom! Men Dilnozaman.", NavoiyProvider.INSTRUCT, 3, fake(engine, v, REF)
    )
    assert engine.calls == [
        {
            "text": "Salom! Men Dilnozaman.",
            "instruct": NavoiyProvider.INSTRUCT,
            "prompt": prompt,
            "seed": 3,
            "speed": 1.0,
        }
    ]
    adir = audio_dir(course)
    assert reference_of(adir, read_index(adir), "toshkent-f") is not None
    assert ref.license == "Apache-2.0" and ref.synthetic
    assert ref.design is not None and ref.design.prompt is not None
    assert ref.design.prompt.sha256 == digest
    assert ref.design.prompt.source.endswith(
        "/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/asset/zero_shot_prompt.wav"
    )
    assert ref.design.dtype == "float32" and ref.design.language == "uz"

    # A prompt that is not the pinned recording is refused.
    prompt.write_bytes(b"another recording")
    with pytest.raises(ProviderError, match="pinned prompt"):
        cast_reference(course, v, "Salom!", NavoiyProvider.INSTRUCT, 3, fake(engine, v, REF))


@dataclass(frozen=True)
class Span:
    start_ms: int
    end_ms: int


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or not espeak.available(), reason="needs ffmpeg and eSpeak NG"
)
def test_clips_without_timings_get_them_by_forced_alignment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, core_cli: CoreCli
) -> None:
    course = tmp_path / "uz"
    shutil.copytree(ROOT / "courses" / "uz", course, ignore=shutil.ignore_patterns("audio"))
    (tmp_path / "images").symlink_to(ROOT / "courses" / "images")
    source = tmp_path / "cosyvoice"
    (source / "asset").mkdir(parents=True)
    (source / "asset" / "zero_shot_prompt.wav").write_bytes(b"prompt")
    digest = hashlib.sha256(b"prompt").hexdigest()
    monkeypatch.setattr(providers, "NAVOIY_PROMPT", ("asset/zero_shot_prompt.wav", digest, "MIT"))
    engine = FakeEngine(source)
    monkeypatch.setitem(providers.PROVIDERS, "navoiy", lambda v, r: fake(engine, v, r))
    v = voice()
    cast_reference(course, v, "Salom!", NavoiyProvider.INSTRUCT, 0, fake(engine, v, REF))
    diags, compiled = compile_course(course, core_cli)
    assert compiled is not None
    intro: list[dict[str, Any]] = [
        {**u, "stories": []} for u in compiled.units if u["id"] == "intro"
    ]
    synthesize_course(course, intro, v, None, compiled.written)
    adir = audio_dir(course)
    assert all(c.timings is None for c in read_index(adir).clips)

    asked: list[list[list[str]]] = []

    def aligner(pcm: bytes, rate: int, words: list[list[str]]) -> list[Span]:
        # 100 ms of silence per clip: the words share it evenly.
        assert rate == 16_000 and len(pcm) > 0
        asked.append(words)
        step = 100 // len(words)
        return [Span(i * step, (i + 1) * step) for i in range(len(words))]

    done = align_course(course, intro, v, "uz", compiled.written, aligner)
    index = read_index(adir)
    assert done == len(index.clips) > 0
    assert all(c.timingSource == "alignment" and c.timings for c in index.clips)
    # Each word's phones, from eSpeak NG: "Bu mening kitobim." is three words.
    s23 = next(c for c in index.clips if c.item == "s.23" and c.speed == "normal")
    assert s23.timings is not None and len(s23.timings) == 3
    assert all(all(w) for words in asked for w in words)
    diags, _ = compile_course(course, core_cli)
    assert not [d for d in diags.items if d.lint == "audio.timings"]
    # Aligned clips are not aligned again.
    assert align_course(course, intro, v, "uz", compiled.written, aligner) == 0


FAKE_WORKER = """
import base64, json, sys
print("library noise", file=sys.stderr)
config = json.loads(sys.stdin.readline())
print(json.dumps({"ready": {"sampleRate": 24000, "torch": "0", "source": "/src"}}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if req["text"] == "boom":
        print(json.dumps({"error": "RuntimeError: boom"}), flush=True)
        continue
    pcm = b"\\x01\\x00" * int(10 * len(req["text"]) / req["speed"])
    answer = {"pcm": base64.b64encode(pcm).decode(), "text": req["text"]}
    print(json.dumps(answer), flush=True)
"""


def test_the_worker_protocol(tmp_path: Path) -> None:
    script = tmp_path / "worker.py"
    script.write_text(FAKE_WORKER, encoding="utf-8")
    worker = CosyVoiceWorker({"checkpoint": {}}, command=[sys.executable, str(script)])
    try:
        assert (worker.sampling_rate, worker.source) == (24000, Path("/src"))
        assert worker.speak("Salom", "calm", Path("p.wav"), 1, 1.0) == b"\x01\x00" * 50
        assert len(worker.speak("Salom", "calm", Path("p.wav"), 1, 0.5)) == 200
        with pytest.raises(ProviderError, match="boom"):
            worker.speak("boom", "calm", Path("p.wav"), 1, 1.0)
        # One bad clip does not end the run.
        assert worker.speak("Ha", "calm", Path("p.wav"), 1, 1.0) == b"\x01\x00" * 20
    finally:
        worker.close()
    assert worker.process.returncode == 0


def test_a_worker_that_dies_is_an_error(tmp_path: Path) -> None:
    script = tmp_path / "worker.py"
    script.write_text("import sys; sys.exit(3)\n", encoding="utf-8")
    with pytest.raises(ProviderError, match="exited"):
        CosyVoiceWorker({}, command=[sys.executable, str(script)])


def test_legacy_runtime_is_blocked_before_starting_a_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_spawn(*args: Any, **kwargs: Any) -> None:
        pytest.fail("the disabled runtime must not start uv or download code")

    monkeypatch.setattr(subprocess, "Popen", unexpected_spawn)
    with pytest.raises(ProviderError, match="disabled"):
        providers.load_navoiy("aisha-org/navoiy-tts", REVISION)


def test_direct_worker_entry_point_is_disabled() -> None:
    result = subprocess.run(
        [sys.executable, str(providers.COSYVOICE_RUNTIME / "worker.py")],
        input="{}\n",
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode != 0
    assert "disabled" in result.stderr
    assert result.stdout == ""


def test_failed_worker_startup_closes_the_process(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    script = tmp_path / "worker.py"
    script.write_text(
        'import sys\nprint(\'{"error": "bad model"}\', flush=True)\nsys.stdin.read()\n'
    )
    popen = subprocess.Popen
    children: list[subprocess.Popen[str]] = []

    def start(*args: Any, **kwargs: Any) -> subprocess.Popen[str]:
        child = popen(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(subprocess, "Popen", start)
    with pytest.raises(ProviderError, match="bad model"):
        CosyVoiceWorker({}, command=[sys.executable, str(script)])
    assert len(children) == 1
    assert children[0].poll() is not None
    assert children[0].stdin is not None and children[0].stdin.closed
    assert children[0].stdout is not None and children[0].stdout.closed


def test_the_runtime_pins_what_the_provider_expects() -> None:
    """The runtime's pyproject keeps CosyVoice's stack; the worker reads what the provider sends."""
    runtime = providers.COSYVOICE_RUNTIME
    pyproject = (runtime / "pyproject.toml").read_text("utf-8")
    for pin in ('"torch==2.3.1"', '"transformers==4.51.3"', '"numpy==1.26.4"'):
        assert pin in pyproject
    assert (runtime / "uv.lock").exists()
    worker = (runtime / "worker.py").read_text("utf-8")
    for key in ('config["runtime"]', 'config["base"]', 'config["checkpoint"]', '"normalizer"'):
        assert key in worker
    json.dumps(providers.NAVOIY_WEIGHTS)


LIVE = os.environ.get("NABU_NAVOIY") == "1"


@pytest.mark.skipif(not LIVE, reason="NABU_NAVOIY=1, the CosyVoice runtime and the checkpoint")
def test_live_the_course_voice_speaks_uzbek() -> None:
    from nabu.audio.qa import cer, transcribe

    source = yaml.safe_load((ROOT / "courses" / "uz" / "course.yaml").read_text("utf-8"))
    v = AudioVoice.model_validate(source["audio"]["voices"][0])
    adir = audio_dir(ROOT / "courses" / "uz")
    tts = NavoiyProvider(v, reference_of(adir, read_index(adir), v.voice))
    [clip] = tts.synthesize([Request("Men choy ichaman.", v.voice, 1.0)])
    assert 0.5 < len(clip.pcm) / 2 / clip.sample_rate < 6
    assert cer(transcribe(clip, "uz"), "Men choy ichaman.") <= 0.2
