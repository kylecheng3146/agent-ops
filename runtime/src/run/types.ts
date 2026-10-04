export type NativeHostKind = "codex" | "claude";

export type NativeGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type UsageCompleteness = "complete" | "partial" | "unknown";


export interface UsageHighWater {
  readonly source: NativeHostKind | "review" | "verify";
  readonly epoch: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly completeness: UsageCompleteness;
  readonly observedAt: string;
}
