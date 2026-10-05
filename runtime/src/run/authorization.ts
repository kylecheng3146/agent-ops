import {canonicalJson} from "../config/hash.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {RunControlService, type RunAuthorizationResult} from "./controls.js";
import type {NativeGoalEvent} from "./hosts/types.js";
import type {RunRepository} from "./service.js";

const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Provider decisions are observations, never an alternate permission executor. */
export async function recordNativeRunAuthorization(repository: RunRepository, event: NativeGoalEvent): Promise<void> {
  if (!plain(event.payload)) return;
  const payload = event.payload;
  const decisions: {id: string; operation: string; command: string; resource: string; reason: string; result: RunAuthorizationResult}[] = [];
  if (event.host === "codex" && event.transportMethod === "item/autoApprovalReview/completed") {
    if (!plain(payload.action) || !plain(payload.review) || typeof payload.reviewId !== "string")
      throw new AgentOpsError("RUN_AUTHORIZATION_PROTOCOL_INVALID", "Native approval notification has an invalid scope or identity.");
    const action = payload.action, review = payload.review;
    if (payload.decisionSource !== "agent" || !["approved", "denied", "timedOut", "aborted"].includes(String(review.status)) ||
      !["command", "execve", "writeStdin", "applyPatch", "networkAccess", "mcpToolCall", "requestPermissions"].includes(String(action.type)))
      throw new AgentOpsError("RUN_AUTHORIZATION_PROTOCOL_INVALID", "Native approval must expose a supported completed agent decision.");
    const status = review.status;
    decisions.push({id: payload.reviewId, operation: String(action.type), command: canonicalJson(action),
      resource: canonicalJson({cwd: action.cwd ?? null, host: action.host ?? null, target: action.target ?? null,
        files: action.files ?? null, server: action.server ?? null, permissions: action.permissions ?? null}),
      result: status === "approved" ? "auto-approved" : status === "denied" ? "denied" : "requires-host-approval",
      reason: typeof review.rationale === "string" && review.rationale.trim().length > 0 ? review.rationale : "Native review did not expose a rationale."});
  } else if (event.host === "claude") {
    const message = plain(payload.message) ? payload.message : null;
    if (message !== null && Array.isArray(message.content)) for (const item of message.content) {
      if (!plain(item) || item.type !== "tool_use" || typeof item.id !== "string" || typeof item.name !== "string" || !plain(item.input)) continue;
      decisions.push({id: "tool:" + item.id, operation: item.name, command: canonicalJson(item.input), resource: canonicalJson({tool: item.name}),
        result: "unknown", reason: "Claude exposed the requested tool scope but no per-command auto-mode decision or rationale."});
    }
    if (Array.isArray(payload.permission_denials)) for (const item of payload.permission_denials) {
      if (!plain(item)) continue;
      decisions.push({id: "denied:" + (typeof item.tool_use_id === "string" ? item.tool_use_id : sha256(canonicalJson(item))),
        operation: typeof item.tool_name === "string" ? item.tool_name : "native-permission",
        command: canonicalJson(item.tool_input ?? item), resource: canonicalJson({tool: item.tool_name ?? null}),
        result: "denied", reason: "Claude reported an explicit permission denial; no alternate execution is authorized."});
    }
  }
  if (decisions.length === 0) return;
  const state = await repository.read(event.runId);
  const worker = state?.workers.find(w => w.workerId === event.workerId);
  if (state?.policyBinding === undefined || worker?.generation !== event.generation || state.status !== "active" || state.disableRestart) return;
  if (event.host === "codex" && payload.threadId !== worker.nativeJobId)
    throw new AgentOpsError("RUN_AUTHORIZATION_STALE", "Native approval belongs to another thread.");
  const service = new RunControlService(repository);
  for (const decision of decisions) await service.recordAuthorization(event.runId, {...decision,
    authorizationId: decision.id, workerId: worker.workerId, generation: worker.generation, nativeSessionId: worker.nativeSessionId,
    source: event.host === "codex" ? "codex-auto-review" : "claude-auto-mode", commandDigest: sha256(decision.command),
    resourceDigest: sha256(decision.resource), policyConfigHash: state.policyBinding.configHash,
    runtimeHash: state.policyBinding.runtimeHash, policyArtifactDigest: state.policyBinding.artifactDigest, expiresAt: state.policyBinding.expiresAt});
}
