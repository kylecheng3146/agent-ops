import type {AgentOpsConfig, LearningConfig} from "../contracts.js";
import {globsOverlap} from "../escape/lessons.js";
import {casePaths, digest, exact, object, parseProposal, parseSuite, redactData, text, type LearningSuite} from "./data.js";
import {validateHistoricalAdvice, type CandidateRecord} from "./history.js";
import type {LearningSettings} from "./experiment.js";
import {readCompletedCase, type LearningSource} from "./intake.js";

const boundedPath = (v: unknown): boolean => text(v, 256) && !v.startsWith("/") && !/[\\\r\n:*?]/u.test(v) &&
  v.split("/").every(p => p !== "" && p !== "." && p !== "..");
export function validLearningConfig(v: unknown): v is LearningConfig {
  return object(v) && exact(v, ["suitePath", "suiteDigest", "humanConfirmed", "independentlyLabelled", "settings"]) &&
    boundedPath(v.suitePath) && typeof v.suiteDigest === "string" && /^[a-f0-9]{64}$/u.test(v.suiteDigest) &&
    typeof v.humanConfirmed === "boolean" && typeof v.independentlyLabelled === "boolean" &&
    object(v.settings) && exact(v.settings, ["target", "model", "effort"]) &&
    ["codex", "claude", "agy"].includes(String(v.settings.target)) && text(v.settings.model, 256) && text(v.settings.effort, 64);
}
export type LearningSetup = {status: "waiting"; reason: string} | {
  status: "eligible"; reason: "READY"; suite: LearningSuite; suiteCommit: string; suiteDigest: string;
  settings: LearningSettings; registration: LearningConfig; fingerprint: string;
};
/** Reads only committed inputs. Trust/policy must also be checked by the launch/adoption controller. No model calls. */
export async function resolveLearningSetup(options: LearningSource & {config: AgentOpsConfig; candidate: CandidateRecord}): Promise<LearningSetup> {
  const wait = (reason: string): LearningSetup => ({status: "waiting", reason});
  const registration = options.config.learning;
  if (registration === undefined) return wait("SETUP_MISSING");
  if (!validLearningConfig(registration)) return wait("SETUP_INVALID");
  if (!registration.humanConfirmed || !registration.independentlyLabelled) return wait("SUITE_UNCONFIRMED");
  const {settings} = registration;
  if (!/(?:\d{8}|\d{4}-\d{2}(?:-\d{2})?|[@:]v?\d+)$/u.test(settings.model) || /(?:^|[-_:])(?:auto|default|latest)(?:$|[-_:])/iu.test(settings.model)) return wait("MODEL_NOT_FIXED");
  if (!options.config.reviewRoles?.some(r => r.role === "independent-review" && r.targets.includes(settings.target))) return wait("TARGET_UNCONFIGURED");
  if (registration.suitePath === "tests/learning/scenarios.json") return wait("SYNTHETIC_SUITE");
  try {
    const git = async (args: string[]): Promise<string> => {
      const r = await options.git(options.mainRoot, args);
      if (r.exitCode !== 0) throw new Error("SUITE_UNAVAILABLE");
      return r.stdout;
    };
    const suiteCommit = (await git(["rev-parse", "HEAD"])).trim();
    const metadata = await git(["ls-tree", "-z", suiteCommit, "--", registration.suitePath]);
    if (!metadata.startsWith("100644 blob ") && !metadata.startsWith("100755 blob ")) return wait("SUITE_NOT_COMMITTED");
    if ((await git(["status", "--porcelain", "--", registration.suitePath])).trim() !== "") return wait("SUITE_DIRTY");
    const raw = await git(["show", `${suiteCommit}:${registration.suitePath}`]);
    if (Buffer.byteLength(raw) > 64 * 1024) return wait("SUITE_OVERSIZED");
    const value: unknown = JSON.parse(raw);
    if (digest(value) !== registration.suiteDigest) return wait("SUITE_DIGEST_CHANGED");
    if (digest(redactData(value)) !== digest(value)) return wait("SUITE_SENSITIVE");
    const suite = parseSuite(value), proposal = parseProposal(options.candidate.proposal);
    // Optional context/experiences could embed answers or prior held-out results; registered snapshots contain task facts only.
    const allowed = ["taskId", "originalGoal", "intent", "criteria", "surface", "verification", "assignedScope", "child"];
    if (suite.cases.some(c => Object.keys(c.snapshot).some(k => !allowed.includes(k)))) return wait("SUITE_CONTEXT_LEAKAGE");
    if (suite.cases.some(c => casePaths(c.snapshot).some(p => !boundedPath(p) &&
      !(p.endsWith("/**") && boundedPath(p.slice(0, -3)))))) return wait("SUITE_SCOPE_INVALID");
    const identities = suite.cases.map(c => digest({goal: c.snapshot.originalGoal, criteria: c.snapshot.criteria, paths: casePaths(c.snapshot).sort()}));
    if (new Set(identities).size !== identities.length) return wait("SUITE_DUPLICATE_TASKS");
    const sourceText = JSON.stringify(options.candidate);
    if (suite.cases.some(c => options.candidate.history.some(h => h.tasks.some(t => t.goal === c.snapshot.originalGoal)) ||
      sourceText.includes(JSON.stringify(c.snapshot.originalGoal).slice(1, -1)) || sourceText.includes(JSON.stringify(c.snapshot)))) return wait("SOURCE_CASE_LEAKAGE");
    if (suite.cases.filter(c => c.split === "holdout").some(c => sourceText.includes(JSON.stringify(c.id).slice(1, -1)))) return wait("HOLDOUT_LEAKAGE");
    try {
      if (options.candidate.history.length < 1 || options.candidate.history.length > 3 ||
          !validateHistoricalAdvice({candidates: [{sourceCaseIds: options.candidate.history.map(h => h.id), proposal}]},
            options.candidate.history, options.candidate.history.flatMap(h => h.paths))) return wait("CANDIDATE_SOURCE_INVALID");
      for (const context of options.candidate.history) {
        const original = await readCompletedCase(options, context.id);
        const facts = {provenance: original.provenance, paths: original.paths, tasks: original.tasks.map(t =>
          ({id: t.id, parentTaskId: t.parentTaskId, goal: t.goal, criteria: t.criteria}))};
        if (digest(facts) !== digest({provenance: context.provenance, paths: context.paths, tasks: context.tasks})) return wait("CANDIDATE_SOURCE_CHANGED");
      }
    } catch {return wait("CANDIDATE_SOURCE_CHANGED");}
    if (proposal.strategies.length === 0 || proposal.strategies.some(s => ["probe", "holdout"].some(split =>
      !suite.cases.some(c => c.split === split && s.paths.some(p => casePaths(c.snapshot).some(q => globsOverlap(p, q))))))) return wait("SUITE_INAPPLICABLE");
    return {status: "eligible", reason: "READY", suite, suiteCommit, suiteDigest: registration.suiteDigest,
      settings: structuredClone(settings), registration: structuredClone(registration),
      fingerprint: digest({registration, suite, settings})};
  } catch {return wait("SUITE_INVALID_OR_UNAVAILABLE");}
}
