#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { commonHarnessAdapters } from "../../../runtime/src/install/harness.js";
import { NpmRegistryClient } from "../../../runtime/src/registry/npm.js";
import { TaskService } from "../../../runtime/src/task/service.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { runCli } from "./cli.js";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  formatInstallPlan,
  runInitCommand
} from "./commands/init.js";
import {
  formatUninstallPlan,
  runUninstallCommand
} from "./commands/uninstall.js";
import { runTaskCommand } from "./commands/task.js";
import {
  formatUpdatePlan,
  runUpdateCommand
} from "./commands/update.js";
import { errorEnvelope } from "./output.js";

const CLI_VERSION = "0.0.0-development";

async function confirmInit(
  plan: Parameters<typeof formatInstallPlan>[0]
): Promise<boolean> {
  return await confirmPlan(formatInstallPlan(plan));
}

async function confirmPlan(text: string): Promise<boolean> {
  process.stdout.write(text);
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
    version: CLI_VERSION,
    execute: async (args) => {
      const root = args.scope === "user" ? homedir() : process.cwd();
      const isTTY =
        !args.json &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true;
      if (args.command === "init") {
        return await runInitCommand({
          args,
          root,
          adapters: commonHarnessAdapters(),
          isTTY,
          toolkitVersion: CLI_VERSION,
          confirm: async (plan) => await confirmInit(plan)
        });
      }
      if (args.command === "doctor") {
        return await runDoctorCommand({ root });
      }
      if (args.command === "uninstall") {
        return await runUninstallCommand({
          args,
          root,
          isTTY,
          confirm: async (plan) =>
            await confirmPlan(formatUninstallPlan(plan))
        });
      }
      if (args.command === "update") {
        return await runUpdateCommand({
          args,
          root,
          adapters: commonHarnessAdapters(),
          registry: new NpmRegistryClient(),
          isTTY,
          confirm: async (plan) =>
            await confirmPlan(formatUpdatePlan(plan))
        });
      }
      if (args.command === "task") {
        const service = new TaskService(
          new FileTaskStore(
            join(root, ".agent-ops", "tasks", "state.json"),
            root
          )
        );
        const sessionId = process.env.AGENT_OPS_SESSION_ID;
        return await runTaskCommand({
          args,
          service,
          ...(sessionId === undefined ? {} : { sessionId })
        });
      }
      return errorEnvelope(
        "CLI_COMMAND_UNAVAILABLE",
        `Command is not implemented yet: ${args.command}`
      );
    }
  }
);
