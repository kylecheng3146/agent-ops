import { join } from "node:path";

import {
  EVIDENCE_SCHEMA_VERSION,
  type AgentOpsConfig,
  type InstallScope,
  type VerificationCommand,
  type VerificationEvidence
} from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { calculateConfigHash } from "../config/hash.js";
import { evaluateTestCount } from "./test-count.js";

export { calculateConfigHash } from "../config/hash.js";
import { validateEvidence } from "../schema/validate.js";
import {
  readPrivateFile,
  writePrivateFile
} from "../security/permissions.js";
import { redactSecrets } from "../security/redact.js";

export interface BuildVerificationEvidenceInput {
  readonly taskId: string;
  readonly criterionId: string;
  readonly command: VerificationCommand;
  readonly scope: InstallScope;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: number | null;
  readonly testCount: number | null;
  readonly status: VerificationEvidence["status"];
  readonly failureClass: string;
  readonly sourceFingerprint: string;
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly config: AgentOpsConfig;
}

function redactRecord(
  record: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      redactSecrets(key),
      redactSecrets(value)
    ])
  );
}

function validateBuiltEvidence(
  value: unknown
): VerificationEvidence {
  const validation = validateEvidence(value);
  if (!validation.ok) {
    throw new AgentOpsError(
      "EVIDENCE_INVALID",
      validation.errors[0]?.message ??
        "Verification evidence is invalid."
    );
  }
  return validation.value;
}

export function buildVerificationEvidence(
  input: BuildVerificationEvidenceInput
): VerificationEvidence {
  return validateBuiltEvidence({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId: input.taskId,
    criterionId: input.criterionId,
    commandId: input.command.id,
    argv: [input.command.command, ...input.command.args].map(
      redactSecrets
    ),
    cwd: input.command.cwd,
    scope: input.scope,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    exitCode: input.exitCode,
    testCount: input.testCount,
    status: input.status,
    failureClass: redactSecrets(input.failureClass),
    sourceFingerprint: input.sourceFingerprint,
    toolVersions: redactRecord(input.toolVersions),
    configHash: calculateConfigHash(input.config)
  });
}

/** Confirms that a persisted PASS still matches the current command contract. */
export function isPassingVerificationEvidence(
  command: VerificationCommand,
  evidence: VerificationEvidence
): boolean {
  if (
    evidence.status !== "PASS" ||
    evidence.exitCode !== 0 ||
    evidence.failureClass !== "none" ||
    command.evidence.kind === "file"
  ) {
    return false;
  }
  return command.evidence.kind !== "test-count" ||
    evaluateTestCount(evidence.testCount, command.evidence.minimum).status === "PASS";
}

export class FileEvidenceStore {
  readonly #root: string;
  readonly #anchorDirectory: string;

  constructor(root: string, anchorDirectory: string) {
    this.#root = root;
    this.#anchorDirectory = anchorDirectory;
  }

  async save(value: VerificationEvidence): Promise<string> {
    const evidence = validateBuiltEvidence(value);
    const content = `${JSON.stringify(evidence, null, 2)}\n`;
    const contentHash = sha256(content);
    const relativePath = [
      ".agent-ops",
      "tasks",
      "evidence",
      evidence.taskId,
      `${evidence.commandId}-${contentHash.slice(0, 16)}.json`
    ].join("/");
    const absolutePath = join(
      this.#root,
      ...relativePath.split("/")
    );
    const existing = await readPrivateFile(
      absolutePath,
      this.#anchorDirectory
    );
    if (existing !== null && existing !== content) {
      throw new AgentOpsError(
        "EVIDENCE_CONFLICT",
        "Evidence path already contains different content."
      );
    }
    if (existing === null) {
      await writePrivateFile(
        absolutePath,
        content,
        this.#anchorDirectory
      );
    }
    return relativePath;
  }

  async load(reference: string): Promise<unknown | null> {
    const segments = reference.split("/");
    if (
      !reference.startsWith(".agent-ops/tasks/evidence/") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          !/^[A-Za-z0-9._-]+$/u.test(segment)
      )
    ) {
      return null;
    }
    const path = join(this.#root, ...segments);
    const source = await readPrivateFile(path, this.#anchorDirectory);
    if (source === null) {
      return null;
    }
    try {
      return JSON.parse(source) as unknown;
    } catch {
      throw new AgentOpsError("EVIDENCE_INVALID", "Stored evidence is not valid JSON.");
    }
  }
}
