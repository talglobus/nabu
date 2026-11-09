"""TTS providers behind one interface (gameplan §10.1).

A provider turns requests (input string, voice, relative speed) into PCM. Every clip is then
identified by (provider, version, voice, input, rate), so regenerating a course re-synthesizes
only what changed. Two local providers:

- **espeak-ng**: rule-based, deterministic, small. Reads pinned readings exactly (its
  `yue-Latn-jyutping` voice takes Jyutping), and reports word onsets, so its clips carry exact
  timings. Robotic: the round-trip check usually sends its clips to review.
- **piper**: neural (VITS, ONNX). Natural-sounding where a voice exists; reads text or eSpeak
  phonemes in `[[ ]]`. Its voices carry their own licenses, which the course must declare
  (`AudioVoice.license`): several Piper voices derive from datasets with restrictive terms. A
  voice can be pinned outside rhasspy/piper-voices (`model`), and can say short items inside a
  carrier sentence (`carrier`, ADR 0065). Seeded; no timings.

Two hosted providers, for languages the local voices serve badly (ADR 0042):

- **elevenlabs** (Eleven v4): reads inline IPA between slashes, so pinned readings the
  spelling does not settle (Cantonese polyphones) are passed as IPA; reports per-character
  timestamps. Speed 0.7-1.2.
- **cartesia** (Sonic): word timestamps over server-sent events; speed 0.6-1.5; no seed.

One local model for dialects the others do not serve (ADR 0058):

- **omnivoice**: OmniVoice checkpoints from Hugging Face, run on this machine. The Lahgtna
  fine-tune reads Arabic dialects, Lebanese among them (language id "lb"), and reads vowel marks.
  Every clip clones the course's reference voice (`nabu audio cast`), so one course voice is one
  speaker; each clip's sampling is seeded from its identity. No timings.

Hosted providers read their key from the environment (ELEVENLABS_API_KEY, CARTESIA_API_KEY),
never from course files, and only when synthesizing. Their audio is not reproducible
bit-for-bit (the provider's model may change under the same id); clips are committed, so
builds stay deterministic, and the round-trip check reviews each new clip.
"""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from array import array
from collections.abc import Callable
from dataclasses import dataclass, replace
from functools import cache
from pathlib import Path
from typing import Any, ClassVar, Protocol
from urllib.parse import quote

import regex

from nabu.audio import espeak
from nabu.audio.phones import optional
from nabu.schema.models import AudioVoice


@dataclass(frozen=True)
class Request:
    input: str
    voice: str
    #: Relative speed: 1 normal, below 1 slower.
    rate: float = 1.0
    #: Which attempt (ADR 0060): a clip a listener rejected is made again with the next take,
    #: which a seeded provider samples with another seed.
    take: int = 0


@dataclass(frozen=True)
class Reference:
    """A reference voice a cloning provider imitates: the recording and what it says."""

    path: Path
    text: str
    sha256: str


@dataclass(frozen=True)
class Clip:
    pcm: bytes  # s16le mono
    sample_rate: int
    #: Onsets the synthesizer reports, of words or characters: (code point offset in the input,
    #: ms); None if unknown.
    words: tuple[tuple[int, int], ...] | None
    #: What the synthesizer says it spoke (phonemes), for QA.
    trace: str | None


class Provider(Protocol):
    name: str
    #: Whether its audio depends on a seed (`seed_of`): only then does a new take sound different.
    seeded: bool

    def version(self) -> str: ...

    def settings(self) -> dict[str, Any]:
        """What shapes the audio besides voice, input and rate: part of each clip's identity."""
        ...

    def speed(self, rate: float) -> float:
        """The rate the provider will actually use for a requested one."""
        ...

    def synthesize(self, requests: list[Request]) -> list[Clip]: ...


class EspeakProvider:
    name = "espeak-ng"
    seeded = False

    def version(self) -> str:
        return espeak.version()

    def settings(self) -> dict[str, Any]:
        return {}

    def speed(self, rate: float) -> float:
        return rate

    def synthesize(self, requests: list[Request]) -> list[Clip]:
        jobs = [espeak.Job(r.input, r.voice, round(espeak.RATE_NORMAL * r.rate)) for r in requests]
        out: list[Clip] = []
        for request, s in zip(requests, espeak.synthesize_all(jobs), strict=True):
            # Phoneme input ([[...]], ADR 0082) is what was said; eSpeak's text-to-phonemes call
            # would read the brackets' mnemonics as letters.
            trace = (
                request.input
                if "[[" in request.input
                else " ".join("".join(w) for w in espeak.phonemes(request.input, request.voice))
            )
            words = tuple((w.start, w.ms) for w in s.words if w.length > 0)
            out.append(Clip(s.pcm, s.sample_rate, words, trace))
        return out


PIPER_REPO = "rhasspy/piper-voices"


@cache
def _piper_files(voice: str, model: str | None) -> tuple[Path, Path]:
    """A Piper voice's .onnx and .onnx.json: from rhasspy/piper-voices by id
    ("fa_IR-amir-medium"), or, with `model` ("owner/name@<commit>"), the files named after the
    voice in that repo at that commit."""
    hub = optional("huggingface_hub")
    if model is None:
        lang, name, quality = voice.split("-", 2)
        repo, revision, stem = (
            PIPER_REPO,
            None,
            f"{lang.split('_')[0]}/{lang}/{name}/{quality}/{voice}",
        )
    else:
        (repo, revision), stem = checkpoint(model), voice
    onnx = hub.hf_hub_download(repo, f"{stem}.onnx", revision=revision)
    config = hub.hf_hub_download(repo, f"{stem}.onnx.json", revision=revision)
    return Path(onnx), Path(config)


#: Phoneme input for Piper: IPA words in [[ ]], space-separated, an optional final . or ?
PIPER_WORD = regex.compile(r"\[\[([^\]]*)\]\]")
PIPER_PHONEMES = regex.compile(r"(?:\[\[[^\]]*\]\] ?)+[.?]?")
#: What a voice that lacks an IPA symbol says instead: eSpeak NG's tables write g as IPA ɡ, and a
#: voice of a language without aspiration says it as a following h.
PIPER_FALLBACKS = {"g": "\u0261", "\u02b0": "h"}


class PiperProvider:
    """Piper voices (VITS, ONNX): from rhasspy/piper-voices by id, or a voice pinned elsewhere on
    Hugging Face (`model`: owner/name@commit, `voice`: the file stem). Sampling is seeded per clip
    (`seed_of`). Sentences are joined with SENTENCE_GAP_MS of silence.

    With a `carrier` (ADR 0065), an item of at most `maxWords` words is said at the end of the
    carrier sentence with durations set from it, and cut out (nabu.audio.carrier). So is any
    sentence of a longer item that the model would collapse (`carrier.collapses`); the item's
    other sentences are said as they are. `item_settings` names that route, so only the items
    it changes have new identities."""

    name = "piper"
    seeded = True
    SENTENCE_GAP_MS = 200
    #: The sampling noise (Piper's default); the duration noise is off on the carrier path.
    NOISE_SCALE = 0.667

    def __init__(self, voice: AudioVoice | None = None) -> None:
        self.voice = voice.voice if voice is not None else None
        self.model = voice.model if voice is not None else None
        carrier = voice.carrier if voice is not None else None
        self.carrier = carrier.text if carrier is not None else None
        self.max_words = carrier.maxWords if carrier is not None else 0

    def version(self) -> str:
        from importlib.metadata import version

        package = version("piper-tts")
        if self.model is None:
            return package
        repo, revision = checkpoint(self.model)
        # No spaces or "@": it also names the clips' author (generated:piper@<version>).
        return f"{repo}#{revision}+piper-{package}"

    def settings(self) -> dict[str, Any]:
        if self.model is None and self.carrier is None:
            return {}
        out: dict[str, Any] = {
            "sentenceGapMs": self.SENTENCE_GAP_MS,
            "noiseScale": self.NOISE_SCALE,
        }
        if self.carrier is not None:
            from nabu.audio import carrier

            out["carrier"] = {
                "text": self.carrier,
                "maxWords": self.max_words,
                "method": carrier.METHOD,
            }
        return out

    def speed(self, rate: float) -> float:
        return rate

    @staticmethod
    @cache
    def _engine(voice: str, model: str | None) -> Any:
        piper = optional("piper")
        onnx, _config = _piper_files(voice, model)
        return piper.PiperVoice.load(onnx), onnx.read_bytes()

    @staticmethod
    @cache
    def _split(voice: str, model: str | None) -> tuple[Any, bytes]:
        """The duration-reading session (deterministic: no duration noise), and the graph that
        takes durations, for a fresh seeded session per clip."""
        from nabu.audio import carrier

        ort = optional("onnxruntime")
        _engine, raw = PiperProvider._engine(voice, model)
        reading, given = carrier.split(raw)
        return ort.InferenceSession(reading, providers=["CPUExecutionProvider"]), given

    def _session(self, graph: bytes, seed: int) -> Any:
        """Piper's sampling draws from onnxruntime's generator, which a seed sets only for a
        session made after it."""
        ort = optional("onnxruntime")
        ort.set_seed(seed % 2**31)
        return ort.InferenceSession(graph, providers=["CPUExecutionProvider"])

    def _ids(self, engine: Any, text: str) -> list[int]:
        return list(engine.phonemes_to_ids([p for s in engine.phonemize(text) for p in s]))

    def _frames(self, voice: str, ids: list[int]) -> list[float]:
        """Predicted frames per phoneme id (no duration noise: deterministic)."""
        from nabu.audio import carrier

        np: Any = importlib.import_module("numpy")
        reading, _given = self._split(voice, self.model)
        feed = {
            "input": np.array([ids], dtype=np.int64),
            "input_lengths": np.array([len(ids)], dtype=np.int64),
            "scales": np.array([self.NOISE_SCALE, 1.0, 0.0], dtype=np.float32),
        }
        return [float(f) for f in reading.run([carrier.DURATIONS], feed)[0][0, 0]]

    def _symbols(self, engine: Any) -> dict[int, str]:
        return {i: p for p, ids in engine.config.phoneme_id_map.items() for i in ids}

    def _floors(self, engine: Any, voice: str) -> tuple[float, float]:
        """The carrier said on its own, as a sentence: a reading the model gets right."""
        from nabu.audio import carrier

        assert self.carrier is not None
        inv = self._symbols(engine)
        alone = self._ids(engine, regex.sub(r"[\p{P}\s]+$", "", self.carrier.rstrip()) + ".")
        return carrier.floors([inv[i] for i in alone], self._frames(voice, alone))

    def _route(self, engine: Any, voice: str, text: str) -> list[tuple[str, bool]] | None:
        """A longer item's sentences, each with whether the model would collapse it (then it is
        said in the carrier); None when none would, or when the text does not split as Piper
        splits it (then the item is said as it is)."""
        from nabu.audio import carrier

        if self.carrier is None or len(text.split()) <= self.max_words:
            return None
        parts = carrier.sentences(text)
        whole = [list(engine.phonemes_to_ids(s)) for s in engine.phonemize(text)]
        alone = [self._ids(engine, part) for part in parts]
        if alone != whole:
            return None
        inv = self._symbols(engine)
        floor, _pad = self._floors(engine, voice)
        route = [
            (part, carrier.collapses([inv[i] for i in ids], self._frames(voice, ids), floor))
            for part, ids in zip(parts, alone, strict=True)
        ]
        return route if any(c for _, c in route) else None

    def item_settings(self, text: str) -> dict[str, Any]:
        """What shapes this item's clip beyond `settings`: the route through its sentences, when a
        sentence goes through the carrier. Empty otherwise, so other clips keep their identity."""
        if self.voice is None:
            return {}
        engine, _raw = self._engine(self.voice, self.model)
        route = self._route(engine, self.voice, text)
        if route is None:
            return {}
        return {"sentences": ["carrier" if c else "plain" for _, c in route]}

    def _sentences(
        self, engine: Any, raw: bytes, r: Request, route: list[tuple[str, bool]]
    ) -> Clip:
        """Each sentence on its own, the collapsing ones in the carrier, joined with the gap."""
        clips = [
            self._carried(engine, replace(r, input=part))
            if carried
            else self._plain(engine, raw, replace(r, input=part))
            for part, carried in route
        ]
        rate = clips[0].sample_rate
        # Silence: zero samples, two bytes each (s16le).
        gap = bytes(2 * (rate * self.SENTENCE_GAP_MS // 1000))
        return Clip(gap.join(c.pcm for c in clips), rate, None, None)

    def _plain(self, engine: Any, raw: bytes, r: Request) -> Clip:
        piper = optional("piper")
        np: Any = importlib.import_module("numpy")
        engine.session = self._session(raw, seed_of(r))
        config = piper.SynthesisConfig(length_scale=1 / r.rate, noise_scale=self.NOISE_SCALE)
        chunks: list[Any] = list(engine.synthesize(r.input, syn_config=config))
        rate = int(chunks[0].sample_rate) if chunks else engine.config.sample_rate
        gap = np.zeros(rate * self.SENTENCE_GAP_MS // 1000, dtype=np.int16).tobytes()
        pcm = gap.join(bytes(c.audio_int16_bytes) for c in chunks)
        return Clip(pcm, rate, None, None)

    def _carried(self, engine: Any, r: Request) -> Clip:
        from nabu.audio import carrier

        np: Any = importlib.import_module("numpy")
        assert self.carrier is not None
        reading, given = self._split(r.voice, self.model)
        inv = {i: p for p, ids in engine.config.phoneme_id_map.items() for i in ids}
        space = engine.config.phoneme_id_map[carrier.SPACE][0]
        pad = engine.config.phoneme_id_map[carrier.PAD][0]

        def ids_of(text: str) -> list[int]:
            return list(engine.phonemes_to_ids([p for s in engine.phonemize(text) for p in s]))

        def frames(ids: list[int]) -> list[float]:
            feed = {
                "input": np.array([ids], dtype=np.int64),
                "input_lengths": np.array([len(ids)], dtype=np.int64),
                "scales": np.array([self.NOISE_SCALE, 1.0, 0.0], dtype=np.float32),
            }
            return [float(f) for f in reading.run([carrier.DURATIONS], feed)[0][0, 0]]

        lead = self.carrier.rstrip()
        # The carrier said on its own, as a sentence: the floors come from a reading the model
        # gets right.
        alone = ids_of(regex.sub(r"[\p{P}\s]+$", "", lead) + ".")
        floor_phone, floor_pad = carrier.floors([inv[i] for i in alone], frames(alone))
        ids = ids_of(f"{lead} {r.input}")
        first = carrier.item_start(ids, ids_of(lead), space, pad)
        if first is None:
            raise ProviderError(f"piper: the carrier is not read the same before {r.input!r}")
        plan = carrier.plan([inv[i] for i in ids], frames(ids), first, floor_phone, floor_pad)
        scaled = (
            [max(1.0, -(-f / r.rate // 1)) for f in plan.frames] if r.rate != 1.0 else plan.frames
        )
        plan = carrier.Plan(scaled, plan.first, plan.last)
        feed = {
            "input": np.array([ids], dtype=np.int64),
            "input_lengths": np.array([len(ids)], dtype=np.int64),
            "scales": np.array([self.NOISE_SCALE, 1.0, 0.0], dtype=np.float32),
            "durations": np.array([[plan.frames]], dtype=np.float32),
        }
        audio = self._session(given, seed_of(r)).run(None, feed)[0].ravel()
        hop = engine.config.hop_length
        begin, end = carrier.bounds(plan, hop)
        cut = np.array(audio[begin:end], dtype=np.float32)
        rate = engine.config.sample_rate
        fade_in = min(len(cut), rate * carrier.FADE_IN_MS // 1000)
        fade_out = min(len(cut), rate * carrier.FADE_OUT_MS // 1000)
        cut[:fade_in] *= np.linspace(0, 1, fade_in, dtype=np.float32)
        cut[len(cut) - fade_out :] *= np.linspace(1, 0, fade_out, dtype=np.float32)
        peak = float(np.abs(cut).max()) if len(cut) else 0.0
        if peak < 1e-8:
            raise ProviderError(f"piper: no audio for {r.input!r}")
        trace = "".join(inv[i] for i in ids[plan.first : plan.last + 1])
        return Clip(to_pcm(cut / peak), rate, None, trace)

    def _phonemes(self, engine: Any, raw: bytes, r: Request) -> Clip:
        """IPA given as phonemes, one [[word]] at a time (ADR 0087): no phonemizer, so a voice of
        another language says what a pinned reading says. Words are joined by a space; a final
        . or ? is the intonation."""
        piper = optional("piper")
        np: Any = importlib.import_module("numpy")
        known = engine.config.phoneme_id_map
        phonemes: list[str] = []
        words: list[str] = [str(w) for w in PIPER_WORD.findall(r.input)]
        for i, w in enumerate(words):
            if i:
                phonemes.append(" ")
            said: list[str] = [c if c in known else PIPER_FALLBACKS.get(c, c) for c in w]
            unknown = [c for c in said if c not in known]
            if unknown:
                raise ProviderError(f"piper: {r.voice} has no phoneme {' '.join(unknown)!r}")
            phonemes.extend(said)
        end = r.input.rstrip()[-1:]
        if end in known and end not in "]":
            phonemes.append(end)
        ids = list(engine.phonemes_to_ids(phonemes))
        engine.session = self._session(raw, seed_of(r))
        config = piper.SynthesisConfig(length_scale=1 / r.rate, noise_scale=self.NOISE_SCALE)
        audio = np.asarray(engine.phoneme_ids_to_audio(ids, syn_config=config), dtype=np.float32)
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
        return Clip(pcm, int(engine.config.sample_rate), None, "".join(phonemes))

    def synthesize(self, requests: list[Request]) -> list[Clip]:
        out: list[Clip] = []
        for r in requests:
            engine, raw = self._engine(r.voice, self.model)
            if PIPER_PHONEMES.fullmatch(r.input):
                out.append(self._phonemes(engine, raw, r))
                continue
            short = self.carrier is not None and len(r.input.split()) <= self.max_words
            if short:
                out.append(self._carried(engine, r))
                continue
            route = self._route(engine, r.voice, r.input)
            out.append(
                self._plain(engine, raw, r)
                if route is None
                else self._sentences(engine, raw, r, route)
            )
        return out


class MissingKey(RuntimeError):
    """A hosted provider's API key is not in the environment."""

    def __init__(self, provider: str, variable: str) -> None:
        super().__init__(
            f"{provider} needs an API key in ${variable} (in a cloud session: the environment's "
            "settings, never a course file or the chat)"
        )
        self.variable = variable


class ProviderError(RuntimeError):
    """A hosted provider refused a request or could not be reached."""


#: POST (url, headers, body) → response body. Injected in tests; the default retries.
Transport = Callable[[str, dict[str, str], bytes], bytes]
RETRY_STATUS = {408, 429, 500, 502, 503, 504}
SAMPLE_RATE = 22050


def http_post(url: str, headers: dict[str, str], body: bytes) -> bytes:
    """POST with up to four retries (2, 4, 8, 16 s) on rate limits, server errors and network
    failures. Errors carry the URL and the server's message, never the request headers."""
    for attempt in range(5):
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                data: bytes = response.read()
                return data
        except urllib.error.HTTPError as error:
            detail = error.read()[:600].decode("utf-8", "replace")
            if error.code in RETRY_STATUS and attempt < 4:
                time.sleep(2 ** (attempt + 1))
                continue
            raise ProviderError(f"{url}: HTTP {error.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt < 4:
                time.sleep(2 ** (attempt + 1))
                continue
            raise ProviderError(f"{url}: {error}") from None
    raise AssertionError("unreachable")


def _key(provider: str, variable: str) -> str:
    key = os.environ.get(variable, "").strip()
    if not key:
        raise MissingKey(provider, variable)
    return key


def _required(voice: AudioVoice, field: str) -> str:
    value: str | None = getattr(voice, field)
    if not value:
        raise ValueError(f"voice {voice.id}: provider {voice.provider} needs `{field}`")
    return value


def _pcm(data: bytes) -> bytes:
    return data[: len(data) - len(data) % 2]


def onsets_of(text: str, pieces: list[str], starts: list[float]) -> tuple[tuple[int, int], ...]:
    """Map timed pieces (characters or words, in order) to code point offsets in `text`.

    Each piece is looked up from where the previous one ended; a piece the provider normalized
    (a digit spelled out, say) is not found and has no onset. Whitespace has none either.
    """
    out: list[tuple[int, int]] = []
    cursor = 0
    for piece, start in zip(pieces, starts, strict=True):
        if not piece.strip():
            continue
        at = text.find(piece, cursor)
        if at < 0:
            continue
        out.append((at, round(start * 1000)))
        cursor = at + len(piece)
    return tuple(out)


class ElevenLabsProvider:
    """Eleven v4 by voice_id, through the with-timestamps endpoint (PCM 22.05 kHz)."""

    name = "elevenlabs"
    seeded = True
    API = "https://api.elevenlabs.io"
    KEY = "ELEVENLABS_API_KEY"
    MIN_SPEED, MAX_SPEED = 0.7, 1.2
    #: The documented defaults, pinned so a change of defaults cannot change new clips silently.
    VOICE_SETTINGS: ClassVar[dict[str, Any]] = {
        "stability": 0.5,
        "similarity_boost": 0.75,
        "style": 0.0,
        "use_speaker_boost": True,
    }

    def __init__(self, voice: AudioVoice, transport: Transport = http_post) -> None:
        self.model = _required(voice, "model")
        self.language = _required(voice, "language")
        self.transport = transport

    def version(self) -> str:
        return self.model

    def settings(self) -> dict[str, Any]:
        return {"language": self.language, "voiceSettings": self.VOICE_SETTINGS}

    def speed(self, rate: float) -> float:
        return min(max(rate, self.MIN_SPEED), self.MAX_SPEED)

    @staticmethod
    def seed(request: Request) -> int:
        """Best-effort determinism: the same input and rate ask for the same seed."""
        return seed_of(request)

    def body(self, request: Request) -> dict[str, Any]:
        return {
            "text": request.input,
            "model_id": self.model,
            "language_code": self.language,
            "voice_settings": {**self.VOICE_SETTINGS, "speed": self.speed(request.rate)},
            "seed": self.seed(request),
        }

    def synthesize(self, requests: list[Request]) -> list[Clip]:
        key = _key(self.name, self.KEY)
        out: list[Clip] = []
        for r in requests:
            url = (
                f"{self.API}/v1/text-to-speech/{quote(r.voice, safe='')}/with-timestamps"
                f"?output_format=pcm_{SAMPLE_RATE}"
            )
            headers = {
                "xi-api-key": key,
                "Content-Type": "application/json",
                "Accept": "application/json",
            }
            payload = json.dumps(self.body(r), ensure_ascii=False).encode("utf-8")
            response = json.loads(self.transport(url, headers, payload))
            pcm = _pcm(base64.b64decode(response["audio_base64"]))
            alignment = response.get("alignment")
            words = (
                onsets_of(
                    r.input,
                    list(alignment["characters"]),
                    list(alignment["character_start_times_seconds"]),
                )
                if alignment
                else None
            )
            out.append(Clip(pcm, SAMPLE_RATE, words or None, None))
        return out


class CartesiaProvider:
    """Sonic by voice id, through the server-sent-events endpoint with word timestamps."""

    name = "cartesia"
    seeded = False
    API = "https://api.cartesia.ai"
    KEY = "CARTESIA_API_KEY"
    API_VERSION = "2026-08-14"
    MIN_SPEED, MAX_SPEED = 0.6, 1.5

    def __init__(self, voice: AudioVoice, transport: Transport = http_post) -> None:
        self.model = _required(voice, "model")
        self.language = _required(voice, "language")
        self.transport = transport

    def version(self) -> str:
        return self.model

    def settings(self) -> dict[str, Any]:
        return {"language": self.language}

    def speed(self, rate: float) -> float:
        return min(max(rate, self.MIN_SPEED), self.MAX_SPEED)

    def body(self, request: Request) -> dict[str, Any]:
        return {
            "model_id": self.model,
            "transcript": request.input,
            "voice": {"id": request.voice},
            "output_format": {
                "container": "raw",
                "encoding": "pcm_s16le",
                "sample_rate": SAMPLE_RATE,
            },
            "language": self.language,
            "add_timestamps": True,
            "generation_config": {"speed": self.speed(request.rate)},
        }

    @staticmethod
    def events(stream: bytes) -> list[dict[str, Any]]:
        """The JSON events of a text/event-stream body (`data:` lines; blank lines end one)."""
        out: list[dict[str, Any]] = []
        data: list[str] = []
        for line in [*stream.decode("utf-8").splitlines(), ""]:
            if line.startswith("data:"):
                data.append(line[5:].removeprefix(" "))
            elif not line and data:
                out.append(json.loads("\n".join(data)))
                data = []
        return out

    def synthesize(self, requests: list[Request]) -> list[Clip]:
        key = _key(self.name, self.KEY)
        out: list[Clip] = []
        for r in requests:
            headers = {
                "Authorization": f"Bearer {key}",
                "Cartesia-Version": self.API_VERSION,
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            }
            payload = json.dumps(self.body(r), ensure_ascii=False).encode("utf-8")
            chunks: list[bytes] = []
            words: list[str] = []
            starts: list[float] = []
            for event in self.events(self.transport(f"{self.API}/tts/sse", headers, payload)):
                kind = event.get("type")
                if kind == "error":
                    raise ProviderError(
                        f"cartesia: {event.get('title', '')}: {event.get('message', '')} "
                        f"(request {event.get('request_id', '?')})"
                    )
                if kind == "chunk" and event.get("data"):
                    chunks.append(base64.b64decode(event["data"]))
                elif kind == "timestamps" and event.get("word_timestamps"):
                    stamps = event["word_timestamps"]
                    words += stamps["words"]
                    starts += stamps["start"]
                elif kind == "done":
                    break
            pcm = _pcm(b"".join(chunks))
            if not pcm:
                raise ProviderError(f"cartesia: no audio for {r.input!r}")
            onsets = onsets_of(r.input, words, starts)
            out.append(Clip(pcm, SAMPLE_RATE, onsets or None, None))
        return out


def seed_of(request: Request) -> int:
    """Best-effort determinism: the same voice, input, rate and take ask for the same seed. A
    first take keeps the seed clips had before takes existed."""
    fields: list[Any] = [request.voice, request.input, request.rate]
    if request.take:
        fields.append(request.take)
    key = json.dumps(fields, ensure_ascii=False)
    return int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:4], "big")


def checkpoint(model: str) -> tuple[str, str]:
    """A Hugging Face checkpoint pinned to a commit: "owner/name@<40 hex>"."""
    repo, _, revision = model.partition("@")
    if (
        not repo.count("/") == 1
        or len(revision) != 40
        or not all(c in "0123456789abcdef" for c in revision)
    ):
        raise ValueError(f"{model!r}: a pinned model is owner/name@<the 40-hex commit>")
    return repo, revision


class OmniVoiceEngine(Protocol):
    """What the provider needs of an OmniVoice model (a fake one in tests)."""

    sampling_rate: int

    def clone_prompt(self, audio: Path, text: str) -> Any: ...

    def speak(
        self,
        text: str,
        language: str,
        seed: int,
        num_step: int,
        guidance_scale: float,
        **extra: Any,
    ) -> Any:
        """Float samples in [-1, 1]; `extra`: voice_clone_prompt, instruct, speed."""
        ...


class _OmniVoice:
    def __init__(self, model: Any) -> None:
        self.model = model
        self.sampling_rate = int(model.sampling_rate)

    def clone_prompt(self, audio: Path, text: str) -> Any:
        return self.model.create_voice_clone_prompt(ref_audio=str(audio), ref_text=text)

    def speak(
        self,
        text: str,
        language: str,
        seed: int,
        num_step: int,
        guidance_scale: float,
        **extra: Any,
    ) -> Any:
        torch = optional("torch")
        omnivoice = optional("omnivoice")
        torch.manual_seed(seed)
        config = omnivoice.OmniVoiceGenerationConfig(
            num_step=num_step, guidance_scale=guidance_scale
        )
        return self.model.generate(text=text, language=language, generation_config=config, **extra)[
            0
        ]


#: The weights' precision: bfloat16, as the checkpoint was trained. On a CPU with AMX it runs two
#: to three times faster than float32; GPUs from Ampere on run it natively.
OMNIVOICE_DTYPE = "bfloat16"


@cache
def load_omnivoice(repo: str, revision: str) -> OmniVoiceEngine:
    """The OmniVoice model at that commit (cached), on the GPU when there is one."""
    hub = optional("huggingface_hub")
    torch = optional("torch")
    omnivoice = optional("omnivoice")
    path = hub.snapshot_download(repo, revision=revision)
    cuda = bool(torch.cuda.is_available())
    model = omnivoice.OmniVoice.from_pretrained(
        path, device_map="cuda:0" if cuda else "cpu", dtype=getattr(torch, OMNIVOICE_DTYPE)
    )
    return _OmniVoice(model)


def omnivoice_version() -> str:
    from importlib.metadata import version

    return version("omnivoice")


def to_pcm(samples: Any) -> bytes:
    """Float samples in [-1, 1] as s16le: numpy's when it is there (the model's arrays), plain
    Python otherwise (without the speech groups)."""
    try:
        # By name: numpy comes with the speech groups, which CI and its type check leave out.
        np: Any = importlib.import_module("numpy")
    except ImportError:
        pcm = array("h", (round(max(-1.0, min(1.0, float(x))) * 32767.0) for x in samples))
        if sys.byteorder == "big":
            pcm.byteswap()
        return pcm.tobytes()
    data = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    return bytes((data * 32767.0).round().astype("<i2").tobytes())


#: OmniVoice sometimes leaves near-silence around the speech, up to a second before it. A clip keeps
#: LEAD_S before its first and TAIL_S after its last 20 ms within EDGE_DB of its loudest; the tail
#: is the longer, so a soft last sound (an aspirated -s) stays.
EDGE_DB = 40.0
LEAD_S = 0.08
TAIL_S = 0.15


def trim_edges(samples: Any, sampling_rate: int) -> Any:
    """The samples without the near-silence before and after the speech, short margins kept.
    Samples that are all as loud as each other (silence, a level) come back as they are. numpy's
    when it is there (the model's arrays), plain Python otherwise (without the speech groups)."""
    step = max(1, sampling_rate // 50)
    try:
        np: Any = importlib.import_module("numpy")
    except ImportError:
        y: Any = [float(x) for x in samples]
        n = len(y) // step
        rms = [math.sqrt(sum(v * v for v in y[i * step : (i + 1) * step]) / step) for i in range(n)]
    else:
        y = np.asarray(samples, dtype=np.float32)
        n = len(y) // step
        frames = y[: n * step].astype(np.float64).reshape(n, step)
        rms = np.sqrt(np.mean(frames**2, axis=1)).tolist()
    if n < 2 or max(rms) <= 0.0:
        return samples
    floor = max(rms) * 10 ** (-EDGE_DB / 20)
    loud = [i for i, r in enumerate(rms) if r >= floor]
    if loud[0] == 0 and loud[-1] == n - 1:
        return samples
    start = max(0, loud[0] * step - round(LEAD_S * sampling_rate))
    end = min(len(y), (loud[-1] + 1) * step + round(TAIL_S * sampling_rate))
    return y[start:end]


class OmniVoiceProvider:
    """An OmniVoice checkpoint (`model`: owner/name@commit) speaking `language` in the voice of a
    reference recording. Diffusion sampling is seeded per clip (`seed_of`), so the same input,
    rate and settings give the same clip on the same kind of machine and library versions."""

    name = "omnivoice"
    seeded = True
    #: Decoding steps and guidance: OmniVoice's defaults, pinned so a change of defaults cannot
    #: change new clips silently.
    NUM_STEP = 32
    GUIDANCE_SCALE = 2.0

    def __init__(
        self,
        voice: AudioVoice,
        reference: Reference | None,
        load: Callable[[str, str], OmniVoiceEngine] = load_omnivoice,
        package: Callable[[], str] = omnivoice_version,
    ) -> None:
        self.repo, self.revision = checkpoint(_required(voice, "model"))
        self.language = _required(voice, "language")
        if reference is None:
            raise ValueError(
                f"voice {voice.id}: no reference voice {voice.voice!r} in the audio index "
                f"(`nabu audio cast <course> --voice {voice.id}`)"
            )
        self.reference = reference
        self.load = load
        self.package = package

    def version(self) -> str:
        # No spaces or "@": it also names the clips' author (generated:omnivoice@<version>).
        return f"{self.repo}#{self.revision}+omnivoice-{self.package()}"

    def settings(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "numStep": self.NUM_STEP,
            "guidanceScale": self.GUIDANCE_SCALE,
            "dtype": OMNIVOICE_DTYPE,
            "reference": self.reference.sha256,
        }

    def speed(self, rate: float) -> float:
        return rate

    #: Tries per clip: the model can return (almost) nothing for a very short word, once its
    #: silence is trimmed; the next seeds, in order, try again.
    TRIES = 4

    def _speak(self, engine: OmniVoiceEngine, text: str, seed: int, **extra: Any) -> Clip:
        clip = Clip(b"", engine.sampling_rate, None, None)
        for attempt in range(self.TRIES):
            samples = engine.speak(
                text, self.language, seed + attempt, self.NUM_STEP, self.GUIDANCE_SCALE, **extra
            )
            clip = Clip(
                to_pcm(trim_edges(samples, engine.sampling_rate)), engine.sampling_rate, None, None
            )
            if len(clip.pcm) // 2 >= engine.sampling_rate // 10:  # 100 ms
                break
        return clip

    def synthesize(self, requests: list[Request]) -> list[Clip]:
        engine = self.load(self.repo, self.revision)
        prompt = engine.clone_prompt(self.reference.path, self.reference.text)
        out: list[Clip] = []
        for r in requests:
            speed = {} if r.rate == 1.0 else {"speed": r.rate}
            out.append(self._speak(engine, r.input, seed_of(r), voice_clone_prompt=prompt, **speed))
        return out

    def design(self, text: str, instruct: str, seed: int) -> Clip:
        """A reference voice from speaker attributes (voice design), as `nabu audio cast` keeps."""
        return self._speak(self.load(self.repo, self.revision), text, seed, instruct=instruct)

    def design_record(self, instruct: str, seed: int) -> dict[str, Any]:
        """How `design` made a reference, as the audio index keeps it."""
        return {
            "provider": self.name,
            "version": self.version(),
            "language": self.language,
            "instruct": instruct,
            "seed": seed,
            "dtype": OMNIVOICE_DTYPE,
        }


#: Navoiy's runtime (ADR 0059): CosyVoice's source and the CosyVoice2 base model at the commits
#: the checkpoint's own demos were made with (its demo/manifest.json).
COSYVOICE_URL = "https://github.com/FunAudioLLM/CosyVoice"
COSYVOICE_REVISION = "074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc"
COSYVOICE2_BASE = ("FunAudioLLM/CosyVoice2-0.5B", "eec1ae6c79877dbd9379285cf8789c9e0879293d")
#: The fine-tuned LLM of each known checkpoint repo: its file, sha256 and text normalizer.
NAVOIY_WEIGHTS = {
    "aisha-org/navoiy-tts": (
        "emotion_600h_joint.pt",
        "ced40fe65cf0a006a1708fd033cfee37b2c583747d3fd06279ba12d3dbe058af",
        "uztts.normalize",
    ),
}
#: The recording a Navoiy voice is first cloned from (`nabu audio cast`): the prompt of CosyVoice's
#: own examples, which the checkpoint's demos clone too. Path in the source, sha256, license.
NAVOIY_PROMPT = (
    "asset/zero_shot_prompt.wav",
    "c7b31d6dbe7cc6a716dded00550db5b50940bf209e424e4ad207b12e657c8ff6",
    "Apache-2.0",
)
#: The CosyVoice runtime's own environment (pipeline/runtimes/cosyvoice).
COSYVOICE_RUNTIME = Path(__file__).resolve().parents[3] / "runtimes" / "cosyvoice"


class CosyVoiceEngine(Protocol):
    """What the provider needs of a CosyVoice2 model (a fake one in tests)."""

    sampling_rate: int
    #: The CosyVoice source checkout the model runs from.
    source: Path

    def speak(self, text: str, instruct: str, prompt: Path, seed: int, speed: float) -> bytes:
        """s16le mono PCM of `text` in the prompt recording's voice."""
        ...


def runtime_command() -> list[str]:
    """Do not install or execute the quarantined legacy model environment."""
    raise ProviderError(
        "navoiy: CosyVoice generation is disabled pending a security and compatibility update. "
        "Its legacy PyTorch stack can execute malicious model code (CVE-2025-32434). "
        "Use the committed audio; see pipeline/runtimes/cosyvoice/README.md."
    )


class CosyVoiceWorker:
    """The model in its own environment: worker.py of the runtime, spoken to in JSON lines."""

    def __init__(self, config: dict[str, Any], command: list[str] | None = None) -> None:
        import atexit
        import subprocess

        self.process = subprocess.Popen(
            command or runtime_command(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        try:
            ready = self._ask(config)
            if "ready" not in ready:
                raise ProviderError(
                    f"navoiy: the runtime did not start: {ready.get('error', ready)}"
                )
            self.sampling_rate = int(ready["ready"]["sampleRate"])
            self.source = Path(ready["ready"]["source"])
        except Exception:
            self.close()
            raise
        atexit.register(self.close)

    def _ask(self, message: dict[str, Any]) -> dict[str, Any]:
        stdin, stdout = self.process.stdin, self.process.stdout
        assert stdin is not None and stdout is not None
        stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        stdin.flush()
        line = stdout.readline()
        if not line:
            raise ProviderError(f"navoiy: the runtime exited ({self.process.wait()})")
        answer: dict[str, Any] = json.loads(line)
        return answer

    def speak(self, text: str, instruct: str, prompt: Path, seed: int, speed: float) -> bytes:
        answer = self._ask(
            {
                "text": text,
                "instruct": instruct,
                "prompt": str(prompt),
                "seed": seed,
                "speed": speed,
            }
        )
        if "error" in answer:
            raise ProviderError(f"navoiy: {text!r}: {answer['error']}")
        return base64.b64decode(answer["pcm"])

    def close(self) -> None:
        import atexit
        import contextlib
        import subprocess

        atexit.unregister(self.close)
        if self.process.stdin is not None and not self.process.stdin.closed:
            with contextlib.suppress(BrokenPipeError):
                self.process.stdin.close()
        if self.process.poll() is None:
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        if self.process.stdout is not None:
            self.process.stdout.close()


@cache
def load_navoiy(repo: str, revision: str) -> CosyVoiceEngine:
    """The Navoiy checkpoint at that commit over its CosyVoice2 base, in the runtime (cached)."""
    if repo not in NAVOIY_WEIGHTS:
        raise ValueError(f"{repo}: not a known Navoiy checkpoint ({', '.join(NAVOIY_WEIGHTS)})")
    file, sha256, normalizer = NAVOIY_WEIGHTS[repo]
    return CosyVoiceWorker(
        {
            "runtime": {"url": COSYVOICE_URL, "revision": COSYVOICE_REVISION},
            "base": {"repo": COSYVOICE2_BASE[0], "revision": COSYVOICE2_BASE[1]},
            "checkpoint": {"repo": repo, "revision": revision, "file": file, "sha256": sha256},
            "normalizer": normalizer,
        }
    )


class NavoiyProvider:
    """Navoiy (`model`: aisha-org/navoiy-tts@commit), a CosyVoice2 fine-tune that reads Uzbek in
    Latin script, in the voice of a reference recording. Its LLM samples speech tokens, seeded
    per clip (`seed_of`); the instruction asks for its calm style. No timings."""

    name = "navoiy"
    seeded = True
    #: The checkpoint's "calm" (xotirjam) preset, word for word from its emotions_40h.json:
    #: an even, neutral voice for learners.
    STYLE = "calm"
    INSTRUCT = "Speak in a calm, steady, neutral voice with even pacing and relaxed intonation."
    #: float32 everywhere: the same clip on a CPU and a GPU (upstream uses float16 on GPUs).
    DTYPE = "float32"
    TRIES = OmniVoiceProvider.TRIES

    def __init__(
        self,
        voice: AudioVoice,
        reference: Reference | None,
        load: Callable[[str, str], CosyVoiceEngine] = load_navoiy,
    ) -> None:
        self.repo, self.revision = checkpoint(_required(voice, "model"))
        #: Navoiy reads one language; the voice may say which for the record.
        self.language = voice.language or "uz"
        if reference is None:
            raise ValueError(
                f"voice {voice.id}: no reference voice {voice.voice!r} in the audio index "
                f"(`nabu audio cast <course> --voice {voice.id}`)"
            )
        self.reference = reference
        self.load = load

    def version(self) -> str:
        # No spaces or "@": it also names the clips' author (generated:navoiy@<version>).
        return f"{self.repo}#{self.revision}+cosyvoice-{COSYVOICE_REVISION[:12]}"

    def settings(self) -> dict[str, Any]:
        return {
            "base": f"{COSYVOICE2_BASE[0]}#{COSYVOICE2_BASE[1]}",
            "style": self.STYLE,
            "dtype": self.DTYPE,
            "reference": self.reference.sha256,
        }

    def speed(self, rate: float) -> float:
        return rate

    def _speak(
        self, engine: CosyVoiceEngine, text: str, prompt: Path, seed: int, rate: float
    ) -> Clip:
        clip = Clip(b"", engine.sampling_rate, None, None)
        for attempt in range(self.TRIES):
            pcm = engine.speak(text, self.INSTRUCT, prompt, seed + attempt, rate)
            clip = Clip(pcm, engine.sampling_rate, None, None)
            if len(pcm) // 2 >= engine.sampling_rate // 10:  # 100 ms
                break
        return clip

    def synthesize(self, requests: list[Request]) -> list[Clip]:
        engine = self.load(self.repo, self.revision)
        return [
            self._speak(engine, r.input, self.reference.path, seed_of(r), r.rate) for r in requests
        ]

    def design(self, text: str, instruct: str, seed: int) -> Clip:
        """A reference voice, as `nabu audio cast` keeps: the model reads `text` in the voice of
        CosyVoice's prompt recording (NAVOIY_PROMPT). Navoiy cannot design a voice from
        attributes; `instruct` is the style instruction."""
        engine = self.load(self.repo, self.revision)
        path, sha256, _ = NAVOIY_PROMPT
        prompt = engine.source / path
        if hashlib.sha256(prompt.read_bytes()).hexdigest() != sha256:
            raise ProviderError(f"navoiy: {prompt} differs from the pinned prompt recording")
        clip = Clip(b"", engine.sampling_rate, None, None)
        for attempt in range(self.TRIES):
            clip = Clip(
                engine.speak(text, instruct, prompt, seed + attempt, 1.0),
                engine.sampling_rate,
                None,
                None,
            )
            if len(clip.pcm) // 2 >= engine.sampling_rate // 10:
                break
        return clip

    def design_record(self, instruct: str, seed: int) -> dict[str, Any]:
        path, sha256, license = NAVOIY_PROMPT
        return {
            "provider": self.name,
            "version": self.version(),
            "language": self.language,
            "instruct": instruct,
            "seed": seed,
            "dtype": self.DTYPE,
            "prompt": {
                "source": f"{COSYVOICE_URL}/blob/{COSYVOICE_REVISION}/{path}",
                "sha256": sha256,
                "license": license,
            },
        }


PROVIDERS: dict[str, Callable[[AudioVoice, Reference | None], Provider]] = {
    "espeak-ng": lambda _voice, _ref: EspeakProvider(),
    "piper": lambda voice, _ref: PiperProvider(voice),
    "elevenlabs": lambda voice, _ref: ElevenLabsProvider(voice),
    "cartesia": lambda voice, _ref: CartesiaProvider(voice),
    "omnivoice": lambda voice, ref: OmniVoiceProvider(voice, ref),
    "navoiy": lambda voice, ref: NavoiyProvider(voice, ref),
}


def provider(voice: AudioVoice, reference: Reference | None = None) -> Provider:
    """The provider of a course voice, configured from it (model, language) and, for a cloning
    provider, its reference voice."""
    if voice.provider not in PROVIDERS:
        raise ValueError(f"unknown TTS provider {voice.provider!r}")
    return PROVIDERS[voice.provider](voice, reference)
