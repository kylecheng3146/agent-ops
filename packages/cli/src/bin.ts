#!/usr/bin/env node

import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

import { commonHarnessAdapters } from "../../../runtime/src/install/harness.js";
import { runCli } from "./cli.js";
import { runInitCommand } from "./commands/init.js";
import { errorEnvelope } from "./output.js";

async function confirmInit(
  operations: readonly { kind: string; path: string }[]
): Promise<boolean> {
  process.stdout.write(
    operations.map(({ kind, path }) => `  ${kind} ${path}`).join("\n") +
      "\n"
  );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await prompt.question(
      "Apply this installation plan? [y/N]: "
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

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
    version: "0.0.0-development",
    execute: async (args) => {
      if (args.command !== "init") {
        return errorEnvelope(
          "CLI_COMMAND_UNAVAILABLE",
          `Command is not implemented yet: ${args.command}`
        );
      }
      return await runInitCommand({
        args,
        root: args.scope === "user" ? homedir() : process.cwd(),
        adapters: commonHarnessAdapters(),
        isTTY:
          !args.json &&
          process.stdin.isTTY === true &&
          process.stdout.isTTY === true,
        confirm: async (plan) => await confirmInit(plan.operations)
      });
    }
  }
);
