import type {OfficeSnapshot} from "./snapshot.js";

export interface SceneActor {
  readonly key: string;
  readonly kind: "coordinator" | "worker" | "reviewer" | "visitor";
  readonly x: number;
  readonly y: number;
  readonly alert: boolean;
  readonly label: string;
}

export interface SceneProp {
  readonly kind: "whiteboard" | "desk" | "bench" | "table" | "door" | "shelf" | "clock" | "plant";
  readonly x: number;
  readonly y: number;
  readonly key: string;
}

export interface SceneFloor {
  readonly key: string;
  readonly kind: "run" | "lobby";
  readonly title: string;
  readonly top: number;
  readonly props: readonly SceneProp[];
  readonly actors: readonly SceneActor[];
  /** Props and actors are in floor-local tiles; the floor starts at row `top`. Paper stack height per desk key. */
  readonly papers: Readonly<Record<string, number>>;
  readonly books: {readonly lit: number; readonly total: number};
  /** Remaining budget, 0..1; the clock hand sweeps it down. */
  readonly clock: number;
}

export interface SceneModel {
  readonly cols: number;
  readonly rows: number;
  readonly floors: readonly SceneFloor[];
  readonly dialogue: readonly string[];
}

/**
 * Pure snapshot -> scene mapping in tile units. Self-contained on purpose: the
 * page embeds this exact function with Function.prototype.toString, so it may
 * not reference imports or module-level values.
 */
export function sceneModel(snapshot: OfficeSnapshot): SceneModel {
  const COLS = 24, FLOOR_ROWS = 9, MAX_PAPERS = 8;
  // Zones per decision 4, in floor-local tiles.
  const ZONES: Record<string, {x: number; y: number}> = {
    planning: {x: 3, y: 3}, verifying: {x: 15, y: 3}, reviewing: {x: 15, y: 7}, integrating: {x: 21, y: 2}
  };
  const deskAt = (i: number) => ({x: 6 + i * 3, y: 5});
  const papersFor = (files: number) => Math.min(MAX_PAPERS, files);
  const floors: SceneFloor[] = [];
  const dialogue: string[] = [];
  snapshot.runs.forEach((run, index) => {
    const top = index * FLOOR_ROWS;
    const props: SceneProp[] = [
      {kind: "whiteboard", x: 2, y: 1, key: run.runId + ":planning"},
      {kind: "bench", x: 14, y: 2, key: run.runId + ":verifying"},
      {kind: "table", x: 14, y: 5, key: run.runId + ":reviewing"},
      {kind: "door", x: 22, y: 1, key: run.runId + ":integrating"},
      {kind: "shelf", x: 19, y: 1, key: run.runId + ":shelf"},
      {kind: "clock", x: 10, y: 1, key: run.runId + ":clock"}
    ];
    const papers: Record<string, number> = {};
    const actors: SceneActor[] = [];
    let lit = 0, total = 0;
    run.agents.slice(0, 3).forEach((agent, i) => {
      const desk = deskAt(i);
      const deskKey = run.runId + ":desk:" + agent.id;
      props.push({kind: "desk", x: desk.x, y: desk.y - 1, key: deskKey});
      papers[deskKey] = papersFor(agent.diff?.files ?? 0);
      const zone = ZONES[agent.phase];
      // Agents sharing a zone stand side by side; implementing or unknown sit at their own desk.
      const spot = zone === undefined ? {x: desk.x, y: desk.y} : {x: zone.x + i, y: zone.y + 1};
      actors.push({key: run.runId + ":" + agent.id, kind: agent.role, x: spot.x, y: spot.y,
        alert: agent.role === "coordinator" && run.questions.length > 0, label: agent.id});
      lit += agent.progress?.passed ?? 0;
      total += agent.progress?.total ?? 0;
      dialogue.push(`${run.title}: ${agent.role} ${agent.narration}.`);
    });
    run.reviewers.slice(0, 2).forEach((review, i) => actors.push({key: run.runId + ":review:" + review.slot, kind: "reviewer",
      x: 14 + i * 3, y: 7, alert: false, label: "reviewer " + review.slot}));
    if (run.questions.length > 0) dialogue.push(`${run.title}: waiting for your answer — ${run.questions[0]!.prompt}`);
    floors.push({key: run.runId, kind: "run", title: run.title + " [" + run.phase + "]", top, props, actors, papers,
      books: {lit, total}, clock: run.budget.limitMs > 0 ? run.budget.remainingMs / run.budget.limitMs : 0});
  });
  const top = snapshot.runs.length * FLOOR_ROWS;
  const props: SceneProp[] = [{kind: "door", x: 1, y: 1, key: "lobby:door"}, {kind: "table", x: 18, y: 5, key: "lobby:meeting"},
    {kind: "plant", x: 22, y: 3, key: "lobby:plant"}];
  const papers: Record<string, number> = {};
  const actors: SceneActor[] = [];
  snapshot.lobby.slice(0, 4).forEach((desk, i) => {
    const key = "lobby:desk:" + desk.name;
    props.push({kind: "desk", x: 4 + i * 3, y: 4, key});
    papers[key] = papersFor(desk.diff.files);
    actors.push({key: "lobby:" + desk.name, kind: "worker", x: 4 + i * 3, y: 5, alert: false, label: desk.name});
    dialogue.push(`Lobby: ${desk.name} ${desk.narration}.`);
  });
  snapshot.reviews.slice(0, 2).forEach((review, i) => actors.push({key: "lobby:review:" + review.slot, kind: "reviewer",
    x: 18 + i * 3, y: 7, alert: false, label: "reviewer " + review.slot}));
  floors.push({key: "lobby", kind: "lobby", title: "Lobby", top, props, actors, papers, books: {lit: 0, total: 0}, clock: 1});
  if (dialogue.length === 0) dialogue.push("The office is quiet. No agent is at work.");
  return {cols: COLS, rows: top + FLOOR_ROWS, floors, dialogue};
}
