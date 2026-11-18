"""The voice receiver's slot scheduling and checks, against a stub TTSService."""

import runpy
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

voice = runpy.run_path(
    str(Path(__file__).resolve().parents[1] / "integration/e2e/internal/fixtures/voice_session.py")
)


class StubService:
    """TTSService's slot contract: -1 admits with a word, -2 ends, one word per step."""

    def __init__(self, slots, fail=False):
        self.clients = [SimpleNamespace(state=None, complete=False) for _ in range(slots)]
        self.updates = []
        self.fail = fail

    def step(self, updates, pcm, flags, _codes):
        if self.fail:
            raise RuntimeError("probability tensor contains nan")
        self.updates.append(list(updates))
        flags[:] = 0
        for slot, entry, _voice in updates:
            client = self.clients[slot]
            if entry[0] == -1:
                assert entry[1:], "a reset must carry its first word"
                client.state, client.complete, entry = SimpleNamespace(entries=[]), False, entry[1:]
            if entry == [-2]:
                client.complete = True
            else:
                client.state.entries.append(entry)
        for slot, client in enumerate(self.clients):
            if client.state is None:
                continue
            if client.state.entries:
                client.state.entries.pop(0)
                pcm[slot] = 0.1 * (slot + 1)
                flags[slot] |= voice["HAS_PCM"]
            elif client.complete:
                flags[slot] |= voice["IS_EOS"]
                client.state = None
        time.sleep(0.001)


def encode(text):
    return [[index] for index, _word in enumerate(text.split())]


def until(condition, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not condition():
        assert time.monotonic() < deadline, "condition not reached"
        time.sleep(0.005)


def make(slots=2, **options):
    service = StubService(slots, **options)
    return voice["Voice"](slots, service=service, encode=encode), service


def test_overlapping_sessions_progress_in_their_own_slots_and_free_them():
    sessions, service = make()
    first = sessions.open("one two three four")
    second = sessions.open("five six")
    first.wait(5)
    second.wait(5)
    assert len(first.chunks) == 4 and len(second.chunks) == 2
    # Each session holds only its own slot's audio.
    assert np.allclose(first.audio(), 0.1) and np.allclose(second.audio(), 0.2)
    until(lambda: service.clients[0].state is None and service.clients[1].state is None)
    sessions.open("again")
    sessions.open("and again")  # both slots were freed


def test_a_third_session_is_refused_while_both_slots_are_busy():
    sessions, _service = make()
    sessions.open("a b", hold=True)
    sessions.open("c d", hold=True)
    with pytest.raises(RuntimeError, match="no free voice slot"):
        sessions.open("e f")


def test_a_held_session_keeps_generating_until_released_and_its_slot_is_reused():
    sessions, service = make(slots=1)
    held = sessions.open("held words here", hold=True)
    until(lambda: len(held.chunks) > 20)  # far past its three words: re-admitted
    assert not held.done.is_set()
    sessions.release(held)
    assert held.done.is_set()
    until(lambda: service.clients[0].state is None)
    stopped = len(held.chunks)
    time.sleep(0.05)
    assert len(held.chunks) == stopped  # a released slot computes nothing
    reused = sessions.open("x y")
    reused.wait(5)
    assert len(reused.chunks) == 2
    # Every utterance, held or not, starts with a reset carrying its first word.
    admissions = [u for step in service.updates for u in step if u[1][0] == -1]
    assert len(admissions) > 2 and {tuple(u[1]) for u in admissions} == {(-1, 0)}


def test_a_scheduler_failure_errors_every_session_and_refuses_new_ones():
    sessions, _service = make(fail=True)
    session = sessions.open("a b")
    with pytest.raises(RuntimeError, match="voice session failed: probability tensor"):
        session.wait(5)
    with pytest.raises(RuntimeError, match="voice scheduler failed"):
        sessions.open("c d")


def test_text_without_words_is_refused_before_it_takes_a_slot():
    sessions, _service = make(slots=1)
    with pytest.raises(ValueError, match="no words"):
        sessions.open("   ")
    sessions.open("a b").wait(5)


def test_a_slot_released_and_reopened_before_the_next_step_starts_fresh():
    sessions, service = make(slots=1)
    held = sessions.open("held words here", hold=True)
    until(lambda: len(held.chunks) > 3)
    with sessions._lock:  # both land in one scheduler iteration
        sessions.release(held)
        fresh = sessions.open("x y")
    fresh.wait(5)
    assert len(fresh.chunks) == 2 and np.allclose(fresh.audio(), 0.1)


def test_the_check_accepts_its_reference_and_rejects_silence_and_other_speech():
    rng = np.random.default_rng(1)
    reference = rng.normal(0, 0.1, 24_000 * 3).astype(np.float32)
    evidence = voice["check"](reference, reference, "Tesla T4", "load-1")
    assert evidence["distance"] == 0.0 and evidence["device"] == "Tesla T4"
    with pytest.raises(RuntimeError, match="no speech"):
        voice["check"](np.zeros_like(reference), reference, "Tesla T4", "load-1")
    # A correct but truncated session matches its reference's opening.
    with pytest.raises(RuntimeError, match="lasted 2.50 s against its reference's 3.00 s"):
        voice["check"](reference[: 24_000 * 5 // 2], reference, "Tesla T4", "load-1")
    other = np.sin(np.arange(len(reference)) / 7).astype(np.float32) * 0.1
    with pytest.raises(RuntimeError, match="distance .* on Tesla T4 exceeds"):
        voice["check"](other, reference, "Tesla T4", "load-1")
    with pytest.raises(RuntimeError, match="no speech|exceeds"):
        voice["check"](np.full_like(reference, np.nan), reference, "Tesla T4", "load-1")


def test_word_error_rate():
    assert voice["word_error_rate"]("The quick brown fox.", "the quick brown fox") == 0.0
    assert voice["word_error_rate"]("a b c d", "a x c") == 0.5


def test_a_held_session_that_stops_producing_audio_is_a_stall():
    sessions, _service = make(slots=1)
    held = voice["HeldSession"](sessions, sessions.open("a b c", hold=True))
    until(lambda: len(held.session.chunks) > 1)
    held.poll()
    held.session.last_chunk_at -= voice["STALL_SECONDS"] + 1
    with pytest.raises(RuntimeError, match="no progress for"):
        held.poll()
    held.stop()
    assert held.session.done.is_set()


def test_a_session_dates_its_first_chunk_from_its_admission():
    sessions, _service = make()
    session = sessions.open("one two three")
    session.wait(5)
    assert session.opened_ms <= session.first_chunk_ms
