import {ROOM_PALETTE, avatarColors, notePosition, personSprites, roomSprites} from "./art.js";
import {findPath, officeLayout, walkGrid} from "./layout.js";
import {sceneModel} from "./scene.js";

const STYLE = String.raw`
:root{color-scheme:light}
*{box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{margin:0;background:#2b241f;color:#2b241f;font:14px/1.45 system-ui,-apple-system,sans-serif}
button{font:inherit;color:inherit}
#app{height:100dvh;display:flex;flex-direction:column;overflow:hidden;background:#ead8b8}
#header{min-height:54px;display:flex;align-items:center;gap:12px;padding:8px 18px;background:#2b241f;color:#fff7e6;border-bottom:4px solid #8a5033;white-space:nowrap}
#brand{font:bold clamp(16px,1.4vw,22px)/1.25 "Courier New",monospace;letter-spacing:.02em}
#crumb{flex:1;overflow:hidden;text-overflow:ellipsis;color:#f2e5c9}
#header button{border:2px solid #f2e5c9;background:#355a4b;color:#fff7e6;padding:5px 9px;cursor:pointer;box-shadow:2px 2px 0 #000}
#header button:hover,#header button:focus-visible{background:#adc39a;color:#2b241f;outline:3px solid #f2c95c;outline-offset:2px}
#header button[hidden],#header select[hidden]{display:none}
#header select{border:2px solid #f2e5c9;background:#355a4b;color:#fff7e6;padding:4px 6px;font:inherit;box-shadow:2px 2px 0 #000}
#header select:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
#live{color:#adc39a}
#panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
#panel-toggle{flex:none;border:2px solid #2b241f;background:#d9aa72;padding:2px 8px;font-size:13px;cursor:pointer;box-shadow:2px 2px 0 #8a5033}
#panel-toggle:hover,#panel-toggle:focus-visible{background:#f2c95c;outline:3px solid #355a4b;outline-offset:2px}
#workspace.collapsed{grid-template-columns:minmax(0,1fr) 46px}
#workspace.collapsed #work-panel{padding:6px 4px;align-items:center}
#workspace.collapsed #work-heading,#workspace.collapsed #work-summary,#workspace.collapsed #work-list{display:none}
#workspace.collapsed #panel-head{flex:1}
#workspace.collapsed #panel-toggle{writing-mode:vertical-rl;padding:10px 4px;letter-spacing:.1em}
#workspace.collapsed #wrap{overflow:hidden}
#workspace{min-height:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) clamp(330px,28vw,400px);gap:12px;padding:10px}
#wrap{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;background:#ead8b8}
#overview{display:flex;flex-direction:column;gap:18px;padding:4px 8px 16px;outline:none}
#overview[hidden],#room-view[hidden]{display:none}
.repo-head{display:flex;align-items:baseline;gap:10px;margin:0 0 8px;padding:4px 10px;font-size:16px;background:#2b241f;color:#fff7e6;border-left:6px solid #6d9275}
.repo-alert{color:#f2c95c;font-size:14px}
.cards{display:flex;flex-wrap:wrap;gap:14px;justify-content:flex-start}
.card{position:relative;display:block;max-width:100%;padding:0;border:0;background:transparent;text-align:left;cursor:pointer}
.card-caption{position:absolute;left:10px;bottom:10px;max-width:calc(100% - 20px);display:flex;flex-wrap:wrap;align-items:baseline;gap:0 10px;padding:3px 10px;background:rgba(43,36,31,.85);border:2px solid #2b241f;pointer-events:none}
.card canvas{display:block;max-width:100%;height:auto;image-rendering:pixelated;image-rendering:crisp-edges;border:4px solid #6b5d50;box-shadow:4px 4px 0 #8a5033}
.card:hover canvas,.card:focus-visible canvas{border-color:#355a4b;outline:3px solid #f2c95c;outline-offset:2px}
.card:focus-visible{outline:none}
.card-title{font-weight:bold;color:#fff7e6;overflow-wrap:anywhere}
.card-meta{font-size:13px;color:#f2e5c9}
.empty-room{cursor:default}
.page-grid{display:grid;justify-content:center;gap:14px}
#overview.paged{height:100%;overflow-y:auto;scroll-snap-type:y mandatory;overscroll-behavior:contain;scrollbar-width:none;padding:0;gap:0}
#overview.paged::-webkit-scrollbar{display:none}
.page{scroll-snap-align:start;scroll-snap-stop:always;display:flex;align-items:center;justify-content:center;padding:8px 16px}
#room-view{display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 8px}
#hud{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;width:100%;padding:6px 10px;background:#fff7e6;border:2px solid #8a5033}
.hud-title{font-size:15px;margin-right:4px;overflow-wrap:anywhere}
.hud-bar{display:inline-block;width:110px;height:10px;background:#e2cda6;border:2px solid #2b241f}
.hud-bar i{display:block;height:100%;background:#6d9a5a}
.hud-count{font-variant-numeric:tabular-nums}
.badge{padding:0 6px;font-size:12px;border:2px solid #6b5d50;background:#f2e5c9}
.badge.good{border-color:#3f6b4e;color:#3f6b4e}
.badge.bad{border-color:#c86f4a;color:#a2502f}
.badge.alert{background:#c86f4a;border-color:#2b241f;color:#fff7e6;cursor:pointer}
#stage{position:relative}
#office{display:block;image-rendering:pixelated;image-rendering:crisp-edges;border:4px solid #6b5d50;box-shadow:6px 6px 0 #8a5033;outline:none;cursor:pointer;box-sizing:content-box}
#office:focus-visible{outline:4px solid #f2c95c;outline-offset:4px}
#labels{position:absolute;left:4px;top:4px;pointer-events:none}
#labels span{position:absolute;white-space:nowrap;font-size:12px;line-height:1.3}
#labels span[hidden]{display:none}
.zone-label{padding:0 6px;background:rgba(43,36,31,.82);color:#fff7e6;font-weight:bold}
.nameplate{transform:translateX(-50%);padding:0 4px;background:#fff7e6;border:1px solid #6b5d50;color:#2b241f}
.nameplate.alert{border-color:#c86f4a;color:#a2502f;font-weight:bold}
.nameplate.viewer{background:#f2c95c}
.overflow{padding:0 5px;background:#355a4b;color:#fff7e6;font-weight:bold}
.speech{transform:translate(-50%,-100%);max-width:260px;white-space:normal!important;padding:4px 8px;background:#fff7e6;border:2px solid #2b241f;box-shadow:2px 2px 0 #8a5033;color:#2b241f}
#work-panel{min-width:0;min-height:0;display:flex;flex-direction:column;padding:12px;background:#fff7e6;border:3px solid #6b5d50;box-shadow:4px 4px 0 #8a5033}
#work-heading{margin:0;font-size:18px;color:#355a4b}
#work-summary{margin:4px 0 10px;font-size:13px}
#work-list{min-height:0;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:8px;padding:2px 4px 4px 0}
.work-card{flex-shrink:0;padding:10px;border:2px solid #b7c7a3;background:#f2e5c9;overflow-wrap:anywhere}
.work-card.attention{border-color:#8a5033;border-left-width:5px}
.work-card button{display:block;width:100%;text-align:left;white-space:normal;overflow-wrap:anywhere;border:0;background:transparent;padding:0;cursor:pointer}
.work-name{font-weight:bold;font-size:14px;text-decoration:underline;text-underline-offset:3px;color:#355a4b}
.work-card p{margin:4px 0 0}
.criterion{border-left-width:5px}
.criterion.pass{border-color:#6d9275}
.criterion.fail{border-color:#c86f4a}
.criterion.unknown{border-color:#6b5d50}
.criterion.pending{border-color:#d9aa72}
.work-section{margin:6px 0 0;font-size:14px;color:#355a4b}
.work-command{display:block;padding:4px 6px;background:#f2e5c9;font:12px/1.4 monospace;overflow-wrap:anywhere}
.work-meta,.work-proof{font-size:13px;color:#4b4035}
.work-action,.work-reason{font-size:13px;font-weight:600;color:#8a5033}
.work-card button:focus-visible{outline:3px solid #355a4b;outline-offset:3px}
#status{position:fixed;z-index:4;inset:6dvh 50% auto auto;transform:translateX(50%);width:min(92vw,680px);max-height:88dvh;overflow:hidden;display:flex;flex-direction:column;gap:4px;padding:16px;background:#fff7e6;border:4px solid #6b5d50;box-shadow:8px 8px 0 #2b241f;color:#2b241f}
#status[hidden]{display:none}
#status h2{margin:0 0 8px;color:#355a4b;font-size:1.25em;overflow-wrap:anywhere}
#status .dialog-body{min-height:0;overflow:auto}
#status p{margin:5px 0;overflow-wrap:anywhere;white-space:pre-wrap}
#status ul{margin:5px 0;padding-left:22px}
#status li{overflow-wrap:anywhere}
#status .actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
#status>.actions{flex:0 0 auto}
#status code{display:inline-block;max-width:calc(100% - 74px);overflow-wrap:anywhere;white-space:pre-wrap;background:#f2e5c9;padding:2px 4px}
#status .dialog-pager{border-top:2px solid #d9aa72;padding-top:6px}
#status button{border:2px solid #2b241f;background:#d9aa72;padding:5px 10px;cursor:pointer}
#status button:focus-visible{outline:3px solid #f2c95c;outline-offset:2px}
#status.panel h2{font-family:"Courier New",monospace}
.panel-heading{margin:10px 0 4px;font-size:14px;color:#355a4b}
.panel-meta{font-size:13px;color:#4b4035}
.panel-phases{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;padding:0;list-style:none}
.panel-phases li{padding:2px 8px;border:2px solid #6b5d50;background:#f2e5c9;font-size:13px}
.panel-phases li.now{background:#355a4b;color:#fff7e6;border-color:#2b241f}
.panel-notes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.panel-column{display:flex;flex-direction:column;gap:6px;min-width:0}
.note{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:2px solid #2b241f;font-size:13px;box-shadow:2px 2px 0 rgba(43,36,31,.35);overflow-wrap:anywhere}
.note.todo{background:#f2c95c}.note.fail{background:#f3c2b4;border-color:#c86f4a}.note.pass{background:#cfe0a4}
.panel-question{padding:6px 8px;border:2px solid #c86f4a;background:#fdeee8}
#status.panel-task{border-color:#9c8d7d;background:#fffdf7}
#status.panel-diff{background:#2f3f4f;color:#e8eef0;border-color:#2b241f}
#status.panel-diff h2,#status.panel-diff .panel-meta{color:#a9d3d8}
.panel-files{margin:6px 0;padding-left:18px;font:13px/1.5 monospace}
.panel-files li.recent{color:#f2c95c}
#status.panel-verify{background:#2b241f;color:#fff7e6;border-color:#2f3f4f}
#status.panel-verify h2,#status.panel-verify .panel-meta{color:#a8c46a}
.panel-leds{list-style:none;margin:6px 0;padding:0;display:flex;flex-direction:column;gap:8px}
.led-row{display:flex;flex-direction:column;gap:2px;padding:6px 8px 6px 14px;border-left:6px solid #6b5d50;background:#3a2f28}
.led-row.pass{border-color:#a8c46a}.led-row.fail,.led-row.unknown{border-color:#c86f4a}
.panel-output{margin:4px 0 0;padding:6px 8px;max-height:220px;overflow:auto;background:#1f1a16;color:#f2e5c9;font:12px/1.4 monospace;white-space:pre-wrap;overflow-wrap:anywhere}
#status.panel-verify code,#status.panel-diff code{background:#1f1a16;color:#fff7e6}
#status.panel-review{background:#f0cf93;border-color:#2b241f}
.stamp{display:inline-block;margin:0 0 6px;padding:2px 10px;border:3px solid currentColor;font:bold 16px "Courier New",monospace;transform:rotate(-4deg)}
.stamp.pass{color:#3f6b4e}.stamp.fail{color:#a2502f}.stamp.not_run{color:#6b5d50}
.round{margin:8px 0;padding:8px 10px;background:#fff7e6;border:2px solid #b8743f}
.panel-findings{margin:6px 0 0;padding-left:18px}
.panel-findings li{margin:4px 0}.panel-findings li.blocking strong{color:#a2502f}
.panel-findings .advice{color:#355a4b}
#status.panel-integration{background:#e8c38c;border-color:#2b241f}
.panel-facts{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0;padding:8px;background:#fff7e6;border:2px solid #2b241f}
.panel-facts dt{font-weight:bold}.panel-facts dd{margin:0;font-family:monospace;overflow-wrap:anywhere}
.panel-steps{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.panel-steps li{padding:2px 10px;border:2px solid #6b5d50;background:#fff7e6;font-size:13px}
.panel-steps li.done{border-color:#3f6b4e;color:#3f6b4e}.panel-steps li.failed{border-color:#c86f4a;color:#a2502f}
@media(max-width:640px){.panel-notes{grid-template-columns:1fr}}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1000px){#workspace{grid-template-columns:1fr;grid-template-rows:minmax(240px,1fr) minmax(180px,.8fr);gap:8px;padding:6px}#workspace.collapsed{grid-template-columns:1fr;grid-template-rows:1fr auto}#workspace.collapsed #panel-toggle{writing-mode:horizontal-tb;padding:2px 8px}#work-panel{padding:8px}#work-heading{font-size:16px}}
@media(max-width:760px){#header{flex-wrap:wrap;gap:6px;padding:6px 8px}#brand{font-size:16px}#header button{order:1;font-size:12px;padding:3px 5px}#crumb{min-width:70px}#live{font-size:12px}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

const CLIENT = String.raw`
var PALETTE = __PALETTE__, SPRITES = __SPRITES__, PEOPLE = __PEOPLE__, LAYOUT = __LAYOUT__;
var sceneModel = __SCENE__, avatarColors = __AVATAR_COLORS__, walkGrid = __WALK__, findPath = __PATH__, notePosition = __NOTE_POS__;
var GRID = walkGrid(LAYOUT), ROOM_W = LAYOUT.width, ROOM_H = LAYOUT.height, BOARD_SLOTS = 12;
var ROOM_OF = {planning:"planning", implementing:"implementing", verifying:"verifying", reviewing:"reviewing", integrating:"integrating"};
var app = document.getElementById("app"), canvas = document.getElementById("office"), ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;
var wrap = document.getElementById("wrap"), overviewBox = document.getElementById("overview"), roomView = document.getElementById("room-view"), hud = document.getElementById("hud"), labels = document.getElementById("labels");
var statusBox = document.getElementById("status");
// The right-hand list can fold away so the office takes the whole width; the choice is a per-viewer convenience.
var workspace = document.getElementById("workspace"), panelToggle = document.getElementById("panel-toggle"), panelCollapsed = readCollapsed();
function readCollapsed(){ try { return localStorage.getItem("agent-office-list") === "collapsed"; } catch (_) { return false; } }
var workList=document.getElementById('work-list'),workHeading=document.getElementById('work-heading'),workSummary=document.getElementById('work-summary'),workSignature='';
var crumb = document.getElementById("crumb"), backButton = document.getElementById("back"), recentButton = document.getElementById("recent");
var languageButton = document.getElementById("language"), live = document.getElementById("live"), repoSelect = document.getElementById("repo-filter"), repoFilter = "", repoSignature = "";
var snapshot = null, model = null, frame = 0, offline = false, scale = 1, scaleY = 1;
var mode = "overview", selectedKey = null, showRecent = false, detailPage = 0, dialogClose = null, detailPreviousFocus = null, detailTarget = null;
var detailSignature = "";
var people = {}, viewer = spawnViewer(), doorFrames = {}, images = {}, bases = {}, roomCanvases = {}, overviewSignature = "", hudSignature = "", labelNodes = {}, lastFigures = [], stageCanvas = null;
var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function spawnViewer(){ return {x: Math.round(LAYOUT.spawn.x / 2) * 2, y: Math.round(LAYOUT.spawn.y / 2) * 2, path: [], dir: "up", step: 0}; }
var STRINGS = {
  en: {copyFailed:"Copy manually", copyHint:"Clipboard unavailable; select the command and copy it manually.", checks:"Acceptance checks", unfinished:"Not complete", sessionEnded:"Session ended", attention:"Needs attention", verifyFailed:"Verification failed", reviewFailed:"Review failed", blockedUnknown:"Blocked; reason not provided", openQuestion:"View questions and commands", detailsAction:"Details and commands", stale:"Reconnecting; showing last known state", viewer:"You", overview:"Office overview", rooms:"rooms", people:"people", recent:"Recently completed", recentOn:"Hide completed", repos:"Repository", allRepos:"All repositories", noTask:"No task", noTaskHint:"Nothing to verify or review", panel_task:"Whiteboard", panel_diff:"Screen", panel_verify:"QA board", panel_review:"Review desk", panel_integration:"Sorting table", noChanges:"No changed files yet.", filesCount:"files", notReviewed:"Not reviewed yet.", firstRound:"Round 1", recheck:"Re-check", blocking:"blocking", refutedYes:"The re-check overturned round 1.", refutedNo:"The re-check upheld round 1.", worktree:"Worktree", branch:"Branch", base:"Base", ahead:"Commits ahead", commitStep:"Commit", finishStep:"worktree finish (merge)", hideList:"Hide list »", showList:"« Work list", moveHint:"Arrow keys or WASD walk; Enter talks to the nearest person; Esc returns.", critPass:"PASS", critFail:"FAIL", critUnknown:"Undetermined", critPending:"Not verified yet", noCriteria:"This room has no acceptance criteria.", back:"Back to overview", connected:"● Connected", offline:"○ Reconnecting", quiet:"The office is quiet. No agent is at work.", waiting:"waiting for your answer", enter:"Enter room", close:"Close", previous:"Previous", next:"Next", page:"Page", details:"Details", progress:"Progress", verify:"Verify", review:"Review", pending:"Awaiting answer", task:"Task", status:"Status", phase:"Phase", host:"Host", now:"Now", owner:"Owner", currentWork:"Current work", question:"Pending question", questions:"Questions", workList:"Work list", clickWork:"Click for work", keyboardWork:"Press L for work list", keyboardPhase:"Press 1-5 for phase work", keyboardQuestions:"Press Q for questions", noPeople:"No known work is in this phase", noQuestions:"No pending questions", files:"Changed files", commands:"Commands", copy:"Copy", copied:"Copied", unknown:"unknown", unassigned:"unassigned", phases:{planning:"Planning", implementing:"Implementing", verifying:"Verifying", reviewing:"Reviewing", integrating:"Integrating", lobby:"Lobby", unknown:"Unassigned"}, statuses:{active:"active", idle:"idle", running:"running", reviewing:"reviewing", verifying:"verifying", blocked:"blocked", delivered:"delivered", complete:"complete", unknown:"unknown", unassigned:"unassigned", pending:"pending"}},
  zh: {copyFailed:"手動複製", copyHint:"無法存取剪貼簿；請選取指令後手動複製。", checks:"驗收條件", unfinished:"尚未完成", sessionEnded:"工作階段已結束", attention:"需要介入", verifyFailed:"驗證未通過", reviewFailed:"審查未通過", blockedUnknown:"受阻；尚無原因資料", openQuestion:"查看問題與指令", detailsAction:"詳情與指令", stale:"重新連線中；顯示最後已知狀態", viewer:"你", overview:"辦公室總覽", rooms:"個房間", people:"位成員", recent:"最近完成", recentOn:"隱藏已完成", repos:"專案", allRepos:"所有專案", noTask:"無任務", noTaskHint:"沒有需要驗證或審查的工作", panel_task:"白板", panel_diff:"隔間螢幕", panel_verify:"QA 狀態看板", panel_review:"主管桌", panel_integration:"分信桌", noChanges:"目前沒有變更的檔案。", filesCount:"個檔案", notReviewed:"尚未審查。", firstRound:"第 1 輪", recheck:"對抗複查", blocking:"阻擋", refutedYes:"對抗複查推翻了第 1 輪。", refutedNo:"對抗複查維持第 1 輪的結論。", worktree:"Worktree", branch:"分支", base:"基準", ahead:"領先 commit", commitStep:"commit", finishStep:"worktree finish（合併）", hideList:"收合 »", showList:"« 工作清單", moveHint:"方向鍵或 WASD 走動；Enter 和最近的人對話；Esc 返回。", critPass:"通過", critFail:"未通過", critUnknown:"無法判定", critPending:"還沒驗證", noCriteria:"這間房沒有驗收條件。", back:"返回總覽", connected:"● 已連線", offline:"○ 重新連線中", quiet:"辦公室很安靜，目前沒有成員工作。", waiting:"等待你的回覆", enter:"進入房間", close:"關閉", previous:"上一頁", next:"下一頁", page:"頁", details:"詳細資料", progress:"進度", verify:"驗證", review:"審查", pending:"待回覆", task:"任務", status:"狀態", phase:"階段", host:"主機", now:"目前", owner:"負責人", currentWork:"目前工作", question:"待回覆問題", questions:"問題", workList:"工作清單", clickWork:"點擊查看工作", keyboardWork:"按 L 開啟工作清單", keyboardPhase:"按 1-5 查看階段工作", keyboardQuestions:"按 Q 查看問題", noPeople:"此階段目前沒有已知工作", noQuestions:"目前沒有待回覆問題", files:"變更檔案", commands:"指令", copy:"複製", copied:"已複製", unknown:"未知", unassigned:"未分配", phases:{planning:"規劃", implementing:"開發", verifying:"驗證", reviewing:"審查", integrating:"整合", lobby:"大廳", unknown:"未分配"}, statuses:{active:"進行中", idle:"閒置", running:"工作中", reviewing:"審查中", verifying:"驗證中", blocked:"受阻", delivered:"已交付", complete:"已完成", unknown:"未知", unassigned:"未分配", pending:"待回覆"}}
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
function shortName(value,limit){value=safeText(value);return value.length>limit?value.slice(0,limit-6)+'…'+value.slice(-5):value;}
function roomByKey(key){ if (!model) return null; for (var i = 0; i < model.floors.length; i++) if (model.floors[i].key === key) return model.floors[i]; return null; }
function visibleRooms(){ if (!model) return []; return model.floors.filter(function(f){ return (showRecent || !f.completedAt) && (!repoFilter || f.repo === repoFilter); }); }
function repoNames(){ var names = []; if (model) model.floors.forEach(function(f){ if (f.repo && names.indexOf(f.repo) < 0) names.push(f.repo); }); return names; }
function renderRepoFilter(){
  var names = repoNames(); if (repoFilter && names.indexOf(repoFilter) < 0) repoFilter = "";
  repoSelect.hidden = names.length < 2; repoSelect.setAttribute("aria-label", t("repos"));
  var signature = lang + "|" + repoFilter + "|" + names.join("\n"); if (signature === repoSignature) return; repoSignature = signature;
  repoSelect.textContent = ""; [""].concat(names).forEach(function(name){ var option = document.createElement("option"); option.value = name; option.textContent = name || t("allRepos"); option.selected = name === repoFilter; repoSelect.appendChild(option); });
}
function activeRoom(){ return selectedKey ? roomByKey(selectedKey) : null; }
function hasRecent(){ return !!(model && model.floors.some(function(f){ return !!f.completedAt; })); }
// ---- art: sprites become small canvases once; the canvas world draws no text ----
function mirror(rows){ return rows.map(function(row){ return row.split("").reverse().join(""); }); }
function rasterize(rows, colours){
  var image = document.createElement("canvas"); image.width = rows[0].length; image.height = rows.length;
  var g = image.getContext("2d"); g.imageSmoothingEnabled = false;
  for (var y = 0; y < rows.length; y++) {
    var row = rows[y], x = 0;
    while (x < row.length) { var key = row[x], end = x + 1; while (end < row.length && row[end] === key) end++; if (key !== "." && colours[key]) { g.fillStyle = colours[key]; g.fillRect(x, y, end - x, 1); } x = end; }
  }
  return image;
}
function spriteImage(name){ if (!images[name]) images[name] = rasterize(SPRITES[name], PALETTE); return images[name]; }
function personImage(id, role, pose){
  var key = JSON.stringify([id, role, pose]);
  if (!images[key]) images[key] = rasterize(pose.indexOf("left") === 0 ? mirror(PEOPLE["right" + pose.slice(4)]) : (PEOPLE[pose] || PEOPLE.down0), avatarColors(id, role));
  return images[key];
}
function makeCanvas(){ var c = document.createElement("canvas"); c.width = ROOM_W; c.height = ROOM_H; c.getContext("2d").imageSmoothingEnabled = false; return c; }
function fill(g, key, r){ g.fillStyle = PALETTE[key]; g.fillRect(r.x, r.y, r.w, r.h); }
function tile(g, name, r){
  var image = spriteImage(name), w = SPRITES[name][0].length, h = SPRITES[name].length;
  g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
  for (var y = r.y; y < r.y + r.h; y += h) for (var x = r.x; x < r.x + r.w; x += w) g.drawImage(image, x, y);
  g.restore();
}
function verifyFails(floor){ return floor.board.verify === "FAIL"; }
function variantName(name, variant, floor){ return variant ? name + (verifyFails(floor) ? "Fail" : "Pass") : name; }
/** Floors, walls and wall decor: drawn once per room and verification state. */
function roomBase(floor){
  var key = floor.key + "|" + verifyFails(floor);
  if (bases[key]) return bases[key];
  var base = makeCanvas(), g = base.getContext("2d");
  fill(g, "2", {x: 0, y: 0, w: ROOM_W, h: ROOM_H});
  LAYOUT.rooms.forEach(function(room){ tile(g, room.floor, room); });
  LAYOUT.rugs.forEach(function(rug){ fill(g, rug.border, rug); fill(g, rug.fill, {x: rug.x + 3, y: rug.y + 3, w: rug.w - 6, h: rug.h - 6}); });
  tile(g, "wall", LAYOUT.walls.back); tile(g, "wall", LAYOUT.walls.middle);
  LAYOUT.walls.vertical.forEach(function(v){ fill(g, "1", v); fill(g, "2", {x: v.x + 1, y: v.y, w: 6, h: v.h}); fill(g, "3", {x: v.x + 1, y: v.y, w: 2, h: v.h}); fill(g, "4", {x: v.x + 1, y: v.y, w: 1, h: v.h}); });
  LAYOUT.walls.sides.concat([LAYOUT.walls.bottom]).forEach(function(r){ fill(g, "2", r); });
  var door = LAYOUT.entrance; fill(g, "7", door); fill(g, "b", {x: door.x + 2, y: door.y - 8, w: door.w - 4, h: 8}); fill(g, "c", {x: door.x + 4, y: door.y - 6, w: door.w - 8, h: 4});
  LAYOUT.decor.forEach(function(d){ g.drawImage(spriteImage(variantName(d.sprite, d.variant, floor)), d.x, d.y); });
  bases[key] = base;
  return base;
}

// ---- people: a slot in the room of their phase; they walk only when the phase changes ----
function roomFor(actor){ return ROOM_OF[actor.phase] || "lobby"; }
function layoutRoom(id){ for (var i = 0; i < LAYOUT.rooms.length; i++) if (LAYOUT.rooms[i].id === id) return LAYOUT.rooms[i]; return LAYOUT.rooms[LAYOUT.rooms.length - 1]; }
function placements(floor){
  var counts = {}, byActor = {};
  floor.actors.slice().sort(function(a, b){ return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; }).forEach(function(actor){
    var room = roomFor(actor), index = counts[room] || 0; counts[room] = index + 1; byActor[actor.key] = {room: room, index: index};
  });
  return {byActor: byActor, counts: counts};
}
function syncPeople(){
  if (!model) return;
  var seen = {};
  model.floors.forEach(function(floor){
    var place = placements(floor).byActor;
    floor.actors.forEach(function(actor){
      var p = place[actor.key], room = layoutRoom(p.room), slot = room.slots[Math.min(p.index, room.slots.length - 1)], target = p.room + ":" + p.index, state = people[actor.key];
      seen[actor.key] = true;
      if (!state) { people[actor.key] = {x: slot.feet.x, y: slot.feet.y, path: [], dir: "down", step: 0, target: target, slot: slot, hidden: p.index >= room.slots.length}; return; }
      state.hidden = p.index >= room.slots.length;
      if (state.target === target) return;
      state.target = target; state.slot = slot;
      var path = reducedMotion ? null : findPath(GRID, {x: state.x, y: state.y}, slot.feet);
      if (path && path.length > 1) state.path = path.slice(1);
      else { state.path = []; state.x = slot.feet.x; state.y = slot.feet.y; }
    });
  });
  Object.keys(people).forEach(function(key){ if (!seen[key]) delete people[key]; });
}
function stepAlong(state){
  if (!state.path.length) return;
  var next = state.path.shift(), dx = next.x - state.x, dy = next.y - state.y;
  state.dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
  state.x = next.x; state.y = next.y; state.step++;
}
/** People cover two grid cells a frame, the viewer three. */
function advance(){ Object.keys(people).forEach(function(key){ stepAlong(people[key]); stepAlong(people[key]); }); stepAlong(viewer); stepAlong(viewer); stepAlong(viewer); }
function walkPose(state){ return state.dir + ["1", "0", "2", "0"][(state.step >> 3) % 4]; }
/** Everyone drawn in a room: sprite top-left, draw depth, pose and feet. */
function figures(floor){
  var out = [];
  floor.actors.forEach(function(actor){
    var state = people[actor.key];
    if (!state || state.hidden) return;
    var walking = state.path.length > 0, slot = state.slot;
    if (walking) out.push({actor: actor, x: state.x - 17, y: state.y - 49, z: state.y, pose: walkPose(state), walking: true, feet: {x: state.x, y: state.y}});
    else out.push({actor: actor, x: slot.x, y: slot.y, z: slot.z, pose: actor.questionCount > 0 ? "hand" : slot.pose, walking: false, feet: {x: state.x, y: state.y}});
  });
  return out;
}
/** A door opens while someone walks through it: closed, ajar, open. */
function doorFrame(door, walkers){
  var cx = door.gap.x + door.gap.w / 2, cy = door.gap.y + door.gap.h / 2, near = Infinity;
  walkers.forEach(function(p){ near = Math.min(near, Math.abs(p.x - cx) + Math.abs(p.y - cy)); });
  return near < 20 ? 2 : near < 36 ? 1 : 0;
}
function noteName(status){ return status === "PASS" ? "notePass" : status === "FAIL" ? "noteFail" : status === "UNKNOWN" ? "noteUnknown" : "notePending"; }
/** The planning whiteboard carries one sticky note per acceptance criterion. */
function drawNotes(floor, g){
  var criteria = floor.criteria || [], shown = criteria.length > BOARD_SLOTS ? criteria.slice(0, BOARD_SLOTS - 1) : criteria;
  shown.forEach(function(criterion, index){ var p = notePosition(index); g.drawImage(spriteImage(noteName(criterion.status)), LAYOUT.board.x + p.x, LAYOUT.board.y + p.y); });
  if (criteria.length > BOARD_SLOTS) { var last = notePosition(BOARD_SLOTS - 1); g.drawImage(spriteImage("notePlus"), LAYOUT.board.x + last.x, LAYOUT.board.y + last.y); }
}
function iconFor(floor, actor){
  if (actor.questionCount > 0) return "bubbleAlert";
  if (floor.completedAt || actor.status === "complete") return "bubbleDone";
  if ((actor.phase === "implementing" || actor.phase === "verifying") && (reducedMotion || (frame >> 5) % 2 === 0)) return "bubbleBusy";
  return null;
}
/** Draws one room at 1 art pixel per pixel; returns the people drawn. */
function renderRoom(floor, g){
  g.imageSmoothingEnabled = false;
  g.drawImage(roomBase(floor), 0, 0);
  var figs = figures(floor), here = mode === "room" && activeRoom() === floor, walkers = figs.filter(function(f){ return f.walking; }).map(function(f){ return f.feet; }), list = [];
  if (here) walkers.push({x: viewer.x, y: viewer.y});
  LAYOUT.items.forEach(function(item){ list.push({z: item.z, x: item.x, y: item.y, image: spriteImage(variantName(item.sprite, item.variant, floor)), board: item.sprite === "board"}); });
  LAYOUT.doors.forEach(function(door){
    var f = doorFrame(door, walkers); doorFrames[floor.key + "|" + door.id] = f;
    list.push({z: door.kind === "side" ? door.y + 34 : LAYOUT.walls.middle.y + LAYOUT.walls.middle.h, x: door.x, y: door.y, image: spriteImage((door.kind === "side" ? "sideDoor" : "frontDoor") + f)});
  });
  figs.forEach(function(f){ list.push({z: f.z, x: f.x, y: f.y, image: personImage(f.actor.id, f.actor.kind, f.pose)}); });
  if (here) list.push({z: viewer.y, x: viewer.x - 17, y: viewer.y - 49, image: personImage("viewer", "viewer", viewer.path.length ? walkPose(viewer) : viewer.dir + "0")});
  list.sort(function(a, b){ return a.z - b.z; }).forEach(function(entry){ g.drawImage(entry.image, entry.x, entry.y); if (entry.board) drawNotes(floor, g); });
  figs.forEach(function(f){ var icon = iconFor(floor, f.actor); if (icon) g.drawImage(spriteImage(icon), f.x + 11, f.y - 15 - (icon === "bubbleAlert" && !reducedMotion && (frame >> 4) % 2 ? 1 : 0)); });
  return figs;
}

// ---- overview: one section per repository, equal cards at one whole-number scale ----
function roomRank(floor){
  if (floor.questions.length || floor.actors.some(function(a){ return a.questionCount > 0; })) return 0;
  return !floor.completedAt && floor.status !== "idle" && floor.status !== "complete" ? 1 : 2;
}
function overviewGroups(){
  var groups = {};
  visibleRooms().forEach(function(floor){ var repo = floor.repo || ""; (groups[repo] = groups[repo] || []).push(floor); });
  return Object.keys(groups).sort().map(function(repo){
    var rooms = groups[repo].map(function(floor, index){ return {floor: floor, index: index}; })
      .sort(function(a, b){ return roomRank(a.floor) - roomRank(b.floor) || a.index - b.index; }).map(function(entry){ return entry.floor; });
    return {repo: repo, rooms: rooms, questions: rooms.reduce(function(n, f){ return n + f.questions.length; }, 0)};
  });
}
function orderedRooms(){ return overviewGroups().reduce(function(all, group){ return all.concat(group.rooms); }, []); }
var CARD_GAP = 14, CARD_BORDER = 8;
/** As many columns as fit at 1x or more; the leftover width is shared so the row reaches the right edge. */
function overviewScale(){
  var width = ((wrap && wrap.clientWidth) || window.innerWidth) - 32, columns = Math.max(1, Math.floor((width + CARD_GAP) / (ROOM_W + CARD_GAP)));
  return Math.max(1, (width - (columns - 1) * CARD_GAP - columns * CARD_BORDER) / columns / ROOM_W);
}
function summaryFor(floor){
  var criteria = floor.criteria || [], passed = criteria.filter(function(c){ return c.status === "PASS"; }).length;
  return phaseLabel(floor.phase) + " · " + (criteria.length ? t("checks") + " " + passed + "/" + criteria.length : statusText(floor.status)) + (floor.questions.length ? " · ! " + floor.questions.length : "");
}
var PAGE_SIZE = 4;
/** How far a folded card may stretch from the room's 9:5 to fill the page. */
var MAX_STRETCH = 1.18;
/**
 * Folded list: rooms come in pages of up to four, each page one viewport tall
 * in a scroller that snaps page by page. Each page takes the column count that
 * gives its cards the most area (four rooms form a 2x2 grid, two split the page
 * in halves, one fills it), and cards stretch to fill their cell while their
 * shape stays within MAX_STRETCH of 9:5.
 */
function pageHeight(){ return Math.max(160, Math.floor((wrap && wrap.clientHeight) || window.innerHeight - 70)); }
function pageLayout(count, inset){
  var width = ((wrap && wrap.clientWidth) || window.innerWidth) - 32, height = pageHeight() - 16 - (inset || 0), best = {columns: 1, sx: 0.5, sy: 0.5};
  for (var columns = 1; columns <= Math.max(1, count); columns++) {
    var rows = Math.ceil(Math.max(1, count) / columns);
    var sx = (width - (columns - 1) * CARD_GAP - columns * CARD_BORDER) / columns / ROOM_W, sy = (height - (rows - 1) * CARD_GAP - rows * CARD_BORDER) / rows / ROOM_H;
    if (sx > sy * MAX_STRETCH) sx = sy * MAX_STRETCH; else if (sy > sx * MAX_STRETCH) sy = sx * MAX_STRETCH;
    if (sx * sy > best.sx * best.sy) best = {columns: columns, sx: sx, sy: sy};
  }
  return best;
}
function pageCount(){ return Math.max(1, Math.ceil(orderedRooms().length / PAGE_SIZE)); }
function pageInView(){ return Math.max(0, Math.min(pageCount() - 1, Math.round((overviewBox.scrollTop || 0) / pageHeight()))); }
function pageRooms(page){ return orderedRooms().slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE); }
function roomCard(floor, number, sx, sy){
  var card = document.createElement("button"), view = makeCanvas();
  card.type = "button"; card.className = "card"; card.setAttribute("data-key", floor.key); card.setAttribute("aria-label", t("enter") + ": " + floor.title);
  view.style.width = Math.floor(ROOM_W * sx) + "px"; view.style.height = Math.floor(ROOM_H * (sy || sx)) + "px";
  card.appendChild(view);
  var caption = document.createElement("span"); caption.className = "card-caption";
  caption.appendChild(panelText("span", "card-title", (number <= 9 ? number + ". " : "") + floor.title));
  caption.appendChild(panelText("span", "card-meta", summaryFor(floor)));
  card.appendChild(caption);
  card.addEventListener("click", function(){ enterRoom(floor.key); });
  roomCanvases[floor.key] = view;
  return card;
}
/** Nobody at work: the office still shows one empty room. */
var EMPTY_FLOOR = {key: "__empty", title: "", kind: "desk", actors: [], questions: [], criteria: [], phase: "unknown", status: "idle", completedAt: null, repo: null,
  board: {passed: 0, total: 0, verify: "pending", review: "pending", pending: 0, status: "idle", taskId: "unassigned"}};
function emptyCard(){
  var layout = pageLayout(1, panelCollapsed ? 0 : 24), card = el("div", "card empty-room"), view = makeCanvas();
  view.style.width = Math.floor(ROOM_W * layout.sx) + "px"; view.style.height = Math.floor(ROOM_H * layout.sy) + "px";
  card.appendChild(view);
  var caption = el("span", "card-caption"); caption.appendChild(el("span", "card-title", t("quiet"))); card.appendChild(caption);
  roomCanvases[EMPTY_FLOOR.key] = view;
  // The open overview pads itself; leave that room so a lone card never scrolls.
  var sheet = el("section", "page"); sheet.style.height = (pageHeight() - (panelCollapsed ? 0 : 24)) + "px"; sheet.appendChild(card);
  return sheet;
}
function drawCards(){ Object.keys(roomCanvases).forEach(function(key){ var floor = key === EMPTY_FLOOR.key ? EMPTY_FLOOR : roomByKey(key); if (floor) renderRoom(floor, roomCanvases[key].getContext("2d")); }); }
function renderOverviewPages(){
  var pages = pageCount(), height = pageHeight();
  var signature = JSON.stringify(["pages", lang, height, (wrap && wrap.clientWidth) || window.innerWidth, orderedRooms().map(function(f){ return [f.key, f.title, f.status, f.phase, f.completedAt, f.questions.length, (f.criteria || []).map(function(c){ return c.status; })]; })]);
  if (signature !== overviewSignature) {
    overviewSignature = signature; overviewBox.textContent = ""; roomCanvases = {};
    if (!orderedRooms().length) overviewBox.appendChild(emptyCard());
    for (var page = 0; page < pages && orderedRooms().length; page++) {
      var rooms = pageRooms(page), layout = pageLayout(rooms.length), sheet = document.createElement("section"), grid = document.createElement("div");
      sheet.className = "page"; sheet.setAttribute("data-page", String(page + 1)); sheet.style.height = height + "px";
      grid.className = "cards page-grid"; grid.style.gridTemplateColumns = "repeat(" + layout.columns + ", max-content)";
      rooms.forEach(function(floor, index){ grid.appendChild(roomCard(floor, index + 1, layout.sx, layout.sy)); });
      sheet.appendChild(grid); overviewBox.appendChild(sheet);
    }
  }
  drawCards();
}
function renderOverview(){
  overviewBox.className = panelCollapsed ? "paged" : "";
  if (panelCollapsed) return renderOverviewPages();
  var groups = overviewGroups(), size = overviewScale();
  var signature = JSON.stringify([lang, size, groups.map(function(group){ return [group.repo, group.questions, group.rooms.map(function(f){ return [f.key, f.title, f.status, f.phase, f.completedAt, f.questions.length, (f.criteria || []).map(function(c){ return c.status; })]; })]; })]);
  if (signature !== overviewSignature) {
    overviewSignature = signature; overviewBox.textContent = ""; roomCanvases = {};
    if (!groups.length) overviewBox.appendChild(emptyCard());
    var number = 0;
    groups.forEach(function(group){
      var section = document.createElement("section"); section.className = "repo-section"; section.setAttribute("data-repo", group.repo);
      var head = document.createElement("h2"); head.className = "repo-head";
      head.appendChild(panelText("span", "repo-name", group.repo || t("overview")));
      head.appendChild(panelText("span", "repo-alert", group.questions ? "! " + group.questions : ""));
      section.appendChild(head);
      var cards = document.createElement("div"); cards.className = "cards";
      group.rooms.forEach(function(floor){ number++; cards.appendChild(roomCard(floor, number, size)); });
      section.appendChild(cards); overviewBox.appendChild(section);
    });
  }
  drawCards();
}

// ---- room view: the pixel-exact room layer stretched to fill the space, text in HTML over it ----
/** The room view fills the space, stretching at most MAX_STRETCH from 9:5. */
function roomScales(){
  var width = ((wrap && wrap.clientWidth) || window.innerWidth) - 32, height = ((wrap && wrap.clientHeight) || window.innerHeight) - ((hud && hud.offsetHeight) || 44) - 40;
  var sx = Math.max(0.5, width / ROOM_W), sy = Math.max(0.5, height / ROOM_H);
  if (sx > sy * MAX_STRETCH) sx = sy * MAX_STRETCH; else if (sy > sx * MAX_STRETCH) sy = sx * MAX_STRETCH;
  return {x: sx, y: sy};
}
function renderRoomView(){
  var floor = activeRoom(); if (!floor) return;
  var scales = roomScales(); scale = scales.x; scaleY = scales.y;
  // The CSS box fills the space; the backing store follows the device pixels so nearest-neighbour stays sharp.
  var cssW = Math.round(ROOM_W * scale), cssH = Math.round(ROOM_H * scaleY), dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  var backW = Math.round(cssW * dpr), backH = Math.round(cssH * dpr);
  if (canvas.width !== backW) canvas.width = backW;
  if (canvas.height !== backH) canvas.height = backH;
  canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";
  labels.style.width = canvas.style.width; labels.style.height = canvas.style.height;
  if (!stageCanvas) stageCanvas = makeCanvas();
  lastFigures = renderRoom(floor, stageCanvas.getContext("2d"));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(stageCanvas, 0, 0, backW, backH);
  renderHud(floor); renderLabels(floor, lastFigures);
}
function renderHud(floor){
  var criteria = floor.criteria || [], passed = criteria.filter(function(c){ return c.status === "PASS"; }).length, questions = floor.questions.length;
  var signature = JSON.stringify([lang, floor.key, floor.title, passed, criteria.length, floor.board.verify, floor.board.review, questions]);
  if (signature === hudSignature) return;
  hudSignature = signature; hud.textContent = "";
  hud.appendChild(panelText("strong", "hud-title", floor.title));
  var bar = document.createElement("span"), done = document.createElement("i");
  bar.className = "hud-bar"; bar.setAttribute("role", "img"); bar.setAttribute("aria-label", t("checks") + " " + passed + "/" + criteria.length);
  done.style.width = (criteria.length ? Math.round(passed * 100 / criteria.length) : 0) + "%"; bar.appendChild(done); hud.appendChild(bar);
  hud.appendChild(panelText("span", "hud-count", passed + "/" + criteria.length));
  var tone = function(value){ return value === "FAIL" ? " bad" : value === "PASS" ? " good" : ""; };
  hud.appendChild(panelText("span", "badge" + tone(floor.board.verify), t("verify") + " " + outcomeText(floor.board.verify)));
  hud.appendChild(panelText("span", "badge" + tone(floor.board.review), t("review") + " " + outcomeText(floor.board.review)));
  if (questions) {
    var ask = document.createElement("button"); ask.type = "button"; ask.className = "badge alert"; ask.textContent = "! " + questions + " " + t("pending");
    ask.addEventListener("click", function(){ openQuestionList(floor); }); hud.appendChild(ask);
  }
}
function label(key, className, text, x, y){
  var node = labelNodes[key];
  if (!node) { node = document.createElement("span"); labelNodes[key] = node; labels.appendChild(node); }
  node.className = className; if (node.textContent !== text) node.textContent = text;
  node.style.left = x * scale + "px"; node.style.top = y * scaleY + "px"; node.hidden = false;
  return node;
}
function resetLabels(){ labels.textContent = ""; labelNodes = {}; hudSignature = ""; }
function nearestActor(figs){
  var best = null, distance = 30;
  figs.forEach(function(f){ var d = Math.abs(f.feet.x - viewer.x) + Math.abs(f.feet.y - viewer.y); if (d < distance) { distance = d; best = f; } });
  return best;
}
function renderLabels(floor, figs){
  Object.keys(labelNodes).forEach(function(key){ labelNodes[key].hidden = true; });
  LAYOUT.rooms.forEach(function(room){ label("zone:" + room.id, "zone-label", phaseLabel(room.id), room.x + 4, room.y + 2); });
  var counts = placements(floor).counts;
  LAYOUT.rooms.forEach(function(room){
    var extra = (counts[room.id] || 0) - room.slots.length;
    if (extra > 0) { var last = room.slots[room.slots.length - 1]; label("more:" + room.id, "overflow", "+" + extra, last.x + 30, last.y); }
  });
  figs.forEach(function(f){ label("name:" + f.actor.key, "nameplate" + (f.actor.questionCount ? " alert" : ""), shortName(f.actor.id, 14), f.x + 17, f.y + 50); });
  label("name:viewer", "nameplate viewer", t("viewer"), viewer.x, viewer.y + 1);
  var near = nearestActor(figs);
  if (near) label("speech", "speech", shortName(near.actor.id, 14) + ": " + localizeText(near.actor.narration), near.x + 17, near.y - 6);
}
function render(){ if (!model) return; if (mode === "room") renderRoomView(); else renderOverview(); }
function tick(){ frame++; if (!reducedMotion) advance(); render(); }
function attentionFor(actor){
  if(actor.questionCount)return t('waiting')+' ('+actor.questionCount+')';
  if(actor.progress&&actor.progress.verify==='FAIL')return t('verifyFailed');
  if(actor.progress&&actor.progress.review==='FAIL')return t('reviewFailed');
  return actor.status==='blocked'?t('blockedUnknown'):'';
}
function completionText(floor,actor){
  if(actor.status==='complete')return statusText(actor.status);
  if(floor.completedAt)return t('sessionEnded');
  if(actor.taskId==='unassigned'&&!actor.progress)return t('noTask');
  return statusText(actor.status)+' · '+t('unfinished');
}
function renderWorkPanel(){
  if(!model||!workList)return;
  var rooms=mode==='room'&&activeRoom()?[activeRoom()]:visibleRooms();
  var signature=JSON.stringify([lang,offline,mode,rooms.map(function(f){return [f.key,f.title,f.status,f.phase,f.completedAt,f.actors,f.questions,f.criteria];})]);
  if(signature===workSignature)return;workSignature=signature;
  if(mode==='room'&&activeRoom()){renderRoomPanel(activeRoom());return;}
  var focusKey=document.activeElement&&document.activeElement.getAttribute?document.activeElement.getAttribute('data-work-key'):null,restoreFocus=null,entries=[];
  rooms.forEach(function(floor){floor.actors.forEach(function(actor){entries.push({floor:floor,actor:actor,attention:attentionFor(actor)});});});
  entries.sort(function(a,b){return Number(!!b.attention)-Number(!!a.attention);});
  workHeading.textContent=t('workList')+' · '+entries.length;
  workSummary.textContent=offline?t('stale'):t('attention')+' '+entries.filter(function(entry){return !!entry.attention;}).length+' · '+t('detailsAction');
  workList.textContent='';
  if(!entries.length){var empty=document.createElement('p');empty.textContent=t('quiet');workList.appendChild(empty);}
  entries.forEach(function(entry){
    var floor=entry.floor,actor=entry.actor,card=document.createElement('article'),button=document.createElement('button');
    card.className='work-card'+(entry.attention?' attention':'');
    button.type='button';button.className='work-name';button.textContent=actor.id+' ↗';button.title=t('detailsAction');
    button.setAttribute('aria-label',actor.id+' · '+t('detailsAction'));button.setAttribute('data-work-key',actor.key+':details');
    button.addEventListener('click',function(){openActorDetail(floor,actor);});card.appendChild(button);
    if(focusKey===actor.key+':details')restoreFocus=button;
    var meta=document.createElement('p');meta.className='work-meta';meta.textContent=(floor.repo?floor.repo+' · ':'')+roleText(actor.kind)+' · '+phaseLabel(actor.phase)+' · '+completionText(floor,actor);card.appendChild(meta);
    var work=document.createElement('p');work.textContent=localizeText(actor.narration);card.appendChild(work);
    var proof=document.createElement('p');proof.className='work-proof';proof.textContent=actor.taskId==='unassigned'&&!actor.progress?t('noTaskHint'):progressText(actor.progress);card.appendChild(proof);
    if(entry.attention){var reason=document.createElement('p');reason.className='work-reason';reason.textContent='! '+entry.attention;card.appendChild(reason);}
    if(actor.questionCount){
      var question=document.createElement('p');question.textContent=floor.questions[0]?floor.questions[0].prompt:t('unknown');card.appendChild(question);
      var answer=document.createElement('button');answer.type='button';answer.className='work-action';answer.textContent=t('openQuestion')+' →';answer.setAttribute('data-work-key',actor.key+':questions');answer.addEventListener('click',function(){openQuestionList(floor);});card.appendChild(answer);
      if(focusKey===actor.key+':questions')restoreFocus=answer;
    }
    workList.appendChild(card);
  });
  if(focusKey&&statusBox.hidden)(restoreFocus||canvas).focus();
}
function criterionStatusText(status){return status==='PASS'?t('critPass'):status==='FAIL'?t('critFail'):status==='UNKNOWN'?t('critUnknown'):t('critPending');}
function panelText(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;node.textContent=text;return node;}
// Room mode: the right column lists this room's acceptance criteria, questions and commands. Task text is data, so textContent only.
function renderRoomPanel(floor){
  var criteria=floor.criteria||[],passed=criteria.filter(function(c){return c.status==='PASS';}).length;
  workHeading.textContent=t('checks')+' · '+passed+'/'+criteria.length;
  workSummary.textContent=offline?t('stale'):floor.title;
  workList.textContent='';
  if(!criteria.length)workList.appendChild(panelText('p','',t('noCriteria')));
  criteria.forEach(function(c){
    var card=document.createElement('article');card.className='work-card criterion '+(c.status?c.status.toLowerCase():'pending');card.setAttribute('data-criterion',c.id);
    card.appendChild(panelText('p','work-name',c.id+' · '+criterionStatusText(c.status)));
    card.appendChild(panelText('p','',c.description));
    var meta=[];if(c.status&&c.status!=='PASS'){if(c.failureClass)meta.push(c.failureClass);if(c.exitCode!==null&&c.exitCode!==undefined)meta.push('exit '+c.exitCode);}
    if(c.finishedAt)meta.push(c.finishedAt.replace('T',' ').slice(0,16));
    if(meta.length)card.appendChild(panelText('p','work-meta',meta.join(' · ')));
    workList.appendChild(card);
  });
  if(floor.questions.length){
    workList.appendChild(panelText('h3','work-section',t('questions')+' · '+floor.questions.length));
    floor.questions.forEach(function(question){
      var card=document.createElement('article');card.className='work-card attention';card.appendChild(panelText('p','',question.prompt));
      var answer=document.createElement('button');answer.type='button';answer.className='work-action';answer.textContent=t('openQuestion')+' →';answer.addEventListener('click',function(){openQuestionList(floor);});card.appendChild(answer);
      workList.appendChild(card);
    });
  }
  var source=sourceFor(floor);
  if(source&&source.commands&&source.commands.length){
    workList.appendChild(panelText('h3','work-section',t('commands')));
    source.commands.forEach(function(command){workList.appendChild(panelText('code','work-command',command));});
  }
}
function updateHeader(){
  if(document.documentElement)document.documentElement.lang=lang==='zh'?'zh-Hant':'en';
  canvas.setAttribute('aria-label',t('moveHint')+' '+t('keyboardWork')+'；'+t('keyboardQuestions'));
  renderRepoFilter();
  var rooms = visibleRooms(), count = rooms.reduce(function(n, f){ return n + f.actors.length; }, 0);
  crumb.textContent = mode === "room" && activeRoom() ? activeRoom().title : t("overview") + " · " + rooms.length + " " + t("rooms") + " · " + count + " " + t("people");
  backButton.hidden = mode !== "room"; backButton.textContent = "← " + t("back"); recentButton.textContent = (showRecent ? "✓ " + t("recentOn") : "▣ " + t("recent")) + (hasRecent() ? " (" + model.floors.filter(function(f){ return !!f.completedAt; }).length + ")" : "");
  languageButton.textContent = lang === "zh" ? "繁中 / EN" : "EN / 繁中"; live.textContent = offline ? t("offline") : t("connected");
  overviewBox.hidden = mode !== "overview"; roomView.hidden = mode !== "room";
  workspace.className = panelCollapsed ? "collapsed" : ""; panelToggle.textContent = panelCollapsed ? t("showList") : t("hideList"); panelToggle.setAttribute("aria-expanded", panelCollapsed ? "false" : "true");
  renderWorkPanel();
}
function enterRoom(key){
  if (key) selectedKey = key;
  if (!selectedKey && visibleRooms()[0]) selectedKey = visibleRooms()[0].key;
  if (!activeRoom()) return;
  mode = "room"; viewer = spawnViewer(); resetLabels(); workSignature = "";
  updateHeader(); render(); canvas.focus();
}
function goOverview(){ mode = "overview"; resetLabels(); overviewSignature = ""; workSignature = ""; updateHeader(); render(); if (overviewBox.focus) overviewBox.focus(); }
function changeLanguage(){ lang = lang === "zh" ? "en" : "zh"; saveLanguage(); hudSignature = ""; updateHeader(); render(); }
function showDialog(title, fill){
  if (statusBox.hidden) detailPreviousFocus = document.activeElement || canvas;
  statusBox.className = "";
  statusBox.textContent = ""; var heading = document.createElement("h2"); heading.id = "status-title"; heading.textContent = title; statusBox.appendChild(heading);
  var body = document.createElement("div"); body.className = "dialog-body"; statusBox.appendChild(body); fill(body);
  var actions = document.createElement("div"); actions.className = "actions";
  var close = document.createElement("button"); close.type = "button"; close.textContent = t("close"); close.addEventListener("click", closeDialog); actions.appendChild(close);
  statusBox.appendChild(actions); statusBox.hidden = false; dialogClose = close;
  if (app) { app.inert = true; app.setAttribute("aria-hidden", "true"); }
  close.focus();
}
function closeDialog(){ statusBox.hidden = true; if (app) { app.inert = false; app.removeAttribute("aria-hidden"); } var previous = detailPreviousFocus || canvas; if(previous.isConnected===false&&workList&&previous.getAttribute){var key=previous.getAttribute('data-work-key');previous=Array.prototype.slice.call(workList.querySelectorAll('button')).find(function(button){return button.getAttribute('data-work-key')===key;})||canvas;} if (!previous || previous.isConnected === false || !previous.focus) previous = canvas; dialogClose = null; detailPreviousFocus = null; if (previous && previous.focus) previous.focus(); }
function addLine(box, label, value){ var p = document.createElement("p"); p.textContent = label + ": " + safeText(value); box.appendChild(p); }
function addCommand(box, value, copyValue){
  var row = document.createElement("p"), code = document.createElement("code"), button = document.createElement("button");
  code.textContent = value; button.type = "button"; button.textContent = t("copy"); button.addEventListener("click", function(){
    function failed(){button.textContent=t('copyFailed');button.title=t('copyHint');button.setAttribute('aria-label',t('copyHint'));}
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copyValue || value).then(function(){ button.textContent = t("copied");button.removeAttribute('aria-label'); }, failed);
    else failed();
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
  if (floor.kind === "run") return floor.sourceIndex === null ? null : snapshot.runs[floor.sourceIndex] || null;
  if (floor.kind === "desk") return floor.sourceIndex === null ? null : snapshot.lobby[floor.sourceIndex] || null;
  if (floor.kind === "review") return floor.sourceIndex === null ? null : snapshot.reviews[floor.sourceIndex] || null;
  return null;
}
function sourceSignature(floor){return JSON.stringify(sourceFor(floor),function(key,value){return key==='budget'?undefined:value;});}
function renderDetailItem(item, box){
  if (item.kind === "command") return addCommand(box, item.value, item.copyValue);
  if (item.kind === "file") { var file = document.createElement("p"); file.textContent = "• " + item.value; box.appendChild(file); return; }
  if (item.kind === "heading") { var heading = document.createElement("p"); heading.textContent = item.value; box.appendChild(heading); return; }
  addLine(box, item.label, item.value);
}
function progressText(progress){return progress ? t('checks')+' '+progress.passed+'/'+(progress.total||'?')+' · '+t('verify')+' '+outcomeText(progress.verify||'pending')+' · '+t('review')+' '+outcomeText(progress.review||'pending') : t('checks')+' '+t('unknown');}
function workItemForActor(floor,actor){return {kind:'work',floorKey:floor.key,actorKey:actor.key,label:t('owner')+': '+actor.id+' · '+roleText(actor.kind),value:t('currentWork')+': '+localizeText(actor.narration)+' · '+t('phase')+': '+phaseLabel(actor.phase)+' · '+t('status')+': '+completionText(floor,actor)+' · '+progressText(actor.progress)+' · '+t('pending')+': '+actor.questionCount};}
function workItemsFor(floor){
  var items=[
    {kind:'line',label:t('task'),value:floor.board.taskId==='unassigned'?t('unassigned'):floor.board.taskId},
    {kind:'line',label:t('status'),value:statusText(floor.status)},
    {kind:'line',label:t('progress'),value:progressText({passed:floor.board.passed,total:floor.board.total,verify:floor.board.verify,review:floor.board.review})},
    {kind:'line',label:t('pending'),value:String(floor.board.pending)}
  ];
  floor.actors.forEach(function(actor){items.push(workItemForActor(floor,actor));});
  floor.questions.forEach(function(question){items.push({kind:'question',label:t('question')+' · ! '+question.questionId,value:question.prompt});});
  if (!floor.actors.length && !floor.questions.length) items.push({kind:'line',label:t('people'),value:'0'});
  return items;
}
function phaseWorkItemsFor(floor,phase){
  var items=[{kind:'line',label:t('phase'),value:phaseLabel(phase)}],actors=floor.actors.filter(function(actor){return actor.phase===phase;});
  if(!actors.length)items.push({kind:'line',label:t('currentWork'),value:t('noPeople')});
  actors.forEach(function(actor){items.push(workItemForActor(floor,actor));});
  return items;
}
function questionItemsFor(floor){
  var items=[];
  if(!floor.questions.length)items.push({kind:'line',label:t('questions'),value:t('noQuestions')});
  floor.questions.forEach(function(question){items.push({kind:'line',label:t('question')+' · ! '+question.questionId,value:question.prompt});});
  var source=sourceFor(floor);
  if(source&&source.commands&&source.commands.length){items.push({kind:'heading',value:t('commands')+':' });source.commands.forEach(function(command){items.push({kind:'command',value:command});});}
  return items;
}
function renderWorkItem(item,box){
  if(item.kind==='work'){
    var row=document.createElement('p'),button=document.createElement('button'),detail=document.createElement('span');
    button.type='button';button.textContent=item.label;button.title=t('details');button.addEventListener('click',function(){var floor=roomByKey(item.floorKey),actor=floor&&floor.actors.find(function(candidate){return candidate.key===item.actorKey;});if(floor&&actor)openActorDetail(floor,actor);});
    detail.textContent=' · '+safeText(item.value);row.appendChild(button);row.appendChild(detail);box.appendChild(row);return;
  }
  if(item.kind==='question'){addLine(box,item.label,localizeText(item.value));return;}
  renderDetailItem(item,box);
}
function openWorkList(floor){
  if(!detailTarget||detailTarget.floorKey!==floor.key||detailTarget.view!=='work')detailPage=0;
  detailSignature=sourceSignature(floor);detailTarget={floorKey:floor.key,actorKey:null,view:'work'};
  showDialog(floor.title+' · '+t('workList'),function(box){pageItems(workItemsFor(floor),box,renderWorkItem);});
}
function openPhaseWorkList(floor,phase){
  if(!detailTarget||detailTarget.floorKey!==floor.key||detailTarget.view!=='phase'||detailTarget.phase!==phase)detailPage=0;
  detailSignature=sourceSignature(floor);detailTarget={floorKey:floor.key,actorKey:null,view:'phase',phase:phase};
  showDialog(floor.title+' · '+phaseLabel(phase),function(box){pageItems(phaseWorkItemsFor(floor,phase),box,renderWorkItem);});
}
function openQuestionList(floor){
  if(!detailTarget||detailTarget.floorKey!==floor.key||detailTarget.view!=='questions')detailPage=0;
  detailSignature=sourceSignature(floor);detailTarget={floorKey:floor.key,actorKey:null,view:'questions'};
  showDialog(floor.title+' · '+t('questions'),function(box){pageItems(questionItemsFor(floor),box,renderDetailItem);});
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
    {kind:"line", label:t("status"), value:completionText(floor,actor)}, {kind:"line", label:t("phase"), value:phaseLabel(actor.phase)},
    {kind:"line", label:t("task"), value:actor.taskId === "unassigned" ? t("unassigned") : actor.taskId},
    {kind:"line", label:t("host"), value:localizeText(actor.host)}, {kind:"line", label:t("now"), value:localizeText(actor.narration)}
  ];
  if (actor.questionCount) detailItems.push({kind:"line", label:t("pending"), value:String(actor.questionCount)});
  if (actor.progress) detailItems.push({kind:"line", label:t("checks"), value:progressText(actor.progress)});
  if (actor.questionCount && floor.questions.length) floor.questions.forEach(function(question){ detailItems.push({kind:"line", label:"! " + question.questionId, value:question.prompt}); });
  if (entries.length) { detailItems.push({kind:"heading", value:t("files") + " / " + t("commands") + ":"}); entries.forEach(function(entry){ detailItems.push(entry); }); }
  detailSignature=sourceSignature(floor); detailTarget = {floorKey: floor.key, actorKey: actor.key, view:'actor'}; showDialog(actor.id, function(box){ pageItems(detailItems, box, renderDetailItem); });
}
function openRoomDetail(floor){
  if (!detailTarget || detailTarget.floorKey !== floor.key || detailTarget.actorKey !== null) detailPage = 0;
  detailSignature=sourceSignature(floor); detailTarget = {floorKey: floor.key, actorKey: null, view:'room'}; var source = sourceFor(floor), items = source && source.diff ? source.diff.paths || [] : [], entries = [];
  items.forEach(function(item){ entries.push({kind:"file", value:item}); });
  if (source && source.commands) source.commands.forEach(function(item){ entries.push({kind:"command", value:item}); });
  var detailItems = [
    {kind:"line", label:t("status"), value:statusText(floor.status)}, {kind:"line", label:t("phase"), value:phaseLabel(floor.phase)},
    {kind:"line", label:t("task"), value:floor.board.taskId === "unassigned" ? t("unassigned") : floor.board.taskId},
    {kind:"line", label:t("checks"), value:floor.board.passed + "/" + (floor.board.total || "?")},
    {kind:"line", label:t("verify"), value:outcomeText(floor.board.verify)}, {kind:"line", label:t("review"), value:outcomeText(floor.board.review)},
    {kind:"line", label:t("pending"), value:String(floor.board.pending)}
  ];
  floor.questions.forEach(function(question){ detailItems.push({kind:"line", label:"! " + question.questionId, value:question.prompt}); });
  if (entries.length) { detailItems.push({kind:"heading", value:t("files") + " / " + t("commands") + ":"}); entries.forEach(function(entry){ detailItems.push(entry); }); }
  showDialog(floor.title, function(box){ pageItems(detailItems, box, renderDetailItem); });
}
function openSelectedDetail(){
  var target = detailTarget, floor = target ? roomByKey(target.floorKey) : activeRoom(); if (!floor) return;
  if (target && target.view === 'work') return openWorkList(floor);
  if (target && target.view === 'phase') return openPhaseWorkList(floor,target.phase);
  if (target && target.view === 'questions') return openQuestionList(floor);
  if (target && target.view === 'panel') return openPanel(target.kind, floor);
  if (target && target.actorKey) { var actor = floor.actors.find(function(a){ return a.key === target.actorKey; }); if (actor) return openActorDetail(floor, actor); }
  return openRoomDetail(floor);
}
// ---- prop panels: the whiteboard, cubicle screens, QA board, reviewer's desk and sorting table ----
function hitHotspot(point){
  for (var i = 0; i < LAYOUT.hotspots.length; i++) { var spot = LAYOUT.hotspots[i]; for (var j = 0; j < spot.rects.length; j++) { var r = spot.rects[j]; if (point.x >= r.x && point.x < r.x + r.w && point.y >= r.y && point.y < r.y + r.h) return spot.kind; } }
  return null;
}
/** The prop the viewer stands next to: within reach of the bottom edge of one of its rectangles. */
function nearHotspot(){
  for (var i = 0; i < LAYOUT.hotspots.length; i++) { var spot = LAYOUT.hotspots[i]; for (var j = 0; j < spot.rects.length; j++) { var r = spot.rects[j]; var dx = Math.max(r.x - viewer.x, 0, viewer.x - (r.x + r.w)), dy = Math.max(r.y - viewer.y, 0, viewer.y - (r.y + r.h + 24)); if (dx + dy < 18) return spot.kind; } }
  return null;
}
function el(tag, className, text){ var node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function taskIdOf(floor, source){ var id = source && typeof source.taskId === "string" ? source.taskId : floor.board.taskId; return id && id !== "unassigned" ? id : null; }
function addCommands(box, commands){ if (!commands.length) return; box.appendChild(el("h3", "panel-heading", t("commands"))); commands.forEach(function(command){ addCommand(box, command); }); }
function panelTask(floor, source, box){
  var phases = el("ol", "panel-phases");
  ["planning", "implementing", "verifying", "reviewing", "integrating"].forEach(function(phase){ var step = el("li", phase === floor.phase ? "now" : "", phaseLabel(phase)); if (phase === floor.phase) step.setAttribute("aria-current", "step"); phases.appendChild(step); });
  box.appendChild(phases);
  var criteria = floor.criteria || [], groups = [["todo", t("critPending"), function(c){ return c.status === null; }], ["fail", t("critFail"), function(c){ return c.status === "FAIL" || c.status === "UNKNOWN"; }], ["pass", t("critPass"), function(c){ return c.status === "PASS"; }]];
  if (!criteria.length) box.appendChild(el("p", "", t("noCriteria")));
  else {
    var columns = el("div", "panel-notes");
    groups.forEach(function(group){
      var items = criteria.filter(group[2]), column = el("div", "panel-column");
      column.appendChild(el("h3", "panel-heading", group[1] + " · " + items.length));
      items.forEach(function(c){ var note = el("div", "note " + group[0]); note.appendChild(el("strong", "", c.id)); note.appendChild(el("span", "", c.description)); column.appendChild(note); });
      columns.appendChild(column);
    });
    box.appendChild(columns);
  }
  floor.questions.forEach(function(question){ box.appendChild(el("p", "panel-question", "! " + question.prompt)); });
  addCommands(box, source && source.commands ? source.commands : []);
}
function panelDiff(floor, source, box){
  var diff = source && source.diff ? source.diff : null;
  if (!diff || !diff.files) { box.appendChild(el("p", "", t("noChanges"))); return; }
  box.appendChild(el("p", "panel-meta", (source.branch ? source.branch + " · " : "") + diff.files + " " + t("filesCount") + " · +" + diff.insertions + " −" + diff.deletions));
  var list = el("ul", "panel-files");
  diff.paths.slice(0, 60).forEach(function(path){ list.appendChild(el("li", path === diff.recent ? "recent" : "", (path === diff.recent ? "▶ " : "") + path)); });
  box.appendChild(list);
  if (diff.paths.length > 60) box.appendChild(el("p", "panel-meta", "+" + (diff.paths.length - 60)));
}
function panelVerify(floor, source, box){
  var criteria = floor.criteria || [], taskId = taskIdOf(floor, source);
  box.appendChild(el("p", "panel-meta", t("verify") + " " + outcomeText(floor.board.verify)));
  if (!criteria.length) box.appendChild(el("p", "", t("noCriteria")));
  var list = el("ul", "panel-leds");
  criteria.forEach(function(c){
    var row = el("li", "led-row " + (c.status ? c.status.toLowerCase() : "pending"));
    row.appendChild(el("strong", "", c.id + " · " + criterionStatusText(c.status)));
    row.appendChild(el("span", "", c.description));
    var meta = []; if (c.failureClass && c.status !== "PASS") meta.push(c.failureClass); if (c.exitCode !== null && c.exitCode !== undefined && c.status !== "PASS") meta.push("exit " + c.exitCode); if (c.finishedAt) meta.push(c.finishedAt.replace("T", " ").slice(0, 16));
    if (meta.length) row.appendChild(el("small", "", meta.join(" · ")));
    if (c.output) row.appendChild(el("pre", "panel-output", c.output));
    list.appendChild(row);
  });
  box.appendChild(list);
  if (taskId) addCommands(box, ["agent-ops verify --task " + taskId]);
}
function panelReview(floor, source, box){
  var review = source && source.review ? source.review : null, taskId = taskIdOf(floor, source);
  if (!review) box.appendChild(el("p", "", t("notReviewed")));
  else {
    box.appendChild(el("p", "stamp " + review.status.toLowerCase(), review.status));
    box.appendChild(el("p", "panel-meta", review.createdAt.replace("T", " ").slice(0, 16) + (review.reason ? " · " + review.reason : "")));
    review.rounds.forEach(function(round, index){
      var part = el("section", "round");
      part.appendChild(el("h3", "panel-heading", (index === 0 ? t("firstRound") : t("recheck")) + " · " + round.target));
      if (round.summary) part.appendChild(el("p", "", round.summary));
      if (round.findings.length) {
        var findings = el("ul", "panel-findings");
        round.findings.forEach(function(f){ var item = el("li", f.blocking ? "blocking" : ""); item.appendChild(el("strong", "", "[" + f.severity + (f.blocking ? " · " + t("blocking") : "") + "] " + f.title)); if (f.details) item.appendChild(el("p", "", f.details)); if (f.recommendation) item.appendChild(el("p", "advice", "→ " + f.recommendation)); findings.appendChild(item); });
        part.appendChild(findings);
      }
      box.appendChild(part);
    });
    if (review.refuted !== null) box.appendChild(el("p", "panel-meta", review.refuted ? t("refutedYes") : t("refutedNo")));
  }
  if (taskId) addCommands(box, ["agent-ops review --task " + taskId + " --yes"]);
}
function panelIntegration(floor, source, box){
  var facts = el("dl", "panel-facts"), add = function(label, value){ facts.appendChild(el("dt", "", label)); facts.appendChild(el("dd", "", value)); };
  add(t("worktree"), source && source.name ? source.name : t("unknown"));
  add(t("branch"), source && source.branch ? source.branch : t("unknown"));
  add(t("base"), source && source.base ? source.base : t("unknown"));
  add(t("ahead"), source && typeof source.ahead === "number" ? String(source.ahead) : t("unknown"));
  add(t("files"), source && source.diff ? String(source.diff.files) : "0");
  box.appendChild(facts);
  var verify = floor.board.verify, review = floor.board.review, steps = el("ol", "panel-steps");
  [[t("commitStep"), source && source.ahead > 0 ? "done" : "pending"], [t("verify"), verify === "PASS" ? "done" : verify === "FAIL" ? "failed" : "pending"],
   [t("review"), review === "PASS" ? "done" : review === "FAIL" ? "failed" : "pending"], [t("finishStep"), floor.completedAt ? "done" : "pending"]]
    .forEach(function(step){ var item = el("li", step[1], (step[1] === "done" ? "✓ " : step[1] === "failed" ? "✗ " : "○ ") + step[0]); item.setAttribute("data-state", step[1]); steps.appendChild(item); });
  box.appendChild(steps);
  if (source && source.name && source.branch && source.branch !== "(no worktree)") addCommands(box, ["agent-ops worktree finish " + source.name]);
}
var PANELS = {task: panelTask, diff: panelDiff, verify: panelVerify, review: panelReview, integration: panelIntegration};
function openPanel(kind, floor){
  var source = sourceFor(floor);
  detailSignature = sourceSignature(floor); detailTarget = {floorKey: floor.key, actorKey: null, view: "panel", kind: kind};
  showDialog(t("panel_" + kind) + " · " + floor.title, function(box){ PANELS[kind](floor, source, box); });
  statusBox.className = "panel panel-" + kind;
}
// ---- input: the viewer walks inside a room; walls and furniture stop them ----
function freeAt(p){
  var cx = Math.round(p.x / 2), cy = Math.round(p.y / 2);
  return cx >= 0 && cy >= 0 && cx < GRID.cols && cy < GRID.rows && GRID.free[cy * GRID.cols + cx] === 1;
}
function moveViewer(dx, dy){
  viewer.dir = dx ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down"); viewer.path = [];
  for (var i = 0; i < 4; i++) {
    var next = {x: viewer.x + dx * 2, y: viewer.y + dy * 2};
    if (!freeAt(next)) break;
    viewer.x = next.x; viewer.y = next.y; viewer.step += 2;
  }
  render();
}
function walkTo(point){
  var path = findPath(GRID, {x: viewer.x, y: viewer.y}, point);
  if (!path) return false;
  if (reducedMotion) { var end = path[path.length - 1]; viewer.x = end.x; viewer.y = end.y; viewer.path = []; }
  else viewer.path = path.slice(1);
  render(); return true;
}
function canvasPoint(event){
  var rect = canvas.getBoundingClientRect(), w = rect.width || canvas.width || ROOM_W, h = rect.height || canvas.height || ROOM_H;
  return {x: Math.floor((event.clientX - rect.left) * ROOM_W / w), y: Math.floor((event.clientY - rect.top) * ROOM_H / h)};
}
function hitFigure(point){
  for (var i = lastFigures.length - 1; i >= 0; i--) { var f = lastFigures[i]; if (point.x >= f.x + 6 && point.x < f.x + 28 && point.y >= f.y && point.y < f.y + 50) return f; }
  return null;
}
canvas.addEventListener("click", function(event){
  var floor = activeRoom(); if (mode !== "room" || !floor) return;
  var point = canvasPoint(event), figure = hitFigure(point);
  if (figure) { openActorDetail(floor, figure.actor); return; }
  var spot = hitHotspot(point);
  if (spot) { openPanel(spot, floor); return; }
  walkTo({x: Math.round(point.x / 2) * 2, y: Math.round(point.y / 2) * 2});
});
function keyboardFloor(){ return activeRoom() || roomByKey(selectedKey) || orderedRooms()[0]; }
function sharedKeys(event){
  if (event.key === "Escape" || event.key === "Backspace") { event.preventDefault(); if (!statusBox.hidden) closeDialog(); else if (mode === "room") goOverview(); return true; }
  var floor = keyboardFloor();
  if ((event.key === "l" || event.key === "L") && floor) { event.preventDefault(); openWorkList(floor); return true; }
  if ((event.key === "q" || event.key === "Q") && floor) { event.preventDefault(); openQuestionList(floor); return true; }
  return false;
}
canvas.addEventListener("keydown", function(event){
  if (event.ctrlKey || event.metaKey || event.altKey || sharedKeys(event)) return;
  var floor = activeRoom(); if (mode !== "room" || !floor) return;
  var phaseKeys = {"1": "planning", "2": "implementing", "3": "verifying", "4": "reviewing", "5": "integrating"};
  if (phaseKeys[event.key]) { event.preventDefault(); openPhaseWorkList(floor, phaseKeys[event.key]); return; }
  var move = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1], A: [-1, 0], D: [1, 0], W: [0, -1], S: [0, 1]}[event.key];
  if (move) { event.preventDefault(); moveViewer(move[0], move[1]); return; }
  if (event.key === "Enter") { event.preventDefault(); var near = nearestActor(lastFigures), prop = nearHotspot(); if (near) openActorDetail(floor, near.actor); else if (prop) openPanel(prop, floor); else openRoomDetail(floor); }
});
overviewBox.addEventListener("keydown", function(event){
  if (event.ctrlKey || event.metaKey || event.altKey || sharedKeys(event)) return;
  if (/^[1-9]$/u.test(event.key)) { var floor = (panelCollapsed ? pageRooms(pageInView()) : orderedRooms())[Number(event.key) - 1]; if (floor) { event.preventDefault(); enterRoom(floor.key); } }
});
repoSelect.addEventListener("change", function(){ repoFilter = repoSelect.value; if (activeRoom() && repoFilter && activeRoom().repo !== repoFilter) mode = "overview"; if (!selectedKey || visibleRooms().every(function(f){ return f.key !== selectedKey; })) selectedKey = visibleRooms()[0] && visibleRooms()[0].key; updateHeader(); render(); });
backButton.addEventListener("click", goOverview);
panelToggle.addEventListener("click", function(){ panelCollapsed = !panelCollapsed; try { localStorage.setItem("agent-office-list", panelCollapsed ? "collapsed" : "open"); } catch (_) {} updateHeader(); render(); }); recentButton.addEventListener("click", function(){ showRecent = !showRecent; if (!showRecent && activeRoom() && activeRoom().completedAt) mode = "overview"; updateHeader(); render(); });
languageButton.addEventListener("click", changeLanguage); statusBox.addEventListener("keydown", function(event){
  if (event.key === "Escape") { event.preventDefault(); closeDialog(); return; }
  if (event.key !== "Tab") return;
  var focusables = statusBox.querySelectorAll ? Array.prototype.slice.call(statusBox.querySelectorAll("button:not([disabled])")) : (dialogClose ? [dialogClose] : []);
  if (!focusables.length) return;
  var first = focusables[0], last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function poll(){ fetch("snapshot.json" + location.search, {cache:"no-store"}).then(function(r){ if (!r.ok) throw new Error(String(r.status)); return r.json(); }).then(function(s){ snapshot = s; model = sceneModel(s); syncPeople(); offline = false; var selectedMissing=mode==='room'&&!!selectedKey&&!roomByKey(selectedKey),dialogMissing=!statusBox.hidden&&!!detailTarget&&!roomByKey(detailTarget.floorKey); if(selectedMissing||dialogMissing){if(dialogMissing)detailPreviousFocus=canvas;if(!statusBox.hidden)closeDialog();detailTarget=null;detailPage=0;detailSignature="";mode='overview';resetLabels();} if (!selectedKey || !roomByKey(selectedKey)) selectedKey = visibleRooms()[0] && visibleRooms()[0].key; updateHeader(); render(); if (!statusBox.hidden && detailTarget && roomByKey(detailTarget.floorKey)) { var signature=sourceSignature(roomByKey(detailTarget.floorKey)); if(signature!==detailSignature){detailSignature=signature;openSelectedDetail();} } }, function(){ offline = true; updateHeader(); }); }
function loop(){ tick(); requestAnimationFrame(loop); }
updateHeader(); poll(); setInterval(poll, 2000); window.addEventListener("resize", function(){updateHeader();render();}); requestAnimationFrame(loop);
`;

let data: Record<string, string> | null = null;
/** Art, layout and the shared pure functions, serialised once for every page. */
function pageData(): Record<string, string> {
  data ??= {
    __PALETTE__: JSON.stringify(ROOM_PALETTE), __SPRITES__: JSON.stringify(roomSprites()), __PEOPLE__: JSON.stringify(personSprites()),
    __LAYOUT__: JSON.stringify(officeLayout()), __SCENE__: sceneModel.toString(), __AVATAR_COLORS__: avatarColors.toString(),
    __WALK__: walkGrid.toString(), __PATH__: findPath.toString(), __NOTE_POS__: notePosition.toString()
  };
  return data;
}

/** One inline page; the nonce binds its only script and style under the server's CSP. */
export function officePage(nonce: string): string {
  const values = pageData();
  const script = Object.keys(values).reduce((text, key) => text.replace(key, () => values[key]!), CLIENT);
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>agent-ops Office · Preview</title><style nonce="${nonce}">${STYLE}</style></head>
<body><div id="app"><header id="header"><div id="brand">agent-ops Office · Preview</div><div id="crumb">Office overview</div><button id="back" type="button" hidden>← Back to overview</button><button id="recent" type="button">▣ Recently completed</button><select id="repo-filter" hidden></select><button id="language" type="button">繁中 / EN</button><span id="live" aria-live="polite">● Connected</span></header>
<main id="workspace"><section id="wrap" aria-label="Pixel office"><div id="overview" tabindex="-1"></div><div id="room-view" hidden><div id="hud"></div><div id="stage"><canvas id="office" tabindex="0" width="576" height="320" aria-label="Office room"></canvas><div id="labels"></div></div></div></section><aside id="work-panel" aria-labelledby="work-heading"><div id="panel-head"><h2 id="work-heading">Work list</h2><button id="panel-toggle" type="button" aria-controls="work-list" aria-expanded="true">Hide list »</button></div><p id="work-summary"></p><div id="work-list"></div></aside></main></div>
<section id="status" role="dialog" aria-modal="true" aria-labelledby="status-title" tabindex="-1" hidden></section><script nonce="${nonce}">${script}</script></body></html>`;
}
