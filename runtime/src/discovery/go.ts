import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import type {
  DiscoveryAdapter,
  DiscoveryEvidence,
  DiscoveryResult,
  UserDecisionReason,
  VerifierProposal
} from "./types.js";

const MAX_GO_MOD_BYTES = 1024 * 1024;

type MetadataReadResult =
  | { kind: "invalid"; message: string }
  | { kind: "missing" }
  | { kind: "source"; source: string };

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

async function readGoMod(filePath: string): Promise<MetadataReadResult> {
  let status;
  try {
    status = await lstat(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { kind: "missing" };
    }
    return {
      kind: "invalid",
      message: "go.mod could not be inspected safely."
    };
  }

  if (status.isSymbolicLink() || !status.isFile()) {
    return {
      kind: "invalid",
      message: "go.mod must be a regular file."
    };
  }
  if (status.size > MAX_GO_MOD_BYTES) {
    return {
      kind: "invalid",
      message: "go.mod exceeds the discovery size limit."
    };
  }

  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK
    );
    const openedStatus = await handle.stat();
    if (!openedStatus.isFile()) {
      return {
        kind: "invalid",
        message: "go.mod must remain a regular file."
      };
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_GO_MOD_BYTES) {
      const remaining = MAX_GO_MOD_BYTES + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        null
      );
      if (bytesRead === 0) {
        return {
          kind: "source",
          source: Buffer.concat(chunks, totalBytes).toString("utf8")
        };
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return {
      kind: "invalid",
      message: "go.mod exceeds the discovery size limit."
    };
  } catch {
    return {
      kind: "invalid",
      message: "go.mod could not be read as a regular file."
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasOneModuleDirective(source: string): boolean {
  if (source.includes("\0") || source.includes("\uFFFD")) {
    return false;
  }

  const moduleLines = source.split(/\r?\n/u).filter((line) => (
    /^\s*module(?:\s|$)/u.test(line)
  ));
  return (
    moduleLines.length === 1 &&
    /^\s*module\s+\S+\s*(?:(?:\/\/).*)?$/u.test(moduleLines[0] ?? "")
  );
}

function fileEvidence(detail: string): DiscoveryEvidence {
  return { kind: "file", path: "go.mod", detail };
}

function userDecision(
  reason: UserDecisionReason,
  message: string,
  evidence: DiscoveryEvidence[]
): DiscoveryResult {
  return {
    kind: "user-decision",
    adapter: "go",
    reason,
    message,
    evidence,
    manualConfigAllowed: true
  };
}

function goTestProposal(evidence: DiscoveryEvidence[]): VerifierProposal {
  return {
    id: "go:test",
    command: "go",
    args: ["test", "./..."],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 },
    sourceEvidence: evidence,
    confidence: "high",
    confirmed: false
  };
}

export async function discoverGoProject(
  root: string
): Promise<DiscoveryResult> {
  const metadata = await readGoMod(path.join(root, "go.mod"));
  if (metadata.kind === "missing") {
    return {
      kind: "no-match",
      adapter: "go",
      reason: "not-go-project",
      message: "No go.mod was found.",
      evidence: [],
      manualConfigAllowed: true
    };
  }

  const evidence = [fileEvidence("Found bounded Go module metadata.")];
  if (metadata.kind === "invalid") {
    return userDecision("invalid-manifest", metadata.message, evidence);
  }
  if (!hasOneModuleDirective(metadata.source)) {
    return userDecision(
      "invalid-manifest",
      "go.mod does not contain one valid module directive.",
      evidence
    );
  }

  const proposalEvidence = [
    fileEvidence("Found one explicit Go module directive.")
  ];
  return {
    kind: "proposals",
    adapter: "go",
    proposals: [goTestProposal(proposalEvidence)],
    evidence: proposalEvidence,
    manualConfigAllowed: true
  };
}

export const goDiscoveryAdapter: DiscoveryAdapter = {
  id: "go",
  discover: discoverGoProject
};
