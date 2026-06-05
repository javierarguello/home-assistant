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
  lastActivityAt: number;
  banked?: boolean;
}

interface ManagerOptions {
  /** Called whenever a task changes (drives the kiosk 'task' event). */
  onUpdate?: (task: TaskInfo) => void;
  /** Called with a short notice when a task finishes (voice announce). */
  announce?: (text: string) => void;
}

const PERSIST_KEYS = [
  'id', 'kind', 'title', 'request', 'status', 'analysis', 'startedAt',
  'finishedAt', 'result', 'pid', 'agentCardUrl', 'a2aTaskId', 'banked',
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

  /** Starts a background task; returns its id immediately (does not block). */
  async start(input: { kind: string; request: string; needsCodeAnalysis?: boolean }): Promise<TaskInfo> {
    if (!isWorkerKind(input.kind)) throw new Error(`unknown task kind "${input.kind}"`);
    const running = [...this.registry.values()].filter((r) => r.status === 'running' || r.status === 'starting');
    if (running.length >= config.tasks.maxConcurrent) {
      throw new Error(`too many tasks running (${running.length}/${config.tasks.maxConcurrent}); try again shortly`);
    }
    const rec: TaskRecord = {
      id: randomUUID().slice(0, 8),
      kind: input.kind,
      title: input.request.slice(0, 80),
      request: input.request,
      status: 'starting',
      analysis: !!input.needsCodeAnalysis,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    this.registry.set(rec.id, rec);
    this.emit(rec);

    const { child, agentCard, pid } = await this.spawnWorker(rec.kind, rec.analysis);
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
    };
  }

  private emit(r: TaskRecord): void {
    this.opts.onUpdate?.(this.view(r));
  }

  private spawnWorker(
    kind: WorkerKind,
    needsAnalysis: boolean,
  ): Promise<{ child: ChildProcess; agentCard: string; pid: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY, '--kind', kind], {
        detached: true, // survive parent death
        env: { ...process.env, WORKER_NEEDS_ANALYSIS: String(needsAnalysis) },
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
    for await (const ev of stream) {
      rec.lastActivityAt = Date.now();
      if (ev.kind === 'task') {
        rec.a2aTaskId = ev.id;
        if (ev.status?.state) this.applyState(rec, ev.status.state);
        result += partsText(ev.status?.message?.parts);
      } else if (ev.kind === 'status-update') {
        rec.a2aTaskId = ev.taskId;
        const stepText = partsText(ev.status?.message?.parts);
        if (stepText) rec.step = stepText.slice(0, 100);
        this.applyState(rec, ev.status?.state);
        result += stepText;
      } else if (ev.kind === 'artifact-update') {
        rec.a2aTaskId = ev.taskId;
        result += partsText(ev.artifact?.parts);
        rec.status = 'running';
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
      if (rec.status === 'completed' || rec.status === 'failed') break;
    }
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
    else if (state === 'input-required') {
      // Workers run autonomously; if one asks for input we can't supply, fail it.
      rec.status = 'failed';
      rec.step = 'needs input (not supported for background tasks)';
    } else rec.status = 'running'; // submitted | working
  }

  /** Marks a task done, announces it, and keeps the worker alive until idle-reaped. */
  private finish(rec: TaskRecord, status: 'completed' | 'failed', result?: string): void {
    if (rec.status === 'completed' || rec.status === 'failed') {
      // already finalised; still refresh result if richer
    }
    rec.status = status;
    rec.finishedAt = Date.now();
    rec.lastActivityAt = Date.now();
    if (result) rec.result = result.trim();
    this.emit(rec);
    void this.persist();
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
      if (now - rec.lastActivityAt > this.idleMs) void this.reap(rec);
    }
  }

  /** Summarises a finished task into the bank, then kills its worker process. */
  private async reap(rec: TaskRecord): Promise<void> {
    this.killWorker(rec);
    this.registry.delete(rec.id);
    try {
      if (rec.result && !rec.banked) {
        const summary = (await summarizeTask(rec.request, rec.result)) ?? rec.result.slice(0, 240);
        await addSummary(rec.kind, rec.title, summary);
        rec.banked = true;
      }
    } catch (e) {
      log.error('task reap summary failed', { id: rec.id, err: (e as Error).message });
    }
    await this.persist();
    log.info('task reaped (idle)', { id: rec.id });
  }

  private killWorker(rec: TaskRecord): void {
    const child = this.children.get(rec.id);
    this.children.delete(rec.id);
    try {
      if (child) child.kill('SIGTERM');
      else if (rec.pid) process.kill(rec.pid, 'SIGTERM');
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
      // Still-running worker: re-attach only if its process is alive.
      if (!isAlive(row.pid)) continue;
      const rec: TaskRecord = {
        id: row.id, kind: row.kind, title: row.title ?? row.kind, request: row.request ?? '',
        status: 'running', analysis: !!row.analysis, startedAt: row.startedAt ?? Date.now(),
        result: row.result, pid: row.pid, agentCardUrl: row.agentCardUrl, a2aTaskId: row.a2aTaskId,
        lastActivityAt: Date.now(),
      };
      this.registry.set(rec.id, rec);
      this.emit(rec);
      void this.resume(rec);
      log.info('task recovered', { id: rec.id, pid: rec.pid });
    }
    await this.persist();
  }

  /** Re-attaches to a recovered worker via getTask + resubscribe. */
  private async resume(rec: TaskRecord): Promise<void> {
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
