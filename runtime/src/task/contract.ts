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
    criteria: task.criteria.map(criterionContractHash) }));
}
export function treeContractHash(tasks: readonly AgentTask[]): string {
  return sha256(canonicalJson(tasks.map(task => ({id: task.id, hash: taskContractHash(task)}))
    .sort((a, b) => a.id.localeCompare(b.id))));
}
