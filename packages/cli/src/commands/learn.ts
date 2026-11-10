import {productionLearningAutomation} from "../learning-deps.js";
import {basename, resolve} from "node:path";
import {AgentOpsError} from "../../../../runtime/src/fs/paths.js";
import {readDeliveredReceipt} from "../../../../runtime/src/followup/receipt.js";
import {calculateConfigHash} from "../../../../runtime/src/config/hash.js";
import {digest, invalid, object, parseSuite, redactData} from "../../../../runtime/src/learning/data.js";
import {FileLearningStore} from "../../../../runtime/src/learning/store.js";
import {replayLearningTrial, runLearningTrial, targetLearningCall, type LearningTrial} from "../../../../runtime/src/learning/experiment.js";
import {registeredRunProofRunner} from "../../../../runtime/src/verify/spawn.js";
import {followupRepositoryContext} from "../followup-deps.js";
import {worktreeDependencies} from "../parallel-deps.js";
import type {ParsedArgs} from "../args.js";
import {okEnvelope, type CliEnvelope} from "../output.js";

export async function collectLearningSource(context: Pick<Awaited<ReturnType<typeof followupRepositoryContext>>, "git" | "mainRoot" | "commonDir">,
  receiptPath: string, taskId?: string): Promise<LearningTrial["source"]> {
  const delivered = await readDeliveredReceipt({...context, path: receiptPath});
  if (delivered.reviews.some(r => r.provenanceLimit !== "contract-bound")) invalid("Learning requires contract-bound delivery evidence; legacy receipt retained.");
  const task = delivered.receipt.tasks.find(t => taskId === undefined || t.task.id === taskId);
  if (task === undefined || (taskId === undefined && delivered.receipt.tasks.length !== 1)) invalid("Select one delivered source task with --task.");
  const diffResult = await context.git(context.mainRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", delivered.receipt.targetCommit, delivered.receipt.candidateHead, "--"]);
  if (diffResult.exitCode !== 0) invalid("Source diff is unavailable.");
  const diff = diffResult.stdout;
  const evidence = redactData({goal: task.task.goal ?? null, task: task.task, diff: diff.slice(0, 24576), diffTruncated: diff.length > 24576,
    diffDigest: digest(diff), sourceFingerprint: delivered.receipt.sourceFingerprint,
    verification: Object.values(delivered.receipt.verification).map(sealed => {
      const v = sealed.value;
      return object(v) ? {taskId: v.taskId, criterionId: v.criterionId, commandId: v.commandId, status: v.status,
        acceptance: v.acceptance ?? null, artifactDigest: sealed.digest} : {artifactDigest: sealed.digest};
    }), reviews: delivered.reviews.map(r => ({taskId: r.taskId, digest: r.reportDigest, report: r.artifact}))});
  return {receipt: delivered.digest, taskId: task.task.id, commit: delivered.receipt.candidateHead, evidence};
}

export async function runLearnCommand(options: {args: ParsedArgs; cwd: string}): Promise<CliEnvelope<unknown>> {
  const {args, cwd} = options, context = await followupRepositoryContext(cwd), store = new FileLearningStore(context.commonDir);
  const action = args.learningAction ?? "list";
  if (action === "list") {
    const current = {...await store.current(), automation: await (await productionLearningAutomation(cwd)).status()};
    return okEnvelope("LEARNING_STATE", {...current, text: JSON.stringify(current, null, 2)});
  }
  if (action === "retry") {
    await (await productionLearningAutomation(cwd)).retry(args.learningId!);
    return okEnvelope("LEARNING_RETRY_QUEUED", {text: "Retry requested; the next ordinary CLI use checks current authority, conditions and UTC daily quota. Prior attempts remain counted."});
  }
  if (action === "rollback" || action === "retire") {
    const state = await store.recover(action, args.reason!, args.learningId);
    return okEnvelope("LEARNING_RECOVERED", {state, text: `Learning ${action}; active revision ${state.active ?? "baseline"}.`});
  }
  if (action === "show" || action === "replay") {
    const trial = await store.artifact("trials", args.learningId!) as LearningTrial;
    const replay = action === "replay" ? replayLearningTrial(trial) : undefined;
    return okEnvelope("LEARNING_TRIAL", {trial, replay, text: JSON.stringify({trial, replay}, null, 2)});
  }
  const deps = worktreeDependencies();
  if (await deps.trust.status(cwd, context.config) !== "TRUSTED")
    throw new AgentOpsError("LEARNING_UNTRUSTED", "Learning experiments require current repository trust; no model was called.");
  const git = async (argv: string[]): Promise<string> => {
    const result = await context.git(cwd, argv);
    if (result.exitCode !== 0) throw new AgentOpsError("LEARNING_GIT_FAILED", "Learning source or committed suite is unavailable.");
    return result.stdout;
  };
  if ((await git(["status", "--porcelain"])).trim() !== "") invalid("Commit the suite and source before a learning round.");
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const path = args.learningSuite!;
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === ".."))
    invalid("Suite must be a committed repository-relative regular JSON file.");
  const metadata = await git(["ls-tree", "-z", head, "--", path]);
  if (!metadata.startsWith("100644 blob ") && !metadata.startsWith("100755 blob ")) invalid("Suite is not a committed regular file.");
  const rawSuite = await git(["show", `${head}:${path}`]);
  if (Buffer.byteLength(rawSuite) > 64 * 1024) invalid("Suite exceeds 64 KiB.");
  const suite = parseSuite(JSON.parse(rawSuite));
  const receiptPath = resolve(context.commonDir, "agent-ops", "receipts", basename(args.learningReceipt!));
  const source = await collectLearningSource(context, receiptPath, args.taskId);
  const role = context.config.reviewRoles?.find(r => r.role === "independent-review");
  const target = args.learningTarget ?? role?.targets[0];
  if (target === undefined || !role?.targets.includes(target)) invalid("Select a configured independent-review target.");
  const settings = {target, model: args.learningModel!, effort: role.effort ?? "high"};
  const configHash = calculateConfigHash(context.config);
  const result = await runLearningTrial({store, settings, suiteCommit: head, suite,
    source,
    call: args.learningNoExecute ? null : targetLearningCall(settings, registeredRunProofRunner()),
    isCurrent: async () => (await git(["rev-parse", "HEAD"])).trim() === head &&
      (await git(["status", "--porcelain"])).trim() === "" && calculateConfigHash(await context.loadConfig()) === configHash});
  return okEnvelope("LEARNING_RESULT", {...result, text: `${result.trial.status}: ${result.trial.reason}; CLI invocations ${result.trial.calls.length}/12.\n` +
    `Trial ${result.artifact}; adopted ${result.adopted ?? "none (baseline retained)"}. Provider calls and billing may be unreported; this consumes existing CLI quota.`});
}
