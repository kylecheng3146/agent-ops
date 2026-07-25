#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "agent-ops-package-check-"));
const packJson = join(root, "pack.json");
const consumer = join(root, "consumer");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_cache: join(root, "npm-cache")
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
  const checks = [
    ["--version"],
    ["init", "--dry-run", "--scope", "project", "--harness", "both", "--profile", "core", "--json"],
    ["trust", "status", "--json"],
    ["doctor", "--json"],
    ["task", "status", "--json"],
    ["verify", "--task", "missing", "--json"],
    ["review", "--json"]
  ];
  for (const args of checks) {
    const result = probe(process.execPath, [installed, ...args], {
      cwd: consumer
    });
    if (result.output.includes("CLI_COMMAND_UNAVAILABLE")) {
      throw new Error(`Installed command was not registered: ${args.join(" ")}`);
    }
  }
  process.stdout.write("package check passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
