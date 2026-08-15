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

function reviewSchemaText(): string {
  return readFileSync(reviewSchemaPath(), "utf8");
}

/**
 * Read-only enforcement per target, verified against each CLI's own help
 * output. A target absent from this table is ineligible: review never runs an
 * agent that can edit the code it is reviewing. This is what excludes
 * opencode, whose `--agent plan` is rejected as a subagent and silently falls
 * back to a writable agent.
 */
export const READ_ONLY_ARGS: Readonly<
  Record<ReviewTargetId, readonly string[]>
> = {
  agy: ["--sandbox", "--mode", "plan"],
  claude: ["--permission-mode", "plan"],
  codex: ["-s", "read-only"]
};

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
        "--output-schema",
        reviewSchemaPath(),
        ...(request.repositoryRoot === undefined
          ? []
          : ["--add-dir", request.repositoryRoot, "--ephemeral", "--ignore-rules"]),
        ...shared
      ],
      stdin: request.prompt
    };
  }
  const isolation = request.target === "claude"
    ? ["--no-session-persistence", "--safe-mode", "--disable-slash-commands"]
    : [];
  return {
    command: request.target,
    args: [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      reviewSchemaText(),
      ...(request.repositoryRoot === undefined
        ? []
        : ["--add-dir", request.repositoryRoot]),
      ...isolation,
      ...shared
    ],
    stdin: request.prompt
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
      args: ["exec", "-", "--skip-git-repo-check", ...readOnly],
      stdin: request.prompt
    };
  }
  const isolation = request.target === "claude"
    ? ["--no-session-persistence", "--safe-mode", "--disable-slash-commands"]
    : [];
  return {
    command: request.target,
    args: ["-p", "--output-format", "json", ...isolation, ...readOnly],
    stdin: request.prompt
  };
}
