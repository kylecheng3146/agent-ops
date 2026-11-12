import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { readPrivateFile, withPrivateFileLock, writePrivateFile } from "../security/permissions.js";
import { redactSecrets } from "../security/redact.js";
import { parseQaArtifact, parseQaControl, qaId, validQaReference } from "./validate.js";
import type { QaArtifactKind, QaArtifacts, QaControl, QaReference } from "./types.js";

const MAX_BYTES = 16 * 1024 * 1024;
function invalid(message: string): never {throw new AgentOpsError("QA_STATE_INVALID", message);}
/** Redact values before hashing, so identities describe the saved canonical content. */
function redact(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}
function encode(value: unknown): string {
  const content = canonicalJson(value);
  if (Buffer.byteLength(content) > MAX_BYTES) invalid("QA record exceeds its private byte limit.");
  return content;
}

/** Common-directory state is shared by linked worktrees and never enters source fingerprints. */
export class FileQaStore {
  readonly directory: string;
  constructor(readonly commonDir: string) {this.directory = join(commonDir, "agent-ops", "qa");}

  artifactPath(ref: QaReference): string {
    if (!validQaReference(ref)) invalid("Invalid QA artifact identity.");
    return join(this.directory, ref.kind, `${ref.digest}.json`);
  }
  controlPath(taskId: string): string {
    if (!qaId(taskId)) invalid("Invalid QA task identity.");
    return join(this.directory, "control", `${taskId}.json`);
  }
  controlHistoryPath(taskId: string, revision: number): string {
    if (!qaId(taskId) || !Number.isSafeInteger(revision) || revision < 1) invalid("Invalid QA control history identity.");
    return join(this.directory, "control-history", taskId, `${revision}.json`);
  }
  async #read(path: string): Promise<unknown | null> {
    try {
      const status = await lstat(path);
      if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_BYTES) invalid("QA state must be a bounded regular private file.");
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
    const source = await readPrivateFile(path, this.commonDir);
    if (source === null) return null;
    if (Buffer.byteLength(source) > MAX_BYTES) invalid("QA record exceeds its private byte limit.");
    try {
      const value: unknown = JSON.parse(source);
      if (value === null) invalid("An existing QA record cannot be null.");
      return value;
    } catch {return invalid("QA state contains malformed JSON; preserve it for diagnosis.");}
  }
  async put<K extends QaArtifactKind>(kind: K, value: QaArtifacts[K]): Promise<QaReference> {
    const checked = parseQaArtifact(kind, redact(parseQaArtifact(kind, value)));
    const content = encode(checked), ref: QaReference = {kind, digest: sha256(content)};
    const path = this.artifactPath(ref);
    return await withPrivateFileLock(path, this.commonDir, async () => {
      const previous = await this.#read(path);
      if (previous !== null && canonicalJson(previous) !== content) invalid("An immutable QA artifact was changed.");
      if (previous === null) await writePrivateFile(path, `${content}\n`, this.commonDir);
      return ref;
    });
  }
  async get<K extends QaArtifactKind>(ref: QaReference & {readonly kind: K}): Promise<QaArtifacts[K]> {
    const path = this.artifactPath(ref), value = await this.#read(path);
    if (value === null) throw new AgentOpsError("QA_ARTIFACT_MISSING", "The exact saved QA artifact is unavailable.");
    if (sha256(encode(value)) !== ref.digest) invalid("QA artifact digest does not match its saved identity.");
    return parseQaArtifact(ref.kind, value);
  }
  async readControl(taskId: string): Promise<QaControl | null> {
    const value = await this.#read(this.controlPath(taskId));
    if (value === null) return null;
    const control = parseQaControl(value);
    if (control.taskId !== taskId) invalid("QA control belongs to another task.");
    return control;
  }
  async readControlHistory(taskId: string, revision: number): Promise<QaControl | null> {
    const value = await this.#read(this.controlHistoryPath(taskId, revision));
    if (value === null) return null;
    const control = parseQaControl(value);
    if (control.taskId !== taskId || control.revision !== revision) invalid("QA control history identity changed.");
    return control;
  }
  /** CAS plus the repository's private lock preserves a competing generation's state. */
  async updateControl(taskId: string, expectedRevision: number,
    action: (current: QaControl | null) => QaControl | Promise<QaControl>): Promise<QaControl> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid("Expected a nonnegative control revision.");
    const path = this.controlPath(taskId);
    return await withPrivateFileLock(path, this.commonDir, async () => {
      const current = await this.readControl(taskId);
      if ((current?.revision ?? 0) !== expectedRevision) throw new AgentOpsError("QA_CONTROL_CHANGED", "QA control changed; re-read before continuing.");
      const next = parseQaControl(redact(await action(structuredClone(current))));
      if (next.taskId !== taskId || next.revision !== expectedRevision + 1 ||
        (current !== null && (next.generation < current.generation ||
          (next.generation !== current.generation && current.owner !== null) ||
          (current.owner !== null && next.owner !== null &&
            (current.owner.controllerId !== next.owner.controllerId || canonicalJson(current.owner.session) !== canonicalJson(next.owner.session) ||
              (current.owner.processId !== null && (current.owner.processId !== next.owner.processId || current.owner.processIdentity !== next.owner.processIdentity)))))))
        invalid("QA control cannot replace another task, revision or owned generation.");
      const content = encode(next);
      if (current !== null) {
        const path = this.controlHistoryPath(taskId, current.revision), previous = await this.#read(path);
        const snapshot = encode(current);
        if (previous !== null && encode(previous) !== snapshot) invalid("Immutable QA control history changed.");
        if (previous === null) await writePrivateFile(path, `${snapshot}\n`, this.commonDir);
      }
      await writePrivateFile(path, `${content}\n`, this.commonDir);
      return structuredClone(next);
    });
  }
}
