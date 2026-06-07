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

## Background agents (interactive layer)

- **Live status query / give-context-and-resume / input-required.** Let the root ask
  a running sub-agent what it's doing, feed it more context and resume it, and let a
  sub-agent stop to ask the user a question (A2A input-required) — surfacing options
  on screen (detail sidebar) so the user can answer and the task resumes. (Pause /
  cancel already exist via `control_task`; the output bank already exists.)
