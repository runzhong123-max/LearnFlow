"use client";

import { BookOpenCheck, ExternalLink, SearchX, X } from "lucide-react";
import type { WebResearchReport } from "@/lib/build/types";
import ResearchAudit from "@/app/components/ResearchAudit";
import { sourceUsage } from "@/lib/sources/presentation";

export type EvidenceSourceItem = {
  id: string;
  title: string;
  kind: string;
  tier?: string;
  status?: string;
  asOf?: string;
  locator?: string;
  note?: string;
  discovery?: string;
  evidenceBindingCount?: number;
  qualificationReasons?: string[];
};

type Props = {
  sources: EvidenceSourceItem[];
  query: string;
  research?: WebResearchReport;
  sourceIds?: string[];
  contextLabel?: string;
  onClearContext?: () => void;
};

export default function EvidenceSourceView({ sources, query, research, sourceIds = [], contextLabel, onClearContext }: Props) {
  const needle = query.trim().toLowerCase();
  const scopedSources = sourceIds.length ? sources.filter((source) => sourceIds.includes(source.id)) : sources;
  const visibleSources = needle
    ? scopedSources.filter((source) => `${source.title} ${source.kind} ${source.tier || ""} ${source.note || ""}`.toLowerCase().includes(needle))
    : scopedSources;

  return (
    <div className="evidence-source-view">
      <header>
        <span>PROVENANCE &amp; EVIDENCE</span>
        <h2>来源证据</h2>
        <p>区分实际绑定的证据、待核验资料和已排除资料。搜索入选或资格通过不等于被岗位结论采纳。</p>
        <div className="evidence-source-facts">
          <span><b>{sources.filter((source) => sourceUsage(source).group === "bound").length}</b><small>实际绑定来源</small></span>
          <span><b>{sources.filter((source) => sourceUsage(source).group === "pending").length}</b><small>待核验或未绑定</small></span>
          <span><b>{sources.filter((source) => sourceUsage(source).group === "excluded").length}</b><small>已排除来源</small></span>
        </div>
      </header>

      {research ? <ResearchAudit report={research} /> : null}

      {sourceIds.length ? <div className="evidence-context-filter"><span><b>当前证据范围</b><small>{contextLabel || "所选岗位对象"} · {scopedSources.length} 个已登记来源</small></span>{onClearContext ? <button onClick={onClearContext}><X size={12} /> 查看全部来源</button> : null}</div> : null}

      {visibleSources.length ? (
        <div>{([ ["bound", "实际绑定的来源"], ["pending", "待核验与未绑定资料"], ["excluded", "已排除资料 · 仅供审计"] ] as const).map(([group, label]) => {
          const items = visibleSources.filter((source) => sourceUsage(source).group === group);
          return items.length ? <section key={group} aria-label={label}><h3>{label}（{items.length}）</h3><div className="evidence-source-grid">
          {items.map((source) => (
            <article key={source.id} data-source-usage={group}>
              <div className="evidence-source-icon"><BookOpenCheck size={15} /></div>
              <div>
                <span className="evidence-source-meta">{source.kind} · {source.tier || "未分级"}{source.asOf ? ` · ${source.asOf}` : ""}</span>
                <h3>{source.title}</h3>
                {source.discovery ? <p>{source.discovery}</p> : null}
                {source.note ? <small>{source.note}</small> : null}
                <p><strong>{sourceUsage(source).label}</strong> · {sourceUsage(source).detail}</p>
                {source.qualificationReasons?.length ? <small>资格说明：{source.qualificationReasons.join("；")}</small> : null}
              </div>
              <footer>
                <em>{sourceUsage(source).label}</em>
                {source.locator ? <a href={source.locator} target="_blank" rel="noreferrer">查看原文 <ExternalLink size={11} /></a> : <i>项目内资料</i>}
              </footer>
            </article>
          ))}
        </div></section> : null;
        })}</div>
      ) : (
        <div className="evidence-source-empty"><SearchX size={22} /><span>没有匹配当前检索条件的来源。</span></div>
      )}
    </div>
  );
}
