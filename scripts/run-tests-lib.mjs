import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";

const defaultFileSystem = { readdir, realpath, stat };
const defaultProcess = process;

export function isolateTestEnvironment(environment = process.env) {
  const isolated = { ...environment };
  delete isolated.XDG_CONFIG_HOME;
  delete isolated.OPENCODE_CONFIG_DIR;
  // A suite run by an `agent-ops run` worker must not hand its run identity to
  // the CLIs the tests spawn: init/update would refuse as a run worker.
  for (const name of ["AGENT_OPS_RUN_ID", "AGENT_OPS_WORKER_ID", "AGENT_OPS_WORKER_GENERATION", "AGENT_OPS_SESSION_ID", "AGENT_OPS_HOST"]) {
    delete isolated[name];
  }
  return isolated;
}

export async function collectTestFiles(inputs, fileSystem = defaultFileSystem) {
  const files = new Set();
  const visitedDirectories = new Set();

  async function visit(input) {
    if (typeof input !== "string" || input.length === 0) {
      throw new Error(`Unsupported test input: ${String(input)}`);
    }

    const canonicalInput = path.normalize(
      await fileSystem.realpath(path.resolve(input)),
    );
    const entry = await fileSystem.stat(canonicalInput);

    if (entry.isFile()) {
      if (canonicalInput.endsWith(".test.js")) {
        files.add(canonicalInput);
      }
      return;
    }

    if (!entry.isDirectory()) {
      throw new Error(`Unsupported test input: ${input}`);
    }

    if (visitedDirectories.has(canonicalInput)) {
      return;
    }
    visitedDirectories.add(canonicalInput);

    const children = await fileSystem.readdir(canonicalInput);
    for (const child of [...children].sort()) {
      await visit(path.join(canonicalInput, child));
    }
  }

  for (const input of inputs) {
    await visit(input);
  }

  const sortedFiles = [...files].sort();
  if (sortedFiles.length === 0) {
    throw new Error("No *.test.js files found");
  }

  return sortedFiles;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export async function runTestEntry(
  inputs,
  {
    fileSystem = defaultFileSystem,
    process: processLike = defaultProcess,
    spawn = spawnProcess,
    environment,
  } = {},
) {
  const files = await collectTestFiles(inputs, fileSystem);
  const spawnOptions = { shell: false, stdio: "inherit" };
  if (environment !== undefined) {
    spawnOptions.env = environment;
  }
  const child = spawn(
    processLike.execPath,
    ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
      `--test-reporter=${new URL("./test-failures-reporter.mjs", import.meta.url).href}`,
      "--test-reporter-destination=stderr", ...files],
    spawnOptions,
  );
  const { code, signal } = await waitForChild(child);

  if (signal !== null) {
    processLike.kill(processLike.pid, signal);
    return;
  }

  processLike.exitCode = code ?? 1;
}
