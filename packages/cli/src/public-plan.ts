import { join } from "node:path";

import { redactSecrets } from "../../../runtime/src/security/redact.js";
import type { PreauthChange } from "../../../runtime/src/install/preauth.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import type {
  FileOperation,
  OperationDisclosure
} from "../../../runtime/src/fs/transaction.js";
import type {
  InstallManifest,
  VerificationCommand
} from "../../../runtime/src/contracts.js";
import type {
  TrustBinding,
  TrustStatus
} from "../../../runtime/src/security/trust.js";
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

export type PublicTrustChange =
  | {
      readonly action: "grant" | "revoke" | "unchanged";
      readonly binding: TrustBinding;
      readonly status: TrustStatus;
    }
  | {
      readonly action: "skipped";
      readonly reason: "no-verification-commands" | "user-scope" | "not-configured";
    };

export interface PublicInstallPlan {
  readonly scope: InstallPlan["scope"];
  readonly harness: InstallPlan["harness"];
  readonly profiles: InstallPlan["profiles"];
  readonly capabilities: InstallPlan["capabilities"];
  readonly manifest: InstallManifest;
  readonly operations: readonly PublicFileOperation[];
  readonly repaired: InstallPlan["repaired"];
  readonly detectedVerification: readonly VerificationCommand[];
  readonly trust?: PublicTrustChange;
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
  readonly trust?: PublicTrustChange;
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

/**
 * Pre-authorization changes join the ordinary operations, so every preview and
 * confirmation shows them. A file in Codex's home is shown by absolute path;
 * a file agent-ops does not wholly own is described, never printed.
 */
export function toPublicPreauthorization(
  changes: readonly PreauthChange[] | undefined
): readonly PublicFileOperation[] {
  return (changes ?? []).map((change): PublicFileOperation => {
    const path = publicPath(join(change.root, change.operation.path));
    const operation = change.operation;
    if (operation.kind === "remove") {
      return { kind: "remove", path, expectedHash: operation.expectedHash };
    }
    return change.ownedContent
      ? { kind: "write", path, expectedHash: operation.expectedHash, content: operation.content }
      : {
          kind: "write",
          path,
          expectedHash: operation.expectedHash,
          contentHash: sha256(operation.content),
          summary: redactSecrets(change.summary)
        };
  });
}

export function toPublicInstallPlan(
  plan: InstallPlan,
  trust?: PublicTrustChange
): PublicInstallPlan {
  return {
    scope: plan.scope,
    harness: plan.harness,
    profiles: plan.profiles,
    capabilities: plan.capabilities,
    manifest: plan.manifest,
    operations: [
      ...toPublicOperations(plan.operations),
      ...toPublicPreauthorization(plan.preauthorization)
    ],
    repaired: plan.repaired,
    detectedVerification: plan.detectedVerification,
    ...(trust === undefined ? {} : { trust })
  };
}

export function toPublicUpdatePlan(
  plan: UpdatePlan,
  trust?: PublicTrustChange
): PublicUpdatePlan {
  return {
    targetVersion: plan.targetVersion,
    migrationSteps: plan.migrationSteps,
    installation: toPublicInstallPlan(plan.installation, trust)
  };
}

export function toPublicUninstallPlan(
  plan: UninstallPlan,
  trust?: PublicTrustChange
): PublicUninstallPlan {
  return {
    installed: plan.installed,
    manifest: plan.manifest,
    manifestHash: plan.manifestHash,
    operations: [
      ...toPublicOperations(plan.operations),
      ...toPublicPreauthorization(plan.preauthorization)
    ],
    ...(trust === undefined ? {} : { trust })
  };
}
