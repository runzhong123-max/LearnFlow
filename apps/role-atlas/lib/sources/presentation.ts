export type SourceUsageInput = { status?: string; evidenceBindingCount?: number };

export function sourceUsage(source: SourceUsageInput) {
  const excluded = ["rejected", "quarantined", "low_relevance", "unreadable"].includes(source.status || "");
  if (excluded) return { group: "excluded", label: "已排除", detail: source.evidenceBindingCount ? "此来源已被排除，但仍存在历史绑定，需要修复；不可作为已采纳证据。" : "保留筛选记录，不作为已采纳证据。" } as const;
  if (source.evidenceBindingCount && source.evidenceBindingCount > 0) return { group: "bound", label: "已绑定证据", detail: `${source.evidenceBindingCount} 条证据绑定；绑定不代表每项结论均已证实。` } as const;
  return { group: "pending", label: source.status === "limited" ? "使用受限" : source.status === "accepted" ? "资格通过，尚未绑定" : "待核验", detail: "来源登记或资格通过不等于已被岗位结论采纳。" } as const;
}
