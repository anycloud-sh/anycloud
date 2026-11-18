"""Kyutai TTS voice sessions for the GPU pool receiver.

One warm model serves every Job. Sessions are slots of one batch driven by
Kyutai's own scheduler (`TTSService`, rust/moshi-server/tts.py at the pinned
moshi commit): a slot is admitted with a reset, fed words, and reset again on
cancellation, independently of the others. Decoding is greedy, so a session's
audio can be checked against a reference rendered on CPU at image build, which
Whisper must first hear as its text (MACE's CPU references, for speech).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import numpy as np

MODELS = Path("/models")
REPO = "kyutai/tts-1.6b-en_fr"
REVISION = "f65439609986c392cb12df63938abcc550c3fb15"
VOICE = "vctk/p225_023.wav"
REFERENCE = Path("/app/voice-reference.npy")
REFERENCE_REPORT = Path("/app/voice-reference.json")
TEXT = (
    "The quick brown fox jumps over the lazy dog. "
    "A warm model serves every session, and each one keeps its own voice."
)
# A held session speaks this until it is released.
HELD_TEXT = "Sessions overlap on a shared card while the model stays loaded."
MIN_SECONDS = 2.0
MIN_RMS = 0.01
# The distance covers only the shorter clip, so a session must also be about as
# long as its reference (a GPU session measured 7.28 s against 7.36 s on CPU).
MAX_LENGTH_RATIO_ERROR = 0.05
# Spectral distance from the CPU reference: a session on an A10 measured 0.049
# (alone, beside a held session, and in a reused slot) and other speech 0.147
# (Spike runs 36719539993 to 36724244117). Halfway, for the T4.
TOLERANCE = 0.1
MAX_WORD_ERROR_RATE = 0.1
# A held session emits an 80 ms frame per step; this long without one is a stall.
STALL_SECONDS = 30.0
HAS_PCM, IS_EOS = 1, 2  # tts_service.MaskFlags
FRAME_SAMPLES = 1920  # 80 ms at 24 kHz


def epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def timing(name: str, epoch: int | None = None) -> None:
    """deployment.py's AC_TIMING mark; `epoch` dates an earlier moment."""
    print("AC_TIMING " + json.dumps(
        {"name": name, "epochMs": epoch_ms() if epoch is None else epoch}, sort_keys=True
    ) + "\n", end="", flush=True)


def spectral_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute log-magnitude STFT difference over the shorter clip."""
    n = min(len(a), len(b))
    if n < 2048:
        return float("inf")

    def spectrum(x: np.ndarray) -> np.ndarray:
        frames = np.lib.stride_tricks.sliding_window_view(x[:n], 1024)[::256]
        return np.log1p(np.abs(np.fft.rfft(frames * np.hanning(1024), axis=1)))

    return float(np.mean(np.abs(spectrum(a) - spectrum(b))))


def words(text: str) -> list[str]:
    return "".join(c if c.isalnum() else " " for c in text.lower()).split()


def word_error_rate(expected: str, heard: str) -> float:
    a, b = words(expected), words(heard)
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        previous, row[0] = row[0], i
        for j, y in enumerate(b, 1):
            previous, row[j] = row[j], min(
                row[j] + 1, row[j - 1] + 1, previous + (x != y)
            )
    return round(row[-1] / max(1, len(a)), 3)


def transcribe(audio: np.ndarray) -> str:
    """Whisper base.en on CPU, independent of the voice model."""
    import whisper

    model = whisper.load_model("base.en", device="cpu", download_root=str(MODELS / "whisper"))
    n = int(len(audio) * 16_000 / 24_000)
    resampled = np.interp(
        np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio
    ).astype(np.float32)
    return model.transcribe(resampled, language="en", fp16=False)["text"].strip()


class Session:
    """One voice session: the audio its slot produced so far."""

    def __init__(self, text: str, hold: bool) -> None:
        self.text = text
        self.hold = hold
        self.chunks: list[np.ndarray] = []
        self.done = threading.Event()
        self.error: BaseException | None = None
        self.words: list[list[int]] = []
        self.last_chunk_at = time.monotonic()
        self.opened_ms = epoch_ms()
        self.first_chunk_ms: int | None = None

    def audio(self) -> np.ndarray:
        return np.concatenate(self.chunks) if self.chunks else np.zeros(0, np.float32)

    def seconds(self) -> float:
        return len(self.chunks) * FRAME_SAMPLES / 24_000

    def wait(self, timeout: float) -> None:
        if not self.done.wait(timeout):
            raise RuntimeError(f"voice session did not finish in {timeout:.0f} s")
        if self.error is not None:
            raise RuntimeError(f"voice session failed: {self.error}")


def check(
    audio: np.ndarray, reference: np.ndarray, device: str, load_id: str
) -> dict[str, Any]:
    """A finished session's evidence; raises unless it is its reference's speech."""
    seconds = len(audio) / 24_000
    rms = float(np.sqrt(np.mean(audio**2))) if len(audio) else 0.0
    distance = spectral_distance(audio, reference)
    evidence = {
        "seconds": round(seconds, 2),
        "rms": round(rms, 4),
        "distance": round(distance, 4),
        "device": device,
        "modelLoadId": load_id,
    }
    if seconds < MIN_SECONDS or not rms >= MIN_RMS:
        raise RuntimeError(f"voice session produced no speech: {json.dumps(evidence)}")
    if not abs(len(audio) / len(reference) - 1) <= MAX_LENGTH_RATIO_ERROR:
        raise RuntimeError(
            f"voice audio lasted {seconds:.2f} s against its reference's"
            f" {len(reference) / 24_000:.2f} s on {device} (load {load_id})"
        )
    # Written so a NaN distance fails too.
    if not distance <= TOLERANCE:
        raise RuntimeError(
            f"voice audio distance {distance!r} on {device} exceeds {TOLERANCE}"
            f" (load {load_id})"
        )
    return evidence


class Voice:
    """One warm model; sessions are independent slots of one batch."""

    def __init__(
        self,
        slots: int,
        service: Any = None,
        encode: Callable[[str], list[list[int]]] | None = None,
        device: str = "cuda",
    ) -> None:
        # Tests pass a stub scheduler; the receiver loads Kyutai's.
        self.service, self.encode = (
            (service, encode) if service is not None else load_service(device, slots)
        )
        self.device = device
        self.load_id = str(uuid.uuid4())
        self._slots: list[Session | None] = [None] * slots
        self._pending: list[tuple[int, list[int], str | None]] = []
        self._idle: list[int] = []
        self._lock = threading.Condition()
        self._pcm = np.zeros((slots, FRAME_SAMPLES), np.float32)
        self._flags = np.zeros(slots, np.int32)
        self._codes = np.zeros((slots, 33), np.int32)
        self._failure: BaseException | None = None
        threading.Thread(target=self._run, daemon=True, name="voice").start()

    def _admit(self, slot: int, words: list[list[int]]) -> None:
        """One utterance: -1 resets the slot (carrying the first word), -2 ends it."""
        first, *rest = words
        self._pending.append((slot, [-1, *first], VOICE))
        self._pending += [(slot, tokens, None) for tokens in rest]
        self._pending.append((slot, [-2], None))

    def open(self, text: str, hold: bool = False) -> Session:
        words = self.encode(text)
        if not words:
            raise ValueError("voice session text has no words")
        with self._lock:
            if self._failure is not None:
                raise RuntimeError(f"voice scheduler failed: {self._failure}")
            if None not in self._slots:
                raise RuntimeError("no free voice slot")
            slot = self._slots.index(None)
            session = Session(text, hold)
            session.words = words
            self._slots[slot] = session
            self._admit(slot, words)
            self._lock.notify()
            return session

    def release(self, session: Session) -> None:
        """Cancel a session: its slot stops computing until the next admission resets it."""
        with self._lock:
            if session in self._slots:
                slot = self._slots.index(session)
                self._slots[slot] = None
                self._pending = [u for u in self._pending if u[0] != slot]
                self._idle.append(slot)
                self._lock.notify()
        session.done.set()

    def _run(self) -> None:
        while True:
            with self._lock:
                while not self._pending and not self._idle and not any(self._slots):
                    self._lock.wait()
                # Only this thread touches the scheduler; an unassigned slot is inactive.
                for slot in self._idle:
                    self.service.clients[slot].state = None
                self._idle = []
                updates, self._pending = self._pending, []
                sessions = list(self._slots)
            try:
                self.service.step(updates, self._pcm, self._flags, self._codes)
            except BaseException as error:  # noqa: BLE001 - every session must see it
                # The scheduler may be half-updated: fail every session and
                # refuse new ones rather than reuse it.
                with self._lock:
                    self._failure = error
                    failed = [session for session in self._slots if session is not None]
                    self._slots = [None] * len(self._slots)
                for session in failed:
                    session.error = error
                    session.done.set()
                return
            for slot, session in enumerate(sessions):
                # A session released during the step gets none of its frame.
                if session is None or self._slots[slot] is not session:
                    continue
                if self._flags[slot] & HAS_PCM:
                    if session.first_chunk_ms is None:
                        session.first_chunk_ms = epoch_ms()
                    session.chunks.append(self._pcm[slot].copy())
                    session.last_chunk_at = time.monotonic()
                if self._flags[slot] & IS_EOS:
                    with self._lock:
                        if self._slots[slot] is not session:
                            continue
                        if session.hold:
                            # A held session is a loop of whole utterances in its
                            # slot: feeding a live slot more words mid-turn
                            # degraded its speech in some runs.
                            self._admit(slot, session.words)
                            continue
                        self._slots[slot] = None
                    session.done.set()


class HeldSession:
    """A held Job's session: it must keep producing audio until released."""

    def __init__(self, voice: Voice, session: Session) -> None:
        self.voice = voice
        self.session = session

    def poll(self) -> None:
        if self.session.error is not None:
            raise RuntimeError(f"voice session failed: {self.session.error}")
        stalled = time.monotonic() - self.session.last_chunk_at
        if stalled > STALL_SECONDS:
            raise RuntimeError(
                f"voice session made no progress for {stalled:.0f} s on {self.voice.device}"
            )

    def stop(self) -> None:
        self.voice.release(self.session)


class VoiceWork:
    """The receiver's voice profile: one session per Job, from one warm model."""

    def __init__(self, canaries: set[str], slots: int = 2) -> None:
        import torch

        self.voice = Voice(slots)
        timing("model_loaded")
        self.device = torch.cuda.get_device_name(0)
        self.reference = np.load(REFERENCE)
        self.canaries = canaries
        # Warm up (compile, CUDA) and prove the model before the receiver asks
        # for Jobs, so a Job's first frame is not a cold start.
        warm = self._complete(warm_up=True)
        print("VOICE_WARM " + json.dumps(warm, sort_keys=True) + "\n", end="", flush=True)

    def _complete(self, warm_up: bool = False) -> dict[str, Any]:
        session = self.voice.open(TEXT)
        held = HeldSession(self.voice, session)
        try:
            while not session.done.wait(1):
                held.poll()
            session.wait(0)
        except BaseException:
            held.stop()
            raise
        done_ms = epoch_ms()
        evidence = check(session.audio(), self.reference, self.device, self.voice.load_id)
        first = session.first_chunk_ms or done_ms
        if warm_up:
            timing("warm_first_chunk", first)
            timing("warm_done", done_ms)
        # From the session's admission: its first audio, and wall time over audio time.
        evidence["firstChunkMs"] = first - session.opened_ms
        evidence["rtf"] = round((done_ms - session.opened_ms) / 1000 / evidence["seconds"], 3)
        return evidence

    def __call__(self, job: Any, behavior: str) -> HeldSession | None:
        if job.id in self.canaries:
            # Checked like any session (a failed check raises its own error),
            # then errored on purpose so the harness can read the evidence.
            raise RuntimeError("VOICE_CANARY " + json.dumps(self._complete(), sort_keys=True))
        if behavior == "complete":
            print("VOICE_SESSION " + json.dumps(self._complete(), sort_keys=True), flush=True)
            return None
        return HeldSession(self.voice, self.voice.open(HELD_TEXT, hold=True))


def load_service(device: str, slots: int) -> tuple[Any, Callable[[str], list[list[int]]]]:
    """Kyutai TTS behind its TTSService, greedy, fp16 on CUDA and fp32 on CPU."""
    import torch

    sys.path.insert(0, "/opt/kyutai")
    from moshi.models import loaders
    from moshi.models.tts import TTSModel, script_to_entries
    from tts_service import TTSService

    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("voice receiver requires a visible CUDA device")
    info = loaders.CheckpointInfo.from_hf_repo(REPO, revision=REVISION)
    model = TTSModel.from_checkpoint_info(
        info,
        n_q=32,
        temp=0.0,  # moshi samples only above 0: greedy
        cfg_coef=2.0,
        device=device,
        # Not upstream's bf16: the Azure T4 has none. fp16 measured 0.049 from
        # the fp32 CPU reference on an A10; P4 proves it on the T4.
        dtype=torch.float16 if device == "cuda" else torch.float32,
    )
    # Trained with CFG distillation: the coefficient is a condition (as in
    # tts_service.init).
    cfg_condition = model.cfg_coef
    model.cfg_coef = 1.0
    voice_file = MODELS / "tts-voices" / f"{VOICE}{model.voice_suffix}"
    attributes = model.make_condition_attributes([voice_file, voice_file], cfg_coef=cfg_condition)
    service = TTSService(
        batch_size=slots,
        default_attribute_name=VOICE,
        all_attributes={VOICE: attributes},
        tts_model=model,
        cfg_condition=cfg_condition,
        cfg_is_no_text=False,
        padding_between=1,
        n_q=32,
    )
    if device == "cuda" and any(p.device.type != "cuda" for p in model.lm.parameters()):
        raise RuntimeError("voice model parameters were not loaded on CUDA")

    def encode(text: str) -> list[list[int]]:
        entries = script_to_entries(
            model.tokenizer,
            model.machine.token_ids,
            model.mimi.frame_rate,
            [text],
            multi_speaker=model.multi_speaker,
            padding_between=1,
        )
        pad = model.machine.token_ids.pad
        return [entry.tokens or [pad] * entry.padding for entry in entries]

    return service, encode


def build_reference() -> None:
    """At image build, without a GPU: render TEXT on CPU and require Whisper to hear it."""
    voice = Voice(slots=1, device="cpu")
    session = voice.open(TEXT)
    session.wait(900)  # inside the receiver build's 20-minute limit
    audio = session.audio()
    heard = transcribe(audio)
    error_rate = word_error_rate(TEXT, heard)
    if not error_rate <= MAX_WORD_ERROR_RATE:
        raise RuntimeError(f"reference speech is not its text (WER {error_rate}): {heard}")
    np.save(REFERENCE, audio)
    REFERENCE_REPORT.write_text(
        json.dumps(
            {
                "text": TEXT,
                "heard": heard,
                "wordErrorRate": error_rate,
                "seconds": round(len(audio) / 24_000, 2),
                "sha256": hashlib.sha256(audio.tobytes()).hexdigest(),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-reference", action="store_true", required=True)
    parser.parse_args()
    build_reference()
