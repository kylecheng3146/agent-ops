import { redactSecrets } from "../../../runtime/src/security/redact.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import type {
  FileOperation,
  OperationDisclosure
} from "../../../runtime/src/fs/transaction.js";
import type { InstallManifest } from "../../../runtime/src/contracts.js";
import type { InstallPlan } from "../../../runtime/src/install/plan.js";
import type { UpdatePlan } from "../../../runtime/src/install/update.js";
import type { UninstallPlan } from "../../../runtime/src/install/uninstall.js";

export interface PublicFullWrite {
  readonly kind: "write";
  readonly path: string;
  readonly expectedHash: string | null;
  readonly content: string;
}

export interface PublicOpaqueWrite {
  readonly kind: "write";
  readonly path: string;
  readonly expectedHash: string | null;
  readonly contentHash: string;
  readonly summary: string;
}

export interface PublicRemoveOperation {
  readonly kind: "remove";
  readonly path: string;
  readonly expectedHash: string | null;
}

export type PublicFileOperation =
  | PublicFullWrite
  | PublicOpaqueWrite
  | PublicRemoveOperation;

export interface PublicInstallPlan {
  readonly scope: InstallPlan["scope"];
  readonly harness: InstallPlan["harness"];
  readonly profiles: InstallPlan["profiles"];
  readonly capabilities: InstallPlan["capabilities"];
  readonly manifest: InstallManifest;
  readonly operations: readonly PublicFileOperation[];
}

export interface PublicUpdatePlan {
  readonly targetVersion: UpdatePlan["targetVersion"];
  readonly migrationSteps: UpdatePlan["migrationSteps"];
  readonly installation: PublicInstallPlan;
}

export interface PublicUninstallPlan {
  readonly installed: UninstallPlan["installed"];
  readonly manifest: UninstallPlan["manifest"];
  readonly manifestHash: UninstallPlan["manifestHash"];
  readonly operations: readonly PublicFileOperation[];
}

const OPAQUE_SUMMARY = "Opaque managed settings content withheld.";

function publicPath(path: string): string {
  return redactSecrets(path);
}

export function disclosureOf(
  operation: Pick<FileOperation, "disclosure">
): OperationDisclosure {
  return operation.disclosure ?? "full";
}

export function toPublicOperation(
  operation: FileOperation
): PublicFileOperation {
  const path = publicPath(operation.path);
  if (operation.kind === "remove") {
    return {
      kind: "remove",
      path,
      expectedHash: operation.expectedHash
    };
  }
  if (disclosureOf(operation) === "opaque") {
    return {
      kind: "write",
      path,
      expectedHash: operation.expectedHash,
      contentHash: sha256(operation.content),
      summary: redactSecrets(OPAQUE_SUMMARY)
    };
  }
  return {
    kind: "write",
    path,
    expectedHash: operation.expectedHash,
    content: operation.content
  };
}

export function toPublicOperations(
  operations: readonly FileOperation[]
): readonly PublicFileOperation[] {
  return operations.map(toPublicOperation);
}

export function toPublicInstallPlan(plan: InstallPlan): PublicInstallPlan {
  return {
    scope: plan.scope,
    harness: plan.harness,
    profiles: plan.profiles,
    capabilities: plan.capabilities,
    manifest: plan.manifest,
    operations: toPublicOperations(plan.operations)
  };
}

export function toPublicUpdatePlan(plan: UpdatePlan): PublicUpdatePlan {
  return {
    targetVersion: plan.targetVersion,
    migrationSteps: plan.migrationSteps,
    installation: toPublicInstallPlan(plan.installation)
  };
}

export function toPublicUninstallPlan(
  plan: UninstallPlan
): PublicUninstallPlan {
  return {
    installed: plan.installed,
    manifest: plan.manifest,
    manifestHash: plan.manifestHash,
    operations: toPublicOperations(plan.operations)
  };
}
