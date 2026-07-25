import { AgentOpsError } from "../fs/paths.js";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const SEMVER_LIKE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface RegistryClient {
  latestVersion(packageName: string): Promise<string>;
}

export type RegistryFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;

export interface NpmRegistryClientOptions {
  readonly fetch?: RegistryFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

function defaultFetch(
  url: string,
  init: RequestInit
): Promise<Response> {
  return globalThis.fetch(url, init);
}

function positiveBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgentOpsError(
      "REGISTRY_OPTIONS_INVALID",
      `${name} must be a positive safe integer.`
    );
  }
  return value;
}

function responseTooLarge(): AgentOpsError {
  return new AgentOpsError(
    "REGISTRY_RESPONSE_TOO_LARGE",
    "The npm registry response exceeded the allowed size."
  );
}

async function readBoundedResponse(
  response: Response,
  maxResponseBytes: number,
  controller: AbortController
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > BigInt(maxResponseBytes)
  ) {
    controller.abort();
    throw responseTooLarge();
  }

  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) {
        controller.abort();
        throw responseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseLatestVersion(bytes: Uint8Array): string {
  let parsed: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new AgentOpsError(
      "REGISTRY_RESPONSE_INVALID",
      "The npm registry response is not valid JSON."
    );
  }

  if (!isRecord(parsed)) {
    throw new AgentOpsError(
      "REGISTRY_RESPONSE_INVALID",
      "The npm registry response must be a JSON object."
    );
  }
  const distTags = parsed["dist-tags"];
  const latest = isRecord(distTags) ? distTags.latest : undefined;
  if (typeof latest !== "string" || !SEMVER_LIKE.test(latest)) {
    throw new AgentOpsError(
      "REGISTRY_RESPONSE_INVALID",
      "The npm registry response has no valid latest version."
    );
  }
  return latest;
}

export class NpmRegistryClient implements RegistryClient {
  readonly #fetch: RegistryFetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: NpmRegistryClientOptions = {}) {
    this.#fetch = options.fetch ?? defaultFetch;
    this.#timeoutMs = positiveBound(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs"
    );
    this.#maxResponseBytes = positiveBound(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes"
    );
  }

  async #request(
    packageName: string,
    controller: AbortController
  ): Promise<string> {
    const url = `${NPM_REGISTRY_URL}${encodeURIComponent(packageName)}`;
    const response = await this.#fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (response.status !== 200) {
      throw new AgentOpsError(
        "REGISTRY_HTTP_STATUS",
        `The npm registry returned HTTP ${response.status}.`
      );
    }
    return parseLatestVersion(
      await readBoundedResponse(
        response,
        this.#maxResponseBytes,
        controller
      )
    );
  }

  async latestVersion(packageName: string): Promise<string> {
    if (packageName.length === 0) {
      throw new AgentOpsError(
        "REGISTRY_PACKAGE_INVALID",
        "The npm package name must not be empty."
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(
          new AgentOpsError(
            "REGISTRY_TIMEOUT",
            "The npm registry request timed out."
          )
        );
        controller.abort();
      }, this.#timeoutMs);
    });

    try {
      return await Promise.race([
        this.#request(packageName, controller),
        timeoutFailure
      ]);
    } catch (error) {
      if (timedOut) {
        throw new AgentOpsError(
          "REGISTRY_TIMEOUT",
          "The npm registry request timed out."
        );
      }
      if (error instanceof AgentOpsError) {
        throw error;
      }
      throw new AgentOpsError(
        "REGISTRY_REQUEST_FAILED",
        "The npm registry request failed."
      );
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
