#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "agent-ops-package-check-"));
const packJson = join(root, "pack.json");
const consumer = join(root, "consumer");
const isolatedHome = join(root, "home");
await mkdir(isolatedHome, { recursive: true });

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_cache: join(root, "npm-cache"),
      AGENT_OPS_HOME: isolatedHome
    },
    ...options
  });
}

function probe(command, args, options = {}) {
  try {
    return { status: 0, output: run(command, args, options) };
  } catch (error) {
    const failure = error;
    return {
      status: failure.status ?? 1,
      output: `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`
    };
  }
}

try {
  const metadata = run("npm", ["pack", "--json", "--pack-destination", root]);
  await writeFile(packJson, metadata, "utf8");
  const scan = JSON.parse(
    run(process.execPath, ["scripts/scan-release.mjs", packJson])
  );
  if (scan.unexpected.length > 0 || scan.forbidden.length > 0) {
    throw new Error("Packed artifact contains unexpected or forbidden paths.");
  }
  const tarball = scan.files.length > 0
    ? JSON.parse(metadata)[0]?.filename
    : undefined;
  if (typeof tarball !== "string") {
    throw new Error("npm pack did not report a tarball filename.");
  }
  const packedManifest = JSON.parse(
    run("tar", ["-xOf", join(root, tarball), "package/package.json"])
  );
  if (
    Object.keys(packedManifest.dependencies ?? {}).length > 0 ||
    Object.keys(packedManifest.optionalDependencies ?? {}).length > 0
  ) {
    throw new Error("Packed CLI must not require runtime dependencies.");
  }
  for (const name of scan.files.filter((value) => /\.(?:js|json|md)$/u.test(value))) {
    const content = run("tar", ["-xOf", join(root, tarball), name]);
    if (
      /(?:\/private\/tmp|frontend-wixgo|agent-ops-build|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/u.test(
        content
      )
    ) {
      throw new Error(`Packed content contains an internal path or credential pattern: ${name}`);
    }
  }
  await run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    consumer,
    join(root, tarball)
  ]);
  const installed = join(
    consumer,
    "node_modules",
    "@kylecheng3146",
    "agent-ops",
    "dist",
    "packages",
    "cli",
    "src",
    "bin.js"
  );
  const init = probe(process.execPath, [
    installed,
    "init",
    "--scope",
    "project",
    "--harness",
    "both",
    "--profile",
    "core",
    "--yes",
    "--json"
  ], { cwd: consumer });
  assertEnvelope(init, 0, "INIT_APPLIED");
  const checks = [
    { args: ["--version"], status: 0 },
    {
      args: ["init", "--dry-run", "--scope", "project", "--harness", "both", "--profile", "core", "--json"],
      status: 0,
      code: "INIT_PLAN_READY"
    },
    { args: ["trust", "status", "--json"], status: 0, code: "TRUST_STATUS" },
    { args: ["doctor", "--json"], status: 1, code: "DOCTOR_UNKNOWN" },
    { args: ["task", "status", "--json"], status: 0, code: "TASK_LISTED" },
    { args: ["verify", "--task", "missing", "--json"], status: 1, code: "TASK_NOT_FOUND" },
    { args: ["review", "--json"], status: 1, code: "REVIEW_NOT_RUN" }
  ];
  for (const check of checks) {
    const result = probe(process.execPath, [installed, ...check.args], {
      cwd: consumer
    });
    if (result.status !== check.status) {
      throw new Error(
        `Installed command exit mismatch for ${check.args.join(" ")}: expected ${check.status}, got ${result.status}: ${result.output}`
      );
    }
    if (check.code !== undefined) {
      assertEnvelope(result, check.status, check.code);
    }
  }
  process.stdout.write("package check passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

function assertEnvelope(result, status, code) {
  const lines = result.output.trim().split("\n");
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error(`Command did not return an output envelope for ${code}.`);
  }
  let envelope;
  try {
    envelope = JSON.parse(last);
  } catch {
    throw new Error(`Command did not return JSON for ${code}.`);
  }
  if (result.status !== status || envelope.code !== code) {
    throw new Error(
      `Expected ${code}/${status}, got ${String(envelope.code)}/${result.status}.`
    );
  }
}
