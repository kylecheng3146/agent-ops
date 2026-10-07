import {sceneModel} from "./scene.js";

/** Warm cream, oak and sage colors, kept to a single 16-color pixel palette. */
export const PALETTE = ["#2b241f", "#355a4b", "#6d9275", "#b7c7a3", "#8a5033", "#729ead", "#d9aa72", "#ead8b8",
  "#8e7561", "#6b5d50", "#adc39a", "#f2e5c9", "#e8c99c", "#c86f4a", "#f2c95c", "#fff7e6"];

/** Each person has a fixed 16-color palette, independent of the room colors. */
export function avatarPalette(identity: string, viewer = false): string[] {
  let hash = 0;
  for (const character of identity) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  const hair = viewer ? ["#302c3b", "#514757", "#756575"] : [
    ["#302c3b", "#514757", "#756575"], ["#51372f", "#80533d", "#b47c51"], ["#745338", "#a37c4f", "#d1ad72"]
  ][hash % 3]!;
  const skin = viewer ? ["#bf8264", "#e6ae87", "#f5cda4"] : [
    ["#bf8264", "#e6ae87", "#f5cda4"], ["#9b624b", "#c08762", "#e0ae82"], ["#654039", "#96624e", "#bf8c68"]
  ][Math.floor(hash / 9) % 3]!;
  const clothes = viewer ? ["#bb893b", "#e3b64f", "#f7d878"] : [
    ["#37596d", "#5687a1", "#87b3c7"], ["#934d49", "#c57060", "#e6a087"],
    ["#3b6658", "#61947b", "#92bea1"], ["#625776", "#8c7da4", "#b7a9ca"]
  ][Math.floor(hash / 27) % 4]!;
  return ["#292633", ...hair, ...skin, ...clothes, "#404958", "#707a8b", "#2e3443", "#626e7f", "#fff1db", "#d58c76"];
}

/** Original 32×48 pixel people. Self-contained so the inline client uses this same art. */
export function avatarSprite(identity: string, direction = "down", pose = 0, viewer = false): string[] {
  let hash = 0;
  for (const character of identity) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  const hair = "2", hairLight = "3";
  const style = viewer ? 0 : Math.floor(hash / 3) % 3;
  const skin = "5", skinLight = "6", skinShade = "4", outfit = ["8", "7", "9"];
  const grid = Array.from({length: 48}, () => Array<string>(32).fill("."));
  const rect = (x: number, y: number, width: number, height: number, color: string) => {
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
      if (row >= 0 && row < 48 && column >= 0 && column < 32) grid[row]![column] = color;
    }
  };
  const stride = pose === 1 ? -1 : pose === 3 ? 1 : 0;
  const side = direction === "left" || direction === "right";
  // Slim trousers, cuffs and shaded shoes; opposite feet alternate during a walk.
  for (let leg = 0; leg < 2; leg++) {
    const x = side ? 12 + leg * 4 : 10 + leg * 7, lift = leg ? -stride : stride;
    rect(x, 35 + lift, 5, 10, "0"); rect(x + 1, 36 + lift, 3, 7, "a");
    rect(x + 1, 37 + lift, 1, 5, "b"); rect(x + 1, 43 + lift, 3, 1, "e");
    rect(x - 1, 44 + lift, 6, 3, "c"); rect(x, 44 + lift, 4, 1, "d"); rect(x, 46 + lift, 4, 1, "e");
  }
  const bodyX = side ? 11 : 8, bodyW = side ? 11 : 16;
  rect(bodyX + 2, 23, bodyW - 4, 1, "0"); rect(bodyX, 24, bodyW, 12, "0");
  rect(bodyX + 1, 25, bodyW - 2, 10, outfit[0]!);
  rect(bodyX + 1, 33, bodyW - 2, 2, outfit[1]!); rect(bodyX + bodyW - 3, 27, 2, 6, outfit[1]!);
  rect(bodyX + 2, 27, 2, 4, outfit[2]!); rect(bodyX + 3, 26, bodyW - 6, 1, outfit[2]!);
  if (direction !== "up") {
    rect(side ? 18 : 13, 22, side ? 3 : 6, 3, skinShade); rect(side ? 18 : 13, 22, side ? 2 : 5, 2, skin);
    rect(side ? 18 : 12, 25, side ? 2 : 8, 1, outfit[1]!);
    rect(side ? 18 : 13, 25, side ? 1 : 6, 1, outfit[2]!);
    if (!side) {rect(18, 29, 3, 3, outfit[1]!);rect(18, 29, 3, 1, outfit[2]!);}
  }
  const arms = side ? [12] : [5, 24];
  arms.forEach((x, index) => {
    const swing = stride * (index ? -1 : 1);
    rect(x, 25 + swing, 3, 10, "0"); rect(x + 1, 26 + swing, 2, 4, outfit[0]!);
    rect(x + 1, 29 + swing, 2, 1, outfit[1]!); rect(x + 1, 30 + swing, 2, 4, skinShade);
    rect(x + 1, 30 + swing, 1, 3, skinLight);
  });
  // Rounded jaw and small dark eyes, with warm skin shading instead of white face blocks.
  rect(9, 9, 14, 1, "0"); rect(7, 10, 18, 9, "0"); rect(8, 19, 16, 2, "0"); rect(10, 21, 12, 1, "0");
  rect(9, 10, 14, 11, skin); rect(8, 12, 16, 7, skin); rect(22, 13, 2, 6, skinShade);
  rect(19, 20, 3, 1, skinShade); rect(10, 13, 3, 1, skinLight);
  rect(6, 15, 2, 4, "0"); rect(24, 15, 2, 4, "0"); rect(7, 15, 1, 3, skin); rect(24, 15, 1, 3, skin);
  if (side) {
    rect(23, 14, 3, 4, "0"); rect(23, 15, 2, 2, skin);
    rect(21, 15, 2, 2, "0"); rect(21, 15, 1, 1, "e"); rect(23, 19, 1, 1, skinShade);
  } else if (direction === "down") {
    rect(10, 14, 3, 1, hairLight); rect(19, 14, 3, 1, hairLight);
    rect(11, 15, 2, 2, "0"); rect(19, 15, 2, 2, "0");
    rect(11, 15, 1, 1, "e"); rect(19, 15, 1, 1, "e");
    rect(9, 18, 2, 1, skinShade); rect(21, 18, 2, 1, skinShade); rect(15, 19, 2, 1, skinShade);
  }
  const crown = ["00000000", "00HHHHHHHH00", "0HHHHHHHHHHHH0", "0HHHHHHHHHHHHHH0", "0HHHHhhHHHHHHHHHH0",
    "0HHHhhhhhHHHHHHHHH0", "0HHHHHHhhhhhHHHHHHH0", "0HHHHHHHHHHHHHHHHHH0", "0HHHHHHHHHHHHHHHHHH0"];
  crown.forEach((row, y) => [...row].forEach((pixel, x) => rect(Math.floor((32 - row.length) / 2) + x, y + 2, 1, 1, pixel === "H" ? hair : pixel === "h" ? hairLight : pixel)));
  rect(5, 11, side ? 10 : 4, 5, hair); rect(7, 11, side ? 9 : 7, 2, hair);
  rect(11, 12, 2, 2, hair); rect(14, 11, 2, 1, hair);
  rect(6, 11, 1, 3, hairLight);
  if (direction === "up") {
    rect(6, 10, 20, 8, hair); rect(8, 18, 16, 2, hair); rect(10, 20, 12, 1, "0");
    rect(7, 12, 1, 4, hairLight); rect(22, 16, 2, 1, hairLight); rect(11, 19, 10, 1, hairLight);
  } else if (!side) {
    rect(23, 11, 3, 5, hair); rect(21, 11, 4, 2, hair); rect(20, 12, 2, 1, hair);
  }
  if (style === 1) { // Bob: longer sides and a low back, distinct from the short cut.
    rect(5, 14, side ? 9 : 4, 8, hair); if (!side) rect(23, 14, 3, 8, hair);
    if (direction === "up") rect(8, 18, 16, 5, hair);
    rect(6, 16, 1, 4, hairLight);
  } else if (style === 2) { // Curly outline with a raised crown and uneven fringe.
    rect(8, 1, 3, 3, hair); rect(14, 1, 3, 3, hair); rect(21, 2, 3, 3, hair);
    rect(5, 6, 2, 2, hairLight); rect(14, 11, 2, 2, hair); rect(19, 10, 2, 2, hair);
  }
  return grid.map(row => (direction === "left" ? row.reverse() : row).join(""));
}

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
var avatarSprite = __AVATAR__, avatarPalette = __AVATAR_COLORS__, avatarImages = {};
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
function roleText(kind){return (lang==='zh'?{coordinator:'統籌',worker:'成員',reviewer:'審查',visitor:'訪客'}:{coordinator:'Lead',worker:'Agent',reviewer:'Review',visitor:'Guest'})[kind]||kind;}
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
function avatarScale(surface){return Math.max(1,Math.round(Math.min(surface.width/(model.roomCols*T),surface.height/(model.roomRows*T))*T/9));}
function advanceAvatar(state, tx, ty, speed){
  var dx=tx-state.x,dy=ty-state.y;
  if(Math.abs(dx)>.05||Math.abs(dy)>.05)state.direction=Math.abs(dx)>Math.abs(dy)?(dx<0?'left':'right'):(dy<0?'up':'down');
  if(reducedMotion){state.x=tx;state.y=ty;}else{state.x+=Math.max(-speed,Math.min(speed,dx));state.y+=Math.max(-speed,Math.min(speed,dy));}
  state.walking=!reducedMotion&&(Math.abs(state.x-tx)>.05||Math.abs(state.y-ty)>.05);
}
function drawAvatar(identity, state, x, y, scale, viewer){
  var pose=state.walking&&!reducedMotion?Math.floor(frame/7)%4:0,direction=state.direction||'down',key=JSON.stringify([identity,direction,pose,!!viewer]);
  var image=avatarImages[key];
  if(!image){
    image=document.createElement('canvas');image.width=32;image.height=48;var paint=image.getContext('2d'),rows=avatarSprite(identity,direction,pose,!!viewer),colors=avatarPalette(identity,!!viewer);
    for(var row=0;row<rows.length;row++)for(var col=0;col<rows[row].length;col++){var pixel=rows[row][col];if(pixel!=='.'){paint.fillStyle=colors[parseInt(pixel,16)];paint.fillRect(col,row,1,1);}}
    avatarImages[key]=image;
  }
  x=Math.round(x);y=Math.round(y);
  ctx.fillStyle='rgba(43,36,31,.18)';ctx.fillRect(x+8*scale,y+46*scale,17*scale,2*scale);
  ctx.drawImage(image,x,y,32*scale,48*scale);
}
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
  advanceAvatar(pos,tx,ty,T/5);positions[actor.key]=pos;
  surface=surface||{x:0,y:0,width:canvas.width,height:canvas.height};
  var box=actorBox(actor,surface),oldS=S,oldU=U;S=box.scale;U=box.unit;
  var px=box.x,py=box.y;
  drawAvatar(actor.id,pos,px,py,S,false);
  if(!pos.walking&&!reducedMotion&&Math.floor(frame/30)%2===0){ctx.fillStyle=PALETTE[15];ctx.fillRect(px+12*S,py+30*S,8*S,4*S);}
  var text=short(actor.label,10)+' · '+roleText(actor.kind)+' · '+short(statusText(actor.status),8),font=9*U;
  ctx.font='bold '+font+'px monospace';var labelWidth=Math.min(surface.width-8*U,(ctx.measureText?ctx.measureText(text).width:text.length*font*.62)+8*U),labelX=Math.max(surface.x+4*U,Math.min(surface.x+surface.width-labelWidth-4*U,px-3*U)),labelY=Math.min(surface.y+surface.height-16*U,py+49*S);
  ctx.fillStyle=PALETTE[15];ctx.fillRect(labelX,labelY,labelWidth,14*U);ctx.strokeStyle=PALETTE[8];ctx.lineWidth=U;ctx.strokeRect(labelX,labelY,labelWidth,14*U);fillText(text,labelX+3*U,labelY+2*U,9,actor.alert?PALETTE[13]:PALETTE[0]);
  if(actor.alert&&(reducedMotion||Math.floor(frame/20)%2===0))draw('alert',px+14*S,py-9*S);
  S=oldS;U=oldU;
}
function actorBox(actor,surface){
  var pos=positions[actor.key]||{x:actor.x*T,y:actor.y*T},scale=avatarScale(surface),unit=Math.max(dpr,Math.min(U,scale));
  return {scale:scale,unit:unit,x:Math.round(Math.max(surface.x,Math.min(surface.x+surface.width-32*scale,surface.x+pos.x/(model.roomCols*T)*surface.width))),y:Math.round(Math.max(surface.y,Math.min(surface.y+surface.height-48*scale-16*unit,surface.y+pos.y/(model.roomRows*T)*surface.height)))};
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
  advanceAvatar(supervisor,supervisor.targetX,supervisor.targetY,.7);
  var moving=supervisor.walking,scale=Math.max(1,...visibleRooms().map(function(floor){var b=roomBox(floor);return avatarScale({width:b.width*T,height:b.height*T});}));
  var px=supervisor.x*T-16*scale,py=Math.min(canvas.height-48*scale,supervisor.y*T);drawAvatar('viewer',supervisor,px,py,scale,true);
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
  advanceAvatar(roomSupervisor,roomSupervisor.targetX,roomSupervisor.targetY,.7);
  var scale=avatarScale({width:canvas.width,height:canvas.height});
  var px=roomSupervisor.x/model.roomCols*canvas.width-16*scale,py=Math.min(canvas.height-48*scale,roomSupervisor.y/model.roomRows*canvas.height);drawAvatar('viewer',roomSupervisor,px,py,scale,true);
  var labelW=20*U,labelX=Math.max(4*U,Math.min(canvas.width-labelW-4*U,px+16*scale-labelW/2)),labelY=Math.max(4*U,py-16*U);ctx.fillStyle=PALETTE[15];ctx.fillRect(labelX,labelY,labelW,13*U);ctx.strokeStyle=PALETTE[1];ctx.strokeRect(labelX,labelY,labelW,13*U);fillText("你",labelX+4*U,labelY+2*U,8,PALETTE[1]);
}
function moveSupervisor(dx, dy){
  if (!model || !statusBox.hidden) return;
  var state=mode==='room'?roomSupervisor:supervisor;state.direction=dx?(dx<0?'left':'right'):(dy<0?'up':'down');
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
    {kind:"line", label:lang==='zh'?'職責':'Role', value:roleText(actor.kind)},
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
  for (var i = floor.actors.length - 1; i >= 0; i--) { var a=floor.actors[i],box=actorBox(a,{x:0,y:0,width:canvas.width,height:canvas.height});if(x>=box.x&&x<box.x+32*box.scale&&y>=box.y&&y<box.y+48*box.scale)return a; }
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
    .replace("__SCENE__", () => sceneModel.toString()).replace("__AVATAR__", () => avatarSprite.toString()).replace("__AVATAR_COLORS__", () => avatarPalette.toString());
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>agent-ops Office</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div id="app"><header id="header"><div id="brand">agent-ops Office</div><div id="crumb">Office overview</div><button id="back" type="button" hidden>← Back to overview</button><button id="recent" type="button">▣ Recently completed</button><button id="language" type="button">繁中 / EN</button><span id="live" aria-live="polite">● Connected</span></header>
<main id="wrap"><canvas id="office" tabindex="0" width="576" height="304" aria-label="Office rooms; use arrow keys and Enter to explore"></canvas><div id="dialogue" role="status" aria-live="polite"></div><nav id="room-nav" aria-label="Office rooms"></nav></main></div>
<section id="status" role="dialog" aria-modal="true" aria-labelledby="status-title" tabindex="-1" hidden></section><script nonce="${nonce}">${script}</script></body></html>`;
}
