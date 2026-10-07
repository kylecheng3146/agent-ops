import {sceneModel} from "./scene.js";

/** The fixed 16-color palette, one hex digit per index. */
export const PALETTE = ["#000000", "#0000aa", "#00aa00", "#00aaaa", "#aa0000", "#aa00aa", "#aa5500", "#aaaaaa",
  "#555555", "#5555ff", "#55ff55", "#55ffff", "#ff5555", "#ff55ff", "#ffff55", "#ffffff"];

/**
 * Every sprite is a character matrix: one hex digit per palette index, "." is
 * transparent and "S" is the wearer's shirt. Drawn in code, no image assets.
 */
export const SPRITES: Readonly<Record<string, readonly string[]>> = {
  person: [
    "................",
    "......6666......",
    ".....666666.....",
    ".....6cccc6.....",
    ".....c0cc0c.....",
    ".....cccccc.....",
    "......c44c......",
    ".....SSSSSS.....",
    "....SSSSSSSS....",
    "....cSSSSSSc....",
    "....cSSSSSSc....",
    ".....SSSSSS.....",
    ".....11..11.....",
    ".....11..11.....",
    ".....11..11.....",
    "....000..000...."
  ],
  step: [
    "................",
    "......6666......",
    ".....666666.....",
    ".....6cccc6.....",
    ".....c0cc0c.....",
    ".....cccccc.....",
    "......c44c......",
    ".....SSSSSS.....",
    "....SSSSSSSS....",
    "....cSSSSSSc....",
    "....cSSSSSSc....",
    ".....SSSSSS.....",
    "......1111......",
    ".....11..11.....",
    "....11....11....",
    "...000....000..."
  ],
  desk: [
    "..........88888888..............",
    "..........81111118..............",
    "..........81bb1b18..............",
    "..........81111118..............",
    "..........88888888..............",
    ".............8888...............",
    "00000000000000000000000000000000",
    "0eeeeeeeeeeeeeeeeeeeeeeeeeeeeee0",
    "06666666666666666666666666666660",
    "06666666666666666666666666666660",
    "00000000000000000000000000000000",
    "060..........................060",
    "060..........................060",
    "060..........................060",
    "060..........................060",
    "000..........................000"
  ],
  whiteboard: [
    "00000000000000000000000000000000",
    "0ffffffffffffffffffffffffffffff0",
    "0ff11f1111fffff44f4fffff22fffff0",
    "0ffffffffffffffffffffffffffffff0",
    "0ff1111f11ff44444fffff2222fffff0",
    "0ffffffffffffffffffffffffffffff0",
    "0ff11111ffff444fffff22fffffffff0",
    "0ffffffffffffffffffffffffffffff0",
    "0ffffffffffffffffffffffffffffff0",
    "00000000000000000000000000000000",
    "0777777777777777777777777777777.",
    "..............0880..............",
    "..............0880..............",
    "..............0880..............",
    "..............0880..............",
    "............00000000............"
  ],
  bench: [
    "......b.........a.........d.....",
    ".....0b0.......0a0.......0d0....",
    ".....0b0.......0a0.......0d0....",
    "....0bbb0.....0aaa0.....0ddd0...",
    "...0bbbbb0...0aaaaa0...0ddddd0..",
    "...0000000...0000000...0000000..",
    "00000000000000000000000000000000",
    "0ffffffffffffffffffffffffffffff0",
    "07777777777777777777777777777770",
    "00000000000000000000000000000000",
    "070888888888888888888888888880.0",
    "070..........................070",
    "070..........................070",
    "070..........................070",
    "070..........................070",
    "000..........................000"
  ],
  table: [
    "................................",
    "....000000000000000000000000....",
    "..0066666666666666666666666600..",
    ".06666666666666666666666666666..",
    "0666666ffff666666666ffff6666660.",
    "0666666ffff666666666ffff6666660.",
    "0666666666666666666666666666660.",
    ".066666666666666666666666666660.",
    "..0066666666666666666666666600..",
    "....000000000000000000000000....",
    "......060..............060......",
    "......060..............060......",
    "......060..............060......",
    "......060..............060......",
    "......000..............000......",
    "................................"
  ],
  door: [
    "0000000000000000",
    "0666666666666660",
    "0644444444444460",
    "0646666664666460",
    "0646666664666460",
    "0646666664666460",
    "0644444444444460",
    "0646666664666460",
    "0646666664666460",
    "06466666646ee460",
    "06466666646ee460",
    "0646666664666460",
    "0644444444444460",
    "0646666664666460",
    "0646666664666460",
    "0646666664666460",
    "0646666664666460",
    "0644444444444460",
    "0646666664666460",
    "0646666664666460",
    "0646666664666460",
    "0646666664666460",
    "0644444444444460",
    "0666666666666660",
    "0000000000000000",
    "0aaaaaaaaaaaaaa0",
    "0a2a2a2a2a2a2aa0",
    "0aaaaaaaaaaaaaa0",
    "0000000000000000"
  ],
  shelf: [
    "00000000000000000000000000000000",
    "06666666666666666666666666666660",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06666666666666666666666666666660",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06............................60",
    "06666666666666666666666666666660",
    "00000000000000000000000000000000"
  ],
  book: ["SSS", "SfS", "SSS", "SSS", "SSS", "SSS", "SSS"],
  clock: [
    ".....000000.....",
    "...00ffffff00...",
    "..0ffff0ffff0...",
    ".0fffffffffff0..",
    ".0fffffffffff0..",
    "0ffffffffffffff0",
    "0f0ffffffffff0f0",
    "0ffffffffffffff0",
    "0ffffffffffffff0",
    ".0fffffffffff0..",
    ".0fffffffffff0..",
    "..0ffff0ffff0...",
    "...00ffffff00...",
    ".....000000.....",
    "................",
    "................"
  ],
  plant: [
    "......a..a......",
    "...a..aa.a..a...",
    "....aa2aa2aa....",
    "..a.2aa22aa2.a..",
    "...aa2a22a2aa...",
    "....2aa22aa2....",
    ".....2a22a2.....",
    "......2222......",
    ".....000000.....",
    ".....066660.....",
    ".....064460.....",
    "......0660......",
    "......0660......",
    "......0000......",
    "................",
    "................"
  ],
  paper: ["000000", "0ffff0", "000000"],
  alert: [".00.", "0ee0", "0ee0", "0ee0", "0ee0", ".00.", "0ee0", ".00."],
  floor: [
    "6666666666666666",
    "6666666666666666",
    "666666e666666666",
    "6666666666666666",
    "6666666666666666",
    "4444444444444444",
    "6666666666666666",
    "6666666666666666",
    "6666666666666e66",
    "6666666666666666",
    "6666666666666666",
    "4444444444444444",
    "6666666666666666",
    "6666e66666666666",
    "6666666666666666",
    "4444444444444444"
  ],
  wall: [
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333",
    "3333333333333333"
  ],
  baseboard: [
    "bbbbbbbbbbbbbbbb",
    "0000000000000000"
  ]
};

const STYLE = String.raw`
body{margin:0;background:#000;color:#fff;font:16px/1.3 "Courier New",monospace}
#wrap{display:flex;flex-direction:column;align-items:center;padding:12px}
canvas{image-rendering:pixelated;image-rendering:crisp-edges;cursor:pointer;border:4px double #aaa}
.box{background:#0000aa;border:4px double #fff;padding:10px 14px;box-shadow:4px 4px 0 #000}
#dialogue{margin-top:10px;min-height:3em;width:min(90vw,1152px);box-sizing:border-box;white-space:pre-wrap}
#status{position:fixed;top:8vh;left:50%;transform:translateX(-50%);width:min(92vw,720px);max-height:80vh;overflow:auto;display:none}
#status h2{margin:0 0 8px;font-size:18px;color:#ffff55}
#status ul{margin:4px 0;padding-left:20px}
#status code{background:#000;color:#55ff55;padding:1px 4px;word-break:break-all}
#status button{font:inherit;background:#aaa;color:#000;border:2px outset #fff;margin-left:6px;cursor:pointer}
.row{margin:6px 0}
`;

const CLIENT = String.raw`
var PALETTE = __PALETTE__, SPRITES = __SPRITES__, T = 16;
var sceneModel = __SCENE__;
var canvas = document.getElementById("office"), ctx = canvas.getContext("2d");
var dialogueBox = document.getElementById("dialogue"), statusBox = document.getElementById("status");
var snapshot = null, model = null, positions = {}, frame = 0, lineIndex = 0, typed = 0, offline = false;
function draw(name, x, y, shirt) {
  var rows = SPRITES[name];
  for (var r = 0; r < rows.length; r++) for (var c = 0; c < rows[r].length; c++) {
    var ch = rows[r][c];
    if (ch === ".") continue;
    ctx.fillStyle = ch === "S" ? shirt : PALETTE[parseInt(ch, 16)];
    ctx.fillRect(x + c, y + r, 1, 1);
  }
}
var SHIRTS = {coordinator: PALETTE[4], worker: PALETTE[2], reviewer: PALETTE[5], visitor: PALETTE[8]};
function propSize(kind) { var s = SPRITES[kind]; return {w: s[0].length, h: s.length}; }
function drawFloor(floor) {
  var top = floor.top * T;
  for (var y = 0; y < 9; y++) for (var x = 0; x < model.cols; x++) draw(y < 3 ? "wall" : "floor", x * T, top + y * T);
  for (var bx = 0; bx < model.cols; bx++) draw("baseboard", bx * T, top + 3 * T - 2);
  ctx.fillStyle = PALETTE[0]; ctx.fillRect(0, top + 9 * T - 2, model.cols * T, 2);
  ctx.fillStyle = PALETTE[15]; ctx.font = "8px monospace"; ctx.textBaseline = "top";
  ctx.fillText(floor.title.slice(0, 60), 4, top + 2);
  floor.props.forEach(function (p) {
    var px = p.x * T, py = top + p.y * T;
    if (p.kind === "clock") {
      draw("clock", px, py);
      var angle = -Math.PI / 2 + 2 * Math.PI * floor.clock;
      ctx.fillStyle = PALETTE[4];
      for (var i = 0; i < 5; i++) ctx.fillRect(Math.round(px + 7 + Math.cos(angle) * i), Math.round(py + 6 + Math.sin(angle) * i), 1, 1);
      return;
    }
    draw(p.kind, px, py);
    if (p.kind === "shelf") {
      var total = Math.min(floor.books.total, 16);
      for (var b = 0; b < total; b++) {
        var bx = px + 3 + (b % 8) * 3 + 1, by = py + 2 + Math.floor(b / 8) * 8;
        draw("book", bx, by, b < floor.books.lit ? PALETTE[14] : PALETTE[8]);
      }
    }
    if (p.kind === "desk") for (var n = 0; n < (floor.papers[p.key] || 0); n++) draw("paper", px + 22, py + 5 - n * 2);
  });
}
function step(current, target) { return current === target ? current : current + (target > current ? 1 : -1); }
function render() {
  if (model === null) return;
  canvas.width = model.cols * T; canvas.height = model.rows * T;
  var scale = Math.max(1, Math.min(3, Math.floor((window.innerWidth - 40) / canvas.width)));
  canvas.style.width = canvas.width * scale + "px"; canvas.style.height = canvas.height * scale + "px";
  model.floors.forEach(drawFloor);
  model.floors.forEach(function (floor) {
    floor.actors.forEach(function (a) {
      var tx = a.x * T, ty = (floor.top + a.y) * T, pos = positions[a.key] || {x: tx, y: ty};
      pos = {x: step(pos.x, tx), y: step(pos.y, ty)};
      positions[a.key] = pos;
      var walking = pos.x !== tx || pos.y !== ty;
      draw(walking && Math.floor(frame / 8) % 2 ? "step" : "person", pos.x, pos.y, SHIRTS[a.kind]);
      if (a.alert && Math.floor(frame / 20) % 2 === 0) draw("alert", pos.x + 6, pos.y - 10);
    });
  });
}
function tickDialogue() {
  if (model === null) return;
  var line = offline ? "The office is closed. Run agent-ops office to open it again." : model.dialogue[lineIndex % model.dialogue.length];
  typed = Math.min(line.length, typed + 2);
  dialogueBox.textContent = line.slice(0, typed);
  if (typed === line.length && frame % 180 === 0) { lineIndex++; typed = 0; }
}
function loop() { frame++; render(); tickDialogue(); requestAnimationFrame(loop); }
function poll() {
  fetch("snapshot.json" + location.search, {cache: "no-store"}).then(function (r) {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }).then(function (s) { snapshot = s; model = sceneModel(s); offline = false; }, function () { offline = true; });
}
function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; }
function command(list, text) {
  var row = el("div"); row.className = "row";
  var code = el("code", text), button = el("button", "Copy");
  button.addEventListener("click", function () {
    navigator.clipboard.writeText(text).then(function () { button.textContent = "Copied"; }, function () {
      var range = document.createRange(); range.selectNodeContents(code);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
  });
  row.appendChild(code); row.appendChild(button); list.appendChild(row);
}
function diffRows(box, diff) {
  if (!diff) { box.appendChild(el("div", "Changed files: unknown")); return; }
  box.appendChild(el("div", "Changed files: " + diff.files + " (+" + diff.insertions + " -" + diff.deletions + ")"));
  var ul = el("ul");
  diff.paths.slice(0, 20).forEach(function (p) { ul.appendChild(el("li", p)); });
  if (diff.paths.length > 20) ul.appendChild(el("li", "... " + (diff.paths.length - 20) + " more"));
  box.appendChild(ul);
}
function show(title, fill) {
  statusBox.textContent = "";
  statusBox.appendChild(el("h2", title));
  fill(statusBox);
  var close = el("button", "Close"); close.addEventListener("click", function () { statusBox.style.display = "none"; });
  statusBox.appendChild(close);
  statusBox.style.display = "block";
}
function runDetails(run, agent) {
  show(agent ? agent.role + " " + agent.id : run.title, function (box) {
    box.appendChild(el("div", "Run: " + run.runId + "  status " + run.status + "  phase " + run.phase));
    box.appendChild(el("div", "Budget left: " + Math.round(run.budget.remainingMs / 60000) + " of " + Math.round(run.budget.limitMs / 60000) + " min"));
    var agents = agent ? [agent] : run.agents;
    agents.forEach(function (a) {
      box.appendChild(el("h2", a.id));
      box.appendChild(el("div", "Task: " + a.taskId + "  phase " + a.phase + "  status " + a.status));
      var p = a.progress;
      box.appendChild(el("div", p ? "Criteria: " + p.passed + "/" + p.total + "  verify " + (p.verify || "-") + "  review " + (p.review || "-") : "Criteria: unknown"));
      box.appendChild(el("div", "Now: " + a.narration));
      diffRows(box, a.diff);
    });
    run.questions.forEach(function (q) { box.appendChild(el("div", "! Question " + q.questionId + ": " + q.prompt)); });
    run.commands.forEach(function (c) { command(box, c); });
  });
}
canvas.addEventListener("click", function (event) {
  if (model === null || snapshot === null) return;
  var rect = canvas.getBoundingClientRect();
  var x = (event.clientX - rect.left) * canvas.width / rect.width, y = (event.clientY - rect.top) * canvas.height / rect.height;
  for (var f = 0; f < model.floors.length; f++) {
    var floor = model.floors[f], run = snapshot.runs.find(function (r) { return r.runId === floor.key; });
    for (var i = 0; i < floor.actors.length; i++) {
      var a = floor.actors[i], pos = positions[a.key];
      if (!pos || x < pos.x || x >= pos.x + T || y < pos.y || y >= pos.y + T) continue;
      if (a.kind === "reviewer") {
        var slot = (run ? run.reviewers : snapshot.reviews).find(function (r) { return "reviewer " + r.slot === a.label; });
        return show(a.label, function (box) {
          box.appendChild(el("div", "Task: " + (slot && slot.taskId || "unknown")));
          box.appendChild(el("div", "Reviewing since: " + (slot ? slot.since : "unknown")));
          command(box, "agent-ops review show --task " + (slot && slot.taskId || "<task-id>"));
        });
      }
      if (run) return runDetails(run, run.agents.find(function (g) { return g.id === a.label; }));
      var desk = snapshot.lobby.find(function (d) { return d.name === a.label; });
      if (desk) return show(desk.name, function (box) {
        box.appendChild(el("div", "Branch: " + desk.branch + "  session " + desk.sessionId));
        box.appendChild(el("div", "Now: " + desk.narration));
        diffRows(box, desk.diff);
        desk.commands.forEach(function (c) { command(box, c); });
      });
    }
    for (var j = 0; j < floor.props.length; j++) {
      var p = floor.props[j], size = propSize(p.kind), px = p.x * T, py = (floor.top + p.y) * T;
      if (x < px || x >= px + size.w || y < py || y >= py + size.h) continue;
      if (run) return runDetails(run);
    }
  }
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape") statusBox.style.display = "none"; });
poll(); setInterval(poll, 2000); requestAnimationFrame(loop);
`;

/** One inline page; the nonce binds its only script and style under the server's CSP. */
export function officePage(nonce: string): string {
  // Replacer functions: "$" sequences in the embedded source must stay literal.
  const script = CLIENT.replace("__PALETTE__", () => JSON.stringify(PALETTE)).replace("__SPRITES__", () => JSON.stringify(SPRITES))
    .replace("__SCENE__", () => sceneModel.toString());
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>agent-ops office</title>
<style nonce="${nonce}">${STYLE}</style></head>
<body><div id="wrap"><canvas id="office" width="384" height="144" aria-label="Office view of every agent in this repository"></canvas>
<div id="dialogue" class="box" role="status" aria-live="polite"></div></div>
<div id="status" class="box" role="dialog" aria-label="Status"></div>
<script nonce="${nonce}">${script}</script></body></html>`;
}
