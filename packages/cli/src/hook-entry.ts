#!/usr/bin/env node

// Entry point registered in Claude settings as:
//   node <this file> <harness> <event> --managed-by=agent-ops
import { CLI_VERSION } from "./version.js";
import { runHookProcess } from "./hook-process.js";

process.exitCode = await runHookProcess(
  process.argv.slice(2),
  {
    stdin: process.stdin,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value)
  },
  CLI_VERSION
);
