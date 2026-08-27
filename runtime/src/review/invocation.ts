import type { ReviewTargetId } from "../contracts.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TargetInvocationRequest {
  readonly target: ReviewTargetId;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly repositoryRoot?: string;
  readonly logFile?: string;
}

export interface TargetInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

function reviewSchemaPath(): string {
  const packaged = fileURLToPath(
    new URL("../../../../schemas/review-report.schema.json", import.meta.url)
  );
  if (existsSync(packaged)) {
    return packaged;
  }
  const source = fileURLToPath(
    new URL("../../../schemas/review-report.schema.json", import.meta.url)
  );
  return existsSync(source)
    ? source
    : resolve(process.cwd(), "schemas", "review-report.schema.json");
}

/**
 * Removes every `pattern`. A target validates the schema with its own regex
 * engine before it will run, and Go's RE2 — agy's — rejects constructs ECMA-262
 * allows: it refused `/$defs/path` for a lookahead, then `/$defs/text` for a
 * `\uXXXX` escape. Enumerating those differences is a losing game, and the
 * schema handed to a target only shapes its answer: `validateReviewReport` is
 * the authority and re-applies every pattern to whatever comes back, so an
 * advisory constraint dropped here weakens nothing.
 */
function stripPatterns(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      stripPatterns(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  delete record.pattern;
  for (const item of Object.values(record)) {
    stripPatterns(item);
  }
}

/**
 * The schema as a reviewer CLI will accept it. The file keeps its `$schema`
 * declaration for this repository's own validation, but a target that resolves
 * meta-schema references offline rejects the whole schema over it — claude
 * answers `--json-schema is not a valid JSON Schema: no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema"` and never starts. The draft
 * declaration carries no constraint, so dropping it costs nothing.
 */
function reviewSchemaText(): string {
  const parsed = JSON.parse(
    readFileSync(reviewSchemaPath(), "utf8")
  ) as Record<string, unknown>;
  delete parsed.$schema;
  stripPatterns(parsed);
  return JSON.stringify(parsed);
}

/**
 * Read-only enforcement per target, verified against each CLI's own help
 * output. A target absent from this table is ineligible: review never runs an
 * agent that can edit the code it is reviewing. This is what excludes
 * opencode, whose `--agent plan` is rejected as a subagent and silently falls
 * back to a writable agent.
 *
 * Agy can still mutate its cwd in sandboxed plan mode, so the executor points
 * it at a disposable repository clone. Never combine this with
 * `--dangerously-skip-permissions`, which overrides the permission boundary.
 */
export const READ_ONLY_ARGS: Readonly<
  Partial<Record<ReviewTargetId, readonly string[]>>
> = {
  agy: ["--sandbox", "--mode", "plan"],
  claude: ["--permission-mode", "plan"],
  codex: ["-s", "read-only"]
};

/** Per-target customization suppression. */
function isolationArgs(target: ReviewTargetId): readonly string[] {
  return target === "claude"
    ? ["--no-session-persistence", "--safe-mode", "--disable-slash-commands"]
    : [];
}

function modelArgs(
  target: ReviewTargetId,
  model: string | undefined
): readonly string[] {
  if (model === undefined) {
    return [];
  }
  return target === "codex" ? ["-m", model] : ["--model", model];
}

function effortArgs(
  target: ReviewTargetId,
  effort: string | undefined
): readonly string[] {
  if (effort === undefined) {
    return [];
  }
  // codex has no --effort flag; reasoning effort is a config override.
  return target === "codex"
    ? ["-c", `model_reasoning_effort=${effort}`]
    : ["--effort", effort];
}

export function buildTargetInvocation(
  request: TargetInvocationRequest
): TargetInvocation | undefined {
  const readOnly = READ_ONLY_ARGS[request.target] as
    | readonly string[]
    | undefined;
  if (readOnly === undefined || readOnly.length === 0) {
    return undefined;
  }
  const shared = [
    ...readOnly,
    ...modelArgs(request.target, request.model),
    ...effortArgs(request.target, request.effort)
  ];
  if (request.target === "codex") {
    // codex writes progress to stderr and leaves stdout as the bare final
    // message, so it needs no output-format flag and no scratch file.
    // Without --skip-git-repo-check it refuses to run outside a trusted git
    // directory, which a caller would otherwise read as "not authenticated".
    return {
      command: "codex",
      args: [
        "exec",
        "-",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        ...(request.repositoryRoot === undefined
          ? []
          : ["-C", request.repositoryRoot]),
        ...shared
      ],
      stdin: request.prompt
    };
  }
  return {
    command: request.target,
    args: [
      "-p",
      ...(request.target === "agy" ? [request.prompt] : []),
      "--output-format",
      "json",
      "--json-schema",
      reviewSchemaText(),
      ...(request.repositoryRoot === undefined
        ? []
        : ["--add-dir", request.repositoryRoot]),
      ...(request.target !== "agy" || request.logFile === undefined
        ? []
        : ["--log-file", request.logFile]),
      ...isolationArgs(request.target),
      ...shared
    ],
    // Agy requires the prompt as the value of --print; a bare -p consumes the
    // following flag. Claude accepts the prompt on stdin, keeping it out of ps.
    stdin: request.target === "agy" ? "" : request.prompt
  };
}

/** A deep doctor probe uses stdin but keeps its simple text response contract. */
export function buildProbeInvocation(
  request: TargetInvocationRequest
): TargetInvocation | undefined {
  const readOnly = READ_ONLY_ARGS[request.target] as readonly string[] | undefined;
  if (readOnly === undefined || readOnly.length === 0) {
    return undefined;
  }
  if (request.target === "codex") {
    return {
      command: "codex",
      args: [
        "exec", "-", "--skip-git-repo-check", "--ephemeral",
        "--ignore-user-config", "--ignore-rules", ...readOnly
      ],
      stdin: request.prompt
    };
  }
  return {
    command: request.target,
    args: [
      "-p",
      ...(request.target === "agy" ? [request.prompt] : []),
      "--output-format",
      "json",
      ...(request.target !== "agy" || request.logFile === undefined
        ? []
        : ["--log-file", request.logFile]),
      ...isolationArgs(request.target),
      ...readOnly
    ],
    stdin: request.target === "agy" ? "" : request.prompt
  };
}
