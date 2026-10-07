import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import { errorEnvelope, okEnvelope, type CliEnvelope } from "../output.js";

export interface OfficeCommandOptions {
  /** Reuse the live server or start a background one; null when no background start is available here. */
  readonly ensure: () => Promise<string | null>;
  /** Serve in this process until idle, announcing the URL once it listens. */
  readonly foreground: (onUrl: (url: string) => void) => Promise<void>;
  readonly writeStdout: (text: string) => void;
}

export interface OfficeCommandData {
  readonly url: string;
  readonly text: string;
}

export async function runOfficeCommand(options: OfficeCommandOptions): Promise<CliEnvelope<OfficeCommandData>> {
  try {
    const url = await options.ensure();
    if (url !== null) return okEnvelope("OFFICE_READY", { url, text: `Office: ${url}` });
    let shown = "";
    await options.foreground((served) => {
      shown = served;
      options.writeStdout(`Office: ${served}\nServing in the foreground; it exits 10 minutes after no run is active.\n`);
    });
    return okEnvelope("OFFICE_CLOSED", { url: shown, text: "Office closed: no run was active for 10 minutes." });
  } catch (cause) {
    if (cause instanceof AgentOpsError) return errorEnvelope(cause.code, cause.message) as unknown as CliEnvelope<OfficeCommandData>;
    throw cause;
  }
}
