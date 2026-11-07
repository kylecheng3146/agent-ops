import {join} from "node:path";
import {readPrivateFile, withPrivateFileLock, writePrivateFile} from "../security/permissions.js";
import {globsOverlap} from "../escape/lessons.js";
import {digest, exact, hash, invalid, object, parseProposal, redactData, text, type Proposal} from "./data.js";

export interface LearningVersion {proposal: Proposal; trial: string; source: {receipt: string; taskId: string; commit: string}; previous: string | null}
export interface LearningState {
  schemaVersion: 1;
  generation: number;
  active: string | null;
  versions: string[];
  history: {at: string; action: "adopt" | "rollback" | "retire"; from: string | null; to: string | null; reason: string}[];
}
export class FileLearningStore {
  readonly directory: string;
  readonly path: string;
  constructor(readonly commonDir: string) {
    this.directory = join(commonDir, "agent-ops", "learning");
    this.path = join(this.directory, "state.json");
  }
  async read(): Promise<LearningState> {
    const raw = await readPrivateFile(this.path, this.commonDir);
    if (raw === null) return {schemaVersion: 1, generation: 0, active: null, versions: [], history: []};
    if (Buffer.byteLength(raw) > 1024 * 1024) invalid("Learning state exceeds its bound.");
    let v: unknown; try {v = JSON.parse(raw);} catch {invalid("Unreadable learning state; preserved.");}
    if (!object(v) || !exact(v, ["schemaVersion", "generation", "active", "versions", "history"]) || v.schemaVersion !== 1 ||
        !Number.isSafeInteger(v.generation) || (v.generation as number) < 0 || (v.active !== null && !hash(v.active)) ||
        !Array.isArray(v.versions) || !v.versions.every(hash) || new Set(v.versions).size !== v.versions.length ||
        (v.active !== null && !v.versions.includes(v.active)) || !Array.isArray(v.history) || v.history.length !== v.generation ||
        !v.history.every(h => object(h) && exact(h, ["at", "action", "from", "to", "reason"]) && text(h.at, 64) &&
          Number.isFinite(Date.parse(h.at)) && ["adopt", "rollback", "retire"].includes(String(h.action)) && text(h.reason) &&
          (h.from === null || (v.versions as unknown[]).includes(h.from)) && (h.to === null || (v.versions as unknown[]).includes(h.to)))) invalid("Invalid learning state; preserved.");
    return v as unknown as LearningState;
  }
  async archive(kind: "trials" | "versions" | "uses", value: unknown): Promise<string> {
    const safe = redactData(value), id = digest(safe), body = JSON.stringify(safe);
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) invalid("Learning artifact exceeds 4 MiB.");
    const path = join(this.directory, kind, id + ".json");
    const previous = await readPrivateFile(path, this.commonDir);
    if (previous !== null && previous !== body) invalid("Immutable learning artifact was changed.");
    if (previous === null) await writePrivateFile(path, body, this.commonDir);
    return id;
  }
  async artifact(kind: "trials" | "versions", id: string): Promise<unknown> {
    if (!hash(id)) invalid("Artifact identity must be a digest.");
    const raw = await readPrivateFile(join(this.directory, kind, id + ".json"), this.commonDir);
    if (raw === null || Buffer.byteLength(raw) > 4 * 1024 * 1024) invalid("Learning artifact missing or oversized.");
    let value: unknown; try {value = JSON.parse(raw);} catch {invalid("Unreadable learning artifact.");}
    if (digest(value) !== id) invalid("Learning artifact digest mismatch.");
    return value;
  }
  async version(id: string): Promise<LearningVersion> {
    const value = await this.artifact("versions", id);
    if (!object(value) || !exact(value, ["proposal", "trial", "source", "previous"]) || !hash(value.trial) ||
        (value.previous !== null && !hash(value.previous)) || !object(value.source) || !exact(value.source, ["receipt", "taskId", "commit"]) ||
        !hash(value.source.receipt) || !text(value.source.taskId, 128) || typeof value.source.commit !== "string" ||
        !/^[a-f0-9]{40,64}$/u.test(value.source.commit)) invalid("Invalid experience version.");
    parseProposal(value.proposal);
    await this.artifact("trials", value.trial);
    return value as unknown as LearningVersion;
  }
  async current(): Promise<{state: LearningState; version: LearningVersion | null}> {
    const state = await this.read();
    return {state, version: state.active === null ? null : await this.version(state.active)};
  }
  /** The controller archives complete evidence before attempting this compare-and-swap. */
  async adopt(expected: LearningState, version: LearningVersion): Promise<string | null> {
    const id = await this.archive("versions", version);
    return await withPrivateFileLock(this.path, this.commonDir, async () => {
      const state = await this.read();
      if (state.generation !== expected.generation || state.active !== expected.active) return null;
      await this.save(state, "adopt", id, "Repeated paired evaluation improved held-out omission detection without additional false positives.");
      return id;
    });
  }
  async recover(action: "rollback" | "retire", reason: string, version?: string): Promise<LearningState> {
    if (!text(reason)) invalid("Recovery needs a bounded nonempty reason.");
    return await withPrivateFileLock(this.path, this.commonDir, async () => {
      const state = await this.read();
      const target = action === "retire" ? null : version;
      if (target === undefined || (target !== null && !state.versions.includes(target))) invalid("Rollback selects a previously adopted version.");
      if (target !== null) await this.version(target);
      return await this.save(state, action, target, reason);
    });
  }
  private async save(state: LearningState, action: LearningState["history"][number]["action"], to: string | null, reason: string): Promise<LearningState> {
    const next: LearningState = {...state, generation: state.generation + 1, active: to,
      versions: to === null ? state.versions : [...new Set([...state.versions, to])],
      history: [...state.history, {at: new Date().toISOString(), action, from: state.active, to, reason: String(redactData(reason))}]};
    const body = JSON.stringify(next);
    if (Buffer.byteLength(body) > 1024 * 1024) invalid("Learning history is full; retain it before further adoption.");
    await writePrivateFile(this.path, body, this.commonDir);
    return next;
  }
}

export interface ExperienceContext {id: string; revision: string; source: LearningVersion["source"]; cue: string; check: string; paths: string[]}
export async function matchingExperiences(commonDir: string, paths: readonly string[]): Promise<ExperienceContext[]> {
  const {state, version} = await new FileLearningStore(commonDir).current();
  return version === null ? [] : version.proposal.strategies.filter(s => s.paths.some(p => paths.some(path => globsOverlap(p, path))))
    .map(s => ({...s, revision: state.active!, source: version.source}));
}
