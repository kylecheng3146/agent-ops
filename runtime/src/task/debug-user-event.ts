import {lstat,readFile,readdir,realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {isAbsolute,join,relative,sep} from "node:path";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";

export interface DebugUserEvent {id:string;sourceDigest:string;text:string;timestamp:number;}
export function debugUserControl(text: string): "pause" | "diagnose" | "resume" | "repair" | null {
  const value=text.trim();
  if (/^(?:暫停|暂停|先暫停|先暂停|停止|stop|pause)[。.!！]?$/iu.test(value)) return "pause";
  if (/^(?:先)?只診斷(?:，等我補失敗時證據)?[。.!！]?$/u.test(value) || /^(?:先)?只诊断[。.!！]?$/u.test(value) || /^diagnos(?:e|is)[ -]only[.!]?$/iu.test(value)) return "diagnose";
  if (/^(?:繼續|继续|continue|resume)[。.!！]?$/iu.test(value)) return "resume";
  if (/^(?:繼續修復|继续修复|開始修復|开始修复|resume repair)[。.!！]?$/iu.test(value)) return "repair";
  return null;
}

function codexUserText(row: any): string | undefined {
  if (row?.type === "event_msg" && row.payload?.type === "user_message") return row.payload.message;
  const message=row?.payload;
  if (row?.type !== "response_item" || message?.type !== "message" || message.role !== "user") return undefined;
  const kinds=message.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(k=>k === "user.text") || !Array.isArray(message.content) ||
      message.content.length !== kinds.length || !message.content.every((c: any)=>c?.type === "input_text" && typeof c.text === "string")) return undefined;
  const text=message.content.map((c: {text:string})=>c.text).join("\n");
  const reply=/^<send_user_message_question_reply>\s*([\s\S]*)\s*<\/send_user_message_question_reply>$/u.exec(text.trim());
  if (reply === null) return text;
  try {
    const answers=JSON.parse(reply[1]!);
    if (Array.isArray(answers) && answers.length === 1 && typeof answers[0]?.answer === "string") return answers[0].answer;
  } catch { /* An ambiguous reply cannot authorize a control change. */ }
  return undefined;
}
/** Host transcripts are the user-event authority; CLI actor/text fields are never accepted. */
/** `worktreeRoot` is the session's owned worktree: Claude stamps each row with the shell's cwd, which moves there after `cd`. */
export async function readDebugUserEvent(root:string,sessionId:string,home=homedir(),kind: "latest" | "control" = "latest",worktreeRoot?:string):Promise<DebugUserEvent> {
  if (!/^[a-f0-9-]{36}$/u.test(sessionId)) throw new AgentOpsError("TASK_DEBUG_GRANT_UNSUPPORTED","This host has no identifiable native user-event source.");
  const canonicalHome=await realpath(home).catch(()=>home);
  const paths=[join(home,".claude/projects",root.replace(/[^a-zA-Z0-9]/gu,"-"),sessionId+".jsonl")];
  const codex=join(home,".codex/sessions");
  async function visit(path:string,depth:number):Promise<void> {
    if (paths.length > 4096) return;
    try {for(const entry of await readdir(path,{withFileTypes:true})) {
      if (entry.isDirectory() && depth>0) await visit(join(path,entry.name),depth-1);
      else if (entry.isFile() && entry.name.endsWith(sessionId+".jsonl")) paths.push(join(path,entry.name));
    }} catch { /* The host need not be installed. */ }
  }
  await visit(codex,3);
  for (const path of paths) {
    try {
      const stat=await lstat(path),canonical=await realpath(path);
      const fromHome=relative(canonicalHome,canonical);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size>16*1024*1024 || fromHome.startsWith("..") || isAbsolute(fromHome)) continue;
      const lines=(await readFile(path,"utf8")).split("\n");
      const rows=lines.map(line=>{try{return JSON.parse(line);}catch{return null;}});
      const codexSource=path.startsWith(codex+sep);
      if (codexSource && !rows.some(row=>row?.type === "session_meta" && row.payload?.id === sessionId && row.payload?.cwd === root)) continue;
      for(let index=rows.length-1;index>=0;index--) {
        const row=rows[index];
        const text=codexSource ? codexUserText(row) :
          row?.type === "user" && row.sessionId === sessionId && (row.cwd === root || (worktreeRoot !== undefined && row.cwd === worktreeRoot)) && row.message?.role === "user" &&
          row.isMeta !== true && (row.origin === undefined || row.origin?.kind === "human") ? row.message.content : undefined;
        if (typeof text !== "string" || text.length > 64*1024 || (kind === "control" && debugUserControl(text) === null)) continue;
        const timestamp=Date.parse(row.timestamp);
        if (!Number.isFinite(timestamp)) break;
        const sourceDigest=sha256(lines[index]!);
        return {id:sha256(relative(home,path)+":"+index+":"+sourceDigest),sourceDigest,text,timestamp};
      }
    } catch { /* An unavailable native source cannot grant time. */ }
  }
  throw new AgentOpsError("TASK_DEBUG_GRANT_UNSUPPORTED","No current native human event can authorize this extension. Request explicit host approval; this CLI cannot self-grant it.");
}
