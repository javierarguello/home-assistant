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
SILENCE_SECONDS = float(os.environ.get("WAKEWORD_SILENCE_SECONDS", "1.0"))
SILENCE_RMS = float(os.environ.get("WAKEWORD_SILENCE_RMS", "500"))
INPUT_DEVICE = os.environ.get("WAKEWORD_INPUT_DEVICE") or None


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
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


def main():
    try:
        model = Model(wakeword_models=[MODEL])
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"failed to load wake-word model '{MODEL}': {e}"})
        return 1

    silence_hang = max(1, int(SILENCE_SECONDS * SAMPLE_RATE / CHUNK))
    max_frames = int(MAX_SECONDS * SAMPLE_RATE / CHUNK)

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE, channels=1, dtype="int16", blocksize=CHUNK, device=INPUT_DEVICE
        ) as stream:
            emit({"event": "ready", "model": MODEL})
            while True:
                data, _ = stream.read(CHUNK)
                frame = data[:, 0]
                scores = model.predict(frame)
                score = max(scores.values()) if scores else 0.0
                if score < THRESHOLD:
                    continue

                emit({"event": "wake", "score": round(score, 3)})
                reset(model)

                # Record the utterance until ~SILENCE_SECONDS of trailing silence.
                frames, started, silent = [], False, 0
                for _ in range(max_frames):
                    data, _ = stream.read(CHUNK)
                    f = data[:, 0]
                    frames.append(f)
                    if rms(f) > SILENCE_RMS:
                        started, silent = True, 0
                    elif started:
                        silent += 1
                        if silent >= silence_hang:
                            break

                emit({"event": "utterance", "wav": write_wav(frames)})
                reset(model)
    except Exception as e:  # noqa: BLE001
        emit({"event": "error", "message": f"audio capture failed: {e}"})
        return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
