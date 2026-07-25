import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
