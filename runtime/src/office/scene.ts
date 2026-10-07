import type {OfficeSnapshot} from "./snapshot.js";

export type ScenePhase = "planning" | "implementing" | "verifying" | "reviewing" | "integrating" | "unknown";

export interface SceneProgress {
  readonly passed: number;
  readonly total: number;
  readonly verify: "PASS" | "FAIL" | null;
  readonly review: "PASS" | "FAIL" | null;
}

export interface SceneActor {
  readonly key: string;
  readonly id: string;
  readonly kind: "coordinator" | "worker" | "reviewer" | "visitor";
  readonly x: number;
  readonly y: number;
  readonly alert: boolean;
  readonly label: string;
  readonly status: string;
  readonly phase: ScenePhase;
  readonly taskId: string;
  readonly progress: SceneProgress | null;
  readonly narration: string;
  readonly questionCount: number;
  readonly host: string;
}

export interface SceneProp {
  readonly kind: "whiteboard" | "desk" | "bench" | "table" | "door" | "shelf" | "clock" | "plant";
  readonly x: number;
  readonly y: number;
  readonly key: string;
  readonly phase?: ScenePhase;
  readonly label?: string;
}

export interface ScenePhaseArea {
  readonly phase: ScenePhase;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly prop: SceneProp["kind"];
  readonly label: string;
}

export interface SceneBoard {
  readonly passed: number;
  readonly total: number;
  readonly verify: "PASS" | "FAIL" | "pending";
  readonly review: "PASS" | "FAIL" | "pending";
  readonly pending: number;
  readonly status: string;
  readonly taskId: string;
}

export interface SceneOverviewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SceneFloor {
  readonly key: string;
  readonly sourceIndex: number | null;
  readonly kind: "run" | "desk" | "review";
  readonly title: string;
  readonly top: number;
  readonly props: readonly SceneProp[];
  readonly actors: readonly SceneActor[];
  readonly phaseAreas: readonly ScenePhaseArea[];
  readonly board: SceneBoard;
  readonly questions: readonly {readonly questionId: string; readonly prompt: string}[];
  /** Props and actors are in room-local tiles. Paper stack height per desk key. */
  readonly papers: Readonly<Record<string, number>>;
  readonly books: {readonly lit: number; readonly total: number};
  /** Remaining budget, 0..1; the clock hand sweeps it down. */
  readonly clock: number;
  readonly phase: ScenePhase;
  readonly status: string;
  readonly completedAt: string | null;
  readonly overview: SceneOverviewBox;
}

export interface SceneModel {
  readonly cols: number;
  readonly rows: number;
  readonly roomCols: number;
  readonly roomRows: number;
  readonly floors: readonly SceneFloor[];
  readonly dialogue: readonly string[];
}

/**
 * Pure snapshot -> scene mapping in tile units. Self-contained on purpose: the
 * page embeds this exact function with Function.prototype.toString, so it may
 * not reference imports or module-level values.
 */
export function sceneModel(snapshot: OfficeSnapshot): SceneModel {
  const ROOM_COLS = 64, ROOM_ROWS = 40, OVERVIEW_COLS = 72, OVERVIEW_ROWS = 38;
  const PHASES: readonly ScenePhase[] = ["planning", "implementing", "verifying", "reviewing", "integrating"];
  const labels: Record<string, string> = {
    planning: "Planning", implementing: "Implementing", verifying: "Verifying", reviewing: "Reviewing", integrating: "Integrating", unknown: "Unassigned"
  };
  const areas: Record<string, {x: number; y: number; width: number; height: number; prop: SceneProp["kind"]}> = {
    planning: {x: 2, y: 4, width: 15, height: 14, prop: "whiteboard"},
    implementing: {x: 18, y: 5, width: 18, height: 15, prop: "desk"},
    verifying: {x: 39, y: 4, width: 18, height: 14, prop: "bench"},
    reviewing: {x: 18, y: 22, width: 22, height: 15, prop: "table"},
    integrating: {x: 43, y: 22, width: 18, height: 15, prop: "door"}
  };
  const position = (phase: ScenePhase, index: number): {x: number; y: number} => {
    const area = areas[phase] ?? areas.implementing;
    return {x: area.x + 3 + (index % 3) * 5, y: area.y + 8 + Math.floor(index / 3) * 3};
  };
  const progressOf = (value: unknown): SceneProgress | null => {
    if (value === null || typeof value !== "object") return null;
    const p = value as {passed?: unknown; total?: unknown; verify?: unknown; review?: unknown};
    return {passed: typeof p.passed === "number" ? p.passed : 0, total: typeof p.total === "number" ? p.total : 0,
      verify: p.verify === "PASS" || p.verify === "FAIL" ? p.verify : null, review: p.review === "PASS" || p.review === "FAIL" ? p.review : null};
  };
  const short = (value: string, limit = 18) => value.length > limit ? value.slice(0, limit - 1) + "…" : value;
  const optional = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const boardFor = (progress: SceneProgress | null, status: string, taskId: string, pending: number): SceneBoard => ({
    passed: progress?.passed ?? 0, total: progress?.total ?? 0,
    verify: progress?.verify ?? "pending", review: progress?.review ?? "pending", pending, status, taskId
  });
  const floors: SceneFloor[] = [];
  const dialogue: string[] = [];
  const makeAreas = (): ScenePhaseArea[] => PHASES.map(phase => {
    const area = areas[phase];
    return {phase, x: area.x, y: area.y, width: area.width, height: area.height, prop: area.prop, label: labels[phase]};
  });
  const makeProps = (key: string): SceneProp[] => [
    {kind: "whiteboard", x: 2, y: 5, key: key + ":planning", phase: "planning", label: labels.planning},
    {kind: "desk", x: 18, y: 8, key: key + ":implementing", phase: "implementing", label: labels.implementing},
    {kind: "bench", x: 39, y: 6, key: key + ":verifying", phase: "verifying", label: labels.verifying},
    {kind: "table", x: 19, y: 25, key: key + ":reviewing", phase: "reviewing", label: labels.reviewing},
    {kind: "door", x: 45, y: 24, key: key + ":integrating", phase: "integrating", label: labels.integrating},
    {kind: "shelf", x: 1, y: 23, key: key + ":shelf"},
    {kind: "clock", x: 31, y: 1, key: key + ":clock"},
    {kind: "plant", x: 56, y: 5, key: key + ":plant"}
  ];
  const makeRun = (run: OfficeSnapshot["runs"][number]): SceneFloor => {
    const extra = optional(run);
    const completedAt = typeof extra.completedAt === "string" ? extra.completedAt : null;
    const questions = run.questions;
    const props = makeProps(run.runId);
    const actors: SceneActor[] = [];
    const papers: Record<string, number> = {};
    let passed = 0, total = 0, verify: "PASS" | "FAIL" | null = null, review: "PASS" | "FAIL" | null = null;
    run.agents.forEach((agent, index) => {
      const phase = agent.phase;
      const p = progressOf(agent.progress);
      const point = position(phase, index);
      const deskKey = run.runId + ":desk:" + agent.id;
      props.push({kind: "desk", x: point.x - 2, y: point.y - 5, key: deskKey, phase: phase === "unknown" ? "implementing" : phase, label: short(agent.id)});
      papers[deskKey] = Math.min(8, agent.diff?.files ?? 0);
      passed += p?.passed ?? 0;
      total += p?.total ?? 0;
      if (p?.verify === "FAIL") verify = "FAIL"; else if (p?.verify === "PASS" && verify === null) verify = "PASS";
      if (p?.review === "FAIL") review = "FAIL"; else if (p?.review === "PASS" && review === null) review = "PASS";
      actors.push({key: run.runId + ":" + agent.id, id: agent.id, kind: agent.role, x: point.x, y: point.y, alert: agent.role === "coordinator" && questions.length > 0,
        label: short(agent.id), status: agent.status, phase, taskId: agent.taskId || "unassigned", progress: p,
        narration: agent.narration, questionCount: agent.role === "coordinator" ? questions.length : 0, host: "unknown"});
      dialogue.push(`${run.title}: ${agent.id} ${agent.narration}.`);
    });
    run.reviewers.forEach((reviewer, index) => {
      const point = position("reviewing", index + run.agents.length);
      actors.push({key: run.runId + ":review:" + reviewer.slot, id: "reviewer " + reviewer.slot, kind: "reviewer", x: point.x, y: point.y, alert: false,
        label: "reviewer " + reviewer.slot, status: "reviewing", phase: "reviewing", taskId: reviewer.taskId ?? "unassigned",
        progress: null, narration: "reviewing", questionCount: 0, host: "unknown"});
    });
    const rootProgress = {passed, total, verify, review};
    const taskId = run.agents.find(agent => agent.role === "coordinator")?.taskId ?? "unassigned";
    if (questions.length > 0) dialogue.push(`${run.title}: waiting for your answer — ${questions[0]!.prompt}`);
    return {key: run.runId, sourceIndex: null, kind: "run", title: short(run.title, 34), top: 0, props, actors, phaseAreas: makeAreas(), questions,
      board: boardFor(rootProgress, run.status, taskId, questions.length), papers, books: {lit: passed, total},
      clock: run.budget.limitMs > 0 ? run.budget.remainingMs / run.budget.limitMs : 0, phase: run.phase, status: run.status,
      completedAt, overview: {x: 0, y: 0, width: 0, height: 0}};
  };
  const makeDesk = (desk: OfficeSnapshot["lobby"][number], index: number): SceneFloor => {
    const extra = optional(desk);
    const phase = extra.phase === "planning" || extra.phase === "implementing" || extra.phase === "verifying" || extra.phase === "reviewing" || extra.phase === "integrating" ? extra.phase : "unknown";
    const status = typeof extra.status === "string" ? extra.status : desk.narration;
    const taskId = typeof extra.taskId === "string" && extra.taskId.length > 0 ? extra.taskId : "unassigned";
    const p = progressOf(extra.progress);
    const questionsValue = Array.isArray(extra.questions) ? extra.questions : [];
    const questions = questionsValue.map(value => {
      const item = optional(value);
      return {questionId: typeof item.questionId === "string" ? item.questionId : "unknown", prompt: typeof item.prompt === "string" ? item.prompt : ""};
    });
    const completedAt = typeof extra.completedAt === "string" ? extra.completedAt : null;
    const key = "session:" + (desk.sessionId || desk.name);
    const props = makeProps(key);
    const point = position(phase, 0);
    const deskKey = key + ":desk";
    props.push({kind: "desk", x: point.x - 2, y: point.y - 5, key: deskKey, phase: phase === "unknown" ? "implementing" : phase, label: short(desk.name)});
    const host = typeof extra.host === "string" ? extra.host : "unknown";
    const actor: SceneActor = {key: key + ":actor", id: desk.name, kind: "worker", x: point.x, y: point.y, alert: questions.length > 0, label: short(desk.name), status,
      phase, taskId, progress: p, narration: desk.narration, questionCount: questions.length, host};
    if (questions.length > 0) dialogue.push(`${desk.name}: waiting for your answer.`);
    dialogue.push(`${desk.name}: ${desk.narration}.`);
    return {key, sourceIndex: index, kind: "desk", title: short(desk.name, 34), top: 0, props, actors: [actor], phaseAreas: makeAreas(),
      board: boardFor(p, status, taskId, questions.length), questions, papers: {[deskKey]: Math.min(8, desk.diff.files)}, books: {lit: p?.passed ?? 0, total: p?.total ?? 0},
      clock: 1, phase, status, completedAt, overview: {x: 0, y: 0, width: 0, height: 0}};
  };
  snapshot.runs.forEach(run => floors.push(makeRun(run)));
  snapshot.lobby.forEach((desk, index) => floors.push(makeDesk(desk, index)));
  snapshot.reviews.forEach((review, index) => {
    const key = "review:" + review.slot + ":" + index;
    const props = makeProps(key);
    const point = position("reviewing", 0);
    const actor: SceneActor = {key: key + ":actor", id: "reviewer " + review.slot, kind: "reviewer", x: point.x, y: point.y, alert: false, label: "reviewer " + review.slot,
      status: "reviewing", phase: "reviewing", taskId: review.taskId ?? "unassigned", progress: null,
      narration: "reviewing", questionCount: 0, host: "unknown"};
    dialogue.push(`Review slot ${review.slot}: ${review.taskId ?? "unassigned"}.`);
    floors.push({key, sourceIndex: index, kind: "review", title: "Review slot " + review.slot, top: 0, props, actors: [actor], phaseAreas: makeAreas(), questions: [],
      board: boardFor(null, "reviewing", review.taskId ?? "unassigned", 0), papers: {}, books: {lit: 0, total: 0}, clock: 1,
      phase: "reviewing", status: "reviewing", completedAt: null, overview: {x: 0, y: 0, width: 0, height: 0}});
  });
  if (dialogue.length === 0) dialogue.push("The office is quiet. No agent is at work.");
  const columns = floors.length === 0 ? 1 : Math.min(floors.length, Math.max(1, Math.ceil(Math.sqrt(floors.length * OVERVIEW_COLS / OVERVIEW_ROWS))));
  const rows = Math.max(1, Math.ceil(floors.length / columns));
  const gap = 1;
  const cardWidth = Math.max(1, Math.floor((OVERVIEW_COLS - gap * (columns + 1)) / columns));
  const cardHeight = Math.max(1, Math.floor((OVERVIEW_ROWS - gap * (rows + 1)) / rows));
  floors.forEach((floor, index) => {
    const x = gap + (index % columns) * (cardWidth + gap), y = gap + Math.floor(index / columns) * (cardHeight + gap);
    (floor as {overview: SceneOverviewBox}).overview = {x, y, width: cardWidth, height: cardHeight};
  });
  return {cols: OVERVIEW_COLS, rows: OVERVIEW_ROWS, roomCols: ROOM_COLS, roomRows: ROOM_ROWS, floors, dialogue};
}
