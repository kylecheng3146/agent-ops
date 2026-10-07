import {sceneModel} from "./scene.js";

/** Warm cream, oak and sage colors, kept to a single 16-color pixel palette. */
export const PALETTE = ["#2b241f", "#355a4b", "#6d9275", "#b7c7a3", "#8a5033", "#c18352", "#d9aa72", "#ead8b8",
  "#8e7561", "#6b5d50", "#adc39a", "#f2e5c9", "#e8c99c", "#c86f4a", "#f2c95c", "#fff7e6"];

/** Every sprite is a character matrix: one hex digit per palette index. */
export const SPRITES: Readonly<Record<string, readonly string[]>> = {
  person: [
    "..................", "....8888888888....", "...888888888888...", "..888cccccc8888...",
    "..88c0cccc0c88....", "..88cccccccc88....", "...88cccccc88.....", "....cccccccc......",
    "...cSSSSSSSSSc....", "..cSSSSSSSSSSSc...", "..cSSSSSSSSSSSc...", "...SSSSSSSSSSSS...",
    "....SSSSSSSSSS....", "....ccSSSScc......", ".....999999.......", "....99999999......",
    "....99....99......", "...999....999.....", "...999....999.....", "..9999....9999...."
  ],
  step: [
    "..................", "....8888888888....", "...888888888888...", "..888cccccc8888...",
    "..88c0cccc0c88....", "..88cccccccc88....", "...88cccccc88.....", "....cccccccc......",
    "...cSSSSSSSSSc....", "..cSSSSSSSSSSSc...", "..cSSSSSSSSSSSc...", "...SSSSSSSSSSSS...",
    "....SSSSSSSSSS....", "....ccSSSScc......", ".....999999.......", "....99999999......",
    ".....99999........", "....999999........", "...999....999.....", "..9999....9999...."
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
  rug: [
    "000000000000000000000000", "0aaaaaaaaaaaaaaaaaaaaaa0", "0a22222222222222222222a0", "0a22222222222222222222a0",
    "0a22222222222222222222a0", "0a22222222222222222222a0", "0a22222222222222222222a0", "0a22222222222222222222a0",
    "0a22222222222222222222a0", "0a22222222222222222222a0", "0a22222222222222222222a0", "0a22222222222222222222a0",
    "0a22222222222222222222a0", "0a22222222222222222222a0", "0aaaaaaaaaaaaaaaaaaaaaa0", "000000000000000000000000"
  ],
  chair: [
    "....000000....", "...06666660...", "...06666660...", "...06666660...", "....000000....", "....066660....",
    "....066660....", "....066660....", "....000000....", "...000..000...", "...060..060...", "...060..060...",
    "..0000..0000..", ".............."
  ],
  window: [
    "000000000000000000000000", "0bbbbbbbbbbbbbbbbbbbbbb0", "0bffffffffffffffffffffb0", "0bffffffff0000ffffffffb0",
    "0bffffffff0000ffffffffb0", "0bffffffffffffffffffffb0", "0bffffffffffffffffffffb0", "000000000000000000000000"
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
    "7777777777777777", "6666666666666666", "666666b666666666", "66666666666b6666", "7777777777777777",
    "6666666666666666", "6666b66666666666", "6666666666666666", "7777777777777777", "6666666666666666",
    "6666666666666b66", "6666666666666666", "7777777777777777", "666666b666666666", "6666666666666666",
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
#wrap{min-height:0;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:4px;padding:4px 8px;overflow:hidden;background:#ead8b8}
#office{display:block;max-width:100%;max-height:none;width:auto;height:auto;image-rendering:pixelated;image-rendering:crisp-edges;border:4px solid #6b5d50;box-shadow:6px 6px 0 #8a5033;outline:none;cursor:pointer}
#office:focus-visible{outline:4px solid #f2c95c;outline-offset:4px}
#dialogue{width:min(90vw,1100px);min-height:2.25em;padding:6px 12px;background:#fff7e6;border:2px solid #8a5033;color:#2b241f;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#room-nav{width:min(94vw,1200px);display:flex;justify-content:center;align-items:center;gap:5px;min-height:28px;overflow:hidden}
#room-nav button{max-width:18ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:2px solid #8a5033;background:#f2e5c9;padding:3px 7px;cursor:pointer}
#room-nav button[aria-current=true]{background:#6d9275;color:#fff7e6;border-color:#2b241f}
#room-nav button:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
#status{position:fixed;z-index:4;inset:6dvh 50% auto auto;transform:translateX(50%);width:min(92vw,680px);max-height:88dvh;overflow:hidden;display:flex;flex-direction:column;gap:4px;padding:16px;background:#fff7e6;border:4px solid #6b5d50;box-shadow:8px 8px 0 #2b241f;color:#2b241f}
#status[hidden]{display:none}
#status h2{margin:0 0 8px;color:#355a4b;font-size:1.25em}
#status .dialog-body{min-height:0;overflow:hidden}
#status p{margin:5px 0;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
#status ul{margin:5px 0;padding-left:22px}
#status li{overflow-wrap:anywhere}
#status .actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
#status>.actions{flex:0 0 auto}
#status code{display:inline-block;max-width:calc(100% - 74px);overflow-wrap:anywhere;white-space:pre-wrap;background:#f2e5c9;padding:2px 4px}
#status .dialog-pager{border-top:2px solid #d9aa72;padding-top:6px}
#status button{border:2px solid #2b241f;background:#d9aa72;padding:5px 10px;cursor:pointer}
#status button:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

const CLIENT = String.raw`
var PALETTE = __PALETTE__, SPRITES = __SPRITES__, T = 8, S = 2, U = 1, dpr = 1;
var sceneModel = __SCENE__;
var canvas = document.getElementById("office"), ctx = canvas.getContext("2d"), app = document.getElementById("app");
ctx.imageSmoothingEnabled = false;
var dialogueBox = document.getElementById("dialogue"), statusBox = document.getElementById("status"), roomNav = document.getElementById("room-nav"), wrap = document.getElementById("wrap");
var crumb = document.getElementById("crumb"), backButton = document.getElementById("back"), recentButton = document.getElementById("recent");
var languageButton = document.getElementById("language"), live = document.getElementById("live");
var snapshot = null, model = null, positions = {}, roomCanvases = {}, frame = 0, lineIndex = 0, typed = 0, offline = false;
var mode = "overview", selectedKey = null, showRecent = false, detailPage = 0, dialogClose = null, detailPreviousFocus = null, detailTarget = null;
var navPage = 0, navSignature = "", NAV_PAGE_SIZE = 8;
var supervisor = {x:43, y:19, targetX:43, targetY:19}, supervisorReady = false, hallwayReturn = null;
var roomSupervisor = {x:32, y:34, targetX:32, targetY:34};
var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var STRINGS = {
  en: {overview:"Office overview", rooms:"rooms", people:"people", recent:"Recently completed", recentOn:"Hide completed", back:"Back to overview", connected:"● Connected", offline:"○ Reconnecting", quiet:"The office is quiet. No agent is at work.", waiting:"waiting for your answer", enter:"Enter room", close:"Close", previous:"Previous", next:"Next", page:"Page", details:"Details", progress:"Progress", verify:"Verify", review:"Review", pending:"Pending", task:"Task", status:"Status", phase:"Phase", host:"Host", now:"Now", files:"Changed files", commands:"Commands", copy:"Copy", copied:"Copied", unknown:"unknown", unassigned:"unassigned", phases:{planning:"Planning", implementing:"Implementing", verifying:"Verifying", reviewing:"Reviewing", integrating:"Integrating", unknown:"Unassigned"}, statuses:{idle:"idle", running:"running", reviewing:"reviewing", verifying:"verifying", blocked:"blocked", delivered:"delivered", complete:"complete", unknown:"unknown", unassigned:"unassigned", pending:"pending"}},
  zh: {overview:"辦公室總覽", rooms:"個房間", people:"位成員", recent:"最近完成", recentOn:"隱藏已完成", back:"返回總覽", connected:"● 已連線", offline:"○ 重新連線中", quiet:"辦公室很安靜，目前沒有成員工作。", waiting:"等待你的回覆", enter:"進入房間", close:"關閉", previous:"上一頁", next:"下一頁", page:"頁", details:"詳細資料", progress:"進度", verify:"驗證", review:"審查", pending:"待回覆", task:"任務", status:"狀態", phase:"階段", host:"主機", now:"目前", files:"變更檔案", commands:"指令", copy:"複製", copied:"已複製", unknown:"未知", unassigned:"未分配", phases:{planning:"規劃", implementing:"開發", verifying:"驗證", reviewing:"審查", integrating:"整合", unknown:"未分配"}, statuses:{idle:"閒置", running:"工作中", reviewing:"審查中", verifying:"驗證中", blocked:"受阻", delivered:"已交付", complete:"已完成", unknown:"未知", unassigned:"未分配", pending:"待回覆"}}
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
function localizeText(value){
  var text = safeText(value);
  if (text === "The office is quiet. No agent is at work.") return t("quiet");
  if (text === "waiting for your answer") return t("waiting");
  if (text === "reviewing") return phaseLabel("reviewing");
  if (text === "planning" || text === "implementing" || text === "verifying" || text === "integrating") return phaseLabel(text);
  if (STRINGS.en.statuses[text]) return statusText(text);
  return text.replace(/waiting for your answer/gu, t("waiting"));
}
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
function fillText(value, x, y, size, color){ ctx.fillStyle = color || PALETTE[0]; ctx.font = "bold " + Math.max(5, Math.round((size || 10) * U)) + "px monospace"; ctx.textBaseline = "top"; ctx.fillText(short(value, 36), x, y); }
function roomByKey(key){ if (!model) return null; for (var i = 0; i < model.floors.length; i++) if (model.floors[i].key === key) return model.floors[i]; return null; }
function visibleRooms(){ if (!model) return []; return model.floors.filter(function(f){ return showRecent || !f.completedAt; }); }
function activeRoom(){ return selectedKey ? roomByKey(selectedKey) : null; }
function hasRecent(){ return !!(model && model.floors.some(function(f){ return !!f.completedAt; })); }
function drawBackdrop(cols, rows, room){
  canvas.width = cols * T; canvas.height = rows * T; ctx.imageSmoothingEnabled = false;
  var width = cols * T, wallHeight = 5 * T;
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(0, 0, width, wallHeight);
  ctx.fillStyle = PALETTE[7]; ctx.fillRect(0, wallHeight, width, rows * T - wallHeight);
  // Quiet staggered oak planks: a few long grain lines are clearer and much
  // cheaper than stamping a tiny texture sprite into every tile each frame.
  for (var plank = 5; plank < rows; plank += 3) {
    ctx.fillStyle = PALETTE[6]; ctx.fillRect(0, plank * T, width, Math.max(1, Math.round(U)));
    ctx.fillStyle = PALETTE[12];
    var offset = ((plank - 5) / 3 % 2) * 8;
    for (var seam = offset; seam < cols; seam += 8) ctx.fillRect(seam * T, plank * T + Math.max(1, Math.round(U)), Math.max(1, Math.round(U)), 3 * T - 2 * U);
  }
  ctx.fillStyle = PALETTE[6]; ctx.fillRect(0, wallHeight - 2 * U, width, 3 * U);
  ctx.fillStyle = PALETTE[0]; ctx.fillRect(0, rows * T - 3 * U, width, 3 * U);
  ctx.fillStyle = "rgba(43,36,31,.12)"; ctx.fillRect(0, wallHeight, width, 3 * U);
}
function drawArea(area, floor){
  var active = floor.phase === area.phase;
  ctx.fillStyle = active ? "rgba(109,146,117,.1)" : "rgba(255,247,230,.035)";
  ctx.fillRect(area.x * T, area.y * T, area.width * T, area.height * T);
  var label = phaseLabel(area.phase), labelWidth = Math.min(area.width * T - 8 * U, Math.max(42 * U, label.length * 7 * U + 12 * U));
  ctx.fillStyle = active ? PALETTE[3] : PALETTE[15]; ctx.fillRect(area.x * T + 4 * U, area.y * T + 4 * U, labelWidth, 15 * U);
  ctx.strokeStyle = active ? PALETTE[1] : PALETTE[8]; ctx.lineWidth = Math.max(1, U); ctx.strokeRect(area.x * T + 4 * U, area.y * T + 4 * U, labelWidth, 15 * U);
  fillText(label, area.x * T + 9 * U, area.y * T + 7 * U, 9, active ? PALETTE[1] : PALETTE[8]);
}
function drawBoard(floor){
  var x = 21 * T, y = 1 * T, w = 25 * T, h = 5 * T;
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(x, y, w, h); ctx.strokeStyle = PALETTE[4]; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
  var b = floor.board, total = b.total > 0 ? b.total : 1, ratio = Math.max(0, Math.min(1, b.passed / total));
  fillText(t("progress") + " " + b.passed + "/" + (b.total || "?"), x + 5 * U, y + 3 * U, 10, PALETTE[0]);
  ctx.fillStyle = PALETTE[3]; ctx.fillRect(x + 5 * U, y + 16 * U, w - 10 * U, 6 * U); ctx.fillStyle = PALETTE[2]; ctx.fillRect(x + 5 * U, y + 16 * U, Math.round((w - 10 * U) * ratio), 6 * U);
  fillText(t("verify") + ":" + outcomeText(b.verify) + "  " + t("review") + ":" + outcomeText(b.review) + "  " + t("pending") + ":" + b.pending, x + 5 * U, y + 25 * U, 8, PALETTE[4]);
}
function drawRoomBase(floor){
  drawBackdrop(model.roomCols, model.roomRows, floor);
  floor.phaseAreas.forEach(function(a){ drawArea(a, floor); });
  drawBoard(floor);
  ctx.fillStyle = PALETTE[6]; ctx.fillRect(2 * T, 1 * T - 2 * U, 16 * T, 3 * T); ctx.strokeStyle = PALETTE[4]; ctx.lineWidth = Math.max(1, 2 * U); ctx.strokeRect(2 * T, 1 * T - 2 * U, 16 * T, 3 * T);
  fillText(short(floor.title, 16), 3 * T, 1 * T, 10, PALETTE[0]);
  fillText(short(statusText(floor.status), 16), 3 * T, 3 * T, 8, PALETTE[4]);
  floor.props.forEach(function(p){
    var px = p.x * T, py = p.y * T, size = propSize(p.kind);
    if (p.kind !== "clock" && p.kind !== "window") { ctx.fillStyle = "rgba(43,36,31,.16)"; ctx.fillRect(px + 4 * U, py + size.h - 2 * U, Math.max(8 * U, size.w - 3 * U), 4 * U); }
    draw(p.kind, px, py, PALETTE[2]);
    if (p.label && !p.phase) fillText(p.label, px + 3, py + size.h + 2, 8, PALETTE[0]);
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
  var bubble = short(actor.label, 14) + " | " + short(statusText(actor.status), 14);
  var labelHeight = 14 * U, labelWidth = Math.min(25 * T, Math.max(10 * T, bubble.length * 5 * U)), labelY = pos.y + 24 * S;
  if (labelY + labelHeight > canvas.height) labelY = Math.max(5 * U, pos.y - labelHeight - 2 * U);
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(pos.x - 4 * U, labelY, labelWidth, labelHeight);
  ctx.strokeStyle = PALETTE[4]; ctx.lineWidth = Math.max(1, U); ctx.strokeRect(pos.x - 4 * U, labelY, labelWidth, labelHeight);
  fillText(bubble, pos.x, labelY + 2 * U, 8, actor.alert ? PALETTE[13] : PALETTE[0]);
  if (actor.alert && (reducedMotion || Math.floor(frame / 20) % 2 === 0)) draw("alert", pos.x + 8 * S, pos.y - 8 * S);
}
function fitCanvas(){
  var wrapW = wrap && wrap.clientWidth ? wrap.clientWidth : window.innerWidth;
  var wrapH = wrap && wrap.clientHeight ? wrap.clientHeight : window.innerHeight - 54;
  var reserved = (dialogueBox && dialogueBox.offsetHeight || 36) + (roomNav && roomNav.offsetHeight || 30) + 24;
  var maxW = Math.max(220, wrapW - 18), maxH = Math.max(160, wrapH - reserved);
  var ratio = Math.min(maxW / canvas.width, maxH / canvas.height);
  canvas.style.width = Math.max(1, Math.floor(canvas.width * ratio)) + "px"; canvas.style.height = Math.max(1, Math.floor(canvas.height * ratio)) + "px";
}
function chooseRenderScale(){
  if (!model) return;
  var wrapW = wrap && wrap.clientWidth ? wrap.clientWidth : window.innerWidth, wrapH = wrap && wrap.clientHeight ? wrap.clientHeight : window.innerHeight - 54;
  var reserved = (dialogueBox && dialogueBox.offsetHeight || 36) + (roomNav && roomNav.offsetHeight || 30) + 24;
  var maxCssTile = Math.min(Math.max(8, (wrapW - 18) / model.cols), Math.max(8, (wrapH - reserved) / model.rows));
  var nextDpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1)), oldT = T, nextT = Math.max(8, Math.floor(maxCssTile * nextDpr));
  T = nextT; S = Math.max(2, T / 4); U = T / 8; dpr = nextDpr;
  if (oldT !== T) { Object.keys(positions).forEach(function(key){ positions[key].x *= T / oldT; positions[key].y *= T / oldT; }); roomCanvases = {}; }
}
function overviewLayout(rooms){
  var count = rooms.length, gap = .75, result = [];
  if (!count) return result;
  var teamIndex = rooms.findIndex(function(f){ return f.kind === "run"; });
  if (teamIndex >= 0 && count >= 2 && count <= 6) {
    var corridor = 3, sideGap = .75, left = Math.min(model.cols - 18, Math.max(30, model.cols * .55)), right = model.cols - left - corridor * 2;
    result[teamIndex] = {x:gap, y:gap, width:left, height:model.rows - gap * 2};
    var others = rooms.filter(function(_, i){ return i !== teamIndex; }), rightCols = others.length <= 2 ? 1 : Math.ceil(Math.sqrt(others.length));
    var rightRows = Math.ceil(others.length / rightCols), rightWidth = (right - sideGap * (rightCols - 1)) / rightCols;
    var rightHeight = (model.rows - sideGap * (rightRows + 1)) / rightRows;
    others.forEach(function(floor, i){ var col = i % rightCols, row = Math.floor(i / rightCols); result[rooms.indexOf(floor)] = {x:left + corridor * 2 + col * (rightWidth + sideGap), y:sideGap + row * (rightHeight + sideGap), width:rightWidth, height:rightHeight}; });
    return result;
  }
  var columns = Math.min(count, Math.max(1, Math.ceil(Math.sqrt(count * model.cols / model.rows))));
  var rows = Math.ceil(count / columns), safeGap = Math.max(0, Math.min(gap, (model.cols - columns * .25) / (columns + 1), (model.rows - rows * .25) / (rows + 1)));
  var width = Math.max(.25, (model.cols - safeGap * (columns + 1)) / columns), height = Math.max(.25, (model.rows - safeGap * (rows + 1)) / rows);
  rooms.forEach(function(_, i){ result[i] = {x:safeGap + (i % columns) * (width + safeGap), y:safeGap + Math.floor(i / columns) * (height + safeGap), width, height}; });
  return result;
}
function roomBox(floor){ var rooms = visibleRooms(), index = rooms.indexOf(floor), layout = overviewLayout(rooms); return index >= 0 && layout[index] ? layout[index] : floor.overview; }
function hallwayBounds(){
  var rooms = visibleRooms(), team = rooms.find(function(f){ return f.kind === "run"; });
  if (team && rooms.length >= 2 && rooms.length <= 6) {
    var teamBox = roomBox(team), other = rooms.find(function(f){ return f !== team; }), otherBox = other ? roomBox(other) : null;
    if (otherBox) return {x:teamBox.x + teamBox.width + .7, width:Math.max(2, otherBox.x - teamBox.x - teamBox.width - 1.4), y:1, height:model.rows - 2};
  }
  return {x:model.cols / 2 - 2.5, width:5, y:1, height:model.rows - 2};
}
function ensureSupervisor(){
  if (supervisorReady || !model) return;
  var hall = hallwayBounds(); supervisor.x = supervisor.targetX = hall.x + hall.width / 2 - 2.25; supervisor.y = supervisor.targetY = model.rows - 5; supervisorReady = true;
}
function roomEntrances(){
  var rooms = visibleRooms(), center = model.cols / 2;
  return rooms.map(function(floor){ var box = roomBox(floor), left = box.x + box.width / 2 < center; return {floor, x:left ? box.x + box.width + .4 : box.x - .4, y:box.y + box.height / 2}; });
}
function supervisorBounds(){
  var rooms = visibleRooms(), team = rooms.find(function(f){ return f.kind === "run"; });
  if (team && rooms.length >= 2 && rooms.length <= 6) { var hall = hallwayBounds(); return {minX:hall.x - .5, maxX:hall.x + hall.width + .9, minY:6, maxY:model.rows - 3}; }
  return {minX:2, maxX:model.cols - 3, minY:6, maxY:model.rows - 3};
}
function drawHallway(){
  var hall = hallwayBounds(), x = hall.x * T, y = hall.y * T, w = hall.width * T, h = hall.height * T;
  ctx.fillStyle = "rgba(183,199,163,.55)"; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PALETTE[3]; ctx.lineWidth = Math.max(1, 2 * U); ctx.strokeRect(x, y, w, h);
  for (var line = y + 14 * U; line < y + h; line += 28 * U) { ctx.strokeStyle = "rgba(138,80,51,.28)"; ctx.beginPath(); ctx.moveTo(x + 3 * U, line); ctx.lineTo(x + w - 3 * U, line); ctx.stroke(); }
  roomEntrances().forEach(function(entry){ var ex = entry.x * T, ey = entry.y * T; ctx.fillStyle = PALETTE[6]; ctx.fillRect(ex - 5 * U, ey - 14 * U, 10 * U, 28 * U); ctx.strokeStyle = PALETTE[4]; ctx.strokeRect(ex - 5 * U, ey - 14 * U, 10 * U, 28 * U); });
}
function drawSupervisor(){
  ensureSupervisor(); if (!model) return;
  if (reducedMotion) { supervisor.x = supervisor.targetX; supervisor.y = supervisor.targetY; }
  else { supervisor.x += Math.max(-.7, Math.min(.7, supervisor.targetX - supervisor.x)); supervisor.y += Math.max(-.7, Math.min(.7, supervisor.targetY - supervisor.y)); }
  var moving = Math.abs(supervisor.x - supervisor.targetX) > .05 || Math.abs(supervisor.y - supervisor.targetY) > .05;
  var px = supervisor.x * T, py = supervisor.y * T; draw(moving && Math.floor(frame / 7) % 2 ? "step" : "person", px, py, PALETTE[14]);
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(px - 6 * U, Math.max(4 * U, py - 16 * U), 118 * U, 13 * U); ctx.strokeStyle = PALETTE[1]; ctx.strokeRect(px - 6 * U, Math.max(4 * U, py - 16 * U), 118 * U, 13 * U); fillText("你 / Supervisor", px - 2 * U, Math.max(5 * U, py - 14 * U), 8, PALETTE[1]);
  var entry = roomEntrances().find(function(candidate){ return Math.hypot(candidate.x - supervisor.x, candidate.y - supervisor.y) < 2; });
  if (!moving && mode === "overview" && entry) { selectedKey = entry.floor.key; hallwayReturn = {x:supervisor.x, y:supervisor.y}; enterRoomFromHallway(entry.floor); }
}
function enterRoomFromHallway(floor){
  if (!floor) return;
  roomSupervisor.x = roomSupervisor.targetX = floor.kind === "run" ? model.roomCols - 7 : 6;
  roomSupervisor.y = roomSupervisor.targetY = Math.max(8, Math.min(model.roomRows - 6, Math.round(model.roomRows / 2)));
  mode = "room"; lineIndex = 0; typed = 0; updateHeader(); canvas.focus();
}
function drawRoomSupervisor(){
  if (!model) return;
  if (reducedMotion) { roomSupervisor.x = roomSupervisor.targetX; roomSupervisor.y = roomSupervisor.targetY; }
  else { roomSupervisor.x += Math.max(-.7, Math.min(.7, roomSupervisor.targetX - roomSupervisor.x)); roomSupervisor.y += Math.max(-.7, Math.min(.7, roomSupervisor.targetY - roomSupervisor.y)); }
  var moving = Math.abs(roomSupervisor.x - roomSupervisor.targetX) > .05 || Math.abs(roomSupervisor.y - roomSupervisor.targetY) > .05;
  var px = roomSupervisor.x * T, py = roomSupervisor.y * T; draw(moving && Math.floor(frame / 7) % 2 ? "step" : "person", px, py, PALETTE[14]);
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(px - 6 * U, Math.max(4 * U, py - 16 * U), 118 * U, 13 * U); ctx.strokeStyle = PALETTE[1]; ctx.strokeRect(px - 6 * U, Math.max(4 * U, py - 16 * U), 118 * U, 13 * U); fillText("你 / Supervisor", px - 2 * U, Math.max(5 * U, py - 14 * U), 8, PALETTE[1]);
}
function moveSupervisor(dx, dy){
  if (!model || !statusBox.hidden) return;
  var step = mode === "room" ? 1 : 1.25;
  if (mode === "room") { roomSupervisor.targetX = Math.max(2, Math.min(model.roomCols - 5, roomSupervisor.targetX + dx * step)); roomSupervisor.targetY = Math.max(7, Math.min(model.roomRows - 5, roomSupervisor.targetY + dy * step)); if (reducedMotion) { roomSupervisor.x = roomSupervisor.targetX; roomSupervisor.y = roomSupervisor.targetY; } render(); return; }
  ensureSupervisor(); var bounds = supervisorBounds(); supervisor.targetX = Math.max(bounds.minX, Math.min(bounds.maxX, supervisor.targetX + dx * step)); supervisor.targetY = Math.max(bounds.minY, Math.min(bounds.maxY, supervisor.targetY + dy * step)); if (reducedMotion) { supervisor.x = supervisor.targetX; supervisor.y = supervisor.targetY; } render();
}
function renderRoomImage(floor){
  var signature = lang + "|" + T + "|" + S + "|" + floor.phase + "|" + floor.status + "|" + floor.board.passed + "/" + floor.board.total + "/" + floor.board.verify + "/" + floor.board.review + "/" + floor.board.pending + "|" + floor.title + "|" + floor.props.length;
  var cached = roomCanvases[floor.key], roomCanvas = cached && cached.canvas;
  if (!roomCanvas) { roomCanvas = document.createElement("canvas"); roomCanvases[floor.key] = {canvas:roomCanvas, signature:""}; }
  if (!roomCanvas || typeof roomCanvas.getContext !== "function") return null;
  if (cached && cached.signature === signature) return roomCanvas;
  roomCanvas.width = model.roomCols * T; roomCanvas.height = model.roomRows * T;
  var roomCtx = roomCanvas.getContext("2d"); if (!roomCtx) return null;
  roomCtx.imageSmoothingEnabled = false;
  var oldCanvas = canvas, oldCtx = ctx; canvas = roomCanvas; ctx = roomCtx;
  drawRoomBase(floor);
  canvas = oldCanvas; ctx = oldCtx;
  roomCanvases[floor.key] = {canvas:roomCanvas, signature:signature};
  return roomCanvas;
}
function drawOverviewRoom(floor){
  var box = roomBox(floor), x = box.x * T, y = box.y * T, w = box.width * T, h = box.height * T;
  ctx.fillStyle = PALETTE[7]; ctx.fillRect(x, y, w, h); ctx.save(); ctx.beginPath(); ctx.rect(x, y, Math.max(1, w), Math.max(1, h)); ctx.clip();
  var image = renderRoomImage(floor);
  var uniform = Math.min(w / (model.roomCols * T), h / (model.roomRows * T)), drawW = model.roomCols * T * uniform, drawH = model.roomRows * T * uniform, drawX = x + (w - drawW) / 2, drawY = y + (h - drawH) / 2;
  if (image && ctx.drawImage) ctx.drawImage(image, drawX, drawY, drawW, drawH);
  var sx = drawW / (model.roomCols * T), sy = drawH / (model.roomRows * T);
  floor.actors.forEach(function(a){
    var current = positions[a.key] || {x:a.x * T, y:a.y * T}, ax = drawX + current.x * sx, ay = drawY + current.y * sy;
    if (image && ctx.drawImage) { ctx.save(); ctx.translate(drawX, drawY); ctx.scale(sx, sy); var oldCanvas = canvas; canvas = image; drawActor(floor, a); canvas = oldCanvas; ctx.restore(); }
    var caption = short(a.label, 9) + " | " + short(statusText(a.status), 9), font = 6, labelWidth = Math.min(w - 8 * U, Math.max(40 * U, caption.length * 5 * U));
    ctx.fillStyle = PALETTE[15]; ctx.fillRect(ax - 2 * U, Math.max(y + 4 * U, ay - 14 * U), labelWidth, 13 * U);
    fillText(caption, ax + 2 * U, Math.max(y + 5 * U, ay - 12 * U), font, a.alert ? PALETTE[13] : PALETTE[0]);
  });
  var barX = x + 8 * U, barY = y + h - 12 * U, barW = Math.max(12 * U, w - 16 * U), progress = floor.board.total > 0 ? floor.board.passed / floor.board.total : 0;
  ctx.fillStyle = PALETTE[3]; ctx.fillRect(barX, barY, barW, 5 * U); ctx.fillStyle = PALETTE[2]; ctx.fillRect(barX, barY, Math.round(barW * progress), 5 * U);
  if (floor.completedAt) { ctx.fillStyle = "rgba(53,90,75,.18)"; ctx.fillRect(x, y, w, h); }
  ctx.restore();
}
function render(){
  if (!model) return;
  chooseRenderScale();
  var floor = activeRoom();
  if (mode === "room" && floor) {
    canvas.width = model.roomCols * T; canvas.height = model.roomRows * T; ctx.imageSmoothingEnabled = false;
    var image = renderRoomImage(floor); if (image && ctx.drawImage) ctx.drawImage(image, 0, 0, canvas.width, canvas.height); else drawRoomBase(floor);
    floor.actors.forEach(function(a){ drawActor(floor, a); });
    drawRoomSupervisor();
  } else {
    drawBackdrop(model.cols, model.rows, null); drawHallway(); visibleRooms().forEach(drawOverviewRoom); drawSupervisor();
    if (visibleRooms().length === 0) fillText(t("quiet"), 4 * T, 18 * T, 12, PALETTE[0]);
  }
  fitCanvas();
}
function renderRoomNav(rooms){
  if (mode !== "overview") { if (navSignature !== lang + "|room") { roomNav.textContent = ""; navSignature = lang + "|room"; } return; }
  var pages = Math.max(1, Math.ceil(rooms.length / NAV_PAGE_SIZE)), selectedIndex = rooms.findIndex(function(f){ return f.key === selectedKey; });
  if (selectedIndex >= 0) navPage = Math.min(Math.floor(selectedIndex / NAV_PAGE_SIZE), pages - 1); else navPage = Math.min(navPage, pages - 1);
  var signature = lang + "|overview|" + (showRecent ? "recent" : "active") + "|" + selectedKey + "|" + navPage + "|" + rooms.map(function(f){ return f.key; }).join(",");
  if (signature === navSignature) return;
  navSignature = signature; roomNav.textContent = "";
  if (pages > 1) { var previous = document.createElement("button"); previous.type = "button"; previous.textContent = "‹ " + t("previous"); previous.disabled = navPage === 0; previous.addEventListener("click", function(){ navPage--; updateHeader(); }); roomNav.appendChild(previous); }
  rooms.slice(navPage * NAV_PAGE_SIZE, navPage * NAV_PAGE_SIZE + NAV_PAGE_SIZE).forEach(function(floor, offset){ var button = document.createElement("button"); button.type = "button"; button.textContent = (navPage * NAV_PAGE_SIZE + offset + 1) + ". " + short(floor.title, 18); button.title = t("enter") + ": " + floor.title; button.setAttribute("aria-current", floor.key === selectedKey ? "true" : "false"); button.addEventListener("click", function(){ selectedKey = floor.key; enterRoom(); }); roomNav.appendChild(button); });
  if (pages > 1) { var next = document.createElement("button"); next.type = "button"; next.textContent = t("next") + " ›"; next.disabled = navPage === pages - 1; next.addEventListener("click", function(){ navPage++; updateHeader(); }); roomNav.appendChild(next); }
}
function updateHeader(){
  var rooms = visibleRooms(), people = rooms.reduce(function(n, f){ return n + f.actors.length; }, 0);
  crumb.textContent = mode === "room" && activeRoom() ? activeRoom().title : t("overview") + " · " + rooms.length + " " + t("rooms") + " · " + people + " " + t("people");
  backButton.hidden = mode !== "room"; backButton.textContent = "← " + t("back"); recentButton.textContent = (showRecent ? "✓ " + t("recentOn") : "▣ " + t("recent")) + (hasRecent() ? " (" + model.floors.filter(function(f){ return !!f.completedAt; }).length + ")" : "");
  languageButton.textContent = lang === "zh" ? "繁中 / EN" : "EN / 繁中"; live.textContent = offline ? t("offline") : t("connected");
  renderRoomNav(rooms);
}
function tickDialogue(){
  if (!model) return;
  var floors = mode === "room" && activeRoom() ? [activeRoom()] : visibleRooms(), lines = [];
  floors.forEach(function(floor){ floor.actors.forEach(function(actor){ lines.push(floor.title + ": " + actor.label + " · " + localizeText(actor.narration)); }); if (floor.questions.length) lines.push(floor.title + ": " + t("waiting")); });
  if (!lines.length) lines = [t("quiet")];
  var line = offline ? t("offline") : localizeText(lines[lineIndex % Math.max(1, lines.length)]);
  typed = Math.min(line.length, typed + 2); dialogueBox.textContent = line.slice(0, typed);
  if (typed === line.length && frame % 180 === 0) { lineIndex++; typed = 0; }
}
function enterRoom(){ if (!selectedKey && visibleRooms()[0]) selectedKey = visibleRooms()[0].key; var floor = activeRoom(); if (!floor) return; enterRoomFromHallway(floor); render(); }
function goOverview(){ mode = "overview"; var hall = hallwayBounds(); supervisor.x = supervisor.targetX = hall.x + hall.width / 2 - 2.25; supervisor.y = supervisor.targetY = hall.y + hall.height - 5; hallwayReturn = null; updateHeader(); render(); canvas.focus(); }
function changeLanguage(){ lang = lang === "zh" ? "en" : "zh"; saveLanguage(); updateHeader(); render(); }
function showDialog(title, fill){
  if (statusBox.hidden) detailPreviousFocus = document.activeElement || canvas;
  statusBox.textContent = ""; var heading = document.createElement("h2"); heading.id = "status-title"; heading.textContent = title; statusBox.appendChild(heading);
  var body = document.createElement("div"); body.className = "dialog-body"; statusBox.appendChild(body); fill(body);
  var actions = document.createElement("div"); actions.className = "actions";
  var close = document.createElement("button"); close.type = "button"; close.textContent = t("close"); close.addEventListener("click", closeDialog); actions.appendChild(close);
  statusBox.appendChild(actions); statusBox.hidden = false; dialogClose = close;
  if (app) { app.inert = true; app.setAttribute("aria-hidden", "true"); }
  close.focus();
}
function closeDialog(){ statusBox.hidden = true; if (app) { app.inert = false; app.removeAttribute("aria-hidden"); } var previous = detailPreviousFocus || canvas; dialogClose = null; detailPreviousFocus = null; if (previous && previous.focus) previous.focus(); }
function addLine(box, label, value){ var p = document.createElement("p"); p.textContent = label + ": " + safeText(value); box.appendChild(p); }
function addCommand(box, value){
  var row = document.createElement("p"), code = document.createElement("code"), button = document.createElement("button");
  code.textContent = value; button.type = "button"; button.textContent = t("copy"); button.addEventListener("click", function(){
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(function(){ button.textContent = t("copied"); }, function(){});
  }); row.appendChild(code); row.appendChild(button); box.appendChild(row);
}
function pageItems(items, box, renderItem){
  var pageSize = window.innerHeight < 560 || window.innerWidth < 480 ? 3 : 5, pages = Math.max(1, Math.ceil(items.length / pageSize)); detailPage = Math.max(0, Math.min(detailPage, pages - 1));
  items.slice(detailPage * pageSize, detailPage * pageSize + pageSize).forEach(function(item){ renderItem(item, box); });
  var paging = document.createElement("div"); paging.className = "actions dialog-pager"; var page = document.createElement("span"); page.textContent = t("page") + " " + (detailPage + 1) + "/" + pages; paging.appendChild(page);
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
function renderDetailItem(item, box){
  if (item.kind === "command") return addCommand(box, item.value);
  if (item.kind === "file") { var file = document.createElement("p"); file.textContent = "• " + item.value; box.appendChild(file); return; }
  if (item.kind === "heading") { var heading = document.createElement("p"); heading.textContent = item.value; box.appendChild(heading); return; }
  addLine(box, item.label, item.value);
}
function openActorDetail(floor, actor){
  var source = sourceFor(floor), items = [], entries = [];
  if (source && actor.kind !== "reviewer" && floor.kind === "run") { var found = source.agents.find(function(a){ return a.id === actor.id; }); if (found && found.diff) items = found.diff.paths || []; }
  if (source && floor.kind === "desk" && source.diff) items = source.diff.paths || [];
  items.forEach(function(item){ entries.push({kind:"file", value:item}); });
  if (source && source.commands) source.commands.forEach(function(item){ entries.push({kind:"command", value:item}); });
  if (!detailTarget || detailTarget.floorKey !== floor.key || detailTarget.actorKey !== actor.key) detailPage = 0;
  var detailItems = [
    {kind:"line", label:t("status"), value:statusText(actor.status)}, {kind:"line", label:t("phase"), value:phaseLabel(actor.phase)},
    {kind:"line", label:t("task"), value:actor.taskId === "unassigned" ? t("unassigned") : actor.taskId},
    {kind:"line", label:t("host"), value:localizeText(actor.host)}, {kind:"line", label:t("now"), value:localizeText(actor.narration)}
  ];
  if (actor.questionCount) detailItems.push({kind:"line", label:t("pending"), value:String(actor.questionCount)});
  if (actor.progress) detailItems.push({kind:"line", label:t("progress"), value:actor.progress.passed + "/" + actor.progress.total + "  " + t("verify") + " " + outcomeText(actor.progress.verify || "-") + "  " + t("review") + " " + outcomeText(actor.progress.review || "-")});
  if (actor.questionCount && floor.questions.length) floor.questions.forEach(function(question){ detailItems.push({kind:"line", label:"! " + question.questionId, value:question.prompt}); });
  if (entries.length) { detailItems.push({kind:"heading", value:t("files") + " / " + t("commands") + ":"}); entries.forEach(function(entry){ detailItems.push(entry); }); }
  detailTarget = {floorKey: floor.key, actorKey: actor.key}; showDialog(actor.label, function(box){ pageItems(detailItems, box, renderDetailItem); });
}
function openRoomDetail(floor){
  if (!detailTarget || detailTarget.floorKey !== floor.key || detailTarget.actorKey !== null) detailPage = 0;
  detailTarget = {floorKey: floor.key, actorKey: null}; var source = sourceFor(floor), items = source && source.diff ? source.diff.paths || [] : [], entries = [];
  items.forEach(function(item){ entries.push({kind:"file", value:item}); });
  if (source && source.commands) source.commands.forEach(function(item){ entries.push({kind:"command", value:item}); });
  var detailItems = [
    {kind:"line", label:t("status"), value:statusText(floor.status)}, {kind:"line", label:t("phase"), value:phaseLabel(floor.phase)},
    {kind:"line", label:t("task"), value:floor.board.taskId === "unassigned" ? t("unassigned") : floor.board.taskId},
    {kind:"line", label:t("progress"), value:floor.board.passed + "/" + (floor.board.total || "?")},
    {kind:"line", label:t("verify"), value:outcomeText(floor.board.verify)}, {kind:"line", label:t("review"), value:outcomeText(floor.board.review)},
    {kind:"line", label:t("pending"), value:String(floor.board.pending)}
  ];
  floor.questions.forEach(function(question){ detailItems.push({kind:"line", label:"! " + question.questionId, value:question.prompt}); });
  if (entries.length) { detailItems.push({kind:"heading", value:t("files") + " / " + t("commands") + ":"}); entries.forEach(function(entry){ detailItems.push(entry); }); }
  showDialog(floor.title, function(box){ pageItems(detailItems, box, renderDetailItem); });
}
function openSelectedDetail(){
  var target = detailTarget, floor = target ? roomByKey(target.floorKey) : activeRoom(); if (!floor) return;
  if (target && target.actorKey) { var actor = floor.actors.find(function(a){ return a.key === target.actorKey; }); if (actor) return openActorDetail(floor, actor); }
  return openRoomDetail(floor);
}
function hitOverview(event){
  var rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * canvas.width / rect.width / T, y = (event.clientY - rect.top) * canvas.height / rect.height / T;
  return visibleRooms().find(function(f){ var b = roomBox(f); return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height; }) || null;
}
function hitActor(event, floor){
  var rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * canvas.width / rect.width, y = (event.clientY - rect.top) * canvas.height / rect.height;
  for (var i = floor.actors.length - 1; i >= 0; i--) { var a = floor.actors[i], pos = positions[a.key] || {x:a.x*T, y:a.y*T}; if (x >= pos.x - 5 && x < pos.x + 18*S && y >= pos.y - 5 && y < pos.y + 26*S) return a; }
  return null;
}
canvas.addEventListener("click", function(event){
  if (!model) return;
  if (mode === "overview") { var floor = hitOverview(event); if (floor) { selectedKey = floor.key; enterRoom(); } return; }
  var room = activeRoom(); if (!room) return; var actor = hitActor(event, room); if (actor) openActorDetail(room, actor); else openRoomDetail(room);
});
canvas.addEventListener("keydown", function(event){
  if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); if (!statusBox.hidden) closeDialog(); else if (mode === "room") goOverview(); return; }
  if (mode === "overview" || mode === "room") {
    var move = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1], a:[-1,0], d:[1,0], w:[0,-1], s:[0,1], A:[-1,0], D:[1,0], W:[0,-1], S:[0,1]}[event.key];
    if (move) { event.preventDefault(); moveSupervisor(move[0], move[1]); return; }
  }
  var rooms = visibleRooms(); if (!rooms.length) return;
  var index = Math.max(0, rooms.findIndex(function(f){ return f.key === selectedKey; }));
  if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); selectedKey = rooms[(index + 1) % rooms.length].key; updateHeader(); render(); }
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); selectedKey = rooms[(index - 1 + rooms.length) % rooms.length].key; updateHeader(); render(); }
  if (event.key === "Enter" && mode === "overview") { event.preventDefault(); enterRoom(); }
  if (event.key === "Enter" && mode === "room") { event.preventDefault(); openSelectedDetail(); }
});
backButton.addEventListener("click", goOverview); recentButton.addEventListener("click", function(){ showRecent = !showRecent; if (!showRecent && activeRoom() && activeRoom().completedAt) mode = "overview"; updateHeader(); render(); });
languageButton.addEventListener("click", changeLanguage); statusBox.addEventListener("keydown", function(event){
  if (event.key === "Escape") { event.preventDefault(); closeDialog(); return; }
  if (event.key !== "Tab") return;
  var focusables = statusBox.querySelectorAll ? Array.prototype.slice.call(statusBox.querySelectorAll("button:not([disabled])")) : (dialogClose ? [dialogClose] : []);
  if (!focusables.length) return;
  var first = focusables[0], last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function poll(){ fetch("snapshot.json" + location.search, {cache:"no-store"}).then(function(r){ if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function(s){ snapshot = s; model = sceneModel(s); offline = false; if (!selectedKey || !roomByKey(selectedKey)) selectedKey = visibleRooms()[0] && visibleRooms()[0].key; updateHeader(); render(); if (!statusBox.hidden && detailTarget && roomByKey(detailTarget.floorKey)) openSelectedDetail(); }, function(){ offline = true; updateHeader(); }); }
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
