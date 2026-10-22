import type { AcceptanceCriterion, AgentTask } from "../contracts.js";
import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";

export function goalHash(task: AgentTask): string {
  return sha256(task.goal ?? task.intent ?? task.title);
}
export function criterionContractHash(criterion: AcceptanceCriterion): string {
  return sha256(canonicalJson(criterion));
}
export function taskContractHash(task: AgentTask): string {
  return sha256(canonicalJson({ goalHash: goalHash(task), title: task.title,
    intent: task.intent ?? null, revision: task.contractRevision ?? 0,
    criteria: task.criteria.map(criterionContractHash), ...(task.debug === undefined ? {} : {debug:task.debug}),
    ...(task.surface === undefined ? {} : {surface: sha256(canonicalJson(task.surface))}),
    ...(task.surfaceRequired === undefined ? {} : {surfaceRequired: true}),
    ...(task.origin === undefined ? {} : {origin: task.origin}),
    ...(task.originRequired === undefined ? {} : {originRequired: true}) }));
}
/**
 * What verification actually ran: the criteria. Surface, origin, goal and revision
 * changes leave it alone, so they need a fresh review but not a fresh verify.
 */
export function executionContractHash(task: AgentTask): string {
  return sha256(canonicalJson({domain: "agent-ops-execution-v1", criteria: task.criteria.map(criterionContractHash)}));
}
/** Verification evidence binds the execution hash; evidence from before 0.11 bound the full contract. */
export function evidenceMatchesContract(hash: string | undefined, task: AgentTask): boolean {
  return hash !== undefined && (hash === executionContractHash(task) || hash === taskContractHash(task));
}
export function treeContractHash(tasks: readonly AgentTask[]): string {
  return sha256(canonicalJson(tasks.map(task => ({id: task.id, hash: taskContractHash(task)}))
    .sort((a, b) => a.id.localeCompare(b.id))));
}
