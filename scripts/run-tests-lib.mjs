import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";

const defaultFileSystem = { mkdtemp, readdir, realpath, rm, stat };
const defaultProcess = process;

export function isolateTestEnvironment(environment = process.env) {
  const isolated = { ...environment };
  delete isolated.XDG_CONFIG_HOME;
  delete isolated.OPENCODE_CONFIG_DIR;
  // A suite run by an `agent-ops run` worker must not hand its run identity to
  // the CLIs the tests spawn: init/update would refuse as a run worker, and
  // verify would join the worker's proof process group.
  for (const name of ["AGENT_OPS_RUN_ID", "AGENT_OPS_WORKER_ID", "AGENT_OPS_WORKER_GENERATION", "AGENT_OPS_SESSION_ID", "AGENT_OPS_HOST", "AGENT_OPS_RUN_PROOF_PID"]) {
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
    environment = process.env,
    tempParent = tmpdir(),
  } = {},
) {
  const fs = { ...defaultFileSystem, ...fileSystem };
  const files = await collectTestFiles(inputs, fs);
  const runDirectory = await fs.mkdtemp(path.join(tempParent, "agent-ops-test-run-"));
  let result;
  // ponytail: a SIGKILLed runner leaves one root; sweep stale agent-ops-test-run-* roots at startup if needed.
  try {
    const child = spawn(
      processLike.execPath,
      ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
        `--test-reporter=${new URL("./test-failures-reporter.mjs", import.meta.url).href}`,
        "--test-reporter-destination=stderr", ...files],
      {
        shell: false,
        stdio: "inherit",
        env: { ...environment, TMPDIR: runDirectory, TMP: runDirectory, TEMP: runDirectory },
      },
    );
    result = await waitForChild(child);
  } finally {
    try {
      await fs.rm(runDirectory, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
  }
  const { code, signal } = result;

  if (signal !== null) {
    processLike.kill(processLike.pid, signal);
    return;
  }

  processLike.exitCode = code ?? 1;
}
