import {join} from "node:path";
import {TaskService} from "../../../runtime/src/task/service.js";
import {FileTaskStore} from "../../../runtime/src/task/store.js";
import {calculateConfigHash} from "../../../runtime/src/config/hash.js";
import {evaluateGuardrail} from "../../../runtime/src/guardrails/evaluate.js";
import {isDebugIssue} from "../../../runtime/src/task/debug-intake.js";
import {ensureSessionWorktree,readWorktreeRecord} from "../../../runtime/src/parallel/service.js";
import {loadEffectiveConfig} from "./context.js";
import {gitRunner,worktreeDependencies} from "./parallel-deps.js";

export async function routeDebugPrompt(root:string,input:unknown):Promise<string | null> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fields=input as {prompt?:unknown;session_id?:unknown};
  if (typeof fields.prompt !== "string") return null;
  const continuation=/^(?:繼續|继续|continue)[。.!！]?$/iu.test(fields.prompt.trim());
  if (!continuation && !isDebugIssue(fields.prompt)) return null;
  const config=(await loadEffectiveConfig(root,"project")).config;
  if (config.features.debug?.enabled !== true) return null;
  if (evaluateGuardrail({kind:"content",content:fields.prompt,scope:root}).action === "block") return null;
  if (typeof fields.session_id !== "string" || fields.session_id.length === 0)
    return "DEBUG intake unsupported: this hook has no reliable native session identity. Use task create --debug --goal with the original issue in the native conversation.";
  const session=fields.session_id;
  const original=new TaskService(new FileTaskStore(join(root,".agent-ops/tasks/state.json"),root),{completion:{root,gitRunner:gitRunner(root),loadConfig:async()=>config}});
  const attached=await original.status({sessionId:session}).catch(()=>null);
  if (continuation) {
    if (attached?.status !== "active" || attached.task.debug === undefined) return null;
    try {await original.debugService().extend(attached.task.id,session,"latest"); return `DEBUG original issue ${attached.task.id}: native human time grant applied once; other limits remain authoritative.`;}
    catch (error) {return `DEBUG continue preserved original issue ${attached.task.id}: ${error instanceof Error ? error.message : "Native user approval unavailable"}`;}
  }
  if (attached?.status === "active") return attached.task.debug === undefined ? null : `Continue original DEBUG issue ${attached.task.id}; retain its existing budget, evidence and hypotheses.`;
  await original.assertDebugBaseline();
  const record=config.worktree?.mode === "auto" && await readWorktreeRecord(root) === null ?
    await ensureSessionWorktree(worktreeDependencies(),{cwd:root,sessionId:session}) : null;
  const path=record?.path ?? root;
  const effective=(await loadEffectiveConfig(path,"project")).config;
  const tasks=new TaskService(new FileTaskStore(join(path,".agent-ops/tasks/state.json"),path),{completion:{root:path,gitRunner:gitRunner(path),loadConfig:async()=>effective}});
  const existing=await tasks.status({sessionId:session}).catch(()=>null);
  if (existing?.status === "active") return existing.task.debug === undefined ? null : `Continue original DEBUG issue ${existing.task.id}.`;
  const ids=effective.verification.commands.filter(c=>c.required).map(c=>c.id);
  const baseline=(await gitRunner(path).run(["rev-parse","--verify","HEAD"])).stdout.toString().trim();
  const criteria=["issue-regression","related-checks"].map(id=>({id,description:id === "issue-regression" ? "Reproduce and fix the original reported issue with relevant regression evidence." : "Pass necessary related checks and two fresh independent reviews.",verifierIds:ids,
    acceptance:{mode:"review-only" as const,baselineCommit:baseline,bindings:[],reviewOnlyReason:"Provisional investigation intake only. Identify and revise to executable original-issue regression before debug success; this criterion cannot prove reproduction."}}));
  const created=await tasks.create({title:fields.prompt.split("\n")[0]!.slice(0,160),goal:fields.prompt,intent:"Investigate and fix the original issue through authoritative task debug evidence.",debug:{facts:["User-reported symptom is unverified."],unknowns:["Baseline reproduction","Root cause","Relevant regression and related checks"]},criteria,sessionId:session,policyConfigHash:calculateConfigHash(effective)});
  return `DEBUG issue ${created.task.id} created in ${path}. Preserve the original goal. Investigate, record falsifiable hypotheses, revise provisional criteria to relevant behavioral regression, verify, obtain two fresh independent reviews, then finish. Defaults: 20 active minutes / 5 material repair candidates. No user-authored debug plan is required.`;
}
