import {sceneModel} from "./scene.js";

/** Warm cream, oak and sage colors, kept to a single 16-color pixel palette. */
export const PALETTE = ["#2b241f", "#355a4b", "#6d9275", "#b7c7a3", "#8a5033", "#c18352", "#d9aa72", "#ead8b8",
  "#8e7561", "#6b5d50", "#adc39a", "#f2e5c9", "#e8c99c", "#c86f4a", "#f2c95c", "#fff7e6"];

/** Every sprite is a character matrix: one hex digit per palette index. */
export const SPRITES: Readonly<Record<string, readonly string[]>> = {
  person: [
    "................", "......8888......", ".....888888.....", ".....8ffff8.....",
    ".....f0ff0f.....", ".....ffffff.....", "......f44f......", ".....SSSSSS.....", "....SSSSSSSS....",
    "....fSSSSSSf....", "....fSSSSSSf....", ".....SSSSSS.....", ".....11..11.....", ".....11..11.....",
    ".....11..11.....", "....000..000...."
  ],
  step: [
    "................", "......8888......", ".....888888.....", ".....8ffff8.....", ".....f0ff0f.....",
    ".....ffffff.....", "......f44f......", ".....SSSSSS.....", "....SSSSSSSS....", "....fSSSSSSf....",
    "....fSSSSSSf....", ".....SSSSSS.....", "......1111......", ".....11..11.....", "....11....11....",
    "...000....000..."
  ],
  desk: [
    "..........88888888..............", "..........81111118..............", "..........81bb1b18..............",
    "..........81111118..............", "..........88888888..............", ".............8888...............",
    "00000000000000000000000000000000", "0eeeeeeeeeeeeeeeeeeeeeeeeeeeeee0", "06666666666666666666666666666660",
    "06666666666666666666666666666660", "00000000000000000000000000000000", "060..........................060",
    "060..........................060", "060..........................060", "060..........................060", "000..........................000"
  ],
  whiteboard: [
    "00000000000000000000000000000000", "0ffffffffffffffffffffffffffffff0", "0ff11f1111fffff44f4fffff22fffff0",
    "0ffffffffffffffffffffffffffffff0", "0ff1111f11ff44444fffff2222fffff0", "0ffffffffffffffffffffffffffffff0",
    "0ff11111ffff444fffff22fffffffff0", "0ffffffffffffffffffffffffffffff0", "0ffffffffffffffffffffffffffffff0",
    "00000000000000000000000000000000", "0777777777777777777777777777777.", "..............0880..............",
    "..............0880..............", "..............0880..............", "..............0880..............", "............00000000............"
  ],
  bench: [
    "......b.........a.........d.....", ".....0b0.......0a0.......0d0....", ".....0b0.......0a0.......0d0....",
    "....0bbb0.....0aaa0.....0ddd0...", "...0bbbbb0...0aaaaa0...0ddddd0..", "...0000000...0000000...0000000..",
    "00000000000000000000000000000000", "0ffffffffffffffffffffffffffffff0", "07777777777777777777777777777770",
    "00000000000000000000000000000000", "070888888888888888888888888880.0", "070..........................070",
    "070..........................070", "070..........................070", "070..........................070", "000..........................000"
  ],
  table: [
    "................................", "....000000000000000000000000....", "..0066666666666666666666666600..",
    ".06666666666666666666666666666..", "0666666ffff666666666ffff6666660.", "0666666ffff666666666ffff6666660.",
    "0666666666666666666666666666660.", ".066666666666666666666666666660.", "..0066666666666666666666666600..",
    "....000000000000000000000000....", "......060..............060......", "......060..............060......",
    "......060..............060......", "......060..............060......", "......000..............000......", "................................"
  ],
  door: [
    "0000000000000000", "0666666666666660", "0644444444444460", "0646666664666460", "0646666664666460",
    "0646666664666460", "0644444444444460", "0646666664666460", "0646666664666460", "06466666646ee460",
    "06466666646ee460", "0646666664666460", "0644444444444460", "0646666664666460", "0646666664666460",
    "0646666664666460", "0646666664666460", "0644444444444460", "0646666664666460", "0646666664666460",
    "0646666664666460", "0644444444444460", "0666666666666660", "0000000000000000", "0aaaaaaaaaaaaaa0",
    "0a2a2a2a2a2a2aa0", "0aaaaaaaaaaaaaa0", "0000000000000000"
  ],
  shelf: [
    "00000000000000000000000000000000", "06666666666666666666666666666660", "06............................60",
    "06............................60", "06............................60", "06............................60", "06............................60",
    "06............................60", "06............................60", "06666666666666666666666666666660", "06............................60",
    "06............................60", "06............................60", "06............................60", "06............................60",
    "06............................60", "06............................60", "06666666666666666666666666666660", "00000000000000000000000000000000"
  ],
  book: ["SSS", "SfS", "SSS", "SSS", "SSS", "SSS", "SSS"],
  clock: [
    ".....000000.....", "...00ffffff00...", "..0ffff0ffff0...", ".0fffffffffff0..", ".0fffffffffff0..",
    "0ffffffffffffff0", "0f0ffffffffff0f0", "0ffffffffffffff0", "0ffffffffffffff0", ".0fffffffffff0..",
    ".0fffffffffff0..", "..0ffff0ffff0...", "...00ffffff00...", ".....000000.....", "................", "................"
  ],
  plant: [
    "......a..a......", "...a..aa.a..a...", "....aa2aa2aa....", "..a.2aa22aa2.a..", "...aa2a22a2aa...",
    "....2aa22aa2....", ".....2a22a2.....", "......2222......", ".....000000.....", ".....066660.....",
    ".....064460.....", "......0660......", "......0660......", "......0000......", "................", "................"
  ],
  paper: ["000000", "0ffff0", "000000"],
  alert: [".00.", "0ee0", "0ee0", "0ee0", "0ee0", ".00.", "0ee0", ".00."],
  floor: [
    "6666666666666666", "6666666666666666", "666666e666666666", "6666666666666666", "6666666666666666",
    "4444444444444444", "6666666666666666", "6666666666666666", "6666666666666e66", "6666666666666666",
    "6666666666666666", "4444444444444444", "6666666666666666", "6666e66666666666", "6666666666666666",
    "6666666666666666"
  ],
  wall: [
    "7777777777777777", "7777777777777777", "7777777777777777", "7777777777777777", "7777777777777777",
    "7777777777777777", "7777777777777777", "7777777777777777", "7777777777777777", "7777777777777777",
    "7777777777777777", "7777777777777777", "7777777777777777", "7777777777777777", "7777777777777777",
    "7777777777777777"
  ],
  baseboard: ["bbbbbbbbbbbbbbbb", "0000000000000000"]
};

const STYLE = String.raw`
:root{color-scheme:light}
*{box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{margin:0;background:#2b241f;color:#2b241f;font:clamp(12px,1.25vw,18px)/1.25 "Courier New",monospace}
button{font:inherit;color:inherit}
#app{height:100dvh;display:flex;flex-direction:column;overflow:hidden;background:#ead8b8}
#header{min-height:54px;display:flex;align-items:center;gap:12px;padding:8px 18px;background:#2b241f;color:#fff7e6;border-bottom:4px solid #8a5033;white-space:nowrap}
#brand{font-weight:bold;font-size:clamp(16px,2vw,26px);letter-spacing:.02em}
#crumb{flex:1;overflow:hidden;text-overflow:ellipsis;color:#f2e5c9}
#header button{border:2px solid #f2e5c9;background:#6d9275;color:#fff7e6;padding:5px 9px;cursor:pointer;box-shadow:2px 2px 0 #000}
#header button:hover,#header button:focus-visible{background:#adc39a;color:#2b241f;outline:3px solid #f2c95c;outline-offset:2px}
#header button[hidden]{display:none}
#live{color:#adc39a}
#wrap{min-height:0;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:8px 12px;overflow:hidden;background:#ead8b8}
#office{display:block;max-width:100%;max-height:calc(100dvh - 132px);width:auto;height:auto;image-rendering:pixelated;image-rendering:crisp-edges;border:4px solid #6b5d50;box-shadow:6px 6px 0 #8a5033;outline:none;cursor:pointer}
#office:focus-visible{outline:4px solid #f2c95c;outline-offset:4px}
#dialogue{width:min(90vw,1100px);min-height:2.25em;padding:6px 12px;background:#fff7e6;border:2px solid #8a5033;color:#2b241f;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#room-nav{width:min(94vw,1200px);display:flex;justify-content:center;gap:5px;min-height:28px;overflow:hidden}
#room-nav button{max-width:18ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:2px solid #8a5033;background:#f2e5c9;padding:3px 7px;cursor:pointer}
#room-nav button[aria-current=true]{background:#6d9275;color:#fff7e6;border-color:#2b241f}
#room-nav button:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
#status{position:fixed;z-index:4;inset:10% 50% auto auto;transform:translateX(50%);width:min(92vw,680px);max-height:78dvh;overflow:hidden;padding:16px;background:#fff7e6;border:4px solid #6b5d50;box-shadow:8px 8px 0 #2b241f;color:#2b241f}
#status[hidden]{display:none}
#status h2{margin:0 0 8px;color:#355a4b;font-size:1.25em}
#status p{margin:5px 0;overflow-wrap:anywhere}
#status ul{margin:5px 0;padding-left:22px}
#status li{overflow-wrap:anywhere}
#status .actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
#status code{display:inline-block;max-width:calc(100% - 74px);overflow-wrap:anywhere;white-space:pre-wrap;background:#f2e5c9;padding:2px 4px}
#status button{border:2px solid #2b241f;background:#d9aa72;padding:5px 10px;cursor:pointer}
#status button:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

const CLIENT = String.raw`
var PALETTE = __PALETTE__, SPRITES = __SPRITES__, T = 8, S = 2;
var sceneModel = __SCENE__;
var canvas = document.getElementById("office"), ctx = canvas.getContext("2d");
var dialogueBox = document.getElementById("dialogue"), statusBox = document.getElementById("status"), roomNav = document.getElementById("room-nav");
var crumb = document.getElementById("crumb"), backButton = document.getElementById("back"), recentButton = document.getElementById("recent");
var languageButton = document.getElementById("language"), live = document.getElementById("live");
var snapshot = null, model = null, positions = {}, frame = 0, lineIndex = 0, typed = 0, offline = false;
var mode = "overview", selectedKey = null, showRecent = false, detailPage = 0, dialogClose = null, detailTarget = null;
var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var STRINGS = {
  en: {overview:"Office overview", rooms:"rooms", people:"people", recent:"Recently completed", recentOn:"Hide completed", back:"Back to overview", connected:"● Connected", offline:"○ Reconnecting", quiet:"The office is quiet. No agent is at work.", enter:"Enter room", close:"Close", previous:"Previous", next:"Next", page:"Page", details:"Details", progress:"Progress", verify:"Verify", review:"Review", pending:"Pending", task:"Task", status:"Status", phase:"Phase", host:"Host", now:"Now", files:"Changed files", commands:"Commands", copy:"Copy", copied:"Copied", unknown:"unknown", unassigned:"unassigned", phases:{planning:"Planning", implementing:"Implementing", verifying:"Verifying", reviewing:"Reviewing", integrating:"Integrating", unknown:"Unassigned"}, statuses:{idle:"idle", running:"running", reviewing:"reviewing", verifying:"verifying", blocked:"blocked", delivered:"delivered", complete:"complete", unknown:"unknown", unassigned:"unassigned", pending:"pending"}},
  zh: {overview:"辦公室總覽", rooms:"個房間", people:"位成員", recent:"最近完成", recentOn:"隱藏已完成", back:"返回總覽", connected:"● 已連線", offline:"○ 重新連線中", quiet:"辦公室很安靜，目前沒有成員工作。", enter:"進入房間", close:"關閉", previous:"上一頁", next:"下一頁", page:"頁", details:"詳細資料", progress:"進度", verify:"驗證", review:"審查", pending:"待回覆", task:"任務", status:"狀態", phase:"階段", host:"主機", now:"目前", files:"變更檔案", commands:"指令", copy:"複製", copied:"已複製", unknown:"未知", unassigned:"未分配", phases:{planning:"規劃", implementing:"開發", verifying:"驗證", reviewing:"審查", integrating:"整合", unknown:"未分配"}, statuses:{idle:"閒置", running:"工作中", reviewing:"審查中", verifying:"驗證中", blocked:"受阻", delivered:"已交付", complete:"已完成", unknown:"未知", unassigned:"未分配", pending:"待回覆"}}
};
function getLanguage(){
  try { var cookie = document.cookie.split(";").map(function(part){ return part.trim().split("="); }).find(function(pair){ return pair[0] === "agent-office-language"; }); if (cookie && (cookie[1] === "en" || cookie[1] === "zh")) return cookie[1]; } catch (_) {}
  try { var stored = localStorage.getItem("agent-office-language"); if (stored === "en" || stored === "zh") return stored; } catch (_) {}
  return (navigator.language || "en").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
}
var lang = getLanguage();
function t(key){ return STRINGS[lang][key] || key; }
function phaseLabel(phase){ return STRINGS[lang].phases[phase] || phase; }
function statusText(status){ return STRINGS[lang].statuses[status] || safeText(status); }
function outcomeText(value){ return value === "pending" ? t("pending") : safeText(value); }
function saveLanguage(){ try { localStorage.setItem("agent-office-language", lang); } catch (_) {} try { document.cookie = "agent-office-language=" + lang + "; Max-Age=31536000; Path=/; SameSite=Strict"; } catch (_) {} }
function safeText(value, fallback){ return typeof value === "string" && value.length ? value : (fallback || t("unknown")); }
function short(value, limit){ value = safeText(value); limit = limit || 22; return value.length > limit ? value.slice(0, limit - 1) + "…" : value; }
function draw(name, x, y, shirt){
  var rows = SPRITES[name]; if (!rows) return;
  var scale = name === "floor" || name === "wall" || name === "baseboard" ? 1 : S;
  for (var r = 0; r < rows.length; r++) for (var c = 0; c < rows[r].length; c++) {
    var ch = rows[r][c]; if (ch === ".") continue;
    ctx.fillStyle = ch === "S" ? shirt : PALETTE[parseInt(ch, 16)]; ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
  }
}
var SHIRTS = {coordinator:PALETTE[13], worker:PALETTE[2], reviewer:PALETTE[4], visitor:PALETTE[8]};
function propSize(kind){ var s = SPRITES[kind] || [""]; return {w:s[0].length * S, h:s.length * S}; }
function fillText(value, x, y, size, color){ ctx.fillStyle = color || PALETTE[0]; ctx.font = "bold " + (size || 10) + "px monospace"; ctx.textBaseline = "top"; ctx.fillText(short(value, 36), x, y); }
function roomByKey(key){ if (!model) return null; for (var i = 0; i < model.floors.length; i++) if (model.floors[i].key === key) return model.floors[i]; return null; }
function visibleRooms(){ if (!model) return []; return model.floors.filter(function(f){ return showRecent || !f.completedAt; }); }
function activeRoom(){ return selectedKey ? roomByKey(selectedKey) : null; }
function hasRecent(){ return !!(model && model.floors.some(function(f){ return !!f.completedAt; })); }
function drawBackdrop(cols, rows, room){
  canvas.width = cols * T; canvas.height = rows * T;
  for (var y = 0; y < rows; y++) for (var x = 0; x < cols; x++) draw(y < 5 ? "wall" : "floor", x * T, y * T);
  for (var bx = 0; bx < cols; bx++) draw("baseboard", bx * T, 5 * T - 2);
  ctx.fillStyle = PALETTE[0]; ctx.fillRect(0, rows * T - 3, cols * T, 3);
  ctx.fillStyle = "rgba(43,36,31,.12)"; ctx.fillRect(0, 5 * T, cols * T, 3);
}
function drawArea(area, floor){
  var active = floor.phase === area.phase;
  ctx.fillStyle = active ? "rgba(109,146,117,.45)" : "rgba(255,247,230,.35)";
  ctx.fillRect(area.x * T, area.y * T, area.width * T, area.height * T);
  ctx.strokeStyle = active ? PALETTE[1] : PALETTE[8]; ctx.lineWidth = active ? 2 : 1;
  ctx.strokeRect(area.x * T + 1, area.y * T + 1, area.width * T - 2, area.height * T - 2);
  fillText(phaseLabel(area.phase), area.x * T + 5, area.y * T + 5, 10, active ? PALETTE[1] : PALETTE[8]);
}
function drawBoard(floor){
  var x = 21 * T, y = 1 * T, w = 25 * T, h = 3 * T;
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(x, y, w, h); ctx.strokeStyle = PALETTE[4]; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
  var b = floor.board, total = b.total > 0 ? b.total : 1, ratio = Math.max(0, Math.min(1, b.passed / total));
  fillText(t("progress") + " " + b.passed + "/" + (b.total || "?"), x + 5, y + 3, 10, PALETTE[0]);
  ctx.fillStyle = PALETTE[3]; ctx.fillRect(x + 5, y + 16, w - 10, 6); ctx.fillStyle = PALETTE[2]; ctx.fillRect(x + 5, y + 16, Math.round((w - 10) * ratio), 6);
  fillText(t("verify") + ":" + b.verify + "  " + t("review") + ":" + b.review + "  !" + b.pending, x + 5, y + 25, 8, PALETTE[4]);
}
function drawRoomBase(floor){
  drawBackdrop(model.roomCols, model.roomRows, floor);
  floor.phaseAreas.forEach(function(a){ drawArea(a, floor); });
  drawBoard(floor);
  fillText(floor.title, 3 * T, 1 * T, 12, PALETTE[0]);
  fillText(statusText(floor.status), 3 * T, 3 * T, 8, PALETTE[4]);
  floor.props.forEach(function(p){
    var px = p.x * T, py = p.y * T, size = propSize(p.kind);
    if (p.kind !== "clock") { ctx.fillStyle = "rgba(43,36,31,.22)"; ctx.fillRect(px + 4, py + size.h - 2, Math.max(8, size.w - 3), 4); }
    draw(p.kind, px, py, PALETTE[2]);
    if (p.label && p.kind !== "desk") fillText(p.label, px + 3, py + size.h + 2, 8, PALETTE[0]);
    if (p.kind === "desk") for (var n = 0; n < (floor.papers[p.key] || 0); n++) draw("paper", px + 22 * S, py + 5 * S - n * 2 * S);
    if (p.kind === "clock") { var angle = -Math.PI / 2 + 2 * Math.PI * floor.clock; ctx.fillStyle = PALETTE[13]; for (var i = 0; i < 8; i++) ctx.fillRect(Math.round(px + 7 * S + Math.cos(angle) * i * S), Math.round(py + 7 * S + Math.sin(angle) * i * S), S, S); }
    if (p.kind === "shelf") { var total = Math.min(floor.books.total, 16); for (var b = 0; b < total; b++) draw("book", px + (3 + (b % 8) * 3) * S, py + (2 + Math.floor(b / 8) * 8) * S, b < floor.books.lit ? PALETTE[14] : PALETTE[8]); }
  });
}
function drawActor(floor, actor){
  var tx = actor.x * T, ty = actor.y * T, pos = positions[actor.key] || {x:tx, y:ty};
  if (reducedMotion) pos = {x:tx, y:ty}; else { pos = {x:pos.x === tx ? tx : pos.x + (tx > pos.x ? T : -T), y:pos.y === ty ? ty : pos.y + (ty > pos.y ? T : -T)}; }
  positions[actor.key] = pos;
  var walking = pos.x !== tx || pos.y !== ty;
  draw(walking && Math.floor(frame / 8) % 2 ? "step" : "person", pos.x, pos.y, SHIRTS[actor.kind] || PALETTE[2]);
  if (!walking && !reducedMotion && Math.floor(frame / 30) % 2 === 0) {
    ctx.fillStyle = PALETTE[14];
    if (actor.phase === "implementing") ctx.fillRect(pos.x + 8 * S, pos.y + 15 * S, 2 * S, S);
    if (actor.phase === "verifying") ctx.fillRect(pos.x + 10 * S, pos.y + 13 * S, S, 3 * S);
    if (actor.phase === "reviewing") ctx.fillRect(pos.x + 5 * S, pos.y + 16 * S, S, 2 * S);
    if (actor.phase === "integrating") ctx.fillRect(pos.x + 11 * S, pos.y + 9 * S, 2 * S, S);
  }
  var bubble = short(actor.label, 14) + " | " + short(actor.status, 14);
  var labelHeight = 13, labelWidth = Math.min(23 * T, Math.max(10 * T, bubble.length * 5)), labelY = pos.y + 20 * S;
  if (labelY + labelHeight > canvas.height) labelY = Math.max(5, pos.y - labelHeight - 2);
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(pos.x - 4, labelY, labelWidth, labelHeight);
  ctx.strokeStyle = PALETTE[4]; ctx.lineWidth = 1; ctx.strokeRect(pos.x - 4, labelY, labelWidth, labelHeight);
  fillText(bubble, pos.x, labelY + 2, 8, actor.alert ? PALETTE[13] : PALETTE[0]);
  if (actor.alert && (reducedMotion || Math.floor(frame / 20) % 2 === 0)) draw("alert", pos.x + 6 * S, pos.y - 8 * S);
}
function fitCanvas(){
  var maxW = Math.max(220, window.innerWidth - 30), maxH = Math.max(160, window.innerHeight - 132);
  var ratio = Math.min(maxW / canvas.width, maxH / canvas.height, 1.5);
  canvas.style.width = Math.max(1, Math.floor(canvas.width * ratio)) + "px"; canvas.style.height = Math.max(1, Math.floor(canvas.height * ratio)) + "px";
}
function drawOverviewRoom(floor){
  var box = floor.overview, x = box.x * T, y = box.y * T, w = box.width * T, h = box.height * T;
  ctx.fillStyle = floor.completedAt ? PALETTE[8] : PALETTE[15]; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = floor.completedAt ? PALETTE[4] : PALETTE[1]; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  fillText(floor.title, x + 5, y + 4, Math.max(7, Math.min(13, Math.floor(w / 18))), PALETTE[0]);
  fillText(phaseLabel(floor.phase) + " · " + short(statusText(floor.status), 12), x + 5, y + 17, Math.max(6, Math.min(10, Math.floor(w / 23))), PALETTE[4]);
  var barX = x + 5, barY = y + h - 15, barW = Math.max(10, w - 10), progress = floor.board.total > 0 ? floor.board.passed / floor.board.total : 0;
  ctx.fillStyle = PALETTE[3]; ctx.fillRect(barX, barY, barW, 5); ctx.fillStyle = PALETTE[2]; ctx.fillRect(barX, barY, Math.round(barW * progress), 5);
  var sx = box.width / model.roomCols, sy = box.height / model.roomRows;
  ctx.save(); ctx.beginPath(); ctx.rect(x + 2, y + 2, Math.max(1, w - 4), Math.max(1, h - 4)); ctx.clip();
  floor.phaseAreas.forEach(function(area){
    var ax = x + area.x * T * sx, ay = y + area.y * T * sy;
    ctx.fillStyle = floor.phase === area.phase ? "rgba(109,146,117,.4)" : "rgba(255,247,230,.25)"; ctx.fillRect(ax, ay, area.width * T * sx, area.height * T * sy);
    ctx.strokeStyle = floor.phase === area.phase ? PALETTE[1] : PALETTE[8]; ctx.lineWidth = 1; ctx.strokeRect(ax, ay, area.width * T * sx, area.height * T * sy);
  });
  floor.props.forEach(function(p){
    var px = x + p.x * T * sx, py = y + p.y * T * sy;
    if (p.kind === "clock") return;
    var scaleX = Math.max(.08, sx), scaleY = Math.max(.08, sy);
    ctx.save(); ctx.translate(px, py); ctx.scale(scaleX, scaleY); draw(p.kind, 0, 0, PALETTE[2]); ctx.restore();
  });
  floor.actors.forEach(function(a, i){
    var ax = x + a.x * T * sx, ay = y + a.y * T * sy;
    ctx.fillStyle = SHIRTS[a.kind] || PALETTE[2]; ctx.fillRect(ax, ay, 7, 8); ctx.fillStyle = PALETTE[8]; ctx.fillRect(ax + 1, ay - 4, 5, 4);
    if (a.alert) { ctx.fillStyle = PALETTE[14]; ctx.fillRect(ax + 8, ay - 7, 5, 6); }
  });
  ctx.restore();
  fillText(String(floor.actors.length) + " " + t("people"), x + 5, y + h - 25, Math.max(6, Math.min(9, Math.floor(w / 26))), PALETTE[1]);
}
function render(){
  if (!model) return;
  var floor = activeRoom();
  if (mode === "room" && floor) {
    drawRoomBase(floor); floor.actors.forEach(function(a){ drawActor(floor, a); });
  } else {
    drawBackdrop(model.cols, model.rows, null); visibleRooms().forEach(drawOverviewRoom);
    if (visibleRooms().length === 0) fillText(t("quiet"), 4 * T, 18 * T, 12, PALETTE[0]);
  }
  fitCanvas();
}
function updateHeader(){
  var rooms = visibleRooms(), people = rooms.reduce(function(n, f){ return n + f.actors.length; }, 0);
  crumb.textContent = mode === "room" && activeRoom() ? activeRoom().title : t("overview") + " · " + rooms.length + " " + t("rooms") + " · " + people + " " + t("people");
  backButton.hidden = mode !== "room"; backButton.textContent = "← " + t("back"); recentButton.textContent = (showRecent ? "✓ " + t("recentOn") : "▣ " + t("recent")) + (hasRecent() ? " (" + model.floors.filter(function(f){ return !!f.completedAt; }).length + ")" : "");
  languageButton.textContent = lang === "zh" ? "繁中 / EN" : "EN / 繁中"; live.textContent = offline ? t("offline") : t("connected");
  roomNav.textContent = "";
  if (mode === "overview") rooms.forEach(function(floor, index){ var button = document.createElement("button"); button.type = "button"; button.textContent = (index + 1) + ". " + floor.title; button.title = t("enter") + ": " + floor.title; button.setAttribute("aria-current", floor.key === selectedKey ? "true" : "false"); button.addEventListener("click", function(){ selectedKey = floor.key; enterRoom(); }); roomNav.appendChild(button); });
}
function tickDialogue(){
  if (!model) return;
  var lines = mode === "room" && activeRoom() ? [activeRoom().title + ": " + activeRoom().status].concat(model.dialogue) : model.dialogue;
  var line = offline ? t("offline") : lines[lineIndex % Math.max(1, lines.length)];
  typed = Math.min(line.length, typed + 2); dialogueBox.textContent = line.slice(0, typed);
  if (typed === line.length && frame % 180 === 0) { lineIndex++; typed = 0; }
}
function enterRoom(){ if (!selectedKey && visibleRooms()[0]) selectedKey = visibleRooms()[0].key; if (!selectedKey) return; mode = "room"; lineIndex = 0; typed = 0; updateHeader(); render(); canvas.focus(); }
function goOverview(){ mode = "overview"; updateHeader(); render(); canvas.focus(); }
function changeLanguage(){ lang = lang === "zh" ? "en" : "zh"; saveLanguage(); updateHeader(); render(); }
function showDialog(title, fill){
  statusBox.textContent = ""; var heading = document.createElement("h2"); heading.id = "status-title"; heading.textContent = title; statusBox.appendChild(heading); fill(statusBox);
  var actions = document.createElement("div"); actions.className = "actions";
  var close = document.createElement("button"); close.type = "button"; close.textContent = t("close"); close.addEventListener("click", closeDialog); actions.appendChild(close);
  statusBox.appendChild(actions); statusBox.hidden = false; dialogClose = close; close.focus();
}
function closeDialog(){ statusBox.hidden = true; if (dialogClose) { dialogClose = null; canvas.focus(); } }
function addLine(box, label, value){ var p = document.createElement("p"); p.textContent = label + ": " + safeText(value); box.appendChild(p); }
function addCommand(box, value){
  var row = document.createElement("p"), code = document.createElement("code"), button = document.createElement("button");
  code.textContent = value; button.type = "button"; button.textContent = t("copy"); button.addEventListener("click", function(){
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(function(){ button.textContent = t("copied"); }, function(){});
  }); row.appendChild(code); row.appendChild(button); box.appendChild(row);
}
function pageItems(items, box, renderItem){
  var pageSize = 5, pages = Math.max(1, Math.ceil(items.length / pageSize)); detailPage = Math.max(0, Math.min(detailPage, pages - 1));
  items.slice(detailPage * pageSize, detailPage * pageSize + pageSize).forEach(function(item){ renderItem(item, box); });
  var paging = document.createElement("div"); paging.className = "actions"; var page = document.createElement("span"); page.textContent = t("page") + " " + (detailPage + 1) + "/" + pages; paging.appendChild(page);
  if (pages > 1) { var previous = document.createElement("button"); previous.type = "button"; previous.textContent = t("previous"); previous.disabled = detailPage === 0; previous.addEventListener("click", function(){ detailPage--; openSelectedDetail(); }); var next = document.createElement("button"); next.type = "button"; next.textContent = t("next"); next.disabled = detailPage === pages - 1; next.addEventListener("click", function(){ detailPage++; openSelectedDetail(); }); paging.appendChild(previous); paging.appendChild(next); }
  box.appendChild(paging);
}
function sourceFor(floor){
  if (!snapshot) return null;
  if (floor.kind === "run") return snapshot.runs.find(function(r){ return r.runId === floor.key; }) || null;
  if (floor.kind === "desk") return floor.sourceIndex === null ? null : snapshot.lobby[floor.sourceIndex] || null;
  if (floor.kind === "review") return floor.sourceIndex === null ? null : snapshot.reviews[floor.sourceIndex] || null;
  return null;
}
function openActorDetail(floor, actor){
  var source = sourceFor(floor), items = [], entries = [];
  if (source && actor.kind !== "reviewer" && floor.kind === "run") { var found = source.agents.find(function(a){ return a.id === actor.id; }); if (found && found.diff) items = found.diff.paths || []; }
  if (source && floor.kind === "desk" && source.diff) items = source.diff.paths || [];
  items.forEach(function(item){ entries.push({kind:"file", value:item}); });
  if (source && source.commands) source.commands.forEach(function(item){ entries.push({kind:"command", value:item}); });
  if (!detailTarget || detailTarget.floorKey !== floor.key || detailTarget.actorKey !== actor.key) detailPage = 0;
  detailTarget = {floorKey: floor.key, actorKey: actor.key}; showDialog(actor.label, function(box){
    addLine(box, t("status"), statusText(actor.status)); addLine(box, t("phase"), phaseLabel(actor.phase)); addLine(box, t("task"), actor.taskId === "unassigned" ? t("unassigned") : actor.taskId); addLine(box, t("host"), actor.host); addLine(box, t("now"), actor.narration);
    if (actor.questionCount) addLine(box, t("pending"), String(actor.questionCount));
    if (actor.progress) addLine(box, t("progress"), actor.progress.passed + "/" + actor.progress.total + "  " + t("verify") + " " + outcomeText(actor.progress.verify || "-") + "  " + t("review") + " " + outcomeText(actor.progress.review || "-"));
    if (actor.questionCount && floor.questions.length) { floor.questions.forEach(function(question){ addLine(box, "! " + question.questionId, question.prompt); }); }
    if (entries.length) { var heading = document.createElement("p"); heading.textContent = t("files") + " / " + t("commands") + ":"; box.appendChild(heading); pageItems(entries, box, function(item, target){ if (item.kind === "command") addCommand(target, item.value); else { var li = document.createElement("p"); li.textContent = "• " + item.value; target.appendChild(li); } }); }
  });
}
function openRoomDetail(floor){
  if (!detailTarget || detailTarget.floorKey !== floor.key || detailTarget.actorKey !== null) detailPage = 0;
  detailTarget = {floorKey: floor.key, actorKey: null}; var source = sourceFor(floor), items = source && source.diff ? source.diff.paths || [] : [], entries = [];
  items.forEach(function(item){ entries.push({kind:"file", value:item}); });
  if (source && source.commands) source.commands.forEach(function(item){ entries.push({kind:"command", value:item}); });
  showDialog(floor.title, function(box){
    addLine(box, t("status"), statusText(floor.status)); addLine(box, t("phase"), phaseLabel(floor.phase)); addLine(box, t("task"), floor.board.taskId === "unassigned" ? t("unassigned") : floor.board.taskId); addLine(box, t("progress"), floor.board.passed + "/" + (floor.board.total || "?"));
    addLine(box, t("verify"), outcomeText(floor.board.verify)); addLine(box, t("review"), outcomeText(floor.board.review)); addLine(box, t("pending"), String(floor.board.pending));
    floor.questions.forEach(function(question){ addLine(box, "! " + question.questionId, question.prompt); });
    if (entries.length) { var heading = document.createElement("p"); heading.textContent = t("files") + " / " + t("commands") + ":"; box.appendChild(heading); pageItems(entries, box, function(item, target){ if (item.kind === "command") addCommand(target, item.value); else { var li = document.createElement("p"); li.textContent = "• " + item.value; target.appendChild(li); } }); }
  });
}
function openSelectedDetail(){
  var target = detailTarget, floor = target ? roomByKey(target.floorKey) : activeRoom(); if (!floor) return;
  if (target && target.actorKey) { var actor = floor.actors.find(function(a){ return a.key === target.actorKey; }); if (actor) return openActorDetail(floor, actor); }
  return openRoomDetail(floor);
}
function hitOverview(event){
  var rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * canvas.width / rect.width / T, y = (event.clientY - rect.top) * canvas.height / rect.height / T;
  return visibleRooms().find(function(f){ var b = f.overview; return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height; }) || null;
}
function hitActor(event, floor){
  var rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * canvas.width / rect.width, y = (event.clientY - rect.top) * canvas.height / rect.height;
  for (var i = floor.actors.length - 1; i >= 0; i--) { var a = floor.actors[i], pos = positions[a.key] || {x:a.x*T, y:a.y*T}; if (x >= pos.x - 5 && x < pos.x + 16*S && y >= pos.y - 5 && y < pos.y + 22*S) return a; }
  return null;
}
canvas.addEventListener("click", function(event){
  if (!model) return;
  if (mode === "overview") { var floor = hitOverview(event); if (floor) { selectedKey = floor.key; enterRoom(); } return; }
  var room = activeRoom(); if (!room) return; var actor = hitActor(event, room); if (actor) openActorDetail(room, actor); else openRoomDetail(room);
});
canvas.addEventListener("keydown", function(event){
  if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); if (!statusBox.hidden) closeDialog(); else if (mode === "room") goOverview(); return; }
  var rooms = visibleRooms(); if (!rooms.length) return;
  var index = Math.max(0, rooms.findIndex(function(f){ return f.key === selectedKey; }));
  if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); selectedKey = rooms[(index + 1) % rooms.length].key; updateHeader(); render(); }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); selectedKey = rooms[(index - 1 + rooms.length) % rooms.length].key; updateHeader(); render(); }
  if (event.key === "Enter" && mode === "overview") { event.preventDefault(); enterRoom(); }
  if (event.key === "Enter" && mode === "room") { event.preventDefault(); openSelectedDetail(); }
});
backButton.addEventListener("click", goOverview); recentButton.addEventListener("click", function(){ showRecent = !showRecent; if (!showRecent && activeRoom() && activeRoom().completedAt) mode = "overview"; updateHeader(); render(); });
languageButton.addEventListener("click", changeLanguage); statusBox.addEventListener("keydown", function(event){ if (event.key === "Escape") closeDialog(); });
function poll(){ fetch("snapshot.json" + location.search, {cache:"no-store"}).then(function(r){ if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function(s){ snapshot = s; model = sceneModel(s); offline = false; if (!selectedKey || !roomByKey(selectedKey)) selectedKey = visibleRooms()[0] && visibleRooms()[0].key; updateHeader(); render(); }, function(){ offline = true; updateHeader(); }); }
function loop(){ frame++; render(); tickDialogue(); requestAnimationFrame(loop); }
updateHeader(); poll(); setInterval(poll, 2000); window.addEventListener("resize", render); requestAnimationFrame(loop);
`;

/** One inline page; the nonce binds its only script and style under the server's CSP. */
export function officePage(nonce: string): string {
  const script = CLIENT.replace("__PALETTE__", () => JSON.stringify(PALETTE)).replace("__SPRITES__", () => JSON.stringify(SPRITES))
    .replace("__SCENE__", () => sceneModel.toString());
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>agent-ops Office</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div id="app"><header id="header"><div id="brand">agent-ops Office</div><div id="crumb">Office overview</div><button id="back" type="button" hidden>← Back to overview</button><button id="recent" type="button">▣ Recently completed</button><button id="language" type="button">繁中 / EN</button><span id="live" aria-live="polite">● Connected</span></header>
<main id="wrap"><canvas id="office" tabindex="0" width="576" height="304" aria-label="Office rooms; use arrow keys and Enter to explore"></canvas><div id="dialogue" role="status" aria-live="polite"></div><nav id="room-nav" aria-label="Office rooms"></nav></main></div>
<section id="status" role="dialog" aria-modal="true" aria-labelledby="status-title" tabindex="-1" hidden></section><script nonce="${nonce}">${script}</script></body></html>`;
}
