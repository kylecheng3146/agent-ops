import {
  applyUninstallPlan,
  createUninstallPlan,
  type UninstallPlan
} from "../../../../runtime/src/install/uninstall.js";
import type { ParsedArgs } from "../args.js";
import {
  okEnvelope,
  type CliEnvelope
} from "../output.js";
import { formatOperationPlan } from "../plan-output.js";
import {
  toPublicUninstallPlan,
  type PublicUninstallPlan
} from "../public-plan.js";

export interface UninstallCommandOptions {
  readonly args: ParsedArgs;
  readonly root: string;
  readonly isTTY: boolean;
  confirm(plan: UninstallPlan): Promise<boolean>;
}

export interface UninstallCommandData {
  readonly applied: boolean;
  readonly plan: PublicUninstallPlan;
  readonly message: string;
  readonly text?: string;
}

function formatUninstallPlan(plan: UninstallPlan): string {
  return formatOperationPlan({
    title: "Uninstall plan",
    metadata: [
      `Installed: ${plan.installed ? "yes" : "no"}`,
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
  plan: UninstallPlan
): CliEnvelope<UninstallCommandData> {
  return {
    code,
    status: "error",
    data: { applied: false, plan: toPublicUninstallPlan(plan), message },
    errors: [{ code, message }]
  };
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
  if (options.args.dryRun) {
    return okEnvelope("UNINSTALL_PLAN_READY", {
      applied: false,
      plan: toPublicUninstallPlan(plan),
      message: "Uninstall plan calculated; no files were changed.",
      text: formatUninstallPlan(plan)
    });
  }
  if (!options.args.yes && !options.isTTY) {
    return uninstallError(
      "UNINSTALL_CONFIRMATION_REQUIRED",
      "Non-interactive uninstall requires --yes.",
      plan
    );
  }
  if (
    !options.args.yes &&
    !(await options.confirm(plan))
  ) {
    return uninstallError(
      "UNINSTALL_CANCELLED",
      "Uninstall was cancelled; no files were changed.",
      plan
    );
  }
  await applyUninstallPlan(options.root, plan);
  return okEnvelope("UNINSTALL_APPLIED", {
    applied: true,
    plan: toPublicUninstallPlan(plan),
    message: "Managed installation content was removed."
  });
}

export { formatUninstallPlan };
