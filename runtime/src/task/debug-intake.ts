/** Conservative intake only; the existing native Agent reasons about the issue. */
export function isDebugIssue(prompt:string):boolean {
  if (prompt.length === 0 || prompt.length > 64*1024 || prompt.includes("\0")) return false;
  const value=prompt.normalize("NFKC").toLowerCase();
  if (/\b(?:explain|describe|what is|how does|refactor|feature|implement|design)\b|說明|解释|解釋|重構|新增功能|設計|實作功能/u.test(value)) return false;
  return /\b(?:bug|error|fail(?:s|ed|ure)?|exception|crash|regression|500)\b|錯誤|错误|失敗|失败|異常|异常|問題|问题|回傳\s*500/u.test(value) &&
    /\b(?:fix|debug|investigate|reproduce|diagnose|resolve|repair)\b|修復|修复|調查|调查|重現|重现|診斷|诊断|查明|找出原因|解決|解决/u.test(value);
}
/** One issue or cause in different spacing or case is still the same one. */
export const sameDebugText=(left:string,right:string):boolean=>
  left.normalize("NFKC").trim().replace(/\s+/gu," ").toLowerCase() === right.normalize("NFKC").trim().replace(/\s+/gu," ").toLowerCase();
