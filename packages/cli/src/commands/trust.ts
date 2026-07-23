import type {
  TrustBinding,
  TrustStatusResult,
  TrustStore
} from "../../../../runtime/src/security/trust.js";
import {
  okEnvelope,
  type CliEnvelope
} from "../output.js";

export type TrustAction = "grant" | "revoke" | "status";

export interface TrustCommandOptions {
  action: TrustAction;
  yes: boolean;
  isTTY: boolean;
  calculateBinding(): Promise<TrustBinding>;
  presentBinding(binding: TrustBinding): Promise<void>;
  confirmGrant(binding: TrustBinding): Promise<boolean>;
  store: TrustStore;
}

export interface TrustCommandData {
  binding: TrustBinding;
  trust?: TrustStatusResult;
  revoked?: boolean;
  message?: string;
}

function trustError(
  code: string,
  message: string,
  binding: TrustBinding
): CliEnvelope<TrustCommandData> {
  return {
    code,
    status: "error",
    data: { binding },
    errors: [{ code, message }]
  };
}

export async function runTrustCommand(
  options: TrustCommandOptions
): Promise<CliEnvelope<TrustCommandData>> {
  const binding = await options.calculateBinding();

  if (options.action === "status") {
    const trust = await options.store.status(binding);
    return okEnvelope("TRUST_STATUS", {
      binding,
      trust,
      message: `Repository trust status: ${trust.status}`
    });
  }

  if (options.action === "revoke") {
    const revoked = await options.store.revoke(binding);
    return okEnvelope("TRUST_REVOKED", {
      binding,
      revoked,
      message: revoked
        ? "Repository trust was revoked."
        : "No exact repository trust record existed."
    });
  }

  await options.presentBinding(binding);
  if (!options.isTTY && !options.yes) {
    return trustError(
      "TRUST_CONFIRMATION_REQUIRED",
      "Non-interactive trust grant requires: agent-ops trust grant --yes",
      binding
    );
  }
  if (
    options.isTTY &&
    !options.yes &&
    !(await options.confirmGrant(binding))
  ) {
    return trustError(
      "TRUST_GRANT_CANCELLED",
      "Repository trust was not granted.",
      binding
    );
  }

  await options.store.grant(binding);
  return okEnvelope("TRUST_GRANTED", {
    binding,
    message: "Repository trust was granted for the displayed binding."
  });
}
