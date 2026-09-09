import type { SemanticNode } from "../build/types";

export type CourseTheme = { title: string; scopeNote: string };
export const courseNameKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
// Legacy operational statements have no course hint. These subject aliases are
// organization hints only: they neither create facts nor assert equivalence.
const subjects: Array<[string, RegExp]> = [
  ["数据中心运维", /机房|上下架|用电规范|消防|电气规范|数据中心/u],
  ["运维文档与配置管理", /编写.*(?:文档|报告)|编制.*(?:文档|报告)|技术文档|资产清单|技术资料|周期文档/u],
  ["IT服务与变更管理", /变更方案|变更管理|产品支持流程|工单|客户技术问题/u],
  ["运维自动化", /shell|python|脚本|自动化运维/iu],
  ["数据库原理与运维", /数据库|mysql|sql server|事务隔离|redis/iu],
  ["计算机网络", /tcp|dns|http|网络协议|路由|子网|防火墙/iu],
  ["Linux系统管理", /linux|进程管理|文件权限|systemd/iu],
  ["云平台运维", /云平台|云计算|虚拟化|fusioncompute|fusionaccess|openstack|云桌面|云资源|华为.*(?:工具|交付)/iu],
];
export function isCourseTitle(title: string): boolean {
  return title.trim().length >= 2 && title.trim().length <= 32
    && !/^(?:在|为|对|根据|按照|使用|执行|完成|掌握|了解|熟悉|编写|编制|制定|解释|排查|负责|管理|维护|建立|设置|配置)/u.test(title.trim());
}
export function courseTheme(point: SemanticNode, roleTitle: string): CourseTheme {
  const hint = point.learningCourse;
  if (hint && isCourseTitle(hint.title) && hint.scopeNote?.trim()) {
    return { title: hint.title.trim(), scopeNote: hint.scopeNote.trim() };
  }
  const title = subjects.find(([, pattern]) => pattern.test(point.label))?.[0]
    || `${roleTitle.slice(0, 22)}专业基础与实践`;
  return { title, scopeNote: `围绕${title}组织相关原理、方法与实践；各岗位的适用场景和验收条件在挂载条目中分别保留。` };
}

/** Strong subject/name matches only; generic role words must not win by overlap. */
export function courseMatchScore(theme: CourseTheme, point: SemanticNode, names: string[]): number {
  const title = courseNameKey(theme.title);
  return Math.max(0, ...names.map(name => {
    const candidate = courseNameKey(name);
    if (candidate === title) return 1;
    if (candidate.length < 3 || /^(?:岗位|运维|基础|实践|工程师|信息技术|计算机)$/u.test(candidate)) return 0;
    if (title.includes(candidate)) return 0.9;
    const subject = (value: string) => value.replace(/(?:课程|技术基础|基础|入门|原理与运维|原理|系统管理|技术应用)$/u, "");
    const a = subject(title), b = subject(candidate);
    if (a.length >= 3 && a === b) return 0.88;
    // E.g. official course “数据库” with an evidenced “数据库事务隔离级别”.
    if (courseNameKey(point.label).includes(candidate)) return 0.85;
    return 0;
  }));
}
