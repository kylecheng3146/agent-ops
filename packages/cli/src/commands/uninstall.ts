import {
  applyUninstallPlan,
  createUninstallPlan,
  type UninstallPlan
} from "../../../../runtime/src/install/uninstall.js";
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
  toPublicUninstallPlan,
  type PublicTrustChange,
  type PublicUninstallPlan
} from "../public-plan.js";
import {
  formatTrustChange,
  planTrustRevoke
} from "./trust.js";

export interface UninstallCommandOptions {
  readonly args: ParsedArgs;
  readonly root: string;
  readonly isTTY: boolean;
  readonly trustStore?: TrustStore;
  calculateTrustBinding?(): Promise<TrustBinding | null>;
  confirm(plan: UninstallPlan, trust: PublicTrustChange): Promise<boolean>;
}

export interface UninstallCommandData {
  readonly applied: boolean;
  readonly plan: PublicUninstallPlan;
  readonly message: string;
  readonly text?: string;
}

function formatUninstallPlan(
  plan: UninstallPlan,
  trust?: PublicTrustChange
): string {
  return formatOperationPlan({
    title: "Uninstall plan",
    metadata: [
      `Installed: ${plan.installed ? "yes" : "no"}`,
      ...(trust === undefined ? [] : formatTrustChange(trust)),
      ...(plan.manifest === null
        ? []
        : [
            `Scope: ${plan.manifest.scope}`,
            `Harness: ${plan.manifest.harness}`
          ])
    ],
    operations: toPublicUninstallPlan(plan).operations
  });
}

function uninstallError(
  code: string,
  message: string,
  plan: UninstallPlan,
  trust: PublicTrustChange,
  applied = false
): CliEnvelope<UninstallCommandData> {
  return {
    code,
    status: "error",
    data: { applied, plan: toPublicUninstallPlan(plan, trust), message },
    errors: [{ code, message }]
  };
}

async function trustChange(
  options: UninstallCommandOptions,
  plan: UninstallPlan
): Promise<PublicTrustChange> {
  if (plan.manifest?.scope === "user") {
    return { action: "skipped", reason: "user-scope" };
  }
  if (
    options.calculateTrustBinding === undefined ||
    options.trustStore === undefined
  ) {
    return { action: "skipped", reason: "not-configured" };
  }
  const binding = await options.calculateTrustBinding();
  return binding === null
    ? { action: "skipped", reason: "no-verification-commands" }
    : await planTrustRevoke(binding, options.trustStore);
}

export async function runUninstallCommand(
  options: UninstallCommandOptions
): Promise<CliEnvelope<UninstallCommandData>> {
  const plan = await createUninstallPlan(options.root);
  if (!plan.installed) {
    return okEnvelope("UNINSTALL_NOT_INSTALLED", {
      applied: false,
      plan: toPublicUninstallPlan(plan),
      message: "No managed installation exists."
    });
  }
  const trust = await trustChange(options, plan);
  if (options.args.dryRun) {
    return okEnvelope("UNINSTALL_PLAN_READY", {
      applied: false,
      plan: toPublicUninstallPlan(plan, trust),
      message: "Uninstall plan calculated; no files were changed.",
      text: formatUninstallPlan(plan, trust)
    });
  }
  if (!options.args.yes && !options.isTTY) {
    return uninstallError(
      "UNINSTALL_CONFIRMATION_REQUIRED",
      "Non-interactive uninstall requires --yes.",
      plan,
      trust
    );
  }
  if (
    !options.args.yes &&
    !(await options.confirm(plan, trust))
  ) {
    return uninstallError(
      "UNINSTALL_CANCELLED",
      "Uninstall was cancelled; no files were changed.",
      plan,
      trust
    );
  }
  await applyUninstallPlan(options.root, plan);
  if (trust.action === "revoke") {
    try {
      if (
        options.trustStore === undefined ||
        !(await options.trustStore.revoke(trust.binding))
      ) {
        throw new Error("Trust record changed during uninstall.");
      }
    } catch {
      return uninstallError(
        "UNINSTALL_TRUST_FAILED",
        "Uninstall was applied, but repository trust was not revoked. Run `agent-ops trust revoke`.",
        plan,
        trust,
        true
      );
    }
  }
  return okEnvelope("UNINSTALL_APPLIED", {
    applied: true,
    plan: toPublicUninstallPlan(plan, trust),
    message: "Managed installation content was removed."
  });
}

export { formatUninstallPlan };
