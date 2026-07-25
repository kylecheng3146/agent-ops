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

const MAX_MAKEFILE_BYTES = 1024 * 1024;

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

async function readMakefile(filePath: string): Promise<MetadataReadResult> {
  let status;
  try {
    status = await lstat(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { kind: "missing" };
    }
    return {
      kind: "invalid",
      message: "Makefile could not be inspected safely."
    };
  }

  if (status.isSymbolicLink() || !status.isFile()) {
    return {
      kind: "invalid",
      message: "Makefile must be a regular file."
    };
  }
  if (status.size > MAX_MAKEFILE_BYTES) {
    return {
      kind: "invalid",
      message: "Makefile exceeds the discovery size limit."
    };
  }

  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const openedStatus = await handle.stat();
    if (!openedStatus.isFile()) {
      return {
        kind: "invalid",
        message: "Makefile must remain a regular file."
      };
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_MAKEFILE_BYTES) {
      const remaining = MAX_MAKEFILE_BYTES + 1 - totalBytes;
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
      message: "Makefile exceeds the discovery size limit."
    };
  } catch {
    return {
      kind: "invalid",
      message: "Makefile could not be read as a regular file."
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function literalTarget(source: string): "check" | "test" | null {
  if (source.includes("\0") || source.includes("\uFFFD")) {
    return null;
  }

  const lines = source.split(/\r?\n/u);
  if (lines.some((line) => /^test[ \t]*:(?![:=])/u.test(line))) {
    return "test";
  }
  if (lines.some((line) => /^check[ \t]*:(?![:=])/u.test(line))) {
    return "check";
  }
  return null;
}

function fileEvidence(
  target: "check" | "test",
  detail: string
): DiscoveryEvidence {
  return {
    kind: "file",
    path: `Makefile#target:${target}`,
    detail
  };
}

function userDecision(
  reason: UserDecisionReason,
  message: string,
  evidence: DiscoveryEvidence[]
): DiscoveryResult {
  return {
    kind: "user-decision",
    adapter: "make",
    reason,
    message,
    evidence,
    manualConfigAllowed: true
  };
}

function makeProposal(
  target: "check" | "test",
  evidence: DiscoveryEvidence[]
): VerifierProposal {
  return {
    id: `make:${target}`,
    command: "make",
    args: [target],
    cwd: ".",
    required: true,
    evidence:
      target === "test"
        ? { kind: "test-count", minimum: 1 }
        : { kind: "exit-code" },
    sourceEvidence: evidence,
    confidence: target === "test" ? "high" : "medium",
    confirmed: false
  };
}

export async function discoverMakeProject(
  root: string
): Promise<DiscoveryResult> {
  const metadata = await readMakefile(path.join(root, "Makefile"));
  if (metadata.kind === "missing") {
    return {
      kind: "no-match",
      adapter: "make",
      reason: "not-make-project",
      message: "No Makefile was found.",
      evidence: [],
      manualConfigAllowed: true
    };
  }

  const genericEvidence: DiscoveryEvidence[] = [{
    kind: "file",
    path: "Makefile",
    detail: "Found bounded Make metadata."
  }];
  if (metadata.kind === "invalid") {
    return userDecision(
      "invalid-manifest",
      metadata.message,
      genericEvidence
    );
  }
  if (metadata.source.includes("\0") || metadata.source.includes("\uFFFD")) {
    return userDecision(
      "invalid-manifest",
      "Makefile contains malformed text metadata.",
      genericEvidence
    );
  }

  const target = literalTarget(metadata.source);
  if (target === null) {
    return userDecision(
      "no-known-commands",
      "No literal test or check target was found.",
      genericEvidence
    );
  }

  const proposalEvidence = [
    fileEvidence(target, `Found literal ${target} target.`)
  ];
  return {
    kind: "proposals",
    adapter: "make",
    proposals: [makeProposal(target, proposalEvidence)],
    evidence: proposalEvidence,
    manualConfigAllowed: true
  };
}

export const makeDiscoveryAdapter: DiscoveryAdapter = {
  id: "make",
  discover: discoverMakeProject
};
