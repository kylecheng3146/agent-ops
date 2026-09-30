import { connect, createServer } from "node:net";

import type { ReviewTargetId } from "../contracts.js";

/**
 * What the host this process runs inside reports or proves it may not let a
 * reviewer do.
 *
 * A reviewer CLI is spawned as a child, so it inherits whatever sandbox the
 * host applied to agent-ops itself. That makes agent-ops a faithful probe: a
 * bind it cannot perform is a bind the reviewer cannot perform either.
 */
export type HostRestriction = "none" | "bind-blocked" | "network-blocked";

export interface HostRestrictionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Resolves true when a loopback listener could be opened. */
  readonly probeBind?: () => Promise<boolean>;
}

/** Targets that need a loopback listener of their own to answer at all. */
export const BIND_DEPENDENT_TARGETS: readonly string[] = ["agy"];

const BIND_PROBE_TIMEOUT_MS = 2_000;

/**
 * A reviewer that cannot reach its API host says so in its own words. Reading
 * that as "not logged in" sent users to re-login an authenticated CLI when the
 * host sandbox was what withheld the network.
 */
const NETWORK_FAILURE =
  /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|getaddrinfo|fetch failed|network is unreachable|could not resolve host|no such host|dial tcp/iu;

export function isNetworkFailure(output: string): boolean {
  return NETWORK_FAILURE.test(output);
}

/**
 * Only output that says so is a login problem. A CLI that dies for any other
 * reason (a sandbox denying its state directory, a crash) used to be reported
 * as "not logged in" too, which sent users to re-login a working install.
 */
const LOGIN_FAILURE =
  /\b(?:not logged in|login required|log in to|authentication required|unauthenticated|unauthorized)\b|\b(?:invalid|expired)\s+(?:api key|token|credential)|\b401\b/iu;

export function isLoginFailure(output: string): boolean {
  return LOGIN_FAILURE.test(output);
}

/** The host each reviewer talks to, so a reachability check tests its real path. */
export const TARGET_API_HOST: Readonly<Record<ReviewTargetId, string>> = {
  agy: "cloudcode-pa.googleapis.com",
  codex: "api.openai.com",
  claude: "api.anthropic.com"
};

export const REACH_TIMEOUT_MS = 2_000;

/**
 * DNS plus a TCP connect to `host:443`, nothing sent. Diagnostic only: it
 * refines a failed probe's reason and never gates a review, so a proxy-only
 * network that fails it still gets the review attempted.
 */
export async function probeHostReachable(
  host: string,
  port = 443
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), REACH_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Opens and immediately closes a loopback listener on an ephemeral port.
 * Cheap enough to run before every review, and it exercises exactly the
 * capability a sandboxed host withholds.
 */
export async function probeLoopbackBind(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close(() => resolve(value));
    };
    const timer = setTimeout(() => finish(false), BIND_PROBE_TIMEOUT_MS);
    timer.unref();
    server.once("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
    server.listen(0, "127.0.0.1", () => finish(true));
  });
}

/**
 * The host's restriction, read from what the host publishes about itself and
 * then, when that says nothing, from what this process can actually do. Codex
 * declares both facts in the environment; nothing else does, so the probe is
 * what covers every other host.
 */
export async function detectHostRestriction(
  options: HostRestrictionOptions = {}
): Promise<HostRestriction> {
  const env = options.env ?? process.env;
  // Keep the host declaration distinct from the narrower loopback probe. The
  // executor treats this signal as advisory because a target may use a
  // transport that differs from this process.
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
    return "network-blocked";
  }
  const probe = options.probeBind ?? probeLoopbackBind;
  return (await probe()) ? "none" : "bind-blocked";
}
