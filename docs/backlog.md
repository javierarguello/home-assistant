# Backlog

Ideas not yet scheduled. See the roadmap in the README for the current phase.

## Kiosk

- **Push-to-talk button (no wake word).** DONE — hold the 🎙 button to record
  (MediaRecorder), release to send a `push-audio` event; the agent transcodes it
  (ffmpeg → 16 kHz WAV), runs STT, and handles it as a turn. Caveat: getUserMedia
  needs a secure context, so open the kiosk at `http://localhost:5173` on the Pi
  (plain-http access from another LAN device is blocked by the browser). Possible
  follow-up: serve the kiosk over HTTPS for remote push-to-talk.

## Background agents (interactive layer) — DONE (pending live verification)

Implemented: `ask_user` (input-required) + `answer_task`/`task-answer` resume +
`task_status` live query, surfaced via voice + kiosk option buttons. See
[background-tasks.md](background-tasks.md). Remaining:

- **Inject context into a still-`running` worker** (not just when awaiting input or
  finished) — would need queuing a mid-run message.
- **Richer live progress** — workers narrating step-by-step so `task_status` shows
  fine-grained activity (today it's status + last step).
- **Live end-to-end verification** of the input-required → answer → resume round-trip
  against real Gemini/ADK (function-response DataPart shape).
