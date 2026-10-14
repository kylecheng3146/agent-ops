/** Escape Loop R1: where a bug came from, declared on the task that fixes it. */
export const ESCAPE_GATES = ["requirement", "surface", "scenario", "criteria", "verify", "review"] as const;
/** Agent-proposed label: the earliest gate that could have caught it, or flagged / out-of-model. */
export const ESCAPE_LABELS = [...ESCAPE_GATES, "flagged", "out-of-model"] as const;
export type EscapeLabel = typeof ESCAPE_LABELS[number];

export type TaskOrigin =
  | { readonly kind: "escape-of"; readonly commit: string; readonly label: EscapeLabel; readonly receipt?: string }
  | { readonly kind: "pre-existing" | "external"; readonly reason: string };

export const RECEIPT_ID = /^[a-f0-9]{64}-[a-f0-9]{40,64}$/u;

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));

export function validOrigin(value: unknown): value is TaskOrigin {
  if (!record(value)) return false;
  if (value.kind === "escape-of")
    return keys(value, ["kind", "commit", "label"], ["receipt"]) && typeof value.commit === "string" &&
      /^[a-f0-9]{40,64}$/u.test(value.commit) && ESCAPE_LABELS.includes(value.label as EscapeLabel) &&
      (value.receipt === undefined || (typeof value.receipt === "string" && RECEIPT_ID.test(value.receipt)));
  return (value.kind === "pre-existing" || value.kind === "external") && keys(value, ["kind", "reason"]) &&
    typeof value.reason === "string" && value.reason.trim().length >= 10 && value.reason.length <= 2048 && !value.reason.includes("\0");
}
