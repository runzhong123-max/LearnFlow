/** Project labels must not become occupational search constraints. */
export function researchRoleTitle(title: string): string {
  const value = title.trim();
  // Strip only explicitly separated test/copy annotations, never occupational
  // qualifiers such as QA工程师、测试工程师、嵌入式软件工程师（BSP）.
  const cleaned = value.replace(/(?:\s*[-—–·|]\s*|\s*[（(])(?:岗位资料|有资料|联网|技术资料|资料)?\s*(?:QA|测试版|测试项目|测试|副本)(?:[\s\d一二三四五六七八九十-]*)(?:[）)])?$/iu, "").trim();
  return cleaned.length >= 2 ? cleaned : value;
}
