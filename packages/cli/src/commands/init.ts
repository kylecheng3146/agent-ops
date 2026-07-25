import type { HarnessInstallAdapter } from "../../../../runtime/src/install/harness.js";
import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import {
  createInstallPlan,
  type InstallPlan
} from "../../../../runtime/src/install/plan.js";
import { applyInstallPlan } from "../../../../runtime/src/install/apply.js";
import type { ParsedArgs } from "../args.js";
import {
  okEnvelope,
  type CliEnvelope
} from "../output.js";
import { formatOperationPlan } from "../plan-output.js";

export interface InitCommandOptions {
  readonly args: ParsedArgs;
  readonly root: string;
  readonly adapters: readonly HarnessInstallAdapter[];
  readonly isTTY: boolean;
  readonly toolkitVersion?: string;
  confirm(plan: InstallPlan): Promise<boolean>;
}

export interface InitCommandData {
  readonly applied: boolean;
  readonly plan: InstallPlan;
  readonly message: string;
  readonly text?: string;
}

export function formatInstallPlan(plan: InstallPlan): string {
  return formatOperationPlan({
    title: "Installation plan",
    metadata: [
      `Scope: ${plan.scope}`,
      `Harness: ${plan.harness}`,
      `Profiles: ${plan.profiles.join(", ")}`
    ],
    operations: plan.operations
  });
}

function initError(
  code: string,
  message: string,
  plan: InstallPlan
): CliEnvelope<InitCommandData> {
  return {
    code,
    status: "error",
    data: { applied: false, plan, message },
    errors: [{ code, message }]
  };
}

export async function runInitCommand(
  options: InitCommandOptions
): Promise<CliEnvelope<InitCommandData>> {
  const { args } = options;
  if (
    args.command !== "init" ||
    args.scope === undefined ||
    args.harness === undefined ||
    args.profiles.length === 0
  ) {
    throw new AgentOpsError(
      "INIT_CHOICES_REQUIRED",
      "Init requires complete scope, harness, and profile choices."
    );
  }

  const plan = await createInstallPlan({
    root: options.root,
    scope: args.scope,
    harness: args.harness,
    profiles: args.profiles,
    adapters: options.adapters,
    ...(options.toolkitVersion === undefined
      ? {}
      : { toolkitVersion: options.toolkitVersion })
  });
  if (args.dryRun) {
    return okEnvelope("INIT_PLAN_READY", {
      applied: false,
      plan,
      message: "Installation plan calculated; no files were written.",
      text: formatInstallPlan(plan)
    });
  }
  if (!args.yes && !options.isTTY) {
    return initError(
      "INIT_CONFIRMATION_REQUIRED",
      "Non-interactive init requires --yes after all choices are explicit.",
      plan
    );
  }
  if (
    !args.yes &&
    options.isTTY &&
    !(await options.confirm(plan))
  ) {
    return initError(
      "INIT_CANCELLED",
      "Installation was cancelled; no files were written.",
      plan
    );
  }

  await applyInstallPlan(options.root, plan);
  return okEnvelope("INIT_APPLIED", {
    applied: true,
    plan,
    message: "Loop Engineering Toolkit installation applied."
  });
}
