import type { HarnessInstallAdapter } from "../../../../runtime/src/install/harness.js";
import type { HookTargetSelection } from "../../../../runtime/src/install/types.js";
import {
  applyUpdatePlan,
  createUpdatePlan,
  type UpdatePlan
} from "../../../../runtime/src/install/update.js";
import type { RegistryClient } from "../../../../runtime/src/registry/npm.js";
import type { ParsedArgs } from "../args.js";
import {
  okEnvelope,
  type CliEnvelope
} from "../output.js";
import { formatOperationPlan } from "../plan-output.js";
import {
  toPublicUpdatePlan,
  type PublicUpdatePlan
} from "../public-plan.js";

export interface UpdateCommandOptions {
  readonly args: ParsedArgs;
  readonly root: string;
  readonly adapters: readonly HarnessInstallAdapter[];
  readonly registry?: RegistryClient;
  readonly targetVersion?: string;
  readonly toolkitVersion?: string;
  readonly isTTY: boolean;
  readonly hookRuntimePath?: string;
  readonly hookTargets?: readonly HookTargetSelection[];
  confirm(plan: UpdatePlan): Promise<boolean>;
}

export interface UpdateCommandData {
  readonly applied: boolean;
  readonly plan: PublicUpdatePlan;
  readonly message: string;
  readonly text?: string;
}

export function formatUpdatePlan(plan: UpdatePlan): string {
  const detectedVerification = plan.installation.detectedVerification;
  return formatOperationPlan({
    title: "Update plan",
    metadata: [
      `Target version: ${plan.targetVersion}`,
      `Harness: ${plan.installation.harness.join(", ")}`,
      `Schema migrations: ${
        plan.migrationSteps.length === 0
          ? "none"
          : plan.migrationSteps
              .map(
                ({ fromVersion, toVersion }) =>
                  `${fromVersion} -> ${toVersion}`
              )
              .join(", ")
      }`,
      ...(detectedVerification.length === 0
        ? []
        : [
            "Detected verifiers (review before confirming):",
            ...detectedVerification.map(
              (command) =>
                `  - ${command.id}: ${command.command} ${command.args.join(
                  " "
                )}`.trimEnd()
            )
          ])
    ],
    operations: toPublicUpdatePlan(plan).installation.operations
  });
}

function updateError(
  code: string,
  message: string,
  plan: UpdatePlan
): CliEnvelope<UpdateCommandData> {
  return {
    code,
    status: "error",
    data: { applied: false, plan: toPublicUpdatePlan(plan), message },
    errors: [{ code, message }]
  };
}

export async function runUpdateCommand(
  options: UpdateCommandOptions
): Promise<CliEnvelope<UpdateCommandData>> {
  const plan = await createUpdatePlan({
    root: options.root,
    adapters: options.adapters,
    ...(options.args.harness === undefined
      ? {}
      : { harness: options.args.harness }),
    ...(options.registry === undefined
      ? {}
      : { registry: options.registry }),
    ...(options.targetVersion === undefined
      ? {}
      : { targetVersion: options.targetVersion }),
    ...(options.toolkitVersion === undefined
      ? {}
      : { toolkitVersion: options.toolkitVersion }),
    ...(options.hookRuntimePath === undefined
      ? {}
      : { hookRuntimePath: options.hookRuntimePath }),
    ...((options.hookTargets ?? options.args.hookTargets) === undefined
      ? {}
      : { hookTargets: options.hookTargets ?? options.args.hookTargets })
  });
  if (options.args.dryRun) {
    return okEnvelope("UPDATE_PLAN_READY", {
      applied: false,
      plan: toPublicUpdatePlan(plan),
      message: "Update plan calculated; no files were changed.",
      text: formatUpdatePlan(plan)
    });
  }
  if (!options.args.yes && !options.isTTY) {
    return updateError(
      "UPDATE_CONFIRMATION_REQUIRED",
      "Non-interactive update requires --yes.",
      plan
    );
  }
  if (
    !options.args.yes &&
    !(await options.confirm(plan))
  ) {
    return updateError(
      "UPDATE_CANCELLED",
      "Update was cancelled; no files were changed.",
      plan
    );
  }
  await applyUpdatePlan(options.root, plan);
  return okEnvelope("UPDATE_APPLIED", {
    applied: true,
    plan: toPublicUpdatePlan(plan),
    message: `Managed installation updated to ${plan.targetVersion}.`
  });
}
