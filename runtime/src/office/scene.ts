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
  readonly kind: "whiteboard" | "desk" | "bench" | "table" | "door" | "shelf" | "clock" | "plant" | "rug" | "chair" | "window";
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
  /** The repository's name when the building spans several; null otherwise. */
  readonly repo: string | null;
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
  const ROOM_COLS = 72, ROOM_ROWS = 40, OVERVIEW_COLS = 80, OVERVIEW_ROWS = 38;
  const PHASES: readonly ScenePhase[] = ["planning", "implementing", "verifying", "reviewing", "integrating"];
  const labels: Record<string, string> = {
    planning: "Planning", implementing: "Implementing", verifying: "Verifying", reviewing: "Reviewing", integrating: "Integrating", unknown: "Unassigned"
  };
  const areas: Record<string, {x: number; y: number; width: number; height: number; prop: SceneProp["kind"]}> = {
    planning: {x: 3, y: 8, width: 17, height: 12, prop: "whiteboard"},
    implementing: {x: 3, y: 23, width: 29, height: 11, prop: "desk"},
    verifying: {x: 49, y: 8, width: 20, height: 12, prop: "bench"},
    reviewing: {x: 38, y: 23, width: 30, height: 11, prop: "table"},
    integrating: {x: 22, y: 34, width: 25, height: 5, prop: "door"}
  };
  const position = (phase: ScenePhase, index: number, count = 1): {x: number; y: number} => {
    const area = areas[phase] ?? areas.implementing;
    // Keep every actor inside the phase area, even when a run has many
    // workers in one phase. Fractional spacing compresses a crowd without
    // dropping actors or sending them through the room walls.
    const inset = 2, columns = Math.max(1, Math.min(count, Math.floor((area.width - inset * 2) / 3)));
    const rows = Math.max(1, Math.ceil(count / columns));
    const xSpan = Math.max(0, area.width - inset * 2), ySpan = Math.max(0, area.height - inset * 2);
    const column = index % columns, row = Math.floor(index / columns);
    return {x: area.x + inset + (columns === 1 ? xSpan * .35 : column * xSpan / (columns - 1)),
      y: area.y + inset + (rows === 1 ? ySpan * .55 : row * ySpan / (rows - 1))};
  };
  const progressOf = (value: unknown): SceneProgress | null => {
    if (value === null || typeof value !== "object") return null;
    const p = value as {passed?: unknown; total?: unknown; verify?: unknown; review?: unknown};
    return {passed: typeof p.passed === "number" ? p.passed : 0, total: typeof p.total === "number" ? p.total : 0,
      verify: p.verify === "PASS" || p.verify === "FAIL" ? p.verify : null, review: p.review === "PASS" || p.review === "FAIL" ? p.review : null};
  };
  const short = (value: string, limit = 18) => value.length > limit ? value.slice(0, limit - 6) + "…" + value.slice(-5) : value;
  const optional = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const boardFor = (progress: SceneProgress | null, status: string, taskId: string, pending: number): SceneBoard => ({
    passed: progress?.passed ?? 0, total: progress?.total ?? 0,
    verify: progress?.verify ?? "pending", review: progress?.review ?? "pending", pending, status, taskId
  });
  const floors: SceneFloor[] = [];
  const dialogue: string[] = [];
  // Two repositories may hold rooms with the same name; the repo keeps their keys apart.
  const repoOf = (value: unknown): string | null => {
    const repo = optional(value).repo;
    return typeof repo === "string" && repo.length > 0 ? repo : null;
  };
  const scoped = (repo: string | null, key: string): string => repo === null ? key : "repo:" + repo + "|" + key;
  const titled = (repo: string | null, title: string): string => repo === null ? title : repo + " · " + title;
  const makeAreas = (): ScenePhaseArea[] => PHASES.map(phase => {
    const area = areas[phase];
    return {phase, x: area.x, y: area.y, width: area.width, height: area.height, prop: area.prop, label: labels[phase]};
  });
  const makeProps = (key: string): SceneProp[] => [
    {kind: "window", x: 56, y: 1, key: key + ":window"},
    {kind: "whiteboard", x: 3, y: 10, key: key + ":planning", phase: "planning"},
    {kind: "desk", x: 5, y: 25, key: key + ":implementing", phase: "implementing"},
    {kind: "bench", x: 49, y: 10, key: key + ":verifying", phase: "verifying"},
    {kind: "table", x: 40, y: 25, key: key + ":reviewing", phase: "reviewing"},
    {kind: "desk", x: 24, y: 35, key: key + ":integrating", phase: "integrating"},
    {kind: "chair", x: 13, y: 30, key: key + ":chair"},
    {kind: "shelf", x: 2, y: 29, key: key + ":shelf"},
    {kind: "shelf", x: 34, y: 20, key: key + ":shelf-middle"},
    {kind: "plant", x: 2, y: 6, key: key + ":plant-left"},
    {kind: "plant", x: 22, y: 16, key: key + ":plant-middle"},
    {kind: "plant", x: 65, y: 6, key: key + ":plant-right"},
    {kind: "plant", x: 57, y: 34, key: key + ":plant-bottom"},
    {kind: "door", x: 65, y: 33, key: key + ":door"}
  ];
  const makeRun = (run: OfficeSnapshot["runs"][number], index: number): SceneFloor => {
    const extra = optional(run);
    const completedAt = typeof extra.completedAt === "string" ? extra.completedAt : null;
    const questions = run.questions;
    const repo = repoOf(run);
    const key = scoped(repo, run.runId);
    const props = makeProps(key);
    const actors: SceneActor[] = [];
    const papers: Record<string, number> = {[key + ":implementing"]: Math.min(8, run.agents.reduce((sum, agent) => sum + (agent.diff?.files ?? 0), 0))};
    let passed = 0, total = 0, verify: "PASS" | "FAIL" | null = null, review: "PASS" | "FAIL" | null = null;
    run.agents.forEach((agent, index) => {
      const phase = agent.phase;
      const p = progressOf(agent.progress);
      const phaseIndex = actors.filter(actor => actor.phase === phase).length;
      const phaseCount = run.agents.filter(candidate => candidate.phase === phase).length;
      const point = position(phase, phaseIndex, phaseCount);
      if ((phase === "implementing" || phase === "unknown") && phaseIndex > 0) {
        const deskKey = key + ":desk:" + agent.id;
        props.push({kind: "desk", x: point.x - 2, y: point.y - 5, key: deskKey, phase: "implementing", label: short(agent.id)});
        papers[deskKey] = Math.min(8, agent.diff?.files ?? 0);
      }
      passed += p?.passed ?? 0;
      total += p?.total ?? 0;
      if (p?.verify === "FAIL") verify = "FAIL";
      if (p?.review === "FAIL") review = "FAIL";
      actors.push({key: key + ":" + agent.id, id: agent.id, kind: agent.role, x: point.x, y: point.y, alert: agent.role === "coordinator" && questions.length > 0,
        label: short(agent.id), status: agent.status, phase, taskId: agent.taskId || "unassigned", progress: p,
        narration: agent.narration, questionCount: agent.role === "coordinator" ? questions.length : 0, host: "unknown"});
      dialogue.push(`${run.title}: ${agent.id} ${agent.narration}.`);
    });
    run.reviewers.forEach((reviewer, index) => {
      const reviewerIndex = actors.filter(actor => actor.phase === "reviewing").length;
      const reviewerCount = run.agents.filter(agent => agent.phase === "reviewing").length + run.reviewers.length;
      const point = position("reviewing", reviewerIndex, reviewerCount);
      actors.push({key: key + ":review:" + reviewer.slot, id: "reviewer " + reviewer.slot, kind: "reviewer", x: point.x, y: point.y, alert: false,
        label: "reviewer " + reviewer.slot, status: "reviewing", phase: "reviewing", taskId: reviewer.taskId ?? "unassigned",
        progress: null, narration: "reviewing", questionCount: 0, host: "unknown"});
    });
    if (verify === null && run.agents.length && run.agents.every(agent => agent.progress?.verify === "PASS")) verify = "PASS";
    if (review === null && run.agents.length && run.agents.every(agent => agent.progress?.review === "PASS")) review = "PASS";
    const rootProgress = {passed, total, verify, review};
    const taskId = run.agents.find(agent => agent.role === "coordinator")?.taskId ?? "unassigned";
    if (questions.length > 0) dialogue.push(`${run.title}: waiting for your answer — ${questions[0]!.prompt}`);
    return {key, sourceIndex: index, kind: "run", title: titled(repo, run.title), top: 0, props, actors, phaseAreas: makeAreas(), questions,
      board: boardFor(rootProgress, run.status, taskId, questions.length), papers, books: {lit: passed, total},
      clock: run.budget.limitMs > 0 ? run.budget.remainingMs / run.budget.limitMs : 0, phase: run.phase, status: run.status,
      completedAt, repo, overview: {x: 0, y: 0, width: 0, height: 0}};
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
    const repo = repoOf(desk);
    const key = scoped(repo, "session:" + [desk.sessionId || "unknown", desk.branch || "unknown", desk.name || "session"].join(":"));
    const props = makeProps(key);
    const point = position(phase, 0, 1);

    const host = typeof extra.host === "string" ? extra.host : "unknown";
    const actor: SceneActor = {key: key + ":actor", id: desk.name, kind: "worker", x: point.x, y: point.y, alert: questions.length > 0, label: short(desk.name), status,
      phase, taskId, progress: p, narration: desk.narration, questionCount: questions.length, host};
    if (questions.length > 0) dialogue.push(`${desk.name}: waiting for your answer.`);
    dialogue.push(`${desk.name}: ${desk.narration}.`);
    return {key, sourceIndex: index, kind: "desk", title: titled(repo, desk.name), top: 0, props, actors: [actor], phaseAreas: makeAreas(),
      board: boardFor(p, status, taskId, questions.length), questions, papers: {[key + ":implementing"]: Math.min(8, desk.diff.files)}, books: {lit: p?.passed ?? 0, total: p?.total ?? 0},
      clock: 1, phase, status, completedAt, repo, overview: {x: 0, y: 0, width: 0, height: 0}};
  };
  snapshot.runs.forEach((run, index) => floors.push(makeRun(run, index)));
  snapshot.lobby.forEach((desk, index) => floors.push(makeDesk(desk, index)));
  snapshot.reviews.forEach((review, index) => {
    const repo = repoOf(review);
    const key = scoped(repo, "review:" + review.slot + ":" + index);
    const props = makeProps(key);
    const point = position("reviewing", 0);
    const actor: SceneActor = {key: key + ":actor", id: "reviewer " + review.slot, kind: "reviewer", x: point.x, y: point.y, alert: false, label: "reviewer " + review.slot,
      status: "reviewing", phase: "reviewing", taskId: review.taskId ?? "unassigned", progress: null,
      narration: "reviewing", questionCount: 0, host: "unknown"};
    dialogue.push(`Review slot ${review.slot}: ${review.taskId ?? "unassigned"}.`);
    floors.push({key, sourceIndex: index, kind: "review", title: titled(repo, "Review slot " + review.slot), top: 0, props, actors: [actor], phaseAreas: makeAreas(), questions: [],
      board: boardFor(null, "reviewing", review.taskId ?? "unassigned", 0), papers: {}, books: {lit: 0, total: 0}, clock: 1,
      phase: "reviewing", status: "reviewing", completedAt: null, repo, overview: {x: 0, y: 0, width: 0, height: 0}});
  });
  // Rooms of one repository sit together; the sort is stable inside each.
  floors.sort((a, b) => (a.repo ?? "").localeCompare(b.repo ?? ""));
  if (dialogue.length === 0) dialogue.push("The office is quiet. No agent is at work.");
  const columns = floors.length === 0 ? 1 : Math.min(floors.length, Math.max(1, Math.ceil(Math.sqrt(floors.length * OVERVIEW_COLS / OVERVIEW_ROWS))));
  const rows = Math.max(1, Math.ceil(floors.length / columns));
  const gap = Math.max(0, Math.min(1, (OVERVIEW_COLS - columns) / (columns + 1), (OVERVIEW_ROWS - rows) / (rows + 1)));
  const cardWidth = Math.max(0.25, (OVERVIEW_COLS - gap * (columns + 1)) / columns);
  const cardHeight = Math.max(0.25, (OVERVIEW_ROWS - gap * (rows + 1)) / rows);
  floors.forEach((floor, index) => {
    const x = gap + (index % columns) * (cardWidth + gap), y = gap + Math.floor(index / columns) * (cardHeight + gap);
    (floor as {overview: SceneOverviewBox}).overview = {x, y, width: cardWidth, height: cardHeight};
  });
  return {cols: OVERVIEW_COLS, rows: OVERVIEW_ROWS, roomCols: ROOM_COLS, roomRows: ROOM_ROWS, floors, dialogue};
}
