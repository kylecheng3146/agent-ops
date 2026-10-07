import {sceneModel} from "./scene.js";

/** Warm cream, oak and sage colors, kept to a single 16-color pixel palette. */
export const PALETTE = ["#2b241f", "#355a4b", "#6d9275", "#b7c7a3", "#8a5033", "#729ead", "#d9aa72", "#ead8b8",
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
#dialogue{width:100%;min-height:2.25em;padding:6px 12px;background:#fff7e6;border:2px solid #8a5033;color:#2b241f;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#room-nav{width:100%;display:flex;justify-content:center;align-items:center;gap:5px;min-height:28px;overflow:hidden}
#room-nav button{max-width:18ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:2px solid #8a5033;background:#f2e5c9;padding:3px 7px;cursor:pointer}
#room-nav button[aria-current=true]{background:#6d9275;color:#fff7e6;border-color:#2b241f}
#room-nav button:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
#status{position:fixed;z-index:4;inset:6dvh 50% auto auto;transform:translateX(50%);width:min(92vw,680px);max-height:88dvh;overflow:hidden;display:flex;flex-direction:column;gap:4px;padding:16px;background:#fff7e6;border:4px solid #6b5d50;box-shadow:8px 8px 0 #2b241f;color:#2b241f}
#status[hidden]{display:none}
#status h2{margin:0 0 8px;color:#355a4b;font-size:1.25em}
#status .dialog-body{min-height:0;overflow:hidden}
#status p{margin:5px 0;overflow-wrap:anywhere;white-space:pre-wrap}
#status ul{margin:5px 0;padding-left:22px}
#status li{overflow-wrap:anywhere}
#status .actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
#status>.actions{flex:0 0 auto}
#status code{display:inline-block;max-width:calc(100% - 74px);overflow-wrap:anywhere;white-space:pre-wrap;background:#f2e5c9;padding:2px 4px}
#status .dialog-pager{border-top:2px solid #d9aa72;padding-top:6px}
#status button{border:2px solid #2b241f;background:#d9aa72;padding:5px 10px;cursor:pointer}
#status button:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:760px){#header{flex-wrap:wrap;gap:6px;padding:6px 8px}#brand{font-size:16px}#header button{order:1;font-size:12px;padding:3px 5px}#crumb{min-width:70px}#live{font-size:12px}}
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
var detailSignature = "";
var navPage = 0, navSignature = "", NAV_PAGE_SIZE = 8;
var supervisor = {x:43, y:19, targetX:43, targetY:19}, supervisorReady = false, hallwayReturn = null;
var roomSupervisor = {x:32, y:34, targetX:32, targetY:34};
var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var STRINGS = {
  en: {overview:"Office overview", rooms:"rooms", people:"people", recent:"Recently completed", recentOn:"Hide completed", back:"Back to overview", connected:"● Connected", offline:"○ Reconnecting", quiet:"The office is quiet. No agent is at work.", waiting:"waiting for your answer", enter:"Enter room", close:"Close", previous:"Previous", next:"Next", page:"Page", details:"Details", progress:"Progress", verify:"Verify", review:"Review", pending:"Awaiting answer", task:"Task", status:"Status", phase:"Phase", host:"Host", now:"Now", files:"Changed files", commands:"Commands", copy:"Copy", copied:"Copied", unknown:"unknown", unassigned:"unassigned", phases:{planning:"Planning", implementing:"Implementing", verifying:"Verifying", reviewing:"Reviewing", integrating:"Integrating", unknown:"Unassigned"}, statuses:{active:"active", idle:"idle", running:"running", reviewing:"reviewing", verifying:"verifying", blocked:"blocked", delivered:"delivered", complete:"complete", unknown:"unknown", unassigned:"unassigned", pending:"pending"}},
  zh: {overview:"辦公室總覽", rooms:"個房間", people:"位成員", recent:"最近完成", recentOn:"隱藏已完成", back:"返回總覽", connected:"● 已連線", offline:"○ 重新連線中", quiet:"辦公室很安靜，目前沒有成員工作。", waiting:"等待你的回覆", enter:"進入房間", close:"關閉", previous:"上一頁", next:"下一頁", page:"頁", details:"詳細資料", progress:"進度", verify:"驗證", review:"審查", pending:"待回覆", task:"任務", status:"狀態", phase:"階段", host:"主機", now:"目前", files:"變更檔案", commands:"指令", copy:"複製", copied:"已複製", unknown:"未知", unassigned:"未分配", phases:{planning:"規劃", implementing:"開發", verifying:"驗證", reviewing:"審查", integrating:"整合", unknown:"未分配"}, statuses:{active:"進行中", idle:"閒置", running:"工作中", reviewing:"審查中", verifying:"驗證中", blocked:"受阻", delivered:"已交付", complete:"已完成", unknown:"未知", unassigned:"未分配", pending:"待回覆"}}
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
function outcomeText(value){ return value === "pending" ? (lang === "zh" ? "尚未完成" : "pending") : safeText(value); }
function localizeText(value){
  var text = safeText(value);
  if (text === "The office is quiet. No agent is at work.") return t("quiet");
  if (text === "waiting for your answer") return t("waiting");
  if (text === "reviewing") return phaseLabel("reviewing");
  if (text === "planning" || text === "implementing" || text === "verifying" || text === "integrating") return phaseLabel(text);
  if (STRINGS.en.statuses[text]) return statusText(text);
  if(lang==='zh')text=text.replace(/^writing tests$/u,'撰寫測試').replace(/^writing docs$/u,'撰寫文件').replace(/^editing /u,'編輯 ');
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
function setCanvasSize(width, height){
  width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.imageSmoothingEnabled = false;
}
function drawBackdrop(cols, rows, room){
  if (!room) setCanvasSize(cols * T, rows * T);
  var width = canvas.width, height = canvas.height, unit = Math.max(1, Math.min(width / 576, height / 320)), wallHeight = Math.round(height * .18);
  ctx.fillStyle = PALETTE[15]; ctx.fillRect(0, 0, width, wallHeight);
  ctx.fillStyle = PALETTE[12]; ctx.fillRect(0, wallHeight, width, height - wallHeight);
  var plankH = 12 * unit, plankW = 64 * unit;
  for (var row = 0, y = wallHeight; y < height; row++, y += plankH) {
    ctx.fillStyle = row % 3 === 0 ? PALETTE[7] : PALETTE[12]; ctx.fillRect(0, y, width, plankH - unit);
    for (var x = -(row % 2) * plankW / 2; x < width; x += plankW) {
      ctx.fillStyle = PALETTE[6]; ctx.fillRect(x, y, unit, plankH);
      ctx.fillStyle = PALETTE[7]; ctx.fillRect(x + 8 * unit, y + 4 * unit, 24 * unit, unit);
    }
  }
  ctx.fillStyle = PALETTE[6]; ctx.fillRect(0, wallHeight - 3 * unit, width, 3 * unit);
  ctx.fillStyle = 'rgba(43,36,31,.12)'; ctx.fillRect(0, wallHeight, width, 4 * unit);
  ctx.fillStyle = PALETTE[9]; ctx.fillRect(0, height - 2 * unit, width, 2 * unit);
}
// Furniture stays square-pixeled while its placement follows the room size.
function furniture(kind, x, y, unit){
  ctx.save(); ctx.translate(Math.round(x), Math.round(y)); unit=Math.max(1,Math.round(unit));ctx.scale(unit, unit);
  function r(x,y,w,h,c){ctx.fillStyle=PALETTE[c];ctx.fillRect(x,y,w,h);}
  function monitor(x,y){r(x,y,22,16,9);r(x+1,y+1,20,13,0);r(x+3,y+3,16,9,5);for(var i=0;i<3;i++){r(x+4,y+4+i*2,4+i*3,1,i%2?14:3);}r(x+10,y+16,2,3,9);r(x+6,y+19,10,1,9);}
  function cup(x,y){r(x,y,5,6,15);r(x+1,y,3,1,4);r(x+5,y+1,2,3,8);}
  function drawer(x,y){r(x,y,17,19,9);r(x+1,y+1,15,7,8);r(x+1,y+10,15,7,8);r(x+6,y+3,5,1,15);r(x+6,y+12,5,1,15);}
  if(kind==='desk'||kind==='bench'){
    r(2,31,72,5,8);drawer(4,28);drawer(52,28);r(1,17,74,13,4);r(2,17,72,9,6);r(2,17,72,2,7);r(25,30,3,15,9);r(70,30,3,15,9);
    monitor(8,0);monitor(34,1);r(15,23,23,3,9);for(var k=0;k<6;k++)r(17+k*3,24,2,1,15);cup(61,19);
    r(43,20,11,5,15);r(45,21,7,1,8);r(45,23,6,1,8);r(66,7,6,9,9);r(67,8,4,6,3);
    if(kind==='bench'){r(2,-4,72,3,9);for(var j=0;j<7;j++){r(5+j*9,-1,2,8,8);r(4+j*9,1,4,3,j%2?14:5);}r(59,0,10,16,9);r(61,2,6,5,3);r(61,9,6,4,5);}
  } else if(kind==='table'){
    r(6,0,47,12,1);r(8,1,43,9,2);r(2,12,63,30,4);r(3,12,61,26,6);r(3,12,61,2,7);r(7,42,3,12,9);r(55,42,3,12,9);
    r(10,19,14,12,15);r(30,22,13,12,15);for(var l=0;l<4;l++){r(12,21+l*2,10,1,8);r(32,24+l*2,9,1,8);}cup(51,19);monitor(41,0);
  } else if(kind==='window'){
    r(0,0,52,28,8);r(2,2,48,23,5);r(4,4,44,19,3);r(4,4,44,13,5);r(8,6,15,2,15);r(30,9,10,2,15);r(3,24,48,4,6);r(24,2,3,23,15);r(2,2,48,2,15);r(2,12,48,2,15);
    r(-2,-3,56,4,9);r(0,-2,52,2,7);r(-3,27,58,4,4);r(-2,27,56,2,6);r(36,20,7,7,4);r(35,17,9,5,2);r(39,14,4,6,1);
  } else if(kind==='whiteboard'){
    r(0,0,65,38,9);r(2,2,61,33,15);r(4,4,57,1,7);r(5,38,3,9,9);r(57,38,3,9,9);r(2,47,9,2,9);r(54,47,9,2,9);
    for(var n=0;n<6;n++){var bx=7+n%3*18,by=9+Math.floor(n/3)*16;r(bx,by,12,9,n%2?3:14);r(bx+2,by+2,8,1,8);r(bx+2,by+5,6,1,8);if(n<5){r(bx+13,by+5,4,1,8);}}
  } else if(kind==='shelf'){
    r(0,0,28,58,4);r(2,2,24,54,9);for(var shelf=0;shelf<3;shelf++){r(2,17+shelf*18,24,2,6);for(var book=0;book<5;book++){r(4+book*4,4+shelf*18+(book%2)*2,3,12-(book%2)*2,[2,5,13,7,3][book]);r(5+book*4,6+shelf*18,1,6,15);}}
    r(0,58,28,3,8);r(3,44,9,11,6);r(14,44,10,11,6);r(6,46,4,1,15);r(17,46,4,1,15);
  } else if(kind==='plant'){
    r(9,18,16,13,8);r(10,18,14,3,6);r(11,21,12,9,7);r(14,4,3,15,1);r(5,7,11,5,2);r(1,5,9,4,3);r(17,3,12,5,2);r(23,0,8,5,3);r(14,-3,5,10,2);r(6,-2,9,5,1);r(20,10,10,5,1);r(3,13,10,4,2);r(11,11,11,5,3);
  } else if(kind==='chair'){
    r(2,0,18,13,1);r(3,1,16,10,2);r(2,13,18,9,2);r(3,14,16,5,3);r(10,22,2,8,9);r(3,29,18,2,9);r(2,28,3,4,9);r(18,28,3,4,9);
  } else if(kind==='door'){
    r(0,0,24,46,8);r(2,2,20,42,4);r(4,4,16,38,6);r(5,5,14,13,7);r(5,22,14,18,7);r(15,21,3,2,14);r(5,28,14,8,1);r(8,31,8,2,15);r(13,29,2,6,15);
  }
  ctx.restore();
}
function drawRoomBase(floor){
  drawBackdrop(model.roomCols, model.roomRows, floor);
  var rx = canvas.width / model.roomCols, ry = canvas.height / model.roomRows, unit = Math.max(.5, Math.min(rx, ry) / 8), labelUnit = Math.min(U, Math.max(1, unit * 1.25));
  var savedU = U; U = labelUnit;
  // Sage rugs and oak furniture give each phase a real place in the room.
  floor.phaseAreas.forEach(function(a){
    if(a.phase==='implementing'||a.phase==='reviewing'){
      var x=a.x*rx,y=(a.y+1)*ry,w=a.width*rx,h=(a.height-1)*ry;
      ctx.fillStyle=PALETTE[3];ctx.fillRect(x,y,w,h);ctx.strokeStyle=PALETTE[2];ctx.lineWidth=2*unit;ctx.strokeRect(x+3*unit,y+3*unit,w-6*unit,h-6*unit);
    }
  });
  floor.props.filter(function(p){return p.kind!=='rug'&&p.kind!=='clock';}).forEach(function(p){
    var px=p.x*rx,py=p.y*ry;
    if(p.kind!=='window'){ctx.fillStyle='rgba(43,36,31,.14)';ctx.fillRect(px+4*unit,py+28*unit,45*unit,6*unit);}
    var heights={desk:45,bench:45,table:54,window:31,whiteboard:49,shelf:61,plant:31,chair:32,door:46};
    var artUnit=Math.max(.3,Math.min(unit*1.85,(canvas.height-py-2*unit)/(heights[p.kind]||45),(canvas.width-px-2*unit)/(p.kind==='window'?58:p.kind==='plant'?32:p.kind==='shelf'?28:p.kind==='door'?24:75)));
    furniture(p.kind,px,py,artUnit);
    if(p.kind==='shelf')for(var book=0;book<Math.min(5,floor.books.lit);book++){ctx.fillStyle=PALETTE[14];ctx.fillRect(px+(4+book*4)*Math.round(artUnit),py+4*Math.round(artUnit),3*Math.round(artUnit),2*Math.round(artUnit));}
    if(p.kind==='desk')for(var paper=0;paper<Math.min(4,floor.papers[p.key]||0);paper++){ctx.fillStyle=PALETTE[15];ctx.fillRect(px+44*artUnit,py+(20-paper)*artUnit,9*artUnit,2*artUnit);}
  });
  floor.phaseAreas.forEach(function(a){var ax=a.x*rx,ay=a.y*ry;ctx.fillStyle=PALETTE[15];ctx.fillRect(ax,ay,Math.min(a.width*rx,72*labelUnit),13*labelUnit);fillText(phaseLabel(a.phase),ax+4*labelUnit,ay+2*labelUnit,9,PALETTE[1]);});
  var titleX=2*rx,titleY=ry,w=19*rx;
  ctx.fillStyle=PALETTE[4];ctx.fillRect(titleX,titleY,w,4*ry);ctx.fillStyle=PALETTE[6];ctx.fillRect(titleX+2*unit,titleY+2*unit,w-4*unit,4*ry-4*unit);
  fillText(short(floor.title,20),titleX+6*unit,titleY+6*unit,11);fillText(statusText(floor.status),titleX+6*unit,titleY+22*unit,8,PALETTE[4]);
  var b=floor.board,bx=24*rx,by=ry,bw=27*rx,bh=Math.max(6*ry,57*unit);
  ctx.fillStyle=PALETTE[9];ctx.fillRect(bx,by,bw,bh);ctx.fillStyle=PALETTE[15];ctx.fillRect(bx+2*unit,by+2*unit,bw-4*unit,bh-4*unit);
  fillText(t('progress')+'  '+b.passed+'/'+(b.total||'?'),bx+6*unit,by+5*unit,11,PALETTE[1]);
  ctx.fillStyle=PALETTE[3];ctx.fillRect(bx+6*unit,by+20*unit,bw-12*unit,5*unit);ctx.fillStyle=PALETTE[2];ctx.fillRect(bx+6*unit,by+20*unit,(bw-12*unit)*Math.min(1,b.total?b.passed/b.total:0),5*unit);
  fillText(t('verify')+' '+outcomeText(b.verify)+'  '+t('review')+' '+outcomeText(b.review),bx+6*unit,by+30*unit,8,PALETTE[4]);
  if(b.pending)fillText('! '+t('pending')+' '+b.pending,bx+6*unit,by+42*unit,8,PALETTE[13]);
  var oldS=S;S=Math.max(1,Math.round(unit));var cx=52*rx,cy=ry;draw('clock',cx,cy);
  ctx.strokeStyle=PALETTE[13];ctx.lineWidth=2*S;ctx.beginPath();ctx.moveTo(cx+8*S,cy+7*S);var angle=-Math.PI/2+2*Math.PI*floor.clock;ctx.lineTo(cx+8*S+Math.cos(angle)*5*S,cy+7*S+Math.sin(angle)*5*S);ctx.stroke();S=oldS;
  U=savedU;
  ctx.strokeStyle=PALETTE[9];ctx.lineWidth=3*unit;ctx.strokeRect(unit,unit,canvas.width-2*unit,canvas.height-2*unit);
}
function drawActor(floor, actor, surface){
  var tx=actor.x*T,ty=actor.y*T,pos=positions[actor.key]||{x:tx,y:ty};
  if(reducedMotion)pos={x:tx,y:ty};else{pos={x:pos.x+Math.max(-T/5,Math.min(T/5,tx-pos.x)),y:pos.y+Math.max(-T/5,Math.min(T/5,ty-pos.y))};}
  positions[actor.key]=pos;var walking=Math.abs(pos.x-tx)>.1||Math.abs(pos.y-ty)>.1;
  surface=surface||{x:0,y:0,width:canvas.width,height:canvas.height};
  var rx=surface.width/(model.roomCols*T),ry=surface.height/(model.roomRows*T),oldS=S,oldU=U;
  S=Math.max(1,Math.round(Math.min(rx,ry)*T/4));U=Math.max(dpr,Math.min(oldU,S/2));
  var px=Math.round(surface.x+pos.x*rx),py=Math.round(surface.y+pos.y*ry);
  ctx.fillStyle='rgba(43,36,31,.18)';ctx.fillRect(px+3*S,py+19*S,13*S,2*S);
  draw(walking&&Math.floor(frame/8)%2?'step':'person',px,py,SHIRTS[actor.kind]||PALETTE[2]);
  if(!walking&&!reducedMotion&&Math.floor(frame/30)%2===0){ctx.fillStyle=PALETTE[15];ctx.fillRect(px+7*S,py+12*S,5*S,3*S);}
  var text=short(actor.label,14)+' · '+short(statusText(actor.status),10),font=9*U;
  ctx.font='bold '+font+'px monospace';var labelWidth=Math.min(surface.width-8*U,(ctx.measureText?ctx.measureText(text).width:text.length*font*.62)+8*U),labelX=Math.max(surface.x+4*U,Math.min(surface.x+surface.width-labelWidth-4*U,px-3*U)),labelY=Math.min(surface.y+surface.height-16*U,py+22*S);
  ctx.fillStyle=PALETTE[15];ctx.fillRect(labelX,labelY,labelWidth,14*U);ctx.strokeStyle=PALETTE[8];ctx.lineWidth=U;ctx.strokeRect(labelX,labelY,labelWidth,14*U);fillText(text,labelX+3*U,labelY+2*U,9,actor.alert?PALETTE[13]:PALETTE[0]);
  if(actor.alert&&(reducedMotion||Math.floor(frame/20)%2===0))draw('alert',px+7*S,py-9*S);
  S=oldS;U=oldU;
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
  if(!model)return;
  var wrapW=wrap&&wrap.clientWidth?wrap.clientWidth:window.innerWidth,wrapH=wrap&&wrap.clientHeight?wrap.clientHeight:window.innerHeight-54;
  var reserved=(dialogueBox&&dialogueBox.offsetHeight||36)+(roomNav&&roomNav.offsetHeight||30)+24;
  var maxW=Math.max(220,wrapW-18),maxH=Math.max(160,wrapH-reserved),nextDpr=Math.max(1,Math.min(3,window.devicePixelRatio||1)),oldT=T;
  model.cols=model.rows*maxW/maxH;
  T=Math.max(4,maxH/model.rows*nextDpr);S=T/4;U=T/8;dpr=nextDpr;
  if(oldT!==T){Object.keys(positions).forEach(function(key){positions[key].x*=T/oldT;positions[key].y*=T/oldT;});roomCanvases={};}
}
function overviewLayout(rooms){
  var count=rooms.length,gap=.6,result=[];if(!count)return result;
  if(count===1)return [{x:gap,y:gap,width:model.cols-6-gap,height:model.rows-gap*2}];
  var hallW=6,left=(model.cols-hallW)/2,right=left,teamIndex=rooms.findIndex(function(f){return f.kind==='run';});
  if(teamIndex>=0&&count<=6){
    left=(model.cols-hallW)*.58;right=model.cols-hallW-left;
    result[teamIndex]={x:gap,y:gap,width:left-gap,height:model.rows-gap*2};
    var others=rooms.filter(function(_,i){return i!==teamIndex;}),height=(model.rows-gap*(others.length+1))/Math.max(1,others.length);
    others.forEach(function(f,i){result[rooms.indexOf(f)]={x:left+hallW,y:gap+i*(height+gap),width:right-gap,height:height};});
    return result;
  }
  var leftCount=Math.ceil(count/2),rightCount=Math.floor(count/2);
  rooms.forEach(function(f,i){var side=i%2,n=side?rightCount:leftCount,row=Math.floor(i/2),height=(model.rows-gap*(n+1))/n;result[i]={x:side?left+hallW:gap,y:gap+row*(height+gap),width:(side?right:left)-gap,height:height};});
  return result;
}
function roomBox(floor){var rooms=visibleRooms(),index=rooms.indexOf(floor);return overviewLayout(rooms)[index]||floor.overview;}
function hallwayBounds(){
  var rooms=visibleRooms(),layout=overviewLayout(rooms),left=layout.find(function(box){return box.x<model.cols/2-3;});
  return {x:left?left.x+left.width:model.cols/2-3,width:6,y:.6,height:model.rows-1.2};
}
function ensureSupervisor(){
  if (supervisorReady || !model) return;
  var hall = hallwayBounds(); supervisor.x = supervisor.targetX = hall.x + hall.width / 2; supervisor.y = supervisor.targetY = model.rows - 5; supervisorReady = true;
}
function roomEntrances(){
  var hall=hallwayBounds();return visibleRooms().map(function(floor){var box=roomBox(floor),left=box.x<hall.x;return {floor:floor,x:left?hall.x+.35:hall.x+hall.width-.35,y:box.y+box.height/2,height:box.height};});
}
function supervisorBounds(){var hall=hallwayBounds();return {minX:hall.x+.2,maxX:hall.x+hall.width-.2,minY:1,maxY:model.rows-3};}
function drawHallway(){
  var hall = hallwayBounds(), x = hall.x * T, y = hall.y * T, w = hall.width * T, h = hall.height * T;
  ctx.fillStyle = "rgba(183,199,163,.55)"; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PALETTE[3]; ctx.lineWidth = Math.max(1, 2 * U); ctx.strokeRect(x, y, w, h);
  for (var line = y + 14 * U; line < y + h; line += 28 * U) { ctx.strokeStyle = "rgba(138,80,51,.28)"; ctx.beginPath(); ctx.moveTo(x + 3 * U, line); ctx.lineTo(x + w - 3 * U, line); ctx.stroke(); }
  var oldS=S;S=T/8;draw('plant',x+T,y+T,PALETTE[2]);draw('plant',x+T,y+h-4*T,PALETTE[2]);S=oldS;
  roomEntrances().forEach(function(entry){ var ex = entry.x * T, ey = entry.y * T; ctx.fillStyle = PALETTE[6]; ctx.fillRect(ex - 5 * U, ey - 14 * U, 10 * U, 28 * U); ctx.strokeStyle = PALETTE[4]; ctx.strokeRect(ex - 5 * U, ey - 14 * U, 10 * U, 28 * U); });
}
function drawSupervisor(){
  ensureSupervisor(); if (!model) return;
  if (reducedMotion) { supervisor.x = supervisor.targetX; supervisor.y = supervisor.targetY; }
  else { supervisor.x += Math.max(-.7, Math.min(.7, supervisor.targetX - supervisor.x)); supervisor.y += Math.max(-.7, Math.min(.7, supervisor.targetY - supervisor.y)); }
  var moving = Math.abs(supervisor.x - supervisor.targetX) > .05 || Math.abs(supervisor.y - supervisor.targetY) > .05;
  var px = (supervisor.x-2.25) * T, py = supervisor.y * T; draw(moving && Math.floor(frame / 7) % 2 ? "step" : "person", px, py, PALETTE[14]);
  var hall=hallwayBounds(),labelX=supervisor.x*T-9*U,labelW=18*U;ctx.fillStyle=PALETTE[15];ctx.fillRect(labelX,py-16*U,labelW,13*U);ctx.strokeStyle=PALETTE[1];ctx.strokeRect(labelX,py-16*U,labelW,13*U);fillText("你",labelX+3*U,py-14*U,7,PALETTE[1]);
  var entry=roomEntrances().sort(function(a,b){return Math.hypot(a.x-supervisor.x,a.y-supervisor.y)-Math.hypot(b.x-supervisor.x,b.y-supervisor.y);})[0]; if(entry&&(Math.abs(entry.x-supervisor.x)>1.25||Math.abs(entry.y-supervisor.y)>Math.min(1.6,entry.height*.35)))entry=null;
  if (!moving && mode === "overview" && entry) { selectedKey = entry.floor.key; hallwayReturn = {x:supervisor.x, y:supervisor.y}; enterRoomFromHallway(entry.floor); }
}
function enterRoomFromHallway(floor){
  if (!floor) return;
  detailTarget=null;detailPage=0;
  roomSupervisor.x = roomSupervisor.targetX = floor.kind === "run" ? model.roomCols - 7 : 6;
  roomSupervisor.y = roomSupervisor.targetY = Math.max(8, Math.min(model.roomRows - 6, Math.round(model.roomRows / 2)));
  mode = "room"; lineIndex = 0; typed = 0; updateHeader(); canvas.focus();
}
function drawRoomSupervisor(){
  if (!model) return;
  if (reducedMotion) { roomSupervisor.x = roomSupervisor.targetX; roomSupervisor.y = roomSupervisor.targetY; }
  else { roomSupervisor.x += Math.max(-.7, Math.min(.7, roomSupervisor.targetX - roomSupervisor.x)); roomSupervisor.y += Math.max(-.7, Math.min(.7, roomSupervisor.targetY - roomSupervisor.y)); }
  var moving = Math.abs(roomSupervisor.x - roomSupervisor.targetX) > .05 || Math.abs(roomSupervisor.y - roomSupervisor.targetY) > .05;
  var px = roomSupervisor.x / model.roomCols * canvas.width - 2.25*T, py = roomSupervisor.y / model.roomRows * canvas.height; draw(moving && Math.floor(frame / 7) % 2 ? "step" : "person", px, py, PALETTE[14]);
  var labelW=20*U,labelX=Math.max(4*U,Math.min(canvas.width-labelW-4*U,px+9*S-labelW/2)),labelY=Math.max(4*U,py-16*U);ctx.fillStyle=PALETTE[15];ctx.fillRect(labelX,labelY,labelW,13*U);ctx.strokeStyle=PALETTE[1];ctx.strokeRect(labelX,labelY,labelW,13*U);fillText("你",labelX+4*U,labelY+2*U,8,PALETTE[1]);
}
function moveSupervisor(dx, dy){
  if (!model || !statusBox.hidden) return;
  var step = mode === "room" ? 1 : Math.min(1.25,(model.rows-2)/Math.max(1,Math.ceil(visibleRooms().length/2))/3);
  if (mode === "room") { roomSupervisor.targetX = Math.max(2, Math.min(model.roomCols - 5, roomSupervisor.targetX + dx * step)); roomSupervisor.targetY = Math.max(7, Math.min(model.roomRows - 7, roomSupervisor.targetY + dy * step)); if (reducedMotion) { roomSupervisor.x = roomSupervisor.targetX; roomSupervisor.y = roomSupervisor.targetY; } render(); return; }
  ensureSupervisor(); var bounds = supervisorBounds(); supervisor.targetX = Math.max(bounds.minX, Math.min(bounds.maxX, supervisor.targetX + dx * step)); supervisor.targetY = Math.max(bounds.minY, Math.min(bounds.maxY, supervisor.targetY + dy * step)); if (reducedMotion) { supervisor.x = supervisor.targetX; supervisor.y = supervisor.targetY; } render();
}
function renderRoomImage(floor, width, height){
  width=Math.round(width);height=Math.round(height);
  var signature=lang+'|'+T+'|'+width+'x'+height+'|'+JSON.stringify([floor.title,floor.status,floor.board,floor.props,floor.papers,floor.books,floor.clock]);
  var cached=roomCanvases[floor.key];if(cached&&cached.signature===signature)return cached.canvas;
  var roomCanvas=cached?cached.canvas:document.createElement('canvas');
  if(typeof roomCanvas.getContext!=='function')return null;
  roomCanvas.width=width;roomCanvas.height=height;var roomCtx=roomCanvas.getContext('2d');if(!roomCtx)return null;
  var oldCanvas=canvas,oldCtx=ctx;canvas=roomCanvas;ctx=roomCtx;ctx.imageSmoothingEnabled=false;drawRoomBase(floor);canvas=oldCanvas;ctx=oldCtx;
  roomCanvases[floor.key]={canvas:roomCanvas,signature:signature};return roomCanvas;
}
function drawOverviewRoom(floor){
  var box=roomBox(floor),surface={x:Math.round(box.x*T),y:Math.round(box.y*T),width:Math.round(box.width*T),height:Math.round(box.height*T)};
  ctx.save();ctx.beginPath();ctx.rect(surface.x,surface.y,surface.width,surface.height);ctx.clip();
  var image=renderRoomImage(floor,surface.width,surface.height);if(image)ctx.drawImage(image,surface.x,surface.y);
  floor.actors.forEach(function(actor){drawActor(floor,actor,surface);});
  if(floor.completedAt){ctx.fillStyle='rgba(53,90,75,.18)';ctx.fillRect(surface.x,surface.y,surface.width,surface.height);}ctx.restore();
}
function render(){
  if(!model)return;chooseRenderScale();var floor=activeRoom();
  if(mode==='room'&&floor){
    setCanvasSize(model.cols*T,model.rows*T);var image=renderRoomImage(floor,canvas.width,canvas.height);if(image)ctx.drawImage(image,0,0);else drawRoomBase(floor);
    floor.actors.forEach(function(actor){drawActor(floor,actor);});drawRoomSupervisor();
  }else{drawBackdrop(model.cols,model.rows,null);drawHallway();visibleRooms().forEach(drawOverviewRoom);drawSupervisor();if(!visibleRooms().length)fillText(t('quiet'),4*T,18*T,12);}
  fitCanvas();
}
function renderRoomNav(rooms){
  NAV_PAGE_SIZE=Math.max(1,Math.min(8,Math.floor((window.innerWidth-160)/120)));
  if (mode !== "overview") { if (navSignature !== lang + "|room") { roomNav.textContent = ""; navSignature = lang + "|room"; } return; }
  var pages = Math.max(1, Math.ceil(rooms.length / NAV_PAGE_SIZE));
  navPage = Math.max(0, Math.min(navPage, pages - 1));
  var signature = lang + "|overview|" + (showRecent ? "recent" : "active") + "|" + selectedKey + "|" + navPage + "|" + rooms.map(function(f){ return f.key; }).join(",");
  if (signature === navSignature) return;
  navSignature = signature; roomNav.textContent = "";
  if (pages > 1) { var previous = document.createElement("button"); previous.type = "button"; previous.textContent = "‹ " + t("previous"); previous.disabled = navPage === 0; previous.addEventListener("click", function(){ navPage--; updateHeader(); }); roomNav.appendChild(previous); }
  rooms.slice(navPage * NAV_PAGE_SIZE, navPage * NAV_PAGE_SIZE + NAV_PAGE_SIZE).forEach(function(floor, offset){ var button = document.createElement("button"); button.type = "button"; button.textContent = (navPage * NAV_PAGE_SIZE + offset + 1) + ". " + short(floor.title, 18); button.title = t("enter") + ": " + floor.title; button.setAttribute("aria-current", floor.key === selectedKey ? "true" : "false"); button.addEventListener("click", function(){ selectedKey = floor.key; enterRoom(); }); roomNav.appendChild(button); });
  if (pages > 1) { var next = document.createElement("button"); next.type = "button"; next.textContent = t("next") + " ›"; next.disabled = navPage === pages - 1; next.addEventListener("click", function(){ navPage++; updateHeader(); }); roomNav.appendChild(next); }
}
function updateHeader(){
  if(document.documentElement)document.documentElement.lang=lang==='zh'?'zh-Hant':'en';
  canvas.setAttribute('aria-label',lang==='zh'?'方向鍵或 WASD 移動 Supervisor；Enter 進入房間或查看細節；Esc 返回。':'Arrow keys or WASD move Supervisor; Enter opens rooms or details; Escape returns.');
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
function goOverview(){ mode = "overview"; var hall = hallwayBounds(); supervisor.x = supervisor.targetX = hall.x + hall.width / 2; supervisor.y = supervisor.targetY = hall.y + hall.height - 5; hallwayReturn = null; updateHeader(); render(); canvas.focus(); }
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
function addCommand(box, value, copyValue){
  var row = document.createElement("p"), code = document.createElement("code"), button = document.createElement("button");
  code.textContent = value; button.type = "button"; button.textContent = t("copy"); button.addEventListener("click", function(){
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copyValue || value).then(function(){ button.textContent = t("copied"); }, function(){});
  }); row.appendChild(code); row.appendChild(button); box.appendChild(row);
}
function pageItems(items, box, renderItem){
  var small=window.innerWidth<480, pageSize=Math.max(1,Math.min(small?3:5,Math.floor((window.innerHeight*.88-145)/(small?75:56)))), pages;
  items = items.flatMap(function(item){var value=item.value||'', limit=window.innerWidth<480?45:90, chunks=[];for(var offset=0;offset<value.length;offset+=limit)chunks.push(Object.assign({},item,{value:value.slice(offset,offset+limit),copyValue:item.kind==='command'?value:undefined}));return chunks.length?chunks:[item];});
  pages = Math.max(1,Math.ceil(items.length/pageSize));detailPage=Math.max(0,Math.min(detailPage,pages-1));
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
  if (item.kind === "command") return addCommand(box, item.value, item.copyValue);
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
  detailSignature=JSON.stringify(sourceFor(floor)); detailTarget = {floorKey: floor.key, actorKey: actor.key}; showDialog(actor.label, function(box){ pageItems(detailItems, box, renderDetailItem); });
}
function openRoomDetail(floor){
  if (!detailTarget || detailTarget.floorKey !== floor.key || detailTarget.actorKey !== null) detailPage = 0;
  detailSignature=JSON.stringify(sourceFor(floor)); detailTarget = {floorKey: floor.key, actorKey: null}; var source = sourceFor(floor), items = source && source.diff ? source.diff.paths || [] : [], entries = [];
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
  for (var i = floor.actors.length - 1; i >= 0; i--) { var a = floor.actors[i], pos = positions[a.key] || {x:a.x*T, y:a.y*T}; var ax=pos.x/(model.roomCols*T)*canvas.width, ay=pos.y/(model.roomRows*T)*canvas.height; if (x >= ax - 5 && x < ax + 18*S && y >= ay - 5 && y < ay + 26*S) return a; }
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
function poll(){ fetch("snapshot.json" + location.search, {cache:"no-store"}).then(function(r){ if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function(s){ snapshot = s; model = sceneModel(s); offline = false; if (!selectedKey || !roomByKey(selectedKey)) selectedKey = visibleRooms()[0] && visibleRooms()[0].key; updateHeader(); render(); if (!statusBox.hidden && detailTarget && roomByKey(detailTarget.floorKey)) { var signature=JSON.stringify(sourceFor(roomByKey(detailTarget.floorKey))); if(signature!==detailSignature){detailSignature=signature;openSelectedDetail();} } }, function(){ offline = true; updateHeader(); }); }
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
