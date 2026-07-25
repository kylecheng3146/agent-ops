import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import {
  readPrivateFile,
  withPrivateFileLock,
  writePrivateFile
} from "./permissions.js";

export interface TrustBinding {
  canonicalPath: string;
  remoteIdentity: string;
  configHash: string;
  runtimeHash: string;
}

export type TrustBindingField = keyof TrustBinding;
export type TrustStatus = "STALE" | "TRUSTED" | "UNTRUSTED";

export interface TrustStatusResult {
  status: TrustStatus;
  mismatchedFields: TrustBindingField[];
}

export interface TrustStore {
  status(binding: TrustBinding): Promise<TrustStatusResult>;
  grant(binding: TrustBinding, grantedAt?: string): Promise<void>;
  revoke(binding: TrustBinding): Promise<boolean>;
}

export interface TrustBindingInput {
  repositoryPath: string;
  remoteUrl: string;
  configHash: string;
  runtimeHash: string;
}

interface TrustRecord {
  binding: TrustBinding;
  grantedAt: string;
}

interface TrustStoreFile {
  schemaVersion: 1;
  records: TrustRecord[];
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_FIELDS: TrustBindingField[] = [
  "canonicalPath",
  "remoteIdentity",
  "configHash",
  "runtimeHash"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function normalizedRepositoryPath(
  path: string,
  caseInsensitive: boolean
): string {
  const normalized = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isCaseInsensitiveHost(host: string): boolean {
  return host === "github.com";
}

export function normalizeRemoteIdentity(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (value.length === 0 || value.includes("\0")) {
    throw new AgentOpsError(
      "TRUST_REMOTE_INVALID",
      "Git remote identity must be a non-empty value."
    );
  }

  const scpLike = /^(?:[^@\s/:]+@)?([^:\s/]+):(.+)$/.exec(value);
  if (
    !value.includes("://") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    scpLike !== null
  ) {
    const host = scpLike[1];
    const repository = scpLike[2];
    if (host !== undefined && repository !== undefined) {
      const normalizedHost = host.toLowerCase();
      return `${normalizedHost}/${normalizedRepositoryPath(
        repository,
        isCaseInsensitiveHost(normalizedHost)
      )}`;
    }
  }

  try {
    const url = new URL(value);
    if (url.hostname.length > 0) {
      const normalizedHost = url.hostname.toLowerCase();
      const repository = normalizedRepositoryPath(
        url.pathname,
        isCaseInsensitiveHost(normalizedHost)
      );
      if (repository.length === 0) {
        throw new AgentOpsError(
          "TRUST_REMOTE_INVALID",
          "Git remote must include a repository path."
        );
      }
      const port = url.port.length === 0 ? "" : `:${url.port}`;
      return `${normalizedHost}${port}/${repository}`;
    }
  } catch (error) {
    if (error instanceof AgentOpsError) {
      throw error;
    }
  }

  const local = value.replace(/\\/g, "/").replace(/\.git$/i, "");
  if (local.length === 0) {
    throw new AgentOpsError(
      "TRUST_REMOTE_INVALID",
      "Git remote identity could not be normalized."
    );
  }
  return `local:${process.platform === "win32" ? local.toLowerCase() : local}`;
}

function assertBinding(binding: TrustBinding): void {
  if (
    !isAbsolute(binding.canonicalPath) ||
    binding.canonicalPath.includes("\0") ||
    binding.remoteIdentity.trim().length === 0 ||
    binding.remoteIdentity.includes("\0") ||
    !HASH_PATTERN.test(binding.configHash) ||
    !HASH_PATTERN.test(binding.runtimeHash)
  ) {
    throw new AgentOpsError(
      "TRUST_BINDING_INVALID",
      "Trust binding fields are invalid."
    );
  }
}

export async function calculateTrustBinding(
  input: TrustBindingInput
): Promise<TrustBinding> {
  const canonicalPath = await realpath(resolve(input.repositoryPath));
  const status = await lstat(canonicalPath);
  if (!status.isDirectory()) {
    throw new AgentOpsError(
      "TRUST_REPOSITORY_INVALID",
      "Trust can be granted only to a repository directory."
    );
  }
  const binding: TrustBinding = {
    canonicalPath,
    remoteIdentity: normalizeRemoteIdentity(input.remoteUrl),
    configHash: input.configHash,
    runtimeHash: input.runtimeHash
  };
  assertBinding(binding);
  return binding;
}

function sameBinding(left: TrustBinding, right: TrustBinding): boolean {
  return BINDING_FIELDS.every((field) => left[field] === right[field]);
}

function parseBinding(value: unknown): TrustBinding {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, BINDING_FIELDS) ||
    typeof value.canonicalPath !== "string" ||
    typeof value.remoteIdentity !== "string" ||
    typeof value.configHash !== "string" ||
    typeof value.runtimeHash !== "string"
  ) {
    throw new AgentOpsError(
      "TRUST_STORE_INVALID",
      "Trust store contains an invalid binding."
    );
  }
  const binding: TrustBinding = {
    canonicalPath: value.canonicalPath,
    remoteIdentity: value.remoteIdentity,
    configHash: value.configHash,
    runtimeHash: value.runtimeHash
  };
  assertBinding(binding);
  return binding;
}

function parseTrustStore(source: string | null): TrustStoreFile {
  if (source === null) {
    return { schemaVersion: 1, records: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new AgentOpsError(
      "TRUST_STORE_INVALID",
      "Trust store is not valid JSON.",
      { cause: error }
    );
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["records", "schemaVersion"]) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.records)
  ) {
    throw new AgentOpsError(
      "TRUST_STORE_INVALID",
      "Trust store has an unsupported structure."
    );
  }
  const records: TrustRecord[] = parsed.records.map((value) => {
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["binding", "grantedAt"]) ||
      typeof value.grantedAt !== "string" ||
      !Number.isFinite(Date.parse(value.grantedAt))
    ) {
      throw new AgentOpsError(
        "TRUST_STORE_INVALID",
        "Trust store contains an invalid record."
      );
    }
    return {
      binding: parseBinding(value.binding),
      grantedAt: value.grantedAt
    };
  });
  return { schemaVersion: 1, records };
}

function mismatchFields(
  stored: TrustBinding,
  current: TrustBinding
): TrustBindingField[] {
  return BINDING_FIELDS.filter((field) => stored[field] !== current[field]);
}

function matchScore(left: TrustBinding, right: TrustBinding): number {
  return BINDING_FIELDS.reduce(
    (score, field) => score + (left[field] === right[field] ? 1 : 0),
    0
  );
}

export class FileTrustStore implements TrustStore {
  readonly #anchorDirectory: string;
  readonly #path: string;

  constructor(path: string, anchorDirectory: string) {
    this.#path = path;
    this.#anchorDirectory = anchorDirectory;
  }

  async #read(): Promise<TrustStoreFile> {
    return parseTrustStore(
      await readPrivateFile(this.#path, this.#anchorDirectory)
    );
  }

  async #write(store: TrustStoreFile): Promise<void> {
    await writePrivateFile(
      this.#path,
      `${JSON.stringify(store, null, 2)}\n`,
      this.#anchorDirectory
    );
  }

  async status(binding: TrustBinding): Promise<TrustStatusResult> {
    assertBinding(binding);
    const store = await this.#read();
    const exact = store.records.find((record) =>
      sameBinding(record.binding, binding)
    );
    if (exact !== undefined) {
      return { status: "TRUSTED", mismatchedFields: [] };
    }
    const related = store.records
      .filter(
        (record) =>
          record.binding.canonicalPath === binding.canonicalPath ||
          record.binding.remoteIdentity === binding.remoteIdentity
      )
      .sort(
        (left, right) =>
          matchScore(right.binding, binding) -
          matchScore(left.binding, binding)
      )[0];
    if (related === undefined) {
      return { status: "UNTRUSTED", mismatchedFields: [] };
    }
    return {
      status: "STALE",
      mismatchedFields: mismatchFields(related.binding, binding)
    };
  }

  async grant(
    binding: TrustBinding,
    grantedAt = new Date().toISOString()
  ): Promise<void> {
    assertBinding(binding);
    if (!Number.isFinite(Date.parse(grantedAt))) {
      throw new AgentOpsError(
        "TRUST_TIMESTAMP_INVALID",
        "Trust grant timestamp must be an ISO-compatible timestamp."
      );
    }
    await withPrivateFileLock(
      this.#path,
      this.#anchorDirectory,
      async () => {
        const store = await this.#read();
        const records = store.records.filter(
          (record) =>
            record.binding.canonicalPath !== binding.canonicalPath &&
            record.binding.remoteIdentity !== binding.remoteIdentity
        );
        records.push({ binding: structuredClone(binding), grantedAt });
        await this.#write({ schemaVersion: 1, records });
      }
    );
  }

  async revoke(binding: TrustBinding): Promise<boolean> {
    assertBinding(binding);
    return await withPrivateFileLock(
      this.#path,
      this.#anchorDirectory,
      async () => {
        const store = await this.#read();
        const records = store.records.filter(
          (record) => !sameBinding(record.binding, binding)
        );
        if (records.length === store.records.length) {
          return false;
        }
        await this.#write({ schemaVersion: 1, records });
        return true;
      }
    );
  }
}
