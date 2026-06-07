# Backlog

Ideas not yet scheduled. See the roadmap in the README for the current phase.

## Kiosk

- **Push-to-talk button (no wake word).** A button in the kiosk that records audio
  while held down (WhatsApp-style: press-and-hold to record, release to send), then
  sends the captured audio straight to the agent as a command — bypassing the wake
  word entirely. Needs: a kiosk UI control (hold to record, visual recording state),
  capture mic audio in the browser (MediaRecorder), and a path to deliver the audio
  to the agent for STT → the normal turn pipeline (e.g. a new client→server WS
  message carrying the audio, handled alongside the existing typed-text path).

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
