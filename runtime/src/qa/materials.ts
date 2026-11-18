import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { materialPath } from "../schema/acceptance.js";
import type { QaAuthorResponse, QaMaterial, QaMaterialLineage } from "./types.js";

const exec = promisify(execFile);
const MAX_MATERIAL_BYTES = 1024 * 1024;
/** QA adds test material only; anything that configures, depends or decides policy goes back to the developer. */
const TEST_SEGMENT = /^(?:tests?|__tests__|specs?|fixtures?|e2e|testdata)$/iu;
const TEST_FILE = /\.(?:test|spec)\.[^/]+$/iu;
const FORBIDDEN = [/(?:^|\/)\.(?:agent-ops|claude|codex|agents|opencode|github|husky|vscode|idea)(?:\/|$)/iu, /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/iu,
  /(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|go\.(?:mod|sum)|Gemfile(?:\.lock)?|Cargo\.(?:toml|lock)|pyproject\.toml)$/iu,
  /(?:^|\/)(?:\.npmrc|\.gitattributes|\.gitmodules|\.gitignore|tsconfig[^/]*\.json)$/iu, /(?:^|\/)\.env(?:\.|$)/iu];

export interface QaMaterialRejection { readonly path: string; readonly reason: string }
export class QaMaterialError extends AgentOpsError {
  constructor(readonly rejections: readonly QaMaterialRejection[], recoveryPaths: readonly string[]) {
    super("QA_MATERIAL_REJECTED", `QA materials were rejected: ${rejections.map(r => `${r.path} (${r.reason})`).join("; ")}`, {recoveryPaths});
  }
}
export interface QaInspectedMaterials {
  readonly authoredCommit: string;
  readonly materials: readonly (QaMaterial & { readonly caseIds: readonly string[] })[];
  readonly materialDigest: string;
  /** Existing-file changes QA needs: the developer decides, they are never merged from the QA checkout. */
  readonly requestedEdits: QaAuthorResponse["requestedEdits"];
}

async function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  return (await exec("git", [...args], {cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024})).stdout;
}
const nul = (output: Buffer): string[] => output.toString("utf8").split("\0").filter(Boolean);
export function qaMaterialPathReason(path: string): string | null {
  if (!materialPath(path)) return "unsafe or generated path";
  if (FORBIDDEN.some(pattern => pattern.test(path))) return "configuration, dependency or policy file";
  const segments = path.split("/");
  if (!segments.slice(0, -1).some(s => TEST_SEGMENT.test(s)) && !TEST_FILE.test(path)) return "not a test, fixture or helper location";
  return null;
}
export function qaMaterialDigest(materials: readonly Pick<QaMaterial, "path" | "role" | "digest">[]): string {
  return sha256(canonicalJson([...materials].sort((a, b) => a.path < b.path ? -1 : 1).map(({path, role, digest}) => ({path, role, digest}))));
}
/** Every ancestor is a real directory inside root: a symlinked parent could aim a write anywhere. */
async function realFile(root: string, path: string): Promise<string | null> {
  const segments = path.split("/");
  for (let i = 1; i < segments.length; i++) {
    const status = await lstat(join(root, ...segments.slice(0, i))).catch(() => null);
    if (status === null || !status.isDirectory()) return "symlinked or missing parent";
  }
  const status = await lstat(join(root, ...segments)).catch(() => null);
  if (status === null) return "declared file is missing";
  if (!status.isFile()) return "not a regular file";
  if (status.nlink !== 1) return "hard link";
  if (status.size > MAX_MATERIAL_BYTES) return "exceeds the 1 MiB material bound";
  const [real, base] = await Promise.all([realpath(join(root, ...segments)), realpath(root)]);
  return real.startsWith(base + "/") ? null : "escapes the QA checkout";
}

/**
 * The QA checkout may only gain new declared material files at the exact authored commit.
 * Any tracked change, deletion, commit or unsafe declaration rejects the whole contribution,
 * and the checkout is left untouched for diagnosis.
 */
export async function inspectQaMaterials(checkout: string, authoredCommit: string, response: QaAuthorResponse): Promise<QaInspectedMaterials> {
  const rejections: QaMaterialRejection[] = [];
  const head = (await git(checkout, ["rev-parse", "HEAD"])).toString().trim();
  if (head !== authoredCommit) rejections.push({path: "HEAD", reason: "QA moved the checkout away from the authored commit"});
  if (response.candidateCommit !== authoredCommit) rejections.push({path: "response", reason: "describes another candidate"});
  const status = nul(await git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]));
  const untracked = new Set<string>();
  for (const entry of status) {
    const code = entry.slice(0, 2), path = entry.slice(3);
    if (code === "??") untracked.add(path);
    // Product, configuration and earlier assertions are the developer's: QA cannot edit or delete them.
    else rejections.push({path, reason: "existing tracked file changed"});
  }
  const materials: (QaMaterial & { caseIds: readonly string[] })[] = [];
  for (const material of response.materials) {
    const reason = qaMaterialPathReason(material.path) ?? await realFile(checkout, material.path) ??
      (untracked.has(material.path) ? null : "not a new untracked file");
    if (reason !== null) {rejections.push({path: material.path, reason}); continue;}
    const bytes = await readFile(join(checkout, ...material.path.split("/")));
    materials.push({path: material.path, role: material.role, digest: sha256(bytes), caseIds: material.caseIds});
  }
  if (rejections.length > 0) throw new QaMaterialError(rejections, [checkout]);
  return {authoredCommit, materials, materialDigest: qaMaterialDigest(materials), requestedEdits: response.requestedEdits};
}

export interface QaImportResult {
  readonly lineage: QaMaterialLineage;
  readonly materials: readonly QaMaterial[];
  readonly materialDigest: string;
}
/**
 * Copies inspected bytes from the QA checkout into the delivery checkout and commits exactly those paths.
 * The new commit is the final candidate: proof observed at the authored commit must be re-executed there.
 */
export async function importQaMaterials(options: {readonly checkout: string; readonly target: string;
  readonly inspected: QaInspectedMaterials; readonly taskId: string}): Promise<QaImportResult> {
  const {checkout, target, inspected} = options;
  const recovery = [checkout, target];
  const head = (await git(target, ["rev-parse", "HEAD"])).toString().trim();
  if (head !== inspected.authoredCommit)
    throw new AgentOpsError("QA_CANDIDATE_MOVED", "The delivery moved after QA authored its materials; this QA result is stale.", {recoveryPaths: recovery});
  const materials = inspected.materials.map(({path, role, digest}) => ({path, role, digest}));
  if (materials.length === 0) return {lineage: {authoredCommit: head, importedCommit: head}, materials, materialDigest: inspected.materialDigest};
  if ((await git(target, ["diff", "--cached", "--name-only", "-z"])).length > 0)
    throw new AgentOpsError("QA_IMPORT_TARGET_DIRTY", "Staged delivery changes would be swept into the QA import commit.", {recoveryPaths: recovery});
  const bytes = new Map<string, Buffer>();
  for (const material of materials) {
    const reason = qaMaterialPathReason(material.path) ?? await realFile(checkout, material.path);
    const content = reason === null ? await readFile(join(checkout, ...material.path.split("/"))) : null;
    if (content === null || sha256(content) !== material.digest)
      throw new QaMaterialError([{path: material.path, reason: reason ?? "changed after inspection"}], recovery);
    if (await lstat(join(target, ...material.path.split("/"))).then(() => true, () => false))
      throw new QaMaterialError([{path: material.path, reason: "already exists in the delivery checkout"}], recovery);
    bytes.set(material.path, content);
  }
  for (const [path, content] of bytes) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = join(target, ...segments.slice(0, i));
      const status = await lstat(parent).catch(() => null);
      if (status === null) await mkdir(parent);
      else if (!status.isDirectory()) throw new QaMaterialError([{path, reason: "symlinked or non-directory parent in the delivery checkout"}], recovery);
    }
    await writeFile(join(target, ...segments), content, {flag: "wx", mode: 0o644});
  }
  const paths = [...bytes.keys()];
  await git(target, ["add", "--", ...paths]);
  await git(target, ["commit", "--quiet", "-m", `test(qa): import independent QA materials for ${options.taskId}\n\nQA-Authored-Commit: ${head}\nQA-Material-Digest: ${inspected.materialDigest}`, "--", ...paths]);
  const imported = (await git(target, ["rev-parse", "HEAD"])).toString().trim();
  const changed = nul(await git(target, ["diff", "--name-status", "-z", "--no-renames", head, imported]));
  const added = changed.filter((_, i) => i % 2 === 1 && changed[i - 1] === "A").sort();
  if (changed.length !== paths.length * 2 || canonicalJson(added) !== canonicalJson([...paths].sort()))
    throw new AgentOpsError("QA_IMPORT_MISMATCH", "The import commit differs from the inspected QA materials; it is preserved for diagnosis.", {recoveryPaths: recovery});
  for (const material of materials)
    if (sha256(await git(target, ["show", `${imported}:${material.path}`])) !== material.digest)
      throw new AgentOpsError("QA_IMPORT_MISMATCH", "Imported material bytes differ from the inspected digest.", {recoveryPaths: recovery});
  return {lineage: {authoredCommit: head, importedCommit: imported}, materials, materialDigest: inspected.materialDigest};
}
