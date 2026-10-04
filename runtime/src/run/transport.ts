import {nativeProcessGroupAlive} from "./hosts/util.js";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {AgentOpsError} from "../fs/paths.js";
import type {NativeGoalHost as Transport, NativeGoalHandle, NativeGoalEvent} from "./hosts/types.js";
import type {NativeGoalHost, NativeSessionIdentity, NativeSessionObservation} from "./supervisor.js";
import type {RunRepository, RunWorkerRecord} from "./service.js";

const exec = promisify(execFile);
export async function nativeProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const {stdout} = await exec("ps", ["-p", String(pid), "-o", "lstart="], {maxBuffer: 8192});
    return stdout.trim() || null;
  } catch {return null;}
}

/** Adapt the native transport without activating a writer before its lease is saved. */
export class NativeRunTransport implements NativeGoalHost {
  readonly host: "claude" | "codex";
  readonly #sessions = new Map<string, {handle: NativeGoalHandle; observation: NativeSessionObservation}>();
  constructor(readonly transport: Transport, readonly repository: RunRepository,
    readonly onEvent: (event: NativeGoalEvent) => Promise<void> = async () => {},
    readonly processIdentity: (pid: number) => Promise<string | null> = nativeProcessIdentity) {this.host = transport.kind;}

  async start(input: Parameters<NativeGoalHost["start"]>[0]): Promise<NativeSessionIdentity> {
    if (input.worktree === null || input.contractHash === null)
      throw new AgentOpsError("RUN_NATIVE_CONTEXT_REQUIRED", "Native workers require a worktree and current contract hash.");
    const saved = (await this.repository.read(input.runId))?.workers.find(w => w.workerId === input.workerId);
    const request = {runId: input.runId, workerId: input.workerId, generation: input.generation,
      contractHash: input.contractHash, cwd: input.worktree,
      ...(this.host === "claude" ? {sessionId: input.ownerSessionId} : {})};
    const handle = saved?.nativeSessionId == null ? await this.transport.start(request)
      : await this.transport.resume(request, saved.nativeSessionId);
    const identity = handle.processId === null ? null : await this.processIdentity(handle.processId);
    if (identity === null) {
      await this.transport.stop(handle, handle);
      throw new AgentOpsError("RUN_PROCESS_IDENTITY_REQUIRED", "Cannot register an unidentified native process.");
    }
    const entry = {handle, observation: {nativeGoalState: "inactive" as NativeSessionObservation["nativeGoalState"],
      processAlive: true, processIdentity: identity, stateDigest: null}};
    this.#sessions.set(handle.sessionId, entry);
    // Drain output immediately, but the host has no goal and cannot start a turn yet.
    void this.consume(entry).catch(async () => {
      entry.observation = {...entry.observation, nativeGoalState: "unknown"};
      await this.repository.appendEvent(handle.runId, {type: "diagnostic", code: "RUN_NATIVE_STREAM_FAILED",
        workerId: handle.workerId, taskId: null, detail: "Native event stream failed; completion remains unproven."}).catch(() => {});
    });
    return {nativeSessionId: handle.sessionId, nativeJobId: handle.threadId, processId: handle.processId,
      processIdentity: identity, instance: handle.nativeVersion};
  }

  async activateRegistered(runId: string, worker: RunWorkerRecord, objective: string): Promise<void> {
    const current = await this.repository.read(runId);
    const saved = current?.workers.find(w => w.workerId === worker.workerId);
    const entry = worker.nativeSessionId === null ? undefined : this.#sessions.get(worker.nativeSessionId);
    if (current?.status !== "active" || saved?.status !== "running" || saved.generation !== worker.generation ||
      saved.nativeSessionId !== worker.nativeSessionId || saved.stopIntent !== null || entry === undefined)
      throw new AgentOpsError("RUN_WORKER_STALE", "Native activation requires a saved current writer lease.");
    await this.transport.activate(entry.handle, objective, entry.handle);
  }

  async inspect(input: NativeSessionIdentity): Promise<NativeSessionObservation> {
    const entry = this.#sessions.get(input.nativeSessionId);
    const identity = input.processId === null ? null : await this.processIdentity(input.processId);
    const groupAlive = input.processId !== null && process.platform !== "win32" && nativeProcessGroupAlive(input.processId);
    const alive = identity !== null || groupAlive;
    if (identity !== null && identity !== input.processIdentity)
      throw new AgentOpsError("RUN_PROCESS_IDENTITY_CHANGED", "A native PID has been reused; preserve the worktree and reconcile ownership.");
    return {...(entry?.observation ?? {nativeGoalState: "unknown", stateDigest: null}),
      processAlive: alive, processIdentity: identity};
  }

  async resume(_input: Parameters<NativeGoalHost["resume"]>[0]): Promise<void> {
    throw new AgentOpsError("RUN_RECONCILE_REQUIRED", "Resume requires a new fenced lease and persisted native identity before activation.");
  }
  async send(input: Parameters<NativeGoalHost["send"]>[0]): Promise<void> {
    const entry = this.#sessions.get(input.nativeSessionId);
    if (entry === undefined || entry.handle.generation !== input.generation)
      throw new AgentOpsError("RUN_WORKER_STALE", "Cannot update an unowned native session.");
    await this.transport.update(entry.handle, {...entry.handle, objective: input.message});
    entry.observation = {...entry.observation, nativeGoalState: "active"};
  }
  async stop(input: Parameters<NativeGoalHost["stop"]>[0]): Promise<void> {
    const entry = this.#sessions.get(input.nativeSessionId);
    if (entry === undefined) {
      const observation = await this.inspect(input);
      if (!observation.processAlive) return;
      if (input.processId === null || observation.processIdentity === null || observation.processIdentity !== input.processIdentity)
        throw new AgentOpsError("RUN_PROCESS_RECONCILE_REQUIRED", "Cannot identify surviving native descendants; takeover is refused.");
      // A crash lost the in-memory transport, but the saved PID/start time still identifies this owned group.
      const pid = input.processId;
      try {process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");}
      catch (cause) {if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;}
      for (let i = 0; i < 30 && (await this.inspect(input)).processAlive; i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      if ((await this.inspect(input)).processAlive) {
        try {process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");}
        catch (cause) {if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;}
        for (let i = 0; i < 30 && (await this.inspect(input)).processAlive; i++)
          await new Promise(resolve => setTimeout(resolve, 100));
      }
      if ((await this.inspect(input)).processAlive)
        throw new AgentOpsError("RUN_WRITER_STILL_ALIVE", "The registered process group has not stopped; takeover is refused.");
      return;
    }
    if (entry.handle.generation !== input.generation)
      throw new AgentOpsError("RUN_WORKER_STALE", "Cannot stop a different writer generation.");
    await this.inspect(input);
    await this.transport.stop(entry.handle, entry.handle);
    entry.observation = {...entry.observation, processAlive: false, nativeGoalState: "cleared"};
  }

  private async consume(entry: {handle: NativeGoalHandle; observation: NativeSessionObservation}): Promise<void> {
    for await (const event of this.transport.observe(entry.handle)) {
      const state = await this.repository.read(event.runId);
      const worker = state?.workers.find(w => w.workerId === event.workerId);
      if (worker?.generation !== event.generation || worker.nativeSessionId !== entry.handle.sessionId || worker.status === "fenced") continue;
      entry.observation = {...entry.observation,
        nativeGoalState: ["active", "paused", "complete"].includes(event.nativeStatus)
          ? event.nativeStatus as NativeSessionObservation["nativeGoalState"] : "unknown",
        ...(event.type === "closed" ? {processAlive: false} : {})};
      await this.onEvent(event);
    }
  }
}
