# Wake word

The voice loop starts with a **wake word**: a short phrase the assistant listens
for continuously before it records a command. This doc covers how it works here,
how to swap or tune the wake word, and how to train a custom one (incl. Spanish).

## Engine

We use **openWakeWord** — fully local, no API key, no phone-home. It runs as a
Python side-car (`apps/agent/python/wakeword_runner.py`) that owns the mic at
16 kHz mono, scores every 80 ms frame, and emits JSON events to the Node agent.

> Porcupine (Picovoice) is supported as an alternative (`WAKE_WORD_ENGINE=porcupine`)
> but needs an API key + periodic internet to validate its license, so it is **not**
> the default. Its upside: a web console that trains Spanish wake words instantly.

## Configuration (`.env`)

```bash
WAKE_WORD_ENGINE=openwakeword
WAKE_WORD=hey_jarvis            # built-in name OR absolute path to a .onnx/.tflite
WAKE_WORD_THRESHOLD=0.35        # 0–1; higher = stricter (fewer false fires)
```

`WAKE_WORD` accepts either:
- a **built-in model name**: `hey_jarvis` (default), `alexa`, `hey_mycroft`,
  `hey_rhasspy` — these ship with openWakeWord, no file needed; or
- an **absolute path** to a custom `.onnx`/`.tflite` model.

No code changes are needed to switch — it's all `.env`.

### Switching wake words

The `.env` keeps both presets; comment/uncomment to switch, then restart the agent:

```bash
# --- Spanish "Ey Alfredo" (custom model) — ACTIVE ---
WAKE_WORD=/abs/path/models/Hey_Alfred_20260604_230140.onnx
WAKE_WORD_THRESHOLD=0.35
#
# --- Default "Hey Jarvis" (built-in) ---
# WAKE_WORD=hey_jarvis
# WAKE_WORD_THRESHOLD=0.35
```

### Tuning the threshold

- **Won't wake / inconsistent** → lower it (e.g. `0.35 → 0.3`).
- **Fires on its own** (TV, conversation) → raise it (e.g. `0.5 → 0.65`).

The kiosk shows the live score, so you can watch how close speech gets to firing
and calibrate. Other capture knobs (silence cutoff, etc.) are documented at the
top of `apps/agent/python/wakeword_runner.py`.

## The bundled "Ey Alfredo" model

`models/Hey_Alfred_20260604_230140.onnx` is a community-trained Spanish model.
Despite the English-looking filename, it responds to **"Ey / Hey Alfredo"**
(Mexican pronunciation, *al-FRE-do*).

We profiled it offline by synthesizing phrases with the installed Piper voices
and scoring them through the model:

| Check | Result |
|-------|--------|
| Language | Spanish — "Ey/Hey Alfredo" fires; "Hey Alfred" (English) does not |
| False positives | None — 15 common Spanish phrases all scored ≤ 0.03 |
| Robustness | **Weak** — only fires reliably for one voice (`es_MX-ald`, ~0.97); an Argentine voice barely reacts (~0.02) |

It's narrow because it was trained on too few speakers — the classic limitation
of Spanish openWakeWord models (see "Training" below). The upside: with a 0.03
false-positive ceiling, the threshold can safely go low (we run `0.35`) to give
real voices more room to trigger. If it misses your voice in practice, train your
own (next section) for a more robust model.

### Profiling a model offline (no mic)

You can measure any model without speaking by synthesizing test phrases with
Piper and scoring them. Run with the wake-word venv:

```bash
SSL_CERT_FILE="$(vendor/wakeword-venv/bin/python -m certifi)" \
  vendor/wakeword-venv/bin/python - <<'PY'
import subprocess, os, tempfile, wave, numpy as np
from openwakeword.model import Model
PIPER, MODEL = "vendor/piper-venv/bin/piper", "models/Hey_Alfred_20260604_230140.onnx"
VOICE = "voices/es_MX-ald-medium.onnx"
def score(text):
    tmp = tempfile.mkdtemp(); raw, wav = tmp+"/r.wav", tmp+"/o.wav"
    subprocess.run([PIPER,"-m",VOICE,"-f",raw], input=text.encode(), check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["ffmpeg","-y","-i",raw,"-ar","16000","-ac","1","-sample_fmt","s16",wav],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pcm = np.frombuffer(wave.open(wav,"rb").readframes(1<<24), dtype=np.int16)
    m = Model(wakeword_models=[MODEL])
    return max(float(max(m.predict(pcm[i:i+1280]).values())) for i in range(0,len(pcm)-1280,1280))
for p in ["Ey Alfredo", "Hey Alfred", "enciende la luz"]:
    print(f"{p:20} {score(p):.2f}")
PY
```

Want LOW scores for negatives, HIGH (≥ 0.5) for your wake phrase across several
voices. Vary `--length_scale` and try multiple `voices/*.onnx` to gauge robustness.

## Training a custom wake word

openWakeWord trains on **synthetic** speech — you don't record yourself. The
pipeline: generate thousands of clips of the phrase with Piper TTS → mix with
background noise (augmentation) → train a tiny classifier → export `.onnx`.

The phrase is **free-form** — not limited to "hey X". Pick something distinctive
and ≥ 3–4 syllables ("oye casa", "hola Jarvis"); avoid short/common words that
collide with everyday speech.

### The Spanish caveat

openWakeWord's strong English models lean on a special **904-speaker** generator
voice (`en_US-libritts_r`). As of mid-2026 the sample generator ships multi-speaker
models for **English, German, French, Dutch only — no Spanish**. Spanish Piper
voices are all **single-speaker**, so a naive Spanish model trains on too few
voices and ends up narrow (exactly what the "Ey Alfredo" model shows).

Workarounds, easiest first:
1. **Cycle several Spanish voices** — generate with 5–6 different `es_ES`/`es_MX`/
   `es_AR` single-speaker voices to fake speaker diversity. Best effort/result.
2. **Voice conversion** — generate with one TTS, then convert clips onto ~100 real
   native-speaker recordings (`freevc24` / `openvoice_v2`). Robust but heavy.
3. **Porcupine GUI** — instant Spanish via web console, but needs a key + internet
   and the `.ppn` expires (~30 days on the free tier).

### Sample counts (recommended)

| Item | Count | Note |
|------|-------|------|
| Positive (train) | ~30,000 | spread across the cycled voices |
| Positive (val) | ~3,000 | |
| Augmentation | ~5–10× | noise/reverb — this, not raw count, adds variety |
| Training steps | ~20,000–30,000 | |

With only ~6 Spanish voices, going past ~30k positives adds little (it just
repeats the same voices) — aggressive augmentation matters more. Start at 30k.

### Where to train

- **Google Colab** (free T4 GPU, ~1 h): open
  `notebooks/automatic_model_training.ipynb` from the openWakeWord repo. There is
  **no language field** — the language is whichever Piper voice the notebook
  downloads (English by default; swap the `wget` for Spanish voices and cycle them).
- **Locally on your Mac** (no GPU needed, ~5–9 h ≈ overnight): the bottleneck is
  generating the clips on CPU; the classifier itself trains in under ~1.5 h.
  Requires a one-time ~40–60 GB download of negative-audio features and ≥ 16 GB RAM.

After training, drop the `.onnx` in `models/` and point `WAKE_WORD` at it.
