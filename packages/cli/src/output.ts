export type CliStatus = "error" | "ok";

export interface CliError {
  code: string;
  message: string;
}

export interface CliEnvelope<T> {
  code: string;
  status: CliStatus;
  data: T | null;
  errors: CliError[];
}

export interface OutputSink {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export function okEnvelope<T>(code: string, data: T): CliEnvelope<T> {
  return {
    code,
    status: "ok",
    data: data === undefined ? null : data,
    errors: []
  };
}

export function errorEnvelope(
  code: string,
  message: string
): CliEnvelope<null> {
  return {
    code,
    status: "error",
    data: null,
    errors: [{ code, message }]
  };
}

function humanSuccess(envelope: CliEnvelope<unknown>): string {
  if (typeof envelope.data === "object" && envelope.data !== null) {
    const data = envelope.data as Record<string, unknown>;
    if (typeof data.text === "string") {
      return data.text.endsWith("\n") ? data.text : `${data.text}\n`;
    }
    if (typeof data.version === "string") {
      return `${data.version}\n`;
    }
    if (typeof data.message === "string") {
      return `${data.message}\n`;
    }
  }
  return `${envelope.code}\n`;
}

function humanError(envelope: CliEnvelope<unknown>): string {
  if (typeof envelope.data === "object" && envelope.data !== null) {
    const data = envelope.data as Record<string, unknown>;
    if (typeof data.text === "string") {
      return data.text.endsWith("\n") ? data.text : `${data.text}\n`;
    }
  }
  const message = envelope.errors[0]?.message ?? envelope.code;
  return `${message}\n`;
}

export function writeEnvelope(
  sink: OutputSink,
  envelope: CliEnvelope<unknown>,
  json: boolean
): void {
  if (json) {
    const normalized =
      envelope.data === undefined ? { ...envelope, data: null } : envelope;
    sink.writeStdout(`${JSON.stringify(normalized)}\n`);
    return;
  }
  if (envelope.status === "ok") {
    sink.writeStdout(humanSuccess(envelope));
    return;
  }
  sink.writeStderr(humanError(envelope));
}
