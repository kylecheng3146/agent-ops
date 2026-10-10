import {lstat,readFile,readdir,realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {join,relative} from "node:path";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";

export interface DebugUserEvent {id:string;sourceDigest:string;text:string;timestamp:number;}
/** Host transcripts are the user-event authority; CLI actor/text fields are never accepted. */
export async function readDebugUserEvent(root:string,sessionId:string,home=homedir()):Promise<DebugUserEvent> {
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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size>16*1024*1024 || relative(canonicalHome,canonical).startsWith("..")) continue;
      const lines=(await readFile(path,"utf8")).split("\n");
      const rows=lines.map(line=>{try{return JSON.parse(line);}catch{return null;}});
      const codexSource=path.startsWith(codex+"/");
      if (codexSource && !rows.some(row=>row?.type === "session_meta" && row.payload?.id === sessionId && row.payload?.cwd === root)) continue;
      for(let index=rows.length-1;index>=0;index--) {
        const row=rows[index];
        const text=codexSource ? row?.type === "event_msg" && row.payload?.type === "user_message" ? row.payload.message : undefined :
          row?.type === "user" && row.sessionId === sessionId && row.cwd === root && row.message?.role === "user" ? row.message.content : undefined;
        if (typeof text !== "string") continue;
        const timestamp=Date.parse(row.timestamp);
        if (!Number.isFinite(timestamp)) break;
        const sourceDigest=sha256(lines[index]!);
        return {id:sha256(relative(home,path)+":"+index+":"+sourceDigest),sourceDigest,text,timestamp};
      }
    } catch { /* An unavailable native source cannot grant time. */ }
  }
  throw new AgentOpsError("TASK_DEBUG_GRANT_UNSUPPORTED","No current native human event can authorize this extension. Request explicit host approval; this CLI cannot self-grant it.");
}
