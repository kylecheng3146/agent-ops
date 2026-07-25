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

const MAX_CARGO_TOML_BYTES = 1024 * 1024;

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

async function readCargoToml(filePath: string): Promise<MetadataReadResult> {
  let status;
  try {
    status = await lstat(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { kind: "missing" };
    }
    return {
      kind: "invalid",
      message: "Cargo.toml could not be inspected safely."
    };
  }

  if (status.isSymbolicLink() || !status.isFile()) {
    return {
      kind: "invalid",
      message: "Cargo.toml must be a regular file."
    };
  }
  if (status.size > MAX_CARGO_TOML_BYTES) {
    return {
      kind: "invalid",
      message: "Cargo.toml exceeds the discovery size limit."
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
        message: "Cargo.toml must remain a regular file."
      };
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_CARGO_TOML_BYTES) {
      const remaining = MAX_CARGO_TOML_BYTES + 1 - totalBytes;
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
      message: "Cargo.toml exceeds the discovery size limit."
    };
  } catch {
    return {
      kind: "invalid",
      message: "Cargo.toml could not be read as a regular file."
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasMalformedTableHeader(source: string): boolean {
  if (source.includes("\0") || source.includes("\uFFFD")) {
    return true;
  }

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("[")) {
      continue;
    }
    const tablePattern = line.startsWith("[[")
      ? /^\[\[[A-Za-z0-9_.-]+\]\](?:\s+#.*)?$/u
      : /^\[[A-Za-z0-9_.-]+\](?:\s+#.*)?$/u;
    if (!tablePattern.test(line)) {
      return true;
    }
  }
  return false;
}

function hasCargoRootEvidence(source: string): boolean {
  return source.split(/\r?\n/u).some((line) => (
    /^\s*\[(?:package|workspace)\]\s*(?:#.*)?$/u.test(line)
  ));
}

function fileEvidence(detail: string): DiscoveryEvidence {
  return { kind: "file", path: "Cargo.toml", detail };
}

function userDecision(
  reason: UserDecisionReason,
  message: string,
  evidence: DiscoveryEvidence[]
): DiscoveryResult {
  return {
    kind: "user-decision",
    adapter: "rust",
    reason,
    message,
    evidence,
    manualConfigAllowed: true
  };
}

function cargoTestProposal(evidence: DiscoveryEvidence[]): VerifierProposal {
  return {
    id: "rust:cargo-test",
    command: "cargo",
    args: ["test"],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 },
    sourceEvidence: evidence,
    confidence: "high",
    confirmed: false
  };
}

export async function discoverRustProject(
  root: string
): Promise<DiscoveryResult> {
  const metadata = await readCargoToml(path.join(root, "Cargo.toml"));
  if (metadata.kind === "missing") {
    return {
      kind: "no-match",
      adapter: "rust",
      reason: "not-rust-project",
      message: "No Cargo.toml was found.",
      evidence: [],
      manualConfigAllowed: true
    };
  }

  const evidence = [fileEvidence("Found bounded Cargo metadata.")];
  if (metadata.kind === "invalid") {
    return userDecision("invalid-manifest", metadata.message, evidence);
  }
  if (hasMalformedTableHeader(metadata.source)) {
    return userDecision(
      "invalid-manifest",
      "Cargo.toml contains malformed table metadata.",
      evidence
    );
  }
  if (!hasCargoRootEvidence(metadata.source)) {
    return userDecision(
      "no-known-commands",
      "No explicit Cargo package or workspace was found.",
      evidence
    );
  }

  const proposalEvidence = [
    fileEvidence("Found explicit Cargo package or workspace evidence.")
  ];
  return {
    kind: "proposals",
    adapter: "rust",
    proposals: [cargoTestProposal(proposalEvidence)],
    evidence: proposalEvidence,
    manualConfigAllowed: true
  };
}

export const rustDiscoveryAdapter: DiscoveryAdapter = {
  id: "rust",
  discover: discoverRustProject
};
