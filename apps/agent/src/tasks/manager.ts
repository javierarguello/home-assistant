/**
 * TaskManager — spawns background worker agents (one detached child process per
 * task, exposed over A2A), drives them with the A2A client in the background so
 * the voice loop never blocks, reaps them after idle (summarizing into the task
 * bank first), and survives a restart by re-attaching to live workers.
 *
 * Running workers are persisted to `config.tasks.bankFile`'s sibling
 * `tasks-running.json` so a crashed-and-restarted main process can find and
 * resume them (workers are spawned `detached`, so they outlive the parent).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { A2AClient } from '@a2a-js/sdk/client';
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, Message, Part } from '@a2a-js/sdk';
import type { TaskInfo, TaskStatus } from '@home-assistant/shared';
import { config } from '../config/env.js';
import { createLogger } from '../logger.js';
import { emitDetail, escapeHtml } from '../tools/detail.js';
import { type WorkerKind, WORKERS, isWorkerKind } from './workers/index.js';
import { addSummary, summarizeTask } from './bank.js';

const log = createLogger('tasks');
const WORKER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'worker-entry.ts');
const RUNNING_FILE = join(dirname(config.tasks.bankFile), 'tasks-running.json');

export interface TaskRecord {
  id: string;
  kind: WorkerKind;
  title: string; // short label for the kiosk/logs (the request, truncated)
  request: string; // full request text given to the worker
  status: TaskStatus;
  step?: string; // latest progress snippet
  analysis: boolean; // escalated to the Pro/code-analysis model
  startedAt: number;
  finishedAt?: number;
  result?: string;
  // runtime
  pid?: number;
  agentCardUrl?: string;
  a2aTaskId?: string; // the A2A task id (for resubscribe after a restart)
  a2aContextId?: string; // the A2A context id (for resume / continuation)
  lastActivityAt: number;
  banked?: boolean;
  /** True once finish()/cancel() has run its finalization (announce/bank/emit). */
  finalized?: boolean;
  // when status is 'awaiting_input':
  pendingQuestion?: string;
  pendingOptions?: string[];
  pendingCallId?: string; // the ask_user function-call id to answer
}

interface ManagerOptions {
  /** Called whenever a task changes (drives the kiosk 'task' event). */
  onUpdate?: (task: TaskInfo) => void;
  /** Called with a short notice when a task finishes (voice announce). */
  announce?: (text: string) => void;
}

const PERSIST_KEYS = [
  'id', 'kind', 'title', 'request', 'status', 'analysis', 'startedAt',
  'finishedAt', 'result', 'pid', 'agentCardUrl', 'a2aTaskId', 'a2aContextId', 'banked',
  'pendingQuestion', 'pendingOptions', 'pendingCallId',
] as const;

function partsText(parts?: Part[]): string {
  return (parts ?? [])
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('');
}

function isAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class TaskManager {
  private readonly registry = new Map<string, TaskRecord>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly idleMs = config.tasks.idleResetMs;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private opts: ManagerOptions = {}) {}

  /** Wire/replace the kiosk + announce callbacks (called by index.ts after construction). */
  configure(opts: ManagerOptions): void {
    this.opts = { ...this.opts, ...opts };
  }

  /** Recovers workers still alive from a previous run, then starts the sweeper. */
  async init(): Promise<void> {
    await this.recover();
    this.sweeper = setInterval(() => this.sweep(), Math.min(this.idleMs, 60_000));
    this.sweeper.unref?.();
  }

  list(): TaskInfo[] {
    return [...this.registry.values()].map((r) => this.view(r));
  }

  /** Resolve a task by id, or the single active one if no id is given. */
  private resolve(id?: string): TaskRecord | undefined {
    if (id) return this.registry.get(id);
    const active = [...this.registry.values()].filter(
      (r) => r.status === 'running' || r.status === 'starting' || r.status === 'paused',
    );
    return active.length === 1 ? active[0] : undefined;
  }

  /** Freeze a running worker process (SIGSTOP). Best-effort. */
  pause(id?: string): TaskInfo {
    const rec = this.resolve(id);
    if (!rec) throw new Error('no matching task to pause');
    if (rec.status === 'running' || rec.status === 'starting') {
      this.signal(rec, 'SIGSTOP');
      rec.status = 'paused';
      rec.lastActivityAt = Date.now();
      this.emit(rec);
      void this.persist();
    }
    return this.view(rec);
  }

  /** Resume a paused worker process (SIGCONT). */
  resume(id?: string): TaskInfo {
    const rec = this.resolve(id);
    if (!rec) throw new Error('no matching task to resume');
    if (rec.status === 'paused') {
      this.signal(rec, 'SIGCONT');
      rec.status = 'running';
      rec.lastActivityAt = Date.now();
      this.emit(rec);
      void this.persist();
    }
    return this.view(rec);
  }

  /** Kill a worker in progress and mark the task canceled (no summary). */
  cancel(id?: string): TaskInfo {
    const rec = this.resolve(id);
    if (!rec) throw new Error('no matching task to cancel');
    rec.finalized = true; // a late stream-end finish() must not override this
    rec.status = 'canceled';
    rec.finishedAt = Date.now();
    rec.banked = true; // don't summarize incomplete work
    this.killWorker(rec); // SIGCONT-then-kill handled in killWorker
    this.emit(rec);
    void this.persist();
    // Drop it from the registry shortly so check_tasks/kiosk clear it.
    setTimeout(() => {
      this.registry.delete(rec.id);
      void this.persist();
    }, 5_000).unref?.();
    log.info('task canceled', { id: rec.id });
    return this.view(rec);
  }

  private signal(rec: TaskRecord, sig: NodeJS.Signals): void {
    const child = this.children.get(rec.id);
    try {
      if (child?.pid) process.kill(child.pid, sig);
      else if (rec.pid) process.kill(rec.pid, sig);
    } catch {
      /* process already gone */
    }
  }

  /** Answer a worker's question (or give it more context) and resume it. */
  answer(id: string | undefined, answer: string): TaskInfo {
    const rec = id
      ? this.registry.get(id)
      : [...this.registry.values()].find((r) => r.status === 'awaiting_input');
    if (!rec) throw new Error('no task is awaiting an answer');
    if (rec.status !== 'awaiting_input') throw new Error(`task ${rec.id} is not awaiting input`);
    const handle = { callId: rec.pendingCallId, contextId: rec.a2aContextId, taskId: rec.a2aTaskId };
    rec.status = 'running';
    rec.step = `respondido: ${answer.slice(0, 60)}`;
    rec.pendingQuestion = undefined;
    rec.pendingOptions = undefined;
    rec.pendingCallId = undefined;
    rec.lastActivityAt = Date.now();
    this.emit(rec);
    void this.persist();
    void this.resumeWithAnswer(rec, handle, answer);
    return this.view(rec);
  }

  /** Live view of a task (status + step + pending question) for "what's it doing?". */
  liveStatus(id?: string): TaskInfo {
    const rec = id
      ? this.registry.get(id)
      : [...this.registry.values()].find(
          (r) => r.status === 'running' || r.status === 'awaiting_input' || r.status === 'starting',
        );
    if (!rec) throw new Error('no matching task');
    return this.view(rec);
  }

  /** Resumes a paused worker by sending the user's answer as a function response. */
  private async resumeWithAnswer(
    rec: TaskRecord,
    handle: { callId?: string; contextId?: string; taskId?: string },
    answer: string,
  ): Promise<void> {
    if (!rec.agentCardUrl) {
      this.finish(rec, 'failed', 'lost worker handle');
      return;
    }
    const textMessage = (): Message => ({
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      taskId: handle.taskId,
      contextId: handle.contextId,
      parts: [{ kind: 'text', text: answer }],
    });
    try {
      const client = await A2AClient.fromCardUrl(rec.agentCardUrl);
      const message: Message = handle.callId
        ? {
            kind: 'message',
            messageId: randomUUID(),
            role: 'user',
            taskId: handle.taskId,
            contextId: handle.contextId,
            parts: [
              {
                kind: 'data',
                data: { id: handle.callId, name: 'ask_user', response: { answer } },
                metadata: { adk_type: 'function_response' },
              } as Part,
            ],
          }
        : textMessage();
      await this.consume(rec, client.sendMessageStream({ message }));
    } catch (e) {
      log.error('resume failed; retrying as plain text', { id: rec.id, err: (e as Error).message });
      try {
        const client = await A2AClient.fromCardUrl(rec.agentCardUrl);
        await this.consume(rec, client.sendMessageStream({ message: textMessage() }));
      } catch (e2) {
        this.finish(rec, 'failed', `could not resume after answer: ${(e2 as Error).message}`);
      }
    }
  }

  /** Starts a background task; returns its id immediately (does not block). */
  async start(input: {
    kind: string;
    request: string;
    needsCodeAnalysis?: boolean;
    deep?: boolean;
  }): Promise<TaskInfo> {
    if (!isWorkerKind(input.kind)) throw new Error(`unknown task kind "${input.kind}"`);
    const running = [...this.registry.values()].filter((r) => r.status === 'running' || r.status === 'starting');
    if (running.length >= config.tasks.maxConcurrent) {
      throw new Error(`too many tasks running (${running.length}/${config.tasks.maxConcurrent}); try again shortly`);
    }
    const opts = { needsCodeAnalysis: !!input.needsCodeAnalysis, deep: !!input.deep };
    const rec: TaskRecord = {
      id: randomUUID().slice(0, 8),
      kind: input.kind,
      title: input.request.slice(0, 80),
      request: input.request,
      status: 'starting',
      // "analysis" = escalated to a stronger model (code analysis or deep research).
      analysis: opts.needsCodeAnalysis || opts.deep,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.registry.set(rec.id, rec);
    this.emit(rec);

    const { child, agentCard, pid } = await this.spawnWorker(rec.kind, opts);
    rec.pid = pid;
    rec.agentCardUrl = agentCard;
    this.children.set(rec.id, child);
    child.once('exit', (code) => {
      if (rec.status === 'running' || rec.status === 'starting') this.finish(rec, 'failed', `worker exited (code ${code})`);
    });
    await this.persist();
    void this.drive(rec); // background; do not await
    return this.view(rec);
  }

  /** Kills all worker processes (wired into the app shutdown). */
  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const rec of this.registry.values()) this.killWorker(rec);
    await this.persist();
  }

  // --- internals ----------------------------------------------------------

  private view(r: TaskRecord): TaskInfo {
    return {
      id: r.id, kind: r.kind, title: r.title, status: r.status,
      step: r.step, analysis: r.analysis, startedAt: r.startedAt, finishedAt: r.finishedAt,
      pendingQuestion: r.pendingQuestion, pendingOptions: r.pendingOptions,
    };
  }

  private emit(r: TaskRecord): void {
    this.opts.onUpdate?.(this.view(r));
  }

  private spawnWorker(
    kind: WorkerKind,
    opts: { needsCodeAnalysis: boolean; deep: boolean },
  ): Promise<{ child: ChildProcess; agentCard: string; pid: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY, '--kind', kind], {
        detached: true, // survive parent death
        env: {
          ...process.env,
          WORKER_NEEDS_ANALYSIS: String(opts.needsCodeAnalysis),
          WORKER_DEEP: String(opts.deep),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => reject(new Error('worker start timeout')), 20_000);
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const j = JSON.parse(line) as { ready?: boolean; agentCard?: string; pid?: number };
            if (j.ready && j.agentCard) {
              clearTimeout(timer);
              child.stdout?.off('data', onData);
              child.unref(); // don't keep the parent alive for this child
              resolve({ child, agentCard: j.agentCard, pid: j.pid ?? child.pid ?? 0 });
              return;
            }
          } catch {
            /* not the ready line */
          }
        }
      };
      child.stdout?.on('data', onData);
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exited before ready (code ${code})`)); });
    });
  }

  /** Opens the A2A stream and folds its events into the task record. */
  private async drive(rec: TaskRecord): Promise<void> {
    if (!rec.agentCardUrl) return;
    try {
      const client = await A2AClient.fromCardUrl(rec.agentCardUrl);
      const stream = client.sendMessageStream({
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'user',
          parts: [{ kind: 'text', text: rec.request }],
        },
      });
      await this.consume(rec, stream);
    } catch (e) {
      log.error('task drive failed', { id: rec.id, err: (e as Error).message });
      this.finish(rec, 'failed', (e as Error).message);
    }
  }

  /** Shared event loop for both fresh streams and post-restart resubscribes. */
  private async consume(
    rec: TaskRecord,
    stream: AsyncGenerator<Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent, void, undefined>,
  ): Promise<void> {
    let result = rec.result ?? '';
    let savedHandle = !!rec.a2aTaskId;
    let awaiting = false;
    for await (const ev of stream) {
      rec.lastActivityAt = Date.now();
      const ctx = (ev as { contextId?: string }).contextId;
      if (ctx) rec.a2aContextId = ctx;
      if (ev.kind === 'task') {
        rec.a2aTaskId = ev.id;
        if (ev.status?.state === 'input-required') awaiting = this.handleInputRequired(rec, ev.status.message);
        else if (ev.status?.state) this.applyState(rec, ev.status.state);
      } else if (ev.kind === 'status-update') {
        rec.a2aTaskId = ev.taskId;
        if (ev.status?.state === 'input-required') {
          awaiting = this.handleInputRequired(rec, ev.status.message);
        } else {
          const stepText = partsText(ev.status?.message?.parts);
          if (stepText) rec.step = stepText.slice(0, 100);
          this.applyState(rec, ev.status?.state);
          result += stepText;
        }
      } else if (ev.kind === 'artifact-update') {
        rec.a2aTaskId = ev.taskId;
        result += partsText(ev.artifact?.parts);
        if (rec.status !== 'awaiting_input') rec.status = 'running';
      } else if (ev.kind === 'message') {
        result += partsText(ev.parts);
      }
      rec.result = result.trim();
      // Persist as soon as we learn the A2A task id so a restart can resubscribe.
      if (!savedHandle && rec.a2aTaskId) {
        savedHandle = true;
        void this.persist();
      }
      if (rec.status === 'running' || rec.status === 'starting') this.emit(rec);
      if (awaiting || rec.status === 'completed' || rec.status === 'failed') break;
    }
    if (awaiting) return; // paused for the user — handleInputRequired already surfaced it
    if (rec.status !== 'completed' && rec.status !== 'failed') {
      // Stream ended without an explicit terminal state — treat as done.
      this.finish(rec, 'completed', rec.result);
    } else {
      this.finish(rec, rec.status, rec.result);
    }
  }

  private applyState(rec: TaskRecord, state?: string): void {
    if (!state) return;
    if (state === 'completed') rec.status = 'completed';
    else if (state === 'failed' || state === 'canceled' || state === 'rejected') rec.status = 'failed';
    else if (state === 'input-required') rec.status = 'awaiting_input';
    else rec.status = 'running'; // submitted | working
  }

  /** A worker called ask_user: extract the question/options + call id and surface them. */
  private handleInputRequired(rec: TaskRecord, message?: Message): boolean {
    rec.status = 'awaiting_input';
    rec.lastActivityAt = Date.now();
    const parts = message?.parts ?? [];
    const fn = parts.find(
      (p) => p.kind === 'data' && (p.data as { name?: string } | undefined)?.name === 'ask_user',
    );
    const data = (fn as { data?: { id?: string; args?: { question?: string; options?: string[] } } } | undefined)?.data;
    rec.pendingCallId = data?.id;
    rec.pendingQuestion =
      typeof data?.args?.question === 'string'
        ? data.args.question
        : 'El agente necesita tu respuesta para continuar.';
    rec.pendingOptions = Array.isArray(data?.args?.options) ? data.args.options : undefined;
    this.emit(rec);
    void this.persist();
    if (this.opts.announce) this.opts.announce(rec.pendingQuestion);
    this.emitQuestionDetail(rec);
    log.info('task awaiting input', { id: rec.id, q: rec.pendingQuestion.slice(0, 60) });
    return true;
  }

  /** Shows the worker's question + clickable options in the kiosk sidebar. */
  private emitQuestionDetail(rec: TaskRecord): void {
    const buttons = (rec.pendingOptions ?? [])
      .map(
        (o) =>
          `<button class="task-option" data-task-id="${escapeHtml(rec.id)}" data-answer="${escapeHtml(o)}">${escapeHtml(o)}</button>`,
      )
      .join(' ');
    const html =
      `<p>${escapeHtml(rec.pendingQuestion ?? '')}</p>` +
      (buttons
        ? `<div class="task-options">${buttons}</div>`
        : '<p class="hint">Responde por voz o escribiendo.</p>');
    emitDetail(`${WORKERS[rec.kind].label} pregunta`, html);
  }

  /** Marks a task done, announces it, and keeps the worker alive until idle-reaped. */
  private finish(rec: TaskRecord, status: 'completed' | 'failed', result?: string): void {
    // Finalize exactly once. Guard on `finalized`, NOT on rec.status — the stream
    // sets rec.status='completed' before we get here, so a status check would wrongly
    // skip finalization (announce/bank/emit).
    if (rec.finalized) return;
    rec.finalized = true;
    rec.status = status;
    rec.finishedAt = Date.now();
    rec.lastActivityAt = Date.now();
    if (result) rec.result = result.trim();
    this.emit(rec);
    void this.persist();
    // Bank the summarized output now (not only on idle reap), so the root can
    // answer about it the moment the worker finishes.
    if (status === 'completed') void this.bankResult(rec);
    const label = WORKERS[rec.kind].label;
    if (config.tasks.announce && this.opts.announce) {
      this.opts.announce(
        status === 'completed'
          ? `Terminé la tarea de ${label}: ${rec.title}.`
          : `La tarea de ${label} (${rec.title}) falló.`,
      );
    }
    log.info('task finished', { id: rec.id, status, ms: rec.finishedAt - rec.startedAt });
  }

  /** Periodic idle reaper — mirrors the agent-runner session sweeper. */
  private sweep(): void {
    const now = Date.now();
    for (const rec of this.registry.values()) {
      // Never idle-reap a task the user paused or that is waiting for the user.
      if (rec.status === 'paused' || rec.status === 'awaiting_input') continue;
      if (now - rec.lastActivityAt > this.idleMs) void this.reap(rec);
    }
  }

  /**
   * Summarises a task's output into the bank (≤ bankMax). Runs on completion and
   * again as a fallback on reap; the `banked` guard makes it idempotent.
   */
  private async bankResult(rec: TaskRecord): Promise<void> {
    if (!rec.result || rec.banked) return;
    rec.banked = true; // set first to avoid a double-bank race (finish + reap)
    try {
      const summary = (await summarizeTask(rec.request, rec.result)) ?? rec.result.slice(0, 400);
      await addSummary(rec.kind, rec.title, summary);
      await this.persist();
    } catch (e) {
      rec.banked = false; // let a later reap retry
      log.error('bank result failed', { id: rec.id, err: (e as Error).message });
    }
  }

  /** Banks the output (if not already), then kills the idle worker process. */
  private async reap(rec: TaskRecord): Promise<void> {
    await this.bankResult(rec);
    this.killWorker(rec);
    this.registry.delete(rec.id);
    await this.persist();
    log.info('task reaped (idle)', { id: rec.id });
  }

  private killWorker(rec: TaskRecord): void {
    const child = this.children.get(rec.id);
    this.children.delete(rec.id);
    const pid = child?.pid ?? rec.pid;
    try {
      if (pid) {
        process.kill(pid, 'SIGCONT'); // un-pause first so SIGTERM is delivered
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      /* already gone */
    }
  }

  // --- persistence & recovery --------------------------------------------

  private async persist(): Promise<void> {
    const rows = [...this.registry.values()].map((r) => {
      const out: Record<string, unknown> = {};
      for (const k of PERSIST_KEYS) out[k] = r[k];
      return out;
    });
    try {
      await mkdir(dirname(RUNNING_FILE), { recursive: true });
      await writeFile(RUNNING_FILE, JSON.stringify(rows, null, 2));
    } catch (e) {
      log.error('persist running tasks failed', e);
    }
  }

  private async recover(): Promise<void> {
    let rows: Partial<TaskRecord>[] = [];
    try {
      rows = JSON.parse(await readFile(RUNNING_FILE, 'utf8')) as Partial<TaskRecord>[];
    } catch {
      return; // no file yet
    }
    for (const row of rows) {
      if (!row.id || !row.kind || !isWorkerKind(row.kind)) continue;
      // A finished-but-unreaped task from before the crash: bank it now.
      if ((row.status === 'completed' || row.status === 'failed') && row.result && !row.banked) {
        try {
          const summary = (await summarizeTask(row.request ?? '', row.result)) ?? row.result.slice(0, 240);
          await addSummary(row.kind, row.title ?? row.kind, summary);
        } catch {
          /* best effort */
        }
        continue;
      }
      // Still-running (or awaiting-input) worker: recover only if its process is alive.
      if (!isAlive(row.pid)) continue;
      const awaiting = row.status === 'awaiting_input';
      const rec: TaskRecord = {
        id: row.id, kind: row.kind, title: row.title ?? row.kind, request: row.request ?? '',
        status: awaiting ? 'awaiting_input' : 'running', analysis: !!row.analysis,
        startedAt: row.startedAt ?? Date.now(),
        result: row.result, pid: row.pid, agentCardUrl: row.agentCardUrl,
        a2aTaskId: row.a2aTaskId, a2aContextId: row.a2aContextId,
        pendingQuestion: row.pendingQuestion, pendingOptions: row.pendingOptions, pendingCallId: row.pendingCallId,
        lastActivityAt: Date.now(),
      };
      this.registry.set(rec.id, rec);
      this.emit(rec);
      if (awaiting) {
        // Re-surface the pending question instead of re-attaching the stream.
        this.emitQuestionDetail(rec);
      } else {
        void this.reattach(rec);
      }
      log.info('task recovered', { id: rec.id, pid: rec.pid, status: rec.status });
    }
    await this.persist();
  }

  /** Re-attaches to a recovered worker via getTask + resubscribe. */
  private async reattach(rec: TaskRecord): Promise<void> {
    if (!rec.agentCardUrl || !rec.a2aTaskId) {
      this.finish(rec, 'failed', 'lost worker handle after restart');
      return;
    }
    try {
      const client = await A2AClient.fromCardUrl(rec.agentCardUrl);
      const got = (await client.getTask({ id: rec.a2aTaskId })) as Task | { result?: Task };
      const task = (got && 'kind' in got ? got : (got as { result?: Task }).result) as Task | undefined;
      const state = task?.status?.state;
      if (state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected') {
        // The result text may live in the final status message and/or artifacts.
        const text =
          [partsText(task?.status?.message?.parts), ...(task?.artifacts ?? []).map((a) => partsText(a.parts))]
            .filter(Boolean)
            .join(' ')
            .trim() || rec.result;
        this.finish(rec, state === 'completed' ? 'completed' : 'failed', text);
        return;
      }
      await this.consume(rec, client.resubscribeTask({ id: rec.a2aTaskId }));
    } catch (e) {
      log.error('task resume failed', { id: rec.id, err: (e as Error).message });
      this.finish(rec, 'failed', 'could not re-attach after restart');
    }
  }
}
