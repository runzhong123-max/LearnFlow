import type { PackageVisibility } from "@/lib/packages/types";

export function releaseAction(visibility?: PackageVisibility | null) {
  return visibility === "private" ? { action: "save_private", label: "保存到我的岗位包" }
    : visibility === "public" ? { action: "publish", label: "发布到公开图谱市场" }
      : visibility === "unlisted" ? { action: "publish", label: "保存为不公开列出的岗位包" } : null;
}

export function releaseStatusLabel(status: string, visibility?: PackageVisibility | null) {
  if (status === "published") return visibility === "public" ? "已公开发布" : visibility === "private" ? "已私有保存" : "已保存";
  return ({ ready: "校验通过，待保存", failed: "校验未通过", compiling: "正在编译", validating: "正在校验", deprecated: "已停用" } as Record<string, string>)[status] || status;
}
