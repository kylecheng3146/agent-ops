import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { collectOfficeInput } from "../../../runtime/src/office/collect.js";
import { claimOffice, createOfficeServer, ensureOffice, readLiveOffice, officeUrl, releaseOffice } from "../../../runtime/src/office/server.js";
import { buildOfficeSnapshot, type OfficeSnapshot } from "../../../runtime/src/office/snapshot.js";
import { resolveCheckouts } from "../../../runtime/src/parallel/service.js";
import { createLaunchdDescriptor, LaunchdController } from "../../../runtime/src/run/macOS.js";
import { ensurePrivateDirectory } from "../../../runtime/src/security/permissions.js";
import { worktreeDependencies } from "./parallel-deps.js";

const entry = fileURLToPath(import.meta.url);

async function checkouts(cwd: string): Promise<{ mainRoot: string; commonDir: string }> {
  return await resolveCheckouts(worktreeDependencies(), cwd);
}

/** Serve the office until no run has been active for the idle window. */
export async function serveOffice(cwd: string, onUrl: (url: string) => void = () => {}): Promise<void> {
  const { mainRoot, commonDir } = await checkouts(cwd);
  // ponytail: one shared 1s snapshot so several polling tabs cost one git scan
  let cached: { at: number; value: Promise<OfficeSnapshot> } | null = null;
  const snapshot = (): Promise<OfficeSnapshot> => {
    if (cached === null || Date.now() - cached.at > 1000)
      cached = { at: Date.now(), value: collectOfficeInput(mainRoot, commonDir).then(buildOfficeSnapshot) };
    return cached.value;
  };
  let finish = (): void => {};
  const idle = new Promise<void>((resolve) => { finish = resolve; });
  const office = createOfficeServer({ snapshot, onIdle: () => finish() });
  const record = await claimOffice(commonDir, office);
  if (record === null) {
    const live = await readLiveOffice(commonDir);
    if (live !== null) onUrl(officeUrl(live));
    return;
  }
  onUrl(officeUrl(record));
  const timer = setInterval(() => { void office.tick(); }, 15_000);
  await idle;
  clearInterval(timer);
  await releaseOffice(commonDir, record);
  await office.close();
}

/** Reuse the live server or start one under launchd; null where launchd is unavailable. */
export async function ensureBackgroundOffice(cwd: string, launchd = new LaunchdController()): Promise<string | null> {
  const { mainRoot, commonDir } = await checkouts(cwd);
  const live = await readLiveOffice(commonDir);
  if (live !== null) return officeUrl(live);
  if (!launchd.supported) return null;
  const privateDirectory = join(commonDir, "agent-ops", "office");
  const descriptor = createLaunchdDescriptor({
    runId: "office-" + createHash("sha256").update(commonDir).digest("hex").slice(0, 12), workerId: "server",
    privateDirectory, command: process.execPath, args: [entry, mainRoot],
    cwd: mainRoot, pathEnvironment: process.env.PATH
  });
  return await ensureOffice(commonDir, async () => {
    // The descriptor write anchors on this directory, so it must exist first.
    await ensurePrivateDirectory(privateDirectory, commonDir);
    await launchd.writeDescriptor(descriptor);
    // A server that exited idle stays loaded in launchd; reload it with the current descriptor.
    await launchd.bootout(descriptor).catch(() => {});
    await launchd.bootstrap(descriptor);
  });
}

if (process.argv[1] === entry) {
  await serveOffice(process.argv[2] ?? process.cwd());
  process.exit(0);
}
