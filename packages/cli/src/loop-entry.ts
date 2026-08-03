#!/usr/bin/env node

// Entry point used only by the generated project-local loop launchers.
import { runLoopProcess } from "./codex-loop-process.js";

process.exitCode = await runLoopProcess(process.argv.slice(2), {
  stdin: process.stdin,
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value)
});
