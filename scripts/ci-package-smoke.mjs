#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = await mkdtemp(join(tmpdir(), "agent-ops-ci-smoke-"));
const isolatedHome = join(root, "home");
const fixture = join(root, "fixture");
const consumer = join(root, "consumer");
await Promise.all([
  mkdir(isolatedHome, { recursive: true }),
  mkdir(fixture, { recursive: true }),
  mkdir(consumer, { recursive: true })
]);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_OPS_HOME: isolatedHome,
      npm_config_cache: join(root, "npm-cache")
    },
    ...options
  });
}

function probe(args, options = {}) {
  try {
    return {
      status: 0,
      output: run(process.execPath, [installed, ...args], options)
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${String(error.stdout ?? "")}\n${String(error.stderr ?? "")}`
    };
  }
}

function assertJson(result, expectedStatus, expectedCode) {
  if (result.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${result.status}: ${result.output}`);
  }
  const line = result.output.trim().split("\n").at(-1);
  if (line === undefined) {
    throw new Error(`Missing JSON output for ${expectedCode}.`);
  }
  const envelope = JSON.parse(line);
  if (envelope.code !== expectedCode) {
    throw new Error(`Expected ${expectedCode}, got ${envelope.code}.`);
  }
}

let installed;
try {
  const metadata = JSON.parse(
    run(npm, ["pack", "--json", "--pack-destination", root])
  );
  const filename = metadata[0]?.filename;
  if (typeof filename !== "string") {
    throw new Error("npm pack did not report a tarball.");
  }
  const tarball = join(root, filename);
  run(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    consumer,
    tarball
  ]);
  installed = join(
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

  const version = probe(["--version"], { cwd: consumer });
  if (version.status !== 0 || !version.output.includes("0.0.0-development")) {
    throw new Error(`Installed --version failed: ${version.output}`);
  }
  assertJson(
    probe([
      "init",
      "--dry-run",
      "--scope",
      "project",
      "--harness",
      "both",
      "--profile",
      "core",
      "--json"
    ], { cwd: fixture }),
    0,
    "INIT_PLAN_READY"
  );
  assertJson(
    probe([
      "init",
      "--scope",
      "project",
      "--harness",
      "both",
      "--profile",
      "core",
      "--yes",
      "--json"
    ], { cwd: fixture }),
    0,
    "INIT_APPLIED"
  );
  assertJson(probe(["doctor", "--json"], { cwd: fixture }), 1, "DOCTOR_UNKNOWN");
  process.stdout.write("installed package smoke passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
