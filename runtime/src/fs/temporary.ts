import { rm } from "node:fs/promises";

/**
 * Removes a scratch directory without letting cleanup hide the result it served.
 * Windows can hold a just-killed child's files open for a moment (EBUSY), so rm
 * retries; a directory that still cannot be removed stays in the OS temp dir.
 */
export async function removeTemporary(path: string): Promise<void> {
  // ponytail: a leaked temp directory is the ceiling; the OS temp cleaner reclaims it.
  await rm(path, { recursive: true, force: true, maxRetries: 10 }).catch(() => undefined);
}
