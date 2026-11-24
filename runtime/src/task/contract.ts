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
    ...(task.originRequired === undefined ? {} : {originRequired: true}),
    ...(task.qa === undefined ? {} : {qa: task.qa}) }));
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
/**
 * What independent QA tested: the task contract minus surface classification. Excluded, dismissed and
 * UNKNOWN rows, scenarios, behavior text, origin and the revision counter change review, not the tests,
 * so reclassifying the surface keeps a sealed QA. The included {id, path} set (or a child's covers) still
 * binds: a new product surface needs a new plan.
 */
export function qaTaskContractHash(task: AgentTask): string {
  const surface = task.surface === undefined ? null : "covers" in task.surface ? {covers: [...task.surface.covers].sort()}
    : {included: task.surface.included.map(row => ({id: row.id, path: row.path})).sort((a, b) => a.id.localeCompare(b.id))};
  return sha256(canonicalJson({domain: "agent-ops-qa-contract-v1", goalHash: goalHash(task), title: task.title,
    intent: task.intent ?? null, criteria: task.criteria.map(criterionContractHash), surface,
    ...(task.debug === undefined ? {} : {debug: task.debug}), ...(task.qa === undefined ? {} : {qa: task.qa})}));
}
export function qaTreeContractHash(tasks: readonly AgentTask[]): string {
  return sha256(canonicalJson(tasks.map(task => ({id: task.id, hash: qaTaskContractHash(task)}))
    .sort((a, b) => a.id.localeCompare(b.id))));
}
