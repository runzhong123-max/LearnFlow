"use client";

import { useMemo } from "react";
import type { IterationProducts } from "@/lib/iteration/types";
import { presentIterationProducts } from "@/lib/iteration/product-presentation";
import "./iteration-products.css";

/**
 * Research products for one iteration round.
 *
 * The panel is deliberately plain: ranking, gating and acceptance already
 * happened in code, so the view formats and nothing else. Two things it must
 * not do are worth stating, because both would misrepresent a round:
 *
 *   - it never shows a model-reported gain as if it were the ordered gain;
 *   - it never hides what was withheld. A round where three augmentations were
 *     refused is a different fact from one where none were proposed.
 */
export default function IterationProductsPanel({ products, withheld }: {
  products?: IterationProducts;
  withheld?: string[];
}) {
  const view = useMemo(() => presentIterationProducts({ products, withheld }), [products, withheld]);
  if (view.isEmpty && !view.withheld.length) return null;

  return (
    <section className="iteration-products">
      {view.risk && (
        <section className="iteration-products-block">
          <h4>风险包</h4>
          <p className="iteration-products-counts">
            确定性发现 {view.risk.deterministicCount} 条 ·
            有证据假设 {view.risk.evidencedHypothesisCount} 条 ·
            无证据假设 {view.risk.bareHypothesisCount} 条
          </p>
          <p className="iteration-products-note">
            确定性发现由代码复算；假设未经核实，不等同于发现。
          </p>
          <ul>
            {view.risk.domains.map(domain => (
              <li key={domain.domain}>
                <strong>{domain.domain}</strong>
                <span> · {domain.claims} 条断言{domain.bare ? `（其中 ${domain.bare} 条无证据）` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.radar.length > 0 && (
        <section className="iteration-products-block">
          <h4>深化雷达（{view.radar.length} 个方向）</h4>
          <ul>
            {view.radar.map(item => (
              <li key={`${item.rank}-${item.direction}`}>
                <span className="iteration-products-rank">#{item.rank}</span>
                <strong>{item.axis}</strong>
                <span> · {item.direction}</span>
                <p className="iteration-products-signal">{item.gapSignal}</p>
                <p className="iteration-products-meta">
                  增益 {item.gain}（代码复算） · {item.cost} · 需要证据：{item.requiredEvidence}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.augmentations.length > 0 && (
        <section className="iteration-products-block">
          <h4>增补候选（{view.augmentations.length} 批，已通过四道闸与审计）</h4>
          <ul>
            {view.augmentations.map(item => (
              <li key={item.motivation}>
                <strong>{item.motivation}</strong>
                <span> · 新增 {item.nodeCount} 个节点、{item.edgeCount} 条关系</span>
                <p className="iteration-products-meta">
                  关联原文片段 {item.evidenceSegmentCount} 条 · {item.nodeLabels.join("、")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.withheld.length > 0 && (
        <section className="iteration-products-block withheld">
          <h4>被拦下的内容（{view.withheld.length} 条）</h4>
          <p className="iteration-products-note">
            这些没有进入快照，理由如下；它们仍保留在候选层，可在后续轮次重新评估。
          </p>
          <ul>{view.withheld.map(note => <li key={note}>{note}</li>)}</ul>
        </section>
      )}
    </section>
  );
}
