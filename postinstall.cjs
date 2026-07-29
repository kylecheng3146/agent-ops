"use strict";

const { closeSync, existsSync, openSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { isatty } = require("node:tty");

const PACKAGE_NAME = "@kylecheng3146/agent-ops";
const packageRoot = __dirname;
const installRoot = resolve(process.env.INIT_CWD ?? process.cwd());

function isDirectDependency() {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(installRoot, "package.json"), "utf8")
    );
    return [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.optionalDependencies,
      packageJson.peerDependencies
    ].some(
      (dependencies) =>
        dependencies !== null &&
        typeof dependencies === "object" &&
        dependencies[PACKAGE_NAME] !== undefined
    );
  } catch {
    return false;
  }
}

function openTerminal() {
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    return { stdio: "inherit", close() {} };
  }

  const inputPath = process.platform === "win32" ? "CONIN$" : "/dev/tty";
  const outputPath = process.platform === "win32" ? "CONOUT$" : "/dev/tty";
  let inputFd;
  let outputFd;
  try {
    inputFd = openSync(inputPath, "r");
    outputFd = process.platform === "win32" ? openSync(outputPath, "a") : inputFd;
    if (!isatty(inputFd) || !isatty(outputFd)) {
      throw new Error("Interactive terminal is unavailable.");
    }
    return {
      stdio: [inputFd, outputFd, outputFd],
      close() {
        if (outputFd !== inputFd) {
          closeSync(outputFd);
        }
        closeSync(inputFd);
      }
    };
  } catch {
    if (outputFd !== undefined && outputFd !== inputFd) {
      closeSync(outputFd);
    }
    if (inputFd !== undefined) {
      closeSync(inputFd);
    }
    return null;
  }
}

if (
  installRoot === resolve(packageRoot) ||
  process.env.CI !== undefined ||
  !isDirectDependency()
) {
  process.exit(0);
}

const terminal = openTerminal();
if (terminal === null) {
  process.exit(0);
}

const cliPath = join(packageRoot, "dist", "packages", "cli", "src", "bin.js");
if (!existsSync(cliPath)) {
  process.stderr.write(
    "agent-ops init was skipped because the installed CLI is unavailable.\n"
  );
  terminal.close();
  process.exit(0);
}

const result = spawnSync(process.execPath, [cliPath], {
  cwd: installRoot,
  env: process.env,
  stdio: terminal.stdio
});
terminal.close();

if (result.error !== undefined || result.status !== 0) {
  process.stderr.write(
    "agent-ops init was not applied; package installation completed. " +
      "Run `agent-ops` to retry.\n"
  );
}
