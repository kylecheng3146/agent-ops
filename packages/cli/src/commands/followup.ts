import { readFile, lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import { reconcileFollowups } from "../../../../runtime/src/followup/intake.js";
import { readFollowupProgress } from "../../../../runtime/src/followup/process.js";
import { FileFollowupStore, clarifyFollowup, setFollowupDisposition } from "../../../../runtime/src/followup/store.js";
import type { ReviewFinding } from "../../../../runtime/src/review/report.js";
import { readFollowupAssessment } from "../../../../runtime/src/review/followup.js";
import { redactSecrets } from "../../../../runtime/src/security/redact.js";
import { safeTaskText } from "../../../../runtime/src/task/render.js";
import type { ParsedArgs } from "../args.js";
import { productionFollowupContext, followupRepositoryContext } from "../followup-deps.js";
import { errorEnvelope, okEnvelope, type CliEnvelope } from "../output.js";

/** Redact strings individually so multiline credentials cannot hide behind JSON escapes. */
function display(value: unknown): unknown {
  if (typeof value === "string") return safeTaskText(redactSecrets(value));
  if (Array.isArray(value)) return value.map(display);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, display(field)]));
  return value;
}

export async function runFollowupCommand(options: { readonly args: ParsedArgs; readonly cwd: string }): Promise<CliEnvelope<unknown>> {
  const { args, cwd } = options;
  const source = await followupRepositoryContext(cwd);
  const collection = await reconcileFollowups(source);
  const store = new FileFollowupStore(source.commonDir);
  const action = args.action ?? "list";
  const warnings = collection.warnings.map(w => `Warning: ${w}`);
  if (action === "import" || action === "sync") return okEnvelope("FOLLOWUP_IMPORTED", { collection,
    text: [`Followup: collected ${collection.candidates} candidate(s), ${collection.observations} observation(s).`, ...warnings].join("\n") });
  if (action === "list") {
    const items = await Promise.all((await store.read()).items.map(async item => {
      const progress = await readFollowupProgress(source.commonDir, item.id, item);
      return { id: item.id, kind: item.kind, disposition: item.disposition, status: progress.status, code: progress.code,
        title: typeof item.original === "string" ? item.original : item.original.title };
    }));
    const safe = display(items) as typeof items;
    return okEnvelope("FOLLOWUP_LIST", { items: safe, collection,
      text: [safe.length === 0 ? "No followup items." : safe.map(i => `${i.id} ${i.kind} ${i.disposition} ${i.status} (${i.code})\n  ${i.title}`).join("\n"), ...warnings].join("\n") });
  }
  const id = args.followupId!;
  if (action === "clarify") {
    const path = resolve(cwd, args.findingFile!);
    if (!(await lstat(path)).isFile() || (await lstat(path)).size > 128 * 1024)
      throw new AgentOpsError("FOLLOWUP_CLARIFICATION_INVALID", "Finding JSON must be a regular file no larger than 128 KiB.");
    let finding: ReviewFinding;
    try { finding = JSON.parse(await readFile(path, "utf8")) as ReviewFinding; }
    catch { throw new AgentOpsError("FOLLOWUP_CLARIFICATION_INVALID", "Finding file must contain concrete ReviewFinding JSON."); }
    await clarifyFollowup(store, id, finding, args.reason!);
  } else if (action === "accept" || action === "defer" || action === "reopen") {
    await setFollowupDisposition(store, id, action, args.reason);
  } else if (action === "process") {
    const progress = await (await productionFollowupContext(cwd)).process(id, args.host!, args.reviewOnlyReason);
    // A persisted refusal remains an error to scripts, with the durable state available to show.
    if (progress.attempts.at(-1)?.code === progress.code)
      return { ...errorEnvelope(progress.code, `Repair start refused: ${progress.code}. Item retained; inspect with followup show ${id}.`),
        data: display({ progress, collection }) };
  }
  const item = await store.get(id), progress = await readFollowupProgress(source.commonDir, id, item);
  const assessment = progress.assessment === undefined ? undefined : await readFollowupAssessment(source.commonDir, progress.assessment);
  const safe = display({ item, progress, ...(assessment === undefined ? {} : {
    assessment: { conclusion: assessment.conclusion, reason: assessment.reason, binding: assessment.binding }
  }) }) as { item: typeof item; progress: typeof progress };
  return okEnvelope("FOLLOWUP_DETAIL", { ...safe, collection,
    text: [`${id}: ${safe.item.kind}, ${safe.item.disposition}, ${progress.status} (${progress.code})`,
      JSON.stringify(safe, null, 2), ...warnings].join("\n") });
}
