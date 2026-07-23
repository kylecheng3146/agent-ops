#!/usr/bin/env node

import { runCli } from "./cli.js";

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    input: process.stdin,
    output: process.stdout,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value)
  },
  {
    version: "0.0.0-development"
  }
);
