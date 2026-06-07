#!/usr/bin/env python3
"""openWakeWord side-car.

Fully-local, no API key. Owns the microphone: listens for the wake word, records
the following utterance (simple RMS end-of-speech), writes a 16 kHz mono WAV, and
emits newline-delimited JSON events on stdout for the Node agent to consume:

    {"event": "ready", "model": "hey_jarvis"}
    {"event": "wake", "score": 0.71}
    {"event": "utterance", "wav": "/tmp/oww-utt-….wav"}
    {"event": "error", "message": "…"}

Config via env vars (set by the Node side):
    WAKEWORD_MODEL            model name (e.g. hey_jarvis) or path to a .onnx/.tflite
    WAKEWORD_THRESHOLD        detection threshold (default 0.5)
    WAKEWORD_MAX_SECONDS      max utterance length (default 8)
    WAKEWORD_SILENCE_SECONDS  trailing silence that ends an utterance (default 1.0)
    WAKEWORD_SILENCE_RMS      RMS below which a frame counts as silence (default 500)
    WAKEWORD_INPUT_DEVICE     optional sounddevice input device index/name
"""
import json
import os
import select
import sys
import tempfile
import time
import wave

import numpy as np
import sounddevice as sd
from openwakeword.model import Model

SAMPLE_RATE = 16000
CHUNK = 1280  # 80 ms @ 16 kHz — openWakeWord's expected chunk size

MODEL = os.environ.get("WAKEWORD_MODEL", "hey_jarvis")
THRESHOLD = float(os.environ.get("WAKEWORD_THRESHOLD", "0.5"))
MAX_SECONDS = float(os.environ.get("WAKEWORD_MAX_SECONDS", "8"))
SILENCE_SECONDS = float(os.environ.get("WAKEWORD_SILENCE_SECONDS", "1.2"))
SILENCE_RMS = float(os.environ.get("WAKEWORD_SILENCE_RMS", "500"))
# How long to wait for the command to actually begin after the wake word (the
# user typically pauses between "hey jarvis" and the request). Leading silence
# during this window does NOT end the capture.
START_SECONDS = float(os.environ.get("WAKEWORD_START_SECONDS", "4.0"))
# Frames of wake-word tail to drop so "…jarvis" doesn't count as the command.
SKIP_FRAMES = int(os.environ.get("WAKEWORD_SKIP_FRAMES", "3"))
INPUT_DEVICE = os.environ.get("WAKEWORD_INPUT_DEVICE") or None


def emit(obj):
    # default= handles numpy scalars (e.g. float32 scores) which aren't JSON-native.
    sys.stdout.write(json.dumps(obj, default=lambda o: o.item() if hasattr(o, "item") else str(o)) + "\n")
    sys.stdout.flush()


def rms(frame):
    if frame.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))


def write_wav(frames):
    path = os.path.join(tempfile.gettempdir(), f"oww-utt-{int(time.time() * 1000)}.wav")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # int16
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"".join(f.tobytes() for f in frames))
    return path


def reset(model):
    fn = getattr(model, "reset", None)
    if callable(fn):
        try:
            fn()
        except Exception:
            pass


def poll_command():
    """Non-blocking read of a one-line command from the Node side (e.g. 'capture')."""
    try:
        ready, _, _ = select.select([sys.stdin], [], [], 0)
        if not ready:
            return None
        line = sys.stdin.readline()
        return line.strip() if line else None
    except Exception:  # noqa: BLE001
        return None


def capture_command(stream, skip_tail):
    """Records one command utterance: waits up to START_SECONDS for speech to begin,
    then records until ~SILENCE_SECONDS of trailing silence. Returns (frames, started)."""
    silence_hang = max(1, int(SILENCE_SECONDS * SAMPLE_RATE / CHUNK))
    start_hang = max(1, int(START_SECONDS * SAMPLE_RATE / CHUNK))
    max_frames = int(MAX_SECONDS * SAMPLE_RATE / CHUNK)
    if skip_tail:
        # Drop the wake-word tail ("…jarvis") so it isn't mistaken for the command.
        for _ in range(SKIP_FRAMES):
            stream.read(CHUNK)
    frames, started, silent, waited = [], False, 0, 0
    for _ in range(max_frames):
        data, _ = stream.read(CHUNK)
        f = data[:, 0]
        loud = rms(f) > SILENCE_RMS
        if not started:
            if loud:
                started = True
                frames.append(f)
            else:
                waited += 1
                if waited >= start_hang:
                    break  # nobody spoke
            continue
        frames.append(f)
        if loud:
            silent = 0
        else:
            silent += 1
            if silent >= silence_hang:
                break
    return frames, started


def main():
    try:
        model = Model(wakeword_models=[MODEL])
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"failed to load wake-word model '{MODEL}': {e}"})
        return 1

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="int16", blocksize=CHUNK, device=INPUT_DEVICE
        ) as stream:
            emit({"event": "ready", "model": MODEL})
            while True:
                # Follow-up capture: the agent asked a question, so the Node side
                # tells us to listen for the answer directly (no wake word needed).
                if poll_command() == "capture":
                    frames, started = capture_command(stream, skip_tail=False)
                    emit({"event": "utterance", "wav": write_wav(frames)} if started else {"event": "aborted"})
                    reset(model)
                    continue

                data, _ = stream.read(CHUNK)
                frame = data[:, 0]
                scores = model.predict(frame)
                score = max(scores.values()) if scores else 0.0
                # Emit every frame: drives the kiosk's live level/score meter so
                # the user can see the mic hears audio (rms) and how close the
                # score is to firing. ~12.5 msgs/s — fine over a local socket.
                emit({"event": "score", "score": round(float(score), 3), "rms": round(rms(frame), 1)})
                if score < THRESHOLD:
                    continue

                emit({"event": "wake", "score": round(score, 3)})
                reset(model)
                frames, started = capture_command(stream, skip_tail=True)
                # Only transcribe if we actually captured speech; otherwise tell
                # the agent to drop back to idle (no command followed the wake).
                if started:
                    emit({"event": "utterance", "wav": write_wav(frames)})
                else:
                    emit({"event": "aborted"})
                reset(model)
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"audio capture failed: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
