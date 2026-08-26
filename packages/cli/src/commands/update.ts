import type { HarnessInstallAdapter } from "../../../../runtime/src/install/harness.js";
import type { HookTargetSelection } from "../../../../runtime/src/install/types.js";
import {
  applyUpdatePlan,
  createUpdatePlan,
  type UpdatePlan
} from "../../../../runtime/src/install/update.js";
import type { RegistryClient } from "../../../../runtime/src/registry/npm.js";
import type { ParsedArgs } from "../args.js";
import type {
  TrustBinding,
  TrustStore
} from "../../../../runtime/src/security/trust.js";
import {
  okEnvelope,
  type CliEnvelope
} from "../output.js";
import { formatOperationPlan } from "../plan-output.js";
import {
  toPublicUpdatePlan,
  type PublicUpdatePlan,
  type PublicTrustChange
} from "../public-plan.js";
import {
  formatTrustChange,
  planTrustGrant
} from "./trust.js";

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
  readonly trustStore?: TrustStore;
  calculateTrustBinding?(config: UpdatePlan["installation"]["config"]): Promise<TrustBinding | null>;
  confirm(plan: UpdatePlan, trust: PublicTrustChange): Promise<boolean>;
}

export interface UpdateCommandData {
  readonly applied: boolean;
  readonly plan: PublicUpdatePlan;
  readonly message: string;
  readonly text?: string;
}

export function formatUpdatePlan(
  plan: UpdatePlan,
  trust?: PublicTrustChange
): string {
  const detectedVerification = plan.installation.detectedVerification;
  return formatOperationPlan({
    title: "Update plan",
    metadata: [
      `Target version: ${plan.targetVersion}`,
      `Harness: ${plan.installation.harness.join(", ")}`,
      ...(trust === undefined ? [] : formatTrustChange(trust)),
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
  plan: UpdatePlan,
  trust: PublicTrustChange,
  applied = false
): CliEnvelope<UpdateCommandData> {
  return {
    code,
    status: "error",
    data: { applied, plan: toPublicUpdatePlan(plan, trust), message },
    errors: [{ code, message }]
  };
}

async function trustChange(
  options: UpdateCommandOptions,
  plan: UpdatePlan
): Promise<PublicTrustChange> {
  if (plan.installation.scope === "user") {
    return { action: "skipped", reason: "user-scope" };
  }
  if (
    options.calculateTrustBinding === undefined ||
    options.trustStore === undefined
  ) {
    return { action: "skipped", reason: "not-configured" };
  }
  const binding = await options.calculateTrustBinding(plan.installation.config);
  return binding === null
    ? { action: "skipped", reason: "no-verification-commands" }
    : await planTrustGrant(binding, options.trustStore);
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
  const trust = await trustChange(options, plan);
  if (options.args.dryRun) {
    return okEnvelope("UPDATE_PLAN_READY", {
      applied: false,
      plan: toPublicUpdatePlan(plan, trust),
      message: "Update plan calculated; no files were changed.",
      text: formatUpdatePlan(plan, trust)
    });
  }
  if (!options.args.yes && !options.isTTY) {
    return updateError(
      "UPDATE_CONFIRMATION_REQUIRED",
      "Non-interactive update requires --yes.",
      plan,
      trust
    );
  }
  if (
    !options.args.yes &&
    !(await options.confirm(plan, trust))
  ) {
    return updateError(
      "UPDATE_CANCELLED",
      "Update was cancelled; no files were changed.",
      plan,
      trust
    );
  }
  await applyUpdatePlan(options.root, plan);
  if (trust.action === "grant") {
    try {
      if (options.trustStore === undefined) {
        throw new Error("Trust store is unavailable.");
      }
      await options.trustStore.grant(trust.binding);
    } catch {
      return updateError(
        "UPDATE_TRUST_FAILED",
        "Update was applied, but repository trust was not granted. Run `agent-ops trust grant --yes`.",
        plan,
        trust,
        true
      );
    }
  }
  return okEnvelope("UPDATE_APPLIED", {
    applied: true,
    plan: toPublicUpdatePlan(plan, trust),
    message: `Managed installation updated to ${plan.targetVersion}.`
  });
}
