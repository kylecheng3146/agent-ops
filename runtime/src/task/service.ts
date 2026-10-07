import {canonicalJson} from "../config/hash.js";
import { randomUUID } from "node:crypto";

import {
  TASK_SCHEMA_VERSION,
  type AgentOpsConfig,
  type AcceptanceCriterion,
  type AgentTask
} from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { validateEvidence, validateTask, validateTaskAgainstConfig } from "../schema/validate.js";
import { renderTaskMarkdown } from "./render.js";
import { checkTaskCompletionEvidence, findIncompleteSubtask } from "./completion.js";
import { calculateConfigHash, FileEvidenceStore, isPassingVerificationEvidence } from "../verify/evidence.js";
import type { GitRunner } from "../verify/change-surface.js";
import { resolveReviewScope } from "../review/scope.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
import {acceptanceCoverage, type CriterionCoverage} from "../verify/acceptance-coverage.js";
import {loadFindingPin} from "./pin-finding.js";
import {findReviewAttestation} from "../review/attestation.js";
import {
  advanceFailureFingerprint,
  type FailureFingerprint,
  type FailureFingerprintAdvance
} from "../verify/fingerprint.js";
import type {
  MutableTaskState,
  StoredTaskRecord,
  TaskStore,
  TaskState
} from "./store.js";

import { taskContractHash, treeContractHash } from "./contract.js";
import { commitIdentity } from "../schema/acceptance.js";

export interface ReviseTaskInput {
  readonly expectedContractHash: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly reason: string;
  readonly diagnostics?: readonly string[];
  readonly baseline?: string;
}
export interface ReplanTaskInput {
  readonly expectedTreeContractHash: string;
  readonly reason: string;
  readonly tasks: readonly { id?: string; title: string; intent: string; criteria: readonly AcceptanceCriterion[]; replaces: readonly string[] }[];
}

export interface CreateTaskInput {
  readonly title: string;
  readonly goal?: string;
  readonly createdSourceCommit?: string;
  readonly intent?: string;
  readonly criteria: readonly AcceptanceCriterion[];
  /** CLI task creation captures this; callers without it remain compatible. */
  readonly policyConfigHash?: string;
  /** Records this task as a subtask of an existing active task. */
  readonly parentTaskId?: string;
  /** Optionally creates and attaches the task in one state mutation. */
  readonly sessionId?: string;
}

export interface TaskServiceOptions {
  readonly generateId?: () => string;
  readonly now?: () => string;
  /** Required for completion; read-only task operations do not need a repository. */
  readonly completion?: {
    readonly root: string;
    readonly gitRunner: GitRunner;
    readonly loadConfig: () => Promise<AgentOpsConfig>;
    readonly base?: string;
    readonly noChangePaths?: readonly string[];
  };
}

export interface TaskStatusQuery {
  readonly taskId?: string;
  readonly sessionId?: string;
}

export type CriterionEvidenceInput = Readonly<
  Record<string, readonly string[]>
>;

const SESSION_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;

function defaultTaskId(): string {
  return `task-${randomUUID()}`;
}

function cloneRecord(record: StoredTaskRecord): StoredTaskRecord {
  return structuredClone(record);
}

function taskError(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

function findTask(
  state: TaskState,
  taskId: string
): StoredTaskRecord {
  const record = state.tasks.find(
    (candidate) => candidate.task.id === taskId
  );
  if (record === undefined) {
    throw taskError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  }
  return record;
}

function replaceTask(
  state: MutableTaskState,
  record: StoredTaskRecord
): void {
  const index = state.tasks.findIndex(
    (candidate) => candidate.task.id === record.task.id
  );
  if (index === -1) {
    throw taskError("TASK_NOT_FOUND", `Task not found: ${record.task.id}`);
  }
  state.tasks[index] = record;
}

function assertTimestamp(value: string): string {
  if (
    value.length === 0 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw taskError(
      "TASK_TIMESTAMP_INVALID",
      "Task timestamps must be ISO-compatible."
    );
  }
  return value;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw taskError(
      "TASK_SESSION_INVALID",
      "Session identity must be a bounded non-empty string."
    );
  }
}

function normalizeEvidence(
  task: AgentTask,
  input: CriterionEvidenceInput
): Record<string, string[]> {
  const criterionIds = new Set(
    task.criteria.map((criterion) => criterion.id)
  );
  if (
    Object.keys(input).length !== criterionIds.size ||
    Object.keys(input).some((criterionId) => !criterionIds.has(criterionId))
  ) {
    throw taskError(
      "TASK_EVIDENCE_INCOMPLETE",
      "Completion requires evidence for every acceptance criterion."
    );
  }
  const evidence: Record<string, string[]> = {};
  for (const criterion of task.criteria) {
    const references = input[criterion.id];
    if (
      references === undefined ||
      references.length === 0 ||
      references.some(
        (reference) =>
          typeof reference !== "string" ||
          reference.length === 0 ||
          reference.length > 4096 ||
          reference.includes("\0")
      ) ||
      new Set(references).size !== references.length
    ) {
      throw taskError(
        "TASK_EVIDENCE_INCOMPLETE",
        `Criterion ${criterion.id} requires valid evidence references.`
      );
    }
    evidence[criterion.id] = [...references];
  }
  return evidence;
}

export class TaskService {
  readonly #store: TaskStore;
  readonly #generateId: () => string;
  readonly #now: () => string;
  readonly #completion: TaskServiceOptions["completion"];

  constructor(store: TaskStore, options: TaskServiceOptions = {}) {
    this.#store = store;
    this.#generateId = options.generateId ?? defaultTaskId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#completion = options.completion;
  }

  async create(input: CreateTaskInput): Promise<StoredTaskRecord> {
    if (
      input.policyConfigHash !== undefined &&
      !/^[a-f0-9]{64}$/u.test(input.policyConfigHash)
    ) {
      throw taskError(
        "TASK_POLICY_CONFIG_INVALID",
        "Policy config hash must be a lowercase SHA-256 digest."
      );
    }
    if (input.sessionId !== undefined) {
      assertSessionId(input.sessionId);
    }
    let createdSourceCommit = input.createdSourceCommit;
    if (createdSourceCommit === undefined && this.#completion !== undefined) {
      const head = await this.#completion.gitRunner.run(["rev-parse", "--verify", "HEAD"]);
      const resolved = head.stdout.toString().trim();
      if (head.exitCode === 0 && commitIdentity(resolved)) createdSourceCommit = resolved;
    }
    if (createdSourceCommit !== undefined && !commitIdentity(createdSourceCommit))
      throw taskError("TASK_BASELINE_INVALID", "Task creation commit must be a resolved SHA.");
    const criteria = structuredClone(input.criteria).map(criterion => ({...criterion,
      ...(criterion.acceptance === undefined ? {} : {acceptance: {...criterion.acceptance,
        baselineCommit: criterion.acceptance.baselineCommit ?? createdSourceCommit}})})) as AcceptanceCriterion[];
    const task: AgentTask = {
      schemaVersion: TASK_SCHEMA_VERSION,
      id: this.#generateId(),
      title: input.title,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      criteria,
      ...(input.goal === undefined ? {} : {goal: input.goal}),
      ...(input.parentTaskId === undefined
        ? {}
        : { parentTaskId: input.parentTaskId })
    };
    const validation = validateTask(task);
    if (!validation.ok) {
      throw taskError(
        "TASK_INVALID",
        validation.errors[0]?.message ?? "Task input is invalid."
      );
    }
    if (validation.value.criteria.some(c => c.finding !== undefined))
      throw taskError("TASK_PIN_REQUIRED", "New finding identities must be validated with pin-finding against a saved failed review.");
    if (validation.value.criteria.some(c => c.acceptance !== undefined)) {
      if (this.#completion === undefined) throw taskError("TASK_BASELINE_CONTEXT_REQUIRED", "Typed acceptance requires repository context.");
      const configured = validateTaskAgainstConfig(validation.value, await this.#completion.loadConfig());
      if (!configured.ok) throw taskError("TASK_INVALID", configured.errors[0]?.message ?? "Invalid runner binding.");
      await this.#retainBaselines(validation.value);
    }
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      if (
        state.tasks.some(
          (record) => record.task.id === validation.value.id
        )
      ) {
        throw taskError(
          "TASK_ID_CONFLICT",
          `Task ID already exists: ${validation.value.id}`
        );
      }
      // A dangling parent would make the subtask unfindable by its own parent
      // filter, so the reference is resolved once, at creation.
      if (input.parentTaskId !== undefined) {
        const parent = state.tasks.find(
          (record) => record.task.id === input.parentTaskId
        );
        if (parent === undefined) {
          throw taskError(
            "TASK_PARENT_NOT_FOUND",
            `Parent task not found: ${input.parentTaskId}`
          );
        }
        if (parent.status !== "active") {
          throw taskError(
            "TASK_PARENT_NOT_ACTIVE",
            "Only an active task can take new subtasks."
          );
        }
        if (parent.task.goal !== undefined) {
          if (validation.value.goal !== undefined && validation.value.goal !== parent.task.goal)
            throw taskError("TASK_GOAL_IMMUTABLE", "Subtasks must retain their parent original goal.");
          validation.value.goal = parent.task.goal;
        }
      }
      const record: StoredTaskRecord = {
        task: validation.value,
        ...(createdSourceCommit === undefined ? {} : {createdSourceCommit}),
        status: "active",
        evidence: {},
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        archivedAt: null,
        failureFingerprint: null,
        policyConfigHash: input.policyConfigHash ?? null,
        completionBase: null
      };
      state.tasks.push(record);
      if (input.sessionId !== undefined) {
        const currentIndex = state.sessions.findIndex(
          ({ sessionId }) => sessionId === input.sessionId
        );
        // A subtask keeps the session on the top of its tree: the completion
        // gate checks the attached task and everything under it, so attaching
        // the subtask would let a Stop through with its parent unfinished.
        let rootId = record.task.id;
        for (let parentId = record.task.parentTaskId; parentId !== undefined;) {
          rootId = parentId;
          parentId = state.tasks.find(({ task }) => task.id === parentId)?.task.parentTaskId;
        }
        const attachment = {
          sessionId: input.sessionId,
          taskId: rootId,
          attachedAt: now
        };
        if (currentIndex === -1) {
          state.sessions.push(attachment);
        } else {
          state.sessions[currentIndex] = attachment;
        }
      }
      return cloneRecord(record);
    });
  }

  async #retainBaselines(task: AgentTask): Promise<void> {
    if (this.#completion === undefined) throw taskError("TASK_BASELINE_CONTEXT_REQUIRED", "Baseline retention needs Git context.");
    for (const criterion of task.criteria) {
      const sha = criterion.acceptance?.baselineCommit;
      if (sha === undefined) continue;
      const result = await this.#completion.gitRunner.run(["rev-parse", "--verify", sha + "^{commit}"]);
      if (result.exitCode !== 0 || result.stdout.toString().trim() !== sha)
        throw taskError("BASELINE_UNAVAILABLE", "Criterion baseline is not the exact available commit.");
      const retained = await this.#completion.gitRunner.run(["update-ref", "refs/agent-ops/baselines/" + task.id + "/" + criterion.id + "/" + sha, sha]);
      if (retained.exitCode !== 0) throw taskError("BASELINE_RETENTION_FAILED", "Could not retain criterion baseline.");
    }
  }

  async revise(taskId: string, input: ReviseTaskInput): Promise<StoredTaskRecord> {
    if (!/^[a-f0-9]{64}$/u.test(input.expectedContractHash) || input.reason.trim() === "" || input.reason.length > 8192 || input.reason.includes("\0") ||
      (input.diagnostics ?? []).some(d => d.length > 4096 || d.includes("\0")))
      throw taskError("TASK_REVISION_INVALID", "Revision requires expected contract and bounded reason/diagnostics.");
    const previous = await this.status({taskId});
    if (previous.status !== "active") throw taskError("TASK_NOT_ACTIVE", "Only active tasks can revise acceptance.");
    if (taskContractHash(previous.task) !== input.expectedContractHash) throw taskError("TASK_CONTRACT_CHANGED", "Task contract changed.");
    const baseline = input.baseline ?? previous.createdSourceCommit;
    const criteria = structuredClone(input.criteria).map(criterion => {
      if (criterion.acceptance === undefined) return criterion;
      const sha = criterion.acceptance.baselineCommit ?? baseline;
      if (sha === undefined) throw taskError("BASELINE_REQUIRED", "Legacy tasks need an explicit baseline before typed acceptance.");
      const old = previous.task.criteria.find(c => c.id === criterion.id)?.acceptance;
      if (old !== undefined && sha !== old.baselineCommit) throw taskError("BASELINE_IMMUTABLE", "Create a replacement criterion instead of changing its baseline.");
      return {...criterion, acceptance: {...criterion.acceptance, baselineCommit: sha}};
    });
    const next: AgentTask = {...previous.task, schemaVersion: TASK_SCHEMA_VERSION,
      contractRevision: (previous.task.contractRevision ?? 0) + 1, criteria};
    const checked = validateTask(next);
    if (!checked.ok) throw taskError("TASK_INVALID", checked.errors[0]?.message ?? "Invalid criterion revision.");
    const records = (await this.#store.read()).tasks;
    for (const criterion of next.criteria) await this.#validateFindingSource(previous, criterion, records);
    let policyConfigHash = previous.policyConfigHash;
    if (this.#completion !== undefined) {
      const config = await this.#completion.loadConfig();
      const configured = validateTaskAgainstConfig(next, config);
      if (!configured.ok) throw taskError("TASK_INVALID", configured.errors[0]?.message ?? "Invalid binding.");
      policyConfigHash = calculateConfigHash(config);
    }
    if (criteria.some(c => c.acceptance !== undefined)) await this.#retainBaselines(next);
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate(state => {
      const current = findTask(state, taskId);
      if (current.status !== "active" || JSON.stringify(current) !== JSON.stringify(previous))
        throw taskError("TASK_CONTRACT_CHANGED", "Concurrent revision preserved; retry from current task.");
      const result: StoredTaskRecord = {...current, task: next, evidence: {}, failureFingerprint: null,
        policyConfigHash, completionBase: null, updatedAt: now,
        revisions: [...(current.revisions ?? []), {previousTask: current.task, previousEvidence: current.evidence,
          previousFailure: current.failureFingerprint, previousHash: input.expectedContractHash,
          currentHash: taskContractHash(next), reason: input.reason, diagnostics: [...(input.diagnostics ?? [])], at: now}]};
      const {reviewBase: _reviewBase, noChangePaths: _paths, ...withoutReview} = result;
      replaceTask(state, withoutReview);
      return cloneRecord(withoutReview);
    });
  }

  async replan(taskId: string, input: ReplanTaskInput): Promise<readonly StoredTaskRecord[]> {
    if (input.reason.trim() === "" || input.reason.includes("\0") || input.reason.length > 8192 ||
      input.tasks.length === 0 || input.tasks.length > 128)
      throw taskError("TASK_REPLAN_INVALID", "Replan requires bounded children and a reason.");
    const snapshot = await this.#store.read();
    const root = findTask(snapshot, taskId);
    if (root.status !== "active") throw taskError("TASK_NOT_ACTIVE", "Only active roots can be replanned.");
    const ids = new Set([taskId]);
    for (let n = 0; n !== ids.size;) {
      n = ids.size;
      for (const r of snapshot.tasks) if (r.supersededBy === undefined && r.task.parentTaskId !== undefined && ids.has(r.task.parentTaskId)) ids.add(r.task.id);
    }
    const previous = snapshot.tasks.filter(r => ids.has(r.task.id) && r.supersededBy === undefined);
    if (treeContractHash(previous.map(r => r.task)) !== input.expectedTreeContractHash)
      throw taskError("TASK_CONTRACT_CHANGED", "Task tree changed.");
    if (previous.some(r => r.status !== "active")) throw taskError("TASK_REPLAN_INVALID", "Replan cannot replace completed or archived contracts.");
    if (input.tasks.reduce((count, t) => count + t.replaces.length, 0) > 512)
      throw taskError("TASK_REPLAN_MAPPING_INVALID", "Replan provenance exceeds its bounded history limit.");
    const sources = new Map(previous.flatMap(r => r.task.criteria.map(c => [r.task.id + ":" + c.id, c] as const)));
    const covered = new Set<string>();
    const now = assertTimestamp(this.#now());
    const children: StoredTaskRecord[] = [];
    const config = this.#completion === undefined ? undefined : await this.#completion.loadConfig();
    for (const planned of input.tasks) {
      if (planned.replaces.length === 0 || new Set(planned.replaces).size !== planned.replaces.length ||
        planned.replaces.some(ref => !sources.has(ref))) throw taskError("TASK_REPLAN_MAPPING_INVALID", "Every child must reference existing criterion identities.");
      for (const ref of planned.replaces) covered.add(ref);
      for (const c of planned.criteria) {
        const originals = planned.replaces.map(ref => sources.get(ref)!).filter(old => old.id === c.id);
        if (originals.some(original => original.acceptance !== undefined && c.acceptance?.baselineCommit !== original.acceptance.baselineCommit))
          throw taskError("BASELINE_IMMUTABLE", "Replan must preserve criterion baselines.");
      }
      for (const criterion of planned.criteria) {
        if (criterion.finding === undefined) continue;
        const inherited = planned.replaces.map(ref => sources.get(ref)!).find(c => c.finding?.pinId === criterion.finding!.pinId);
        if (inherited !== undefined) {
          if (canonicalJson(inherited.finding) !== canonicalJson(criterion.finding))
            throw taskError("TASK_PIN_IMMUTABLE", "Replan must retain immutable finding identity.");
        } else {
          let authorized = false;
          for (const record of previous.filter(r => planned.replaces.some(ref => ref.startsWith(r.task.id + ":")))) {
            try {await this.#validateFindingSource(record, criterion, snapshot.tasks); authorized = true; break;} catch {}
          }
          if (!authorized) throw taskError("TASK_PIN_REQUIRED", "New replan pins require a saved failed report bound to the replaced contracts.");
        }
      }
      for (const ref of planned.replaces) {
        const pin = sources.get(ref)!.finding?.pinId;
        if (pin !== undefined && !planned.criteria.some(c => c.finding?.pinId === pin))
          throw taskError("TASK_REPLAN_PIN_REQUIRED", "Split contracts must preserve mapped regression pin identities.");
      }
      const task: AgentTask = {schemaVersion: TASK_SCHEMA_VERSION, id: planned.id ?? this.#generateId(),
        title: planned.title, intent: planned.intent, goal: root.task.goal ?? root.task.intent ?? root.task.title,
        criteria: structuredClone(planned.criteria) as AcceptanceCriterion[], parentTaskId: taskId};
      const checked = config === undefined ? validateTask(task) : validateTaskAgainstConfig(task, config);
      if (!checked.ok) throw taskError("TASK_INVALID", checked.errors[0]?.message ?? "Invalid split task.");
      if (task.criteria.some(c => c.acceptance !== undefined)) await this.#retainBaselines(task);
      children.push({task, status: "active", evidence: {}, createdAt: now, updatedAt: now,
        completedAt: null, archivedAt: null, failureFingerprint: null, completionBase: null,
        policyConfigHash: config === undefined ? root.policyConfigHash : calculateConfigHash(config),
        ...(root.createdSourceCommit === undefined ? {} : {createdSourceCommit: root.createdSourceCommit})});
    }
    if ([...sources.keys()].some(ref => !covered.has(ref))) throw taskError("TASK_REPLAN_COVERAGE_REQUIRED", "Split must account for every previous criterion.");
    if (new Set(children.map(c => c.task.id)).size !== children.length || children.some(c => snapshot.tasks.some(r => r.task.id === c.task.id)))
      throw taskError("TASK_ID_CONFLICT", "Split task IDs must be new and unique.");
    return await this.#store.mutate(state => {
      if (JSON.stringify(state.tasks) !== JSON.stringify(snapshot.tasks)) throw taskError("TASK_CONTRACT_CHANGED", "Concurrent tree change preserved.");
      const updated: AgentTask = {...root.task, schemaVersion: TASK_SCHEMA_VERSION, contractRevision: (root.task.contractRevision ?? 0) + 1};
      const newRoot: StoredTaskRecord = {...root, task: updated, evidence: {}, failureFingerprint: null, updatedAt: now, completionBase: null,
        revisions: [...(root.revisions ?? []), {previousTask: root.task, previousEvidence: root.evidence, previousFailure: root.failureFingerprint,
          previousHash: taskContractHash(root.task), currentHash: taskContractHash(updated), reason: input.reason, at: now,
          diagnostics: input.tasks.flatMap((t, i) => t.replaces.map(ref => ref + " -> " + children[i]!.task.id))}]};
      const {reviewBase: _base, noChangePaths: _paths, ...clearedRoot} = newRoot;
      replaceTask(state, clearedRoot);
      for (const old of previous.filter(r => r.task.id !== taskId)) {
        const successors = children.filter((_child, i) => input.tasks[i]!.replaces.some(ref => ref.startsWith(old.task.id + ":"))).map(c => c.task.id);
        replaceTask(state, {...old, status: "archived", archivedAt: now, updatedAt: now, supersededBy: successors});
      }
      state.tasks.push(...children);
      for (let i = 0; i < state.sessions.length; i++) {
        const attachment = state.sessions[i]!;
        if (ids.has(attachment.taskId)) state.sessions[i] = {...attachment, taskId, attachedAt: now};
      }
      return children.map(cloneRecord);
    });
  }

  /** Import a child worktree's intent and criteria, never its source-bound proof. */
  async importDelivery(parentTaskId: string, delivered: readonly StoredTaskRecord[]): Promise<void> {
    if (delivered.length === 0 || delivered.some(({ status, task }) =>
      (status === "archived" && delivered.find(r => r.task.id === task.id)?.supersededBy === undefined) || task.intent === undefined || task.intent.trim() === "")) {
      throw taskError("TASK_DELIVERY_INVALID", "Every delivered task needs a recorded intent and must not be archived.");
    }
    await this.#store.mutate((state) => {
      const parent = findTask(state, parentTaskId);
      if (parent.status !== "active") {
        throw taskError("TASK_PARENT_NOT_ACTIVE", "Only an active parent can accept delivery.");
      }
      const ids = new Set(delivered.map(({ task }) => task.id));
      if (ids.size !== delivered.length) {
        throw taskError("TASK_DELIVERY_INVALID", "Delivered task IDs must be unique.");
      }
      for (const record of delivered) {
        const task: AgentTask = {
          ...record.task,
          ...(record.task.parentTaskId === undefined ? { parentTaskId } : {})
        };
        if (task.parentTaskId !== parentTaskId && !ids.has(task.parentTaskId!)) {
          throw taskError("TASK_DELIVERY_INVALID", `Task ${task.id} has a parent outside this delivery.`);
        }
        if (record.policyConfigHash !== parent.policyConfigHash || !validateTask(task).ok) {
          throw taskError("TASK_DELIVERY_INVALID", `Task ${task.id} has an incompatible policy or definition.`);
        }
        const existing = state.tasks.find((item) => item.task.id === task.id);
        if (existing !== undefined) {
          if (JSON.stringify(existing.task) !== JSON.stringify(task)) {
            throw taskError("TASK_ID_CONFLICT", `Task ${task.id} conflicts with an existing task.`);
          }
          continue;
        }
        state.tasks.push({
          task,
          ...(record.createdSourceCommit === undefined ? {} : {createdSourceCommit: record.createdSourceCommit}),
          ...(record.revisions === undefined ? {} : {revisions: structuredClone(record.revisions)}),
          ...(record.supersededBy === undefined ? {} : {supersededBy: [...record.supersededBy]}),
          status: record.supersededBy === undefined ? "active" : "archived",
          evidence: {},
          createdAt: record.createdAt,
          updatedAt: this.#now(),
          completedAt: null,
          archivedAt: record.supersededBy === undefined ? null : record.archivedAt,
          failureFingerprint: null,
          policyConfigHash: record.policyConfigHash,
          completionBase: null
        });
      }
    });
  }

  async list(
    filter: { readonly parentTaskId?: string } = {}
  ): Promise<readonly StoredTaskRecord[]> {
    const state = await this.#store.read();
    return state.tasks
      .filter(
        (record) =>
          filter.parentTaskId === undefined ||
          record.task.parentTaskId === filter.parentTaskId
      )
      .map(cloneRecord)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.task.id.localeCompare(right.task.id)
      );
  }

  async status(query: TaskStatusQuery): Promise<StoredTaskRecord> {
    if (
      (query.taskId === undefined) ===
      (query.sessionId === undefined)
    ) {
      throw taskError(
        "TASK_STATUS_TARGET_REQUIRED",
        "Task status requires exactly one task or session identity."
      );
    }
    const state = await this.#store.read();
    if (query.taskId !== undefined) {
      return cloneRecord(
        findTask(
          {
            schemaVersion: TASK_SCHEMA_VERSION,
            tasks: [...state.tasks],
            sessions: [...state.sessions]
          },
          query.taskId
        )
      );
    }
    const sessionId = query.sessionId;
    if (sessionId === undefined) {
      throw taskError(
        "TASK_STATUS_TARGET_REQUIRED",
        "Task status requires a session identity."
      );
    }
    assertSessionId(sessionId);
    const attachment = state.sessions.find(
      (candidate) => candidate.sessionId === sessionId
    );
    if (attachment === undefined) {
      throw taskError(
        "TASK_SESSION_UNATTACHED",
        "The session is not attached to a task."
      );
    }
    const record = state.tasks.find(
      (candidate) => candidate.task.id === attachment.taskId
    );
    if (record === undefined) {
      throw taskError(
        "TASK_STATE_INVALID",
        "The session references an unknown task."
      );
    }
    return cloneRecord(record);
  }

  async attach(
    sessionId: string,
    taskId: string
  ): Promise<StoredTaskRecord> {
    assertSessionId(sessionId);
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      const record = findTask(state, taskId);
      // A completed task still accepts attachment: the completion gate wants
      // the session bound to a completed task, so refusing here would make
      // "complete, then attach" an unrecoverable order.
      if (record.status === "archived") {
        throw taskError(
          "TASK_NOT_ACTIVE",
          "An archived task cannot be attached to a session."
        );
      }
      const currentIndex = state.sessions.findIndex(
        (attachment) => attachment.sessionId === sessionId
      );
      const attachment = { sessionId, taskId, attachedAt: now };
      if (currentIndex === -1) {
        state.sessions.push(attachment);
      } else {
        state.sessions[currentIndex] = attachment;
      }
      return cloneRecord(record);
    });
  }

  async complete(
    taskId: string,
    evidenceInput: CriterionEvidenceInput
  ): Promise<StoredTaskRecord> {
    const now = assertTimestamp(this.#now());
    const snapshot = await this.#store.read();
    const current = findTask(snapshot, taskId);
    if (current.status === "archived") {
      throw taskError(
        "TASK_NOT_ACTIVE",
        "An archived task cannot be completed."
      );
    }
    // Supplying nothing means "the evidence this task already carries".
    // Re-typing it changes no outcome — the union below adds the recorded
    // references to whatever was submitted, so evidence can never be dropped
    // by naming less of it — and forcing a caller to copy references back out
    // of the task store buys nothing but the chance to mistype them.
    const submitted = normalizeEvidence(
      current.task,
      Object.keys(evidenceInput).length === 0 ? current.evidence : evidenceInput
    );
    // A caller cannot hide a recorded failure by submitting only older PASS references.
    const evidence = normalizeEvidence(current.task, Object.fromEntries(
      Object.entries(submitted).map(([criterionId, references]) => [criterionId,
        [...new Set([...(current.evidence[criterionId] ?? []), ...references])]])
    ));
    const unfinished = findIncompleteSubtask(snapshot.tasks, taskId);
    if (unfinished !== undefined) {
      throw taskError("TASK_SUBTASK_INCOMPLETE", `Complete subtask ${unfinished.task.id} before its parent; archiving unfinished work does not satisfy completion.`);
    }
    const completion = this.#completion;
    if (completion === undefined) {
      throw taskError("TASK_COMPLETION_UNAVAILABLE", "Task completion requires repository config, source, verification evidence and review validation.");
    }
    const evidenceStore = new FileEvidenceStore(completion.root, completion.root);
    for (const [criterionId, references] of Object.entries(evidence)) {
      for (const reference of references) {
        if (reference.startsWith("review:") && current.evidence[criterionId]?.includes(reference)) continue;
        const validation = validateEvidence(await evidenceStore.load(reference));
        if (!validation.ok || validation.value.taskId !== taskId || validation.value.criterionId !== criterionId) {
          throw taskError("TASK_EVIDENCE_INVALID", `Criterion ${criterionId} requires resolvable evidence belonging to this task and criterion.`);
        }
      }
    }
    let completionBase: string | null = null;
    const fingerprint = async (): Promise<string> => {
      try {
        const scope = await resolveReviewScope({ root: completion.root, runner: completion.gitRunner,
          ...(completion.base === undefined ? {} : { base: completion.base }),
          ...((current.noChangePaths ?? completion.noChangePaths) === undefined ? {} : {noChangePaths: current.noChangePaths ?? completion.noChangePaths}) });
        // Recorded so the completion gate can recompute this exact range once
        // the work is committed and the worktree has nothing left to measure.
        completionBase = scope.mode === "base" ? scope.resolvedBase : null;
        return await calculateSourceFingerprint(completion.root, scope, completion.gitRunner);
      } catch (error) {
        if (error instanceof AgentOpsError && error.code === "REVIEW_NO_CHANGE_SURFACE") {
          throw taskError("TASK_COMPLETION_SCOPE_REQUIRED", completion.base === undefined
            ? "No changed worktree scope. For committed work, run verify, review and task complete with the same --base <git-ref>."
            : "The requested base range has no changed paths; choose a base that precedes the committed work.");
        }
        throw error;
      }
    };
    const config = await completion.loadConfig();
    const sourceFingerprint = await fingerprint();
    const problem = await checkTaskCompletionEvidence({ ...current, evidence }, {
      root: completion.root, config, sourceFingerprint,
      evidenceStore
    });
    if (problem !== null) {
      throw taskError(`TASK_COMPLETION_${problem.code}`, problem.remedy);
    }
    if (sourceFingerprint !== await fingerprint() ||
      calculateConfigHash(config) !== calculateConfigHash(await completion.loadConfig())) {
      throw taskError("TASK_COMPLETION_SOURCE_CHANGED", "Source or config changed during completion; verify and review again.");
    }
    return await this.#store.mutate((state) => {
      if (JSON.stringify(findTask(state, taskId)) !== JSON.stringify(current)) {
        throw taskError("TASK_COMPLETION_STATE_CHANGED", "Task changed during completion; retry against its current evidence and status.");
      }
      const unfinished = findIncompleteSubtask(state.tasks, taskId);
      if (unfinished !== undefined) {
        throw taskError("TASK_SUBTASK_INCOMPLETE", `Complete subtask ${unfinished.task.id} before its parent; archiving unfinished work does not satisfy completion.`);
      }
      if (current.status === "complete") {
        if (JSON.stringify(current.evidence) !== JSON.stringify(evidence)) {
          throw taskError(
            "TASK_ALREADY_COMPLETE",
            "Completed task evidence cannot be replaced."
          );
        }
        return cloneRecord(current);
      }
      const completed: StoredTaskRecord = {
        ...current,
        status: "complete",
        evidence,
        updatedAt: now,
        completedAt: now,
        completionBase
      };
      replaceTask(state, completed);
      return cloneRecord(completed);
    });
  }

  /**
   * Append evidence for some criteria without completing the task. Unlike
   * `complete`, the input may be partial — an independent review covers the
   * criteria it was asked about, not necessarily all of them. Only an active
   * task accepts evidence: a completed record must stay exactly as it was
   * verified.
   */
  async recordEvidence(
    taskId: string,
    evidenceInput: CriterionEvidenceInput,
    /**
     * A PASS review's base: set records it, null clears it (the review covered
     * uncommitted work), undefined leaves the record's value alone.
     */
    reviewBase?: string | null,
    noChangePaths?: readonly string[]
  ): Promise<StoredTaskRecord> {
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      const current = findTask(state, taskId);
      if (current.status !== "active") {
        throw taskError(
          "TASK_NOT_ACTIVE",
          "Only an active task can record additional evidence."
        );
      }
      const criterionIds = new Set(
        current.task.criteria.map((criterion) => criterion.id)
      );
      const evidence: Record<string, string[]> = Object.fromEntries(
        Object.entries(current.evidence).map(([criterionId, references]) => [
          criterionId,
          [...references]
        ])
      );
      for (const [criterionId, references] of Object.entries(evidenceInput)) {
        if (!criterionIds.has(criterionId)) {
          throw taskError(
            "TASK_EVIDENCE_UNKNOWN_CRITERION",
            `Unknown criterion: ${criterionId}`
          );
        }
        if (
          references.length === 0 ||
          references.some(
            (reference) =>
              typeof reference !== "string" || reference.trim().length === 0
          )
        ) {
          throw taskError(
            "TASK_EVIDENCE_INVALID",
            `Evidence for ${criterionId} must be non-empty references.`
          );
        }
        evidence[criterionId] = [
          ...new Set([...(evidence[criterionId] ?? []), ...references])
        ];
      }
      const { reviewBase: previousBase, ...rest } = current;
      const base = reviewBase === undefined ? previousBase : reviewBase ?? undefined;
      const updated: StoredTaskRecord = {
        ...rest,
        evidence,
        updatedAt: now,
        ...(noChangePaths === undefined ? {} : {noChangePaths: [...noChangePaths]}),
        ...(base === undefined ? {} : { reviewBase: base })
      };
      replaceTask(state, updated);
      return cloneRecord(updated);
    });
  }

  /** Append a fresh verification to a completed task without reopening it. */
  async recordVerificationEvidence(
    snapshot: StoredTaskRecord,
    evidenceInput: CriterionEvidenceInput,
    sourceFingerprint: string
  ): Promise<StoredTaskRecord> {
    if (snapshot.status === "active") {
      const result = await this.recordEvidence(snapshot.task.id, evidenceInput);
      await this.clearFailure(snapshot.task.id);
      return result;
    }
    const completion = this.#completion;
    if (snapshot.status !== "complete" || completion === undefined) {
      throw taskError("TASK_NOT_ACTIVE", "Completed reverification requires repository context; archived tasks are immutable.");
    }
    const config = await completion.loadConfig();
    const configHash = calculateConfigHash(config);
    if (snapshot.policyConfigHash !== configHash) {
      throw taskError("TASK_REVERIFICATION_CHANGED", "Completed task config changed; create a new task for the new scope.");
    }
    const store = new FileEvidenceStore(completion.root, completion.root);
    const matches = (value: unknown, criterionId: string, commandId: string) => {
      const validation = validateEvidence(value);
      return validation.ok && validation.value.taskId === snapshot.task.id &&
        validation.value.criterionId === criterionId && validation.value.commandId === commandId &&
        validation.value.configHash === configHash && validation.value.sourceFingerprint === sourceFingerprint &&
        (!(snapshot.task.goal !== undefined || (snapshot.task.contractRevision ?? 0) > 0 || snapshot.task.criteria.some(c => c.acceptance !== undefined)) ||
          validation.value.taskContractHash === taskContractHash(snapshot.task))
        ? validation.value : null;
    };
    for (const criterion of snapshot.task.criteria) {
      const commands = config.verification.commands.filter(({ id, required }) => required &&
        (criterion.acceptance !== undefined || criterion.verifierIds.includes(id)));
      if (commands.length === 0 && criterion.acceptance === undefined)
        throw taskError("TASK_REVERIFICATION_CHANGED", "Completed task criteria lack required coverage.");
      for (const command of commands) {
        let original = false;
        let fresh = false;
        for (const reference of snapshot.evidence[criterion.id] ?? []) {
          if (reference.startsWith("review:")) continue;
          const evidence = matches(await store.load(reference), criterion.id, command.id);
          // Legacy counts identify the original scope only; they do not prove fresh PASS.
          if (evidence !== null && isPassingVerificationEvidence({ ...command, evidence: { kind: "exit-code" } }, evidence)) original = true;
        }
        for (const reference of evidenceInput[criterion.id] ?? []) {
          const evidence = matches(await store.load(reference), criterion.id, command.id);
          if (evidence !== null && evidence.schemaVersion >= 3 &&
            !snapshot.evidence[criterion.id]?.includes(reference) && isPassingVerificationEvidence(command, evidence)) fresh = true;
        }
        if (!original || !fresh) throw taskError("TASK_REVERIFICATION_CHANGED", "Completed task source or evidence changed; fresh PASS must cover the original scope and every required verifier.");
      }
    }
    const appended = normalizeEvidence(snapshot.task, evidenceInput);
    for (const [criterionId, references] of Object.entries(appended)) {
      for (const reference of references) {
        const validation = validateEvidence(await store.load(reference));
        const criterion = snapshot.task.criteria.find(({id}) => id === criterionId);
        const permitted = validation.ok && criterion !== undefined && (criterion.acceptance === undefined
          ? criterion.verifierIds.includes(validation.value.commandId)
          : validation.value.acceptance === undefined
            ? config.verification.commands.some(command => command.id === validation.value.commandId)
            : criterion.acceptance.bindings.some(binding => binding.runnerId === validation.value.commandId));
        if (!validation.ok || !permitted || matches(validation.value, criterionId, validation.value.commandId) === null) {
          throw taskError("TASK_EVIDENCE_INVALID", "Fresh verification references must belong to this task, criterion, source and config.");
        }
      }
    }
    for (const record of [snapshot, {...snapshot, evidence: appended}]) {
      const rows = await acceptanceCoverage(record, config, sourceFingerprint, store);
      if (rows.some(row => (row.mode === "behavioral" || row.mode === "invariant") && row.status !== "proven"))
        throw taskError("TASK_REVERIFICATION_CHANGED", "Completed mechanical contracts require both original and fresh paired acceptance proof.");
    }
    const scope = await resolveReviewScope({ root: completion.root, runner: completion.gitRunner,
      ...(completion.base === undefined ? {} : { base: completion.base }),
      ...(snapshot.noChangePaths === undefined ? {} : {noChangePaths: snapshot.noChangePaths}) });
    if (sourceFingerprint !== await calculateSourceFingerprint(completion.root, scope, completion.gitRunner) ||
      configHash !== calculateConfigHash(await completion.loadConfig())) {
      throw taskError("TASK_REVERIFICATION_CHANGED", "Source or config changed during reverification.");
    }
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      if (JSON.stringify(findTask(state, snapshot.task.id)) !== JSON.stringify(snapshot)) {
        throw taskError("TASK_REVERIFICATION_STATE_CHANGED", "Task changed during reverification; retry without discarding the concurrent state.");
      }
      const updated = { ...snapshot, updatedAt: now, failureFingerprint: null,
        evidence: Object.fromEntries(snapshot.task.criteria.map(({ id }) => [id,
          [...new Set([...(snapshot.evidence[id] ?? []), ...appended[id]!])]])) };
      replaceTask(state, updated);
      return cloneRecord(updated);
    });
  }

  async archive(taskId: string): Promise<StoredTaskRecord> {
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      const current = findTask(state, taskId);
      if (current.status === "archived") {
        return cloneRecord(current);
      }
      const archived: StoredTaskRecord = {
        ...current,
        status: "archived",
        updatedAt: now,
        archivedAt: now
      };
      replaceTask(state, archived);
      state.sessions = state.sessions.filter(
        (attachment) => attachment.taskId !== taskId
      );
      return cloneRecord(archived);
    });
  }

  async export(taskId: string): Promise<string> {
    return renderTaskMarkdown(await this.status({ taskId }));
  }

  async recordFailure(
    taskId: string,
    fingerprint: FailureFingerprint
  ): Promise<FailureFingerprintAdvance> {
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      const current = findTask(state, taskId);
      if (current.status === "archived") {
        throw taskError(
          "TASK_NOT_ACTIVE",
          "An archived task cannot record verification failures."
        );
      }
      const advanced = advanceFailureFingerprint(
        current.failureFingerprint,
        fingerprint,
        now
      );
      replaceTask(state, {
        ...current,
        updatedAt: now,
        failureFingerprint: advanced.state
      });
      return structuredClone(advanced);
    });
  }

  async clearFailure(taskId: string): Promise<void> {
    const now = assertTimestamp(this.#now());
    await this.#store.mutate((state) => {
      const current = findTask(state, taskId);
      if (current.failureFingerprint === null) {
        return;
      }
      replaceTask(state, {
        ...current,
        updatedAt: now,
        failureFingerprint: null
      });
    });
  }

  async coverage(taskId: string): Promise<{rows: readonly CriterionCoverage[]; reviewed: boolean; originalMechanical: number}> {
    const record = await this.status({taskId});
    const originalMechanical = record.task.criteria.filter(c => {
      const original = record.revisions?.map(r => r.previousTask.criteria.find(old => old.id === c.id)).find(Boolean) ?? c;
      return original.acceptance?.mode === "behavioral" || original.acceptance?.mode === "invariant";
    }).length;
    const unavailable = () => ({originalMechanical, reviewed: false, rows: record.task.criteria.map(c => ({criterionId: c.id,
      mode: c.acceptance?.mode ?? "legacy" as const, status: "undischarged" as const, evidenceReferences: [],
      reason: "Current source-bound coverage is unavailable; verify and review the current contract."}))});
    if (this.#completion === undefined) return unavailable();
    try {
      const config = await this.#completion.loadConfig();
      const base = this.#completion.base ?? record.reviewBase ?? record.completionBase ?? record.createdSourceCommit;
      const scope = await resolveReviewScope({root: this.#completion.root, runner: this.#completion.gitRunner,
        ...(base === undefined ? {} : {base}), ...(record.noChangePaths === undefined ? {} : {noChangePaths: record.noChangePaths})});
      const fingerprint = await calculateSourceFingerprint(this.#completion.root, scope, this.#completion.gitRunner);
      const rows = await acceptanceCoverage(record, config, fingerprint, new FileEvidenceStore(this.#completion.root, this.#completion.root));
      const attestation = await findReviewAttestation(this.#completion.root, fingerprint, taskId);
      const reviewed = attestation !== null && (attestation.schemaVersion === 3 ? attestation.taskContracts?.[taskId] === taskContractHash(record.task) :
        record.task.goal === undefined && (record.task.contractRevision ?? 0) === 0 && record.task.criteria.every(c => c.acceptance === undefined));
      return {rows, reviewed, originalMechanical};
    } catch {return unavailable();}
  }

  async #validateFindingSource(record: StoredTaskRecord, criterion: AcceptanceCriterion, records: readonly StoredTaskRecord[]): Promise<void> {
    const finding = criterion.finding;
    if (finding === undefined) return;
    const existing = record.task.criteria.find(c => c.finding?.pinId === finding.pinId);
    if (existing !== undefined) {
      if (canonicalJson(existing.finding) !== canonicalJson(finding))
        throw taskError("TASK_PIN_IMMUTABLE", "Finding source identity cannot change.");
      return;
    }
    if (this.#completion === undefined) throw taskError("TASK_PIN_REQUIRED", "New pins require a saved review source.");
    const {finding: _finding, ...unbound} = criterion;
    const resolved = await loadFindingPin(this.#completion.root, record, finding.reportDigest + ":" + finding.findingIndex, unbound, records);
    if (canonicalJson(resolved.finding) !== canonicalJson(finding) || resolved.acceptance?.baselineCommit !== criterion.acceptance?.baselineCommit)
      throw taskError("TASK_PIN_REQUIRED", "Pin identity and baseline must match the saved failed report.");
  }

  async pinFinding(taskId: string, expectedContractHash: string, reference: string, criterion: AcceptanceCriterion, reason?: string):
    Promise<{record: StoredTaskRecord | null; pendingCriterion: AcceptanceCriterion}> {
    if (this.#completion === undefined) throw taskError("TASK_COMPLETION_UNAVAILABLE", "Pin requires a repository and saved review artifacts.");
    const state = await this.#store.read();
    const record = findTask(state, taskId);
    if (record.status !== "active" || taskContractHash(record.task) !== expectedContractHash)
      throw taskError("TASK_CONTRACT_CHANGED", "Pin requires the current active contract.");
    const pinned = await loadFindingPin(this.#completion.root, record, reference, criterion, state.tasks);
    const existing = record.task.criteria.find(c => c.finding?.pinId === pinned.finding?.pinId);
    if (existing === undefined && record.task.criteria.length === 5) return {record: null, pendingCriterion: pinned};
    if (existing === undefined && record.task.criteria.some(c => c.id === pinned.id))
      throw taskError("TASK_CRITERION_ID_CONFLICT", "A new pin requires a new criterion ID.");
    const criteria = existing === undefined ? [...record.task.criteria, pinned] : record.task.criteria.map(c => c.id === existing.id ? pinned : c);
    const updated = await this.revise(taskId, {expectedContractHash, criteria,
      reason: reason ?? "Pin saved review finding " + reference + " against the immutable original goal.", diagnostics: ["finding:" + reference, "pin:" + pinned.finding!.pinId]});
    return {record: updated, pendingCriterion: pinned};
  }

  async treeContract(taskId: string): Promise<string> {
    const state = await this.#store.read();
    findTask(state, taskId);
    const ids = new Set([taskId]);
    for (let size = 0; size !== ids.size;) {
      size = ids.size;
      for (const record of state.tasks) if (record.supersededBy === undefined && record.task.parentTaskId !== undefined && ids.has(record.task.parentTaskId))
        ids.add(record.task.id);
    }
    return treeContractHash(state.tasks.filter(record => ids.has(record.task.id) && record.supersededBy === undefined).map(record => record.task));
  }
}
