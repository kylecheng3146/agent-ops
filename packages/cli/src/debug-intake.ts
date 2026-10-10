import {join} from "node:path";
import {TaskService} from "../../../runtime/src/task/service.js";
import {FileTaskStore} from "../../../runtime/src/task/store.js";
import {calculateConfigHash} from "../../../runtime/src/config/hash.js";
import {evaluateGuardrail} from "../../../runtime/src/guardrails/evaluate.js";
import {isDebugIssue} from "../../../runtime/src/task/debug-intake.js";
import {ensureSessionWorktree,readWorktreeRecord,sessionWorktreeName} from "../../../runtime/src/parallel/service.js";
import {listWorktrees,resumeWorktree} from "../../../runtime/src/parallel/manage.js";
import {collectChangeSurface} from "../../../runtime/src/verify/change-surface.js";
import {calculateSourceFingerprint} from "../../../runtime/src/verify/source-fingerprint.js";
import type {HookResult, NormalizedHookEvent} from "../../../runtime/src/hooks/events.js";
import type {AgentOpsConfig} from "../../../runtime/src/contracts.js";
import {loadEffectiveConfig} from "./context.js";
import {gitRunner,worktreeDependencies} from "./parallel-deps.js";

type DebugHost = "agy" | "claude" | "codex" | "opencode";
const foregroundClockSupported = (host: DebugHost): boolean => host !== "opencode";

function nativeSessionId(input: Record<string, unknown>): string | undefined {
  const fromInput = [input.session_id, input.sessionId, input.conversationId, input.thread_id, input.threadId]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  return fromInput ?? [process.env.AGENT_OPS_SESSION_ID, process.env.CODEX_THREAD_ID]
    .find((value): value is string => value !== undefined && value.length > 0);
}

/** Start only an already attached DEBUG issue; native hooks never create work. */
export async function startDebugSession(root:string, sessionId:string, host:DebugHost):Promise<void> {
  if (!foregroundClockSupported(host) || sessionId.length === 0) return;
  const config=(await loadEffectiveConfig(root,"project")).config;
  const saved=await readWorktreeRecord(join(root,".worktrees",sessionWorktreeName(sessionId)));
  const contextRoot=saved?.mainRoot === root && saved.sessionId === sessionId ? saved.path : root;
  const contextConfig=contextRoot === root ? config : (await loadEffectiveConfig(contextRoot,"project")).config;
  const tasks=new TaskService(new FileTaskStore(join(contextRoot,".agent-ops/tasks/state.json"),contextRoot),{completion:{root:contextRoot,gitRunner:gitRunner(contextRoot),loadConfig:async()=>contextConfig}});
  const attached=await tasks.status({sessionId}).catch(()=>null);
  if (attached?.status === "active" && attached.task.debug !== undefined)
    await tasks.debugService().foregroundStart(attached.task.id,sessionId);
}

export async function routeDebugPrompt(root:string,input:unknown,host:DebugHost = "claude"):Promise<string | null> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fields=input as {prompt?:unknown;session_id?:unknown;sessionId?:unknown;conversationId?:unknown;thread_id?:unknown;threadId?:unknown};
  if (typeof fields.prompt !== "string") return null;
  const continuation=/^(?:繼續|继续|continue)[。.!！]?$/iu.test(fields.prompt.trim());
  const debugIssue=isDebugIssue(fields.prompt);
  const config=(await loadEffectiveConfig(root,"project")).config;
  if (config.features.debug?.enabled !== true) return null;
  if (evaluateGuardrail({kind:"content",content:fields.prompt,scope:root}).action === "block") return null;
  const session=nativeSessionId(fields);
  if (session === undefined) {
    if (!debugIssue && !continuation) return null;
    return "DEBUG intake unsupported: this hook has no reliable native session identity. Use task create --debug --goal with the original issue in the native conversation.";
  }
  const saved=await readWorktreeRecord(join(root,".worktrees",sessionWorktreeName(session)));
  const contextRoot=saved?.mainRoot === root && saved.sessionId === session ? saved.path : root;
  const contextConfig=contextRoot === root ? config : (await loadEffectiveConfig(contextRoot,"project")).config;
  const original=new TaskService(new FileTaskStore(join(contextRoot,".agent-ops/tasks/state.json"),contextRoot),{completion:{root:contextRoot,gitRunner:gitRunner(contextRoot),loadConfig:async()=>contextConfig}});
  const attached=await original.status({sessionId:session}).catch(()=>null);
  if (attached?.status === "active" && attached.task.debug !== undefined) {
    if (continuation) {
      let message=`DEBUG continue preserved original issue ${attached.task.id}: native user event did not extend time; other limits remain authoritative.`;
      try {await original.debugService().extend(attached.task.id,session,"latest"); message=`DEBUG original issue ${attached.task.id}: native human time grant applied once; other limits remain authoritative.`;}
      catch (error) {message=`DEBUG continue preserved original issue ${attached.task.id}: ${error instanceof Error ? error.message : "Native user approval unavailable"}`;}
      if (foregroundClockSupported(host)) {
        try {await original.debugService().foregroundStart(attached.task.id,session);} catch (error) {message+=` Foreground clock unavailable: ${error instanceof Error ? error.message : "host lifecycle is unsupported"}`;}
      } else message+=" Foreground clock unsupported on this host; preserve the issue and use a host with a trustworthy end-of-turn signal.";
      return message;
    }
    if (foregroundClockSupported(host)) {
      try {await original.debugService().foregroundStart(attached.task.id,session);} catch (error) {
        return `DEBUG original issue ${attached.task.id}: foreground clock unavailable: ${error instanceof Error ? error.message : "host lifecycle is unsupported"}`;
      }
    }
    if (!debugIssue) return null;
    return `Continue original DEBUG issue ${attached.task.id}; retain its existing budget, evidence and hypotheses.`;
  }
  if (!debugIssue && !continuation) return null;
  if (continuation) {
    if (attached?.status !== "active" || attached.task.debug === undefined) return null;
    try {await original.debugService().extend(attached.task.id,session,"latest"); return `DEBUG original issue ${attached.task.id}: native human time grant applied once; other limits remain authoritative.`;}
    catch (error) {return `DEBUG continue preserved original issue ${attached.task.id}: ${error instanceof Error ? error.message : "Native user approval unavailable"}`;}
  }
  if (attached?.status === "active") return attached.task.debug === undefined ? null : `Continue original DEBUG issue ${attached.task.id}; retain its existing budget, evidence and hypotheses.`;
  // Another session's worktree may already hold this issue; reusing it keeps
  // its consumed budget and rounds instead of starting a fresh task.
  const holders=await listWorktrees(worktreeDependencies(),root).catch(()=>[]);
  for (const {record:held} of holders) {
    if (held.sessionId === session) continue;
    const heldConfig=(await loadEffectiveConfig(held.path,"project").catch(()=>null))?.config;
    if (heldConfig === undefined) continue;
    const issue=await new TaskService(new FileTaskStore(join(held.path,".agent-ops/tasks/state.json"),held.path),{completion:{root:held.path,gitRunner:gitRunner(held.path),loadConfig:async()=>heldConfig}}).activeDebugRoot(fields.prompt).catch(()=>null);
    if (issue === null) continue;
    try {await resumeWorktree(worktreeDependencies(),{cwd:root,name:held.name,sessionId:session});}
    catch (error) {
      return `DEBUG original issue ${issue.task.id} is still active in ${held.path}; a new task would reset its budget. ${error instanceof Error ? error.message : "Resume needs confirmation."} After the user confirms, run agent-ops worktree resume ${held.name} --session ${session}.`;
    }
    return `Continue original DEBUG issue ${issue.task.id} in ${held.path}; its budget, rounds and evidence are preserved.`;
  }
  await original.assertDebugBaseline();
  const record=config.worktree?.mode === "auto" && await readWorktreeRecord(root) === null ?
    await ensureSessionWorktree(worktreeDependencies(),{cwd:root,sessionId:session}) : null;
  const path=record?.path ?? root;
  const effective=(await loadEffectiveConfig(path,"project")).config;
  const tasks=new TaskService(new FileTaskStore(join(path,".agent-ops/tasks/state.json"),path),{completion:{root:path,gitRunner:gitRunner(path),loadConfig:async()=>effective}});
  const existing=await tasks.status({sessionId:session}).catch(()=>null);
  if (existing?.status === "active") return existing.task.debug === undefined ? null : `Continue original DEBUG issue ${existing.task.id}.`;
  const held=await tasks.activeDebugRoot(fields.prompt);
  if (held !== null) {
    await tasks.attach(session,held.task.id);
    let message=`Continue original DEBUG issue ${held.task.id}; its budget, rounds and evidence are preserved.`;
    if (foregroundClockSupported(host)) {
      try {await tasks.debugService().foregroundStart(held.task.id,session);} catch (error) {message+=` Foreground clock unavailable: ${error instanceof Error ? error.message : "host lifecycle is unsupported"}`;}
    }
    return message;
  }
  const ids=effective.verification.commands.filter(c=>c.required).map(c=>c.id);
  const baseline=(await gitRunner(path).run(["rev-parse","--verify","HEAD"])).stdout.toString().trim();
  const criteria=["issue-regression","related-checks"].map(id=>({id,description:id === "issue-regression" ? "Reproduce and fix the original reported issue with relevant regression evidence." : "Pass necessary related checks and two fresh independent reviews.",verifierIds:ids,
    acceptance:{mode:"review-only" as const,baselineCommit:baseline,bindings:[],reviewOnlyReason:"Provisional investigation intake only. Identify and revise to executable original-issue regression before debug success; this criterion cannot prove reproduction."}}));
  const created=await tasks.create({title:fields.prompt.split("\n")[0]!.slice(0,160),goal:fields.prompt,intent:"Investigate and fix the original issue through authoritative task debug evidence.",debug:{facts:["User-reported symptom is unverified."],unknowns:["Baseline reproduction","Root cause","Relevant regression and related checks"]},criteria,sessionId:session,policyConfigHash:calculateConfigHash(effective)});
  let clockNote="";
  if (foregroundClockSupported(host)) {
    try {await tasks.debugService().foregroundStart(created.task.id,session);} catch (error) {
      return `DEBUG issue ${created.task.id} created in ${path}, but its foreground clock is unavailable: ${error instanceof Error ? error.message : "host lifecycle is unsupported"}. Preserve the issue and do not claim timed completion.`;
    }
  } else clockNote=" Native foreground timing is unsupported on this host; controlled operations remain evidence-timed and do not claim a complete active-time budget.";
  return `DEBUG issue ${created.task.id} created in ${path}. Preserve the original goal. Investigate, record falsifiable hypotheses, revise provisional criteria to relevant behavioral regression, verify, obtain two fresh independent reviews, then finish. Defaults: 60 active minutes / 5 material repair candidates. No user-authored debug plan is required.${clockNote}`;
}

/** Close only the task attached to a native host's verified session. */
export async function closeDebugSession(root:string, sessionId:string, host:DebugHost = "claude"):Promise<void> {
  if (!foregroundClockSupported(host)) return;
  if (sessionId.length === 0) return;
  const config=(await loadEffectiveConfig(root,"project")).config;
  const saved=await readWorktreeRecord(join(root,".worktrees",sessionWorktreeName(sessionId)));
  const contextRoot=saved?.mainRoot === root && saved.sessionId === sessionId ? saved.path : root;
  const contextConfig=contextRoot === root ? config : (await loadEffectiveConfig(contextRoot,"project")).config;
  const tasks=new TaskService(new FileTaskStore(join(contextRoot,".agent-ops/tasks/state.json"),contextRoot),{completion:{root:contextRoot,gitRunner:gitRunner(contextRoot),loadConfig:async()=>contextConfig}});
  const attached=await tasks.status({sessionId}).catch(()=>null);
  if (attached?.status === "active" && attached.task.debug !== undefined)
    await tasks.debugService().foregroundStop(attached.task.id,sessionId);
}

/**
 * Without the completion gate, an active DEBUG issue still cannot end a turn
 * unless a current runtime stop checkpoint exists. Sessions without one pass.
 */
export function debugStopGate(root:string, rootConfig:AgentOpsConfig):{handle:(event:NormalizedHookEvent)=>Promise<HookResult | null>} {
  return {handle:async event=>{
    if (event.event !== "stop" || event.sessionId === undefined || event.sessionId.length === 0) return null;
    const sessionId=event.sessionId;
    const saved=await readWorktreeRecord(join(root,".worktrees",sessionWorktreeName(sessionId))).catch(()=>null);
    const contextRoot=saved?.mainRoot === root && saved.sessionId === sessionId ? saved.path : root;
    const config=contextRoot === root ? rootConfig : (await loadEffectiveConfig(contextRoot,"project").catch(()=>null))?.config;
    if (config === undefined) return null;
    const runner=gitRunner(contextRoot);
    const tasks=new TaskService(new FileTaskStore(join(contextRoot,".agent-ops/tasks/state.json"),contextRoot),{completion:{root:contextRoot,gitRunner:runner,loadConfig:async()=>config}});
    const attached=await tasks.status({sessionId}).catch(()=>null);
    if (attached?.status !== "active" || attached.task.debug === undefined) return null;
    const surface=await collectChangeSurface(runner);
    const fingerprint=await calculateSourceFingerprint(contextRoot,{mode:"worktree",changedFiles:surface.paths},runner);
    return await tasks.debugService().validCheckpoint(attached.task.id,sessionId,fingerprint)
      ? {action:"continue",status:"UNKNOWN",code:"COMPLETION_GATE_TASK_DEBUG_STOPPED",remedy:"Original issue remains active with a runtime-bound non-success checkpoint."}
      : {action:"block",status:"FAIL",code:"COMPLETION_GATE_TASK_DEBUG_ACTIVE",remedy:"Continue the investigation/evidence loop or record a current task debug checkpoint before stopping, even when Git has no net diff."};
  }};
}
