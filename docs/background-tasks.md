# Background task agents

Heavy, multi-step jobs run as **independent background agents** instead of blocking
the voice loop. The assistant says "lo estoy revisando", the work runs in its own
process, the kiosk shows it working, and the assistant announces by voice when it
finishes. Off by default — enable with `TASKS_ENABLED=true`.

## How it works

```
 voice/chat ─▶ root agent
                 │  start_task{ kind, request, needsCodeAnalysis }  → returns a task id immediately
                 │  check_tasks{}                                    → what's running / recent results
                 │  control_task{ action, taskId? }                 → pause | resume | cancel
                 ▼
            TaskManager (apps/agent/src/tasks/manager.ts)
                 ├─ spawns ONE detached child process per task: an A2A worker service
                 ├─ drives it with the @a2a-js/sdk client in the background (never blocks voice)
                 ├─ streams progress → kiosk 'task' events
                 ├─ idle reaper: after TASK_IDLE_MINUTES → summarize → task bank → kill the worker
                 └─ persists live workers → data/tasks-running.json (recovered on restart)
```

- **One process per task** (A2A over localhost), so workers are isolated and can be
  paused/killed independently. The worker uses ADK's `toA2a()` to serve itself; the
  manager talks to it as an A2A client.
- **Each worker has its own prompt, tools, and memory** (its own session).
- The design is generic: a worker is a `kind` registered in
  `apps/agent/src/tasks/workers/index.ts`.

## Workers (kinds)

| kind | What it does | Tools | Model |
|------|--------------|-------|-------|
| `github` | Investigates a repo: commits, diffs between refs, PRs, deployments | `github_*` | cheap by default; Pro only when `needsCodeAnalysis` |
| `research` | Web research: plans, searches, cross-checks, synthesizes | `update_plan`, `web_research`, `request_feedback` | fast `WORKER_RESEARCH_*` by default; **deep** investigations escalate to `WORKER_RESEARCH_DEEP_*` (thinking on for both) |

### The research worker

Works a **plan**: drafts one (`update_plan`), executes it with **budgeted** searches
(`web_research`, capped by `RESEARCH_MAX_TURNS` so it can't run away), revises the plan
each turn, and can **stop to ask the user** (`request_feedback`) when blocked or
ambiguous. Its web search reuses the configured backend (`TAVILY_API_KEY` / Brave /
DuckDuckGo).

## Model policy (tiered)

| Context | Model | When |
|---------|-------|------|
| Root assistant (general chat, web_search) | **lite** (`LLM_MODEL`) | always |
| GitHub worker | **flash** (`WORKER_MODEL`) | default |
| GitHub worker | **pro** (`WORKER_ANALYSIS_MODEL`) | root sets `needsCodeAnalysis: true` (reasoning over code) |
| Research worker | **flash** (`WORKER_RESEARCH_MODEL`) | default |
| Research worker | **pro** (`WORKER_RESEARCH_DEEP_MODEL`) | root sets `deep: true` (user asked for a deep/thorough investigation) |

GitHub runs **as a task** (not inline on the root), so even simple lookups (list
commits, PR status) use flash rather than the lite root model. Task summaries (on
reap) use the cheap model — and need a **static API key** (skipped under
`AUTH=gcloud`, same as memory consolidation).

## Controlling tasks

- **check_tasks** — lists running/recent tasks (id, kind, status, step) plus recent
  summaries, so the assistant can answer "¿qué están haciendo?" / "¿ya terminó?".
- **control_task** — `cancel` (SIGTERM, marks canceled), `pause` (SIGSTOP) / `resume`
  (SIGCONT). If the user doesn't name a task and only one is active, the id can be
  omitted. Pause is best-effort: a long pause may drop an in-flight model request.

## Task memory bank

When a task is reaped, a one- to two-sentence recap is written to a small ring buffer
(`data/task-bank.json`, ≤ `TASK_BANK_MAX`, default 10) and injected into the root
prompt, so the user can ask about past work ("¿qué encontraste en el repo?").

## Crash resilience

- **Workers survive a main-process crash** — they're spawned `detached`, and live
  workers are persisted to `data/tasks-running.json`.
- On startup the TaskManager **re-attaches** to survivors (probes the pid, then
  `getTask`/`resubscribeTask`); finished-while-down work is recovered and banked.
- The **main process** is restarted by systemd (`Restart=on-failure`), not by itself.

## Rich detail sidebar

Tools can push **HTML detail** to the kiosk, separate from the spoken text:
`emitDetail(title, html)` (`apps/agent/src/tools/detail.ts`) sends a `detail`
ServerEvent that the kiosk shows in a **collapsible sidebar** — expanded it takes 80%
of the width (left), with a compact assistant summary on the right 20%. `web_search`
uses it to show a clickable results list. Text inside detail HTML is escaped.

## Configuration

```
TASKS_ENABLED=true            # master switch (off by default)
TASK_IDLE_MINUTES=30          # kill an idle worker after this (then bank a summary)
MAX_CONCURRENT_TASKS=3        # caps worker processes / RAM
TASK_ANNOUNCE=true            # speak a notice when a task finishes
TASK_BANK_MAX=10              # past-task summaries kept

WORKER_MODEL=<gemini-flash>           # cheap default for every worker
WORKER_ANALYSIS_MODEL=<gemini-pro>    # used only when code analysis is needed
WORKER_RESEARCH_MODEL=<gemini-pro>    # research worker (thinking on by default)
RESEARCH_MAX_TURNS=12                 # research search-turn budget
# WORKER_* / WORKER_ANALYSIS_* / WORKER_RESEARCH_* accept _BASE_URL/_API_KEY/_AUTH/_THINK

ENABLE_GITHUB=true            # also required for the github worker's tools
GITHUB_TOKEN=ghp_...          # repo scope for private repos
```

## Adding a worker

1. Create `apps/agent/src/tasks/workers/<kind>-worker.ts` — an `LlmAgent` with its
   own prompt and tools (`build(model) => LlmAgent`).
2. Register it in `apps/agent/src/tasks/workers/index.ts` (`WORKERS[kind] = { label,
   resolveModel, build }`). The `start_task` kind enum updates automatically.

## Key files

| File | Role |
|------|------|
| `apps/agent/src/tasks/manager.ts` | Spawn, drive, reap, persist, recover |
| `apps/agent/src/tasks/worker-entry.ts` | Child process: serves a worker over A2A |
| `apps/agent/src/tasks/workers/` | Worker registry + `github`/`research` agents |
| `apps/agent/src/tasks/bank.ts` | Task memory bank + summarizer |
| `apps/agent/src/tools/tasks.ts` | `start_task` / `check_tasks` / `control_task` |
| `apps/agent/src/tools/detail.ts` | HTML detail side channel |
