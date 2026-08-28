import type { HarnessInstallAdapter } from "../../../../runtime/src/install/harness.js";
import type { HookTargetSelection } from "../../../../runtime/src/install/types.js";
import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import {
  createInstallPlan,
  type InstallPlan
} from "../../../../runtime/src/install/plan.js";
import { applyInstallPlan } from "../../../../runtime/src/install/apply.js";
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
  toPublicInstallPlan,
  type PublicInstallPlan,
  type PublicTrustChange
} from "../public-plan.js";
import {
  formatTrustChange,
  planTrustGrant
} from "./trust.js";

export interface InitCommandOptions {
  readonly args: ParsedArgs;
  readonly root: string;
  readonly adapters: readonly HarnessInstallAdapter[];
  readonly isTTY: boolean;
  readonly toolkitVersion?: string;
  readonly hookRuntimePath?: string;
  readonly hookTargets?: readonly HookTargetSelection[];
  /** Optional runtime probe; init warns but never blocks on an agy binary. */
  agyWarning?(): string | undefined;
  readonly trustStore?: TrustStore;
  calculateTrustBinding?(config: InstallPlan["config"]): Promise<TrustBinding | null>;
  confirm(
    plan: InstallPlan,
    trust: PublicTrustChange,
    warnings?: readonly string[]
  ): Promise<boolean>;
}

export interface InitCommandData {
  readonly applied: boolean;
  readonly plan: PublicInstallPlan;
  readonly message: string;
  readonly warnings?: readonly string[];
  readonly text?: string;
}

export function formatInstallPlan(
  plan: InstallPlan,
  trust?: PublicTrustChange,
  warnings: readonly string[] = []
): string {
  const hooks = plan.manifest.hooks ?? [];
  const detectedVerification = plan.detectedVerification;
  return formatOperationPlan({
    title: "Installation plan",
    metadata: [
      `Scope: ${plan.scope}`,
      `Harness: ${plan.harness}`,
      `Profiles: ${plan.profiles.join(", ")}`,
      ...(plan.scope === "user" && plan.harness.includes("agy")
        ? ["Notice: .gemini/GEMINI.md is a shared Gemini rule surface."]
        : []),
      ...(warnings.length === 0
        ? []
        : ["Warnings:", ...warnings.map((warning) => `  - ${warning}`)]),
      ...(trust === undefined ? [] : formatTrustChange(trust)),
      ...(hooks.length === 0
        ? ["Hooks: none selected"]
        : [
            "Hooks:",
            ...hooks.map(
              (hook) =>
                `  - ${hook.harness}: ${hook.path} (${hook.events.join(
                  ", "
                )})`
            )
          ]),
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
    operations: toPublicInstallPlan(plan).operations
  });
}

function appliedMessage(plan: InstallPlan): string {
  const hooks = plan.manifest.hooks ?? [];
  if (hooks.length === 0) {
    return "Loop Engineering Toolkit installation applied.\nHooks: none selected.";
  }
  return [
    "Loop Engineering Toolkit installation applied.",
    "Hooks configured:",
    ...hooks.map(
      (hook) =>
        `- ${hook.harness}: ${hook.path} (${hook.events.join(", ")})`
    )
  ].join("\n");
}

function initError(
  code: string,
  message: string,
  plan: InstallPlan,
  trust: PublicTrustChange,
  warnings: readonly string[] = [],
  applied = false
): CliEnvelope<InitCommandData> {
  const displayMessage = warnings.length === 0
    ? message
    : `${message}\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
  return {
    code,
    status: "error",
    data: {
      applied,
      plan: toPublicInstallPlan(plan, trust),
      message: displayMessage,
      ...(warnings.length === 0 ? {} : { warnings })
    },
    errors: [{ code, message }]
  };
}

async function trustChange(
  options: InitCommandOptions,
  plan: InstallPlan
): Promise<PublicTrustChange> {
  if (plan.scope === "user") {
    return { action: "skipped", reason: "user-scope" };
  }
  if (
    options.calculateTrustBinding === undefined ||
    options.trustStore === undefined
  ) {
    return { action: "skipped", reason: "not-configured" };
  }
  const binding = await options.calculateTrustBinding(plan.config);
  return binding === null
    ? { action: "skipped", reason: "no-verification-commands" }
    : await planTrustGrant(binding, options.trustStore);
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
      : { toolkitVersion: options.toolkitVersion }),
    ...(options.hookRuntimePath === undefined
      ? {}
      : { hookRuntimePath: options.hookRuntimePath }),
    ...((options.hookTargets ?? args.hookTargets) === undefined
      ? {}
      : { hookTargets: options.hookTargets ?? args.hookTargets }),
    ...(args.reviewTargets === undefined
      ? {}
      : { reviewTargets: args.reviewTargets })
  });
  const trust = await trustChange(options, plan);
  const warnings = plan.harness.includes("agy") && options.agyWarning !== undefined
    ? (() => {
        try {
          const warning = options.agyWarning();
          return warning === undefined ? [] : [warning];
        } catch {
          return ["agy could not be probed; run `agent-ops doctor` to verify it."];
        }
      })()
    : [];
  if (args.dryRun) {
    return okEnvelope("INIT_PLAN_READY", {
      applied: false,
      plan: toPublicInstallPlan(plan, trust),
      message: "Installation plan calculated; no files were written.",
      ...(warnings.length === 0 ? {} : { warnings }),
      text: formatInstallPlan(plan, trust, warnings)
    });
  }
  if (!args.yes && !options.isTTY) {
    return initError(
      "INIT_CONFIRMATION_REQUIRED",
      "Non-interactive init requires --yes after all choices are explicit.",
      plan,
      trust,
      warnings
    );
  }
  if (
    !args.yes &&
    options.isTTY &&
    !(await options.confirm(plan, trust, warnings))
  ) {
    return initError(
      "INIT_CANCELLED",
      "Installation was cancelled; no files were written.",
      plan,
      trust,
      warnings
    );
  }

  await applyInstallPlan(options.root, plan);
  if (trust.action === "grant") {
    try {
      if (options.trustStore === undefined) {
        throw new Error("Trust store is unavailable.");
      }
      await options.trustStore.grant(trust.binding);
    } catch {
      return initError(
        "INIT_TRUST_FAILED",
        "Installation was applied, but repository trust was not granted. Run `agent-ops trust grant --yes`.",
        plan,
        trust,
        warnings,
        true
      );
    }
  }
  const message = appliedMessage(plan);
  return okEnvelope("INIT_APPLIED", {
    applied: true,
    plan: toPublicInstallPlan(plan, trust),
    message: warnings.length === 0
      ? message
      : `${message}\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`,
    ...(warnings.length === 0 ? {} : { warnings })
  });
}
