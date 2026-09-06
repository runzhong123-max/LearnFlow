"use client";

import { ArrowRight, BadgeCheck, Box, Boxes, GitBranch, PackageOpen, Search, ShieldCheck, Sparkles, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { searchHub, type HubEntry } from "@/lib/hub/discovery";
import { roleAtlasHref } from "@/lib/public-links";

export default function GraphHubMarketplace({ initialPackages, initialQuery = "", initialCategory = "", roleAtlasBaseUrl = "" }: { initialPackages: HubEntry[]; initialQuery?: string; initialCategory?: string; roleAtlasBaseUrl?: string }) {
  const [query, setQuery] = useState(initialQuery.slice(0, 500));
  const [filter, setFilter] = useState(initialCategory);
  const [offset, setOffset] = useState(0);
  const result = useMemo(() => searchHub(initialPackages, { query, category: filter, offset, limit: 12 }), [filter, initialPackages, query, offset]);
  const industries = ["", ...result.categories];
  const packages = result.items;
  const releaseCount = initialPackages.length;
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim()); else url.searchParams.delete("q");
    if (filter) url.searchParams.set("category", filter); else url.searchParams.delete("category");
    window.history.replaceState(window.history.state, "", url);
  }, [query, filter]);

  return <main className="hub-shell">
    <header className="hub-nav">
      <Link className="hub-brand" href="/hub"><span><Boxes size={18} /></span><b>Graph Hub</b><i>by Role Atlas</i></Link>
      <nav><a href="#explore">探索</a><a href="#repositories">图谱仓库</a><Link href="/registry">Registry</Link></nav>
      <div><a className="hub-ghost" href={roleAtlasHref(roleAtlasBaseUrl, "/")}>进入 Role Atlas</a><a className="hub-primary" href={roleAtlasHref(roleAtlasBaseUrl, "/projects/new")}><UploadCloud size={14} /> 发布图谱</a></div>
    </header>

    <section className="hub-hero" id="explore">
      <div className="hub-hero-copy">
        <span className="hub-eyebrow"><Sparkles size={13} /> OPEN GRAPH REPOSITORIES</span>
        <h1>发现、托管与共建<br /><em>岗位知识图谱</em></h1>
        <p>面向计算机专业群，按技术岗位方向探索图谱，检索岗位名称、别名和能力。新发布的图谱自动归类，暂未收录的方向欢迎共建。</p>
        <label className="hub-search"><Search size={19} /><input aria-label="搜索图谱仓库" value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="搜索计算机相关岗位、别名或技能" /></label>
        <div className="hub-trust"><span><ShieldCheck size={14} /> 内容哈希校验</span><span><GitBranch size={14} /> 不可变版本历史</span><span><BadgeCheck size={14} /> 来源与证据可追溯</span></div>
      </div>
      <aside className="hub-hero-panel">
        <div className="hub-orbit"><span className="hub-orbit-core"><Boxes size={30} /></span><i /><i /><i /></div>
        <dl><div><dt>{initialPackages.length}</dt><dd>公开仓库</dd></div><div><dt>{releaseCount}</dt><dd>可用推荐版本</dd></div><div><dt>v3</dt><dd>统一岗位包协议</dd></div></dl>
      </aside>
    </section>

    <section className="hub-market" id="repositories">
      <div className="hub-section-title"><div><span>CURATED & COMMUNITY</span><h2>图谱仓库</h2><p>围绕软件、网络、云计算、数据与人工智能等方向，发现可复用的岗位图谱。</p></div><a href={roleAtlasHref(roleAtlasBaseUrl, "/projects/new")}>创建你的岗位图谱 <ArrowRight size={14} /></a></div>
      <div className="hub-filter-row hub-category-filters" aria-label="计算机专业群岗位方向">{industries.map((industry) => <button type="button" aria-pressed={filter === industry} className={filter === industry ? "active" : ""} key={industry} onClick={() => { setFilter(industry); setOffset(0); }}>{industry || "全部"}（{industry ? result.categoryCounts[industry] || 0 : initialPackages.length}）</button>)}</div>
      <p role="status">{result.total} 个匹配仓库{query.trim() ? " · 按相关性排序" : ""}</p>
      {packages.length ? <div className="hub-repo-grid">{packages.map(({ entry: item, reasons }) => {
        const recommended = item.release;
        return <article className="hub-repo-card" key={item.id}>
          <div className="hub-repo-card-top"><span className="hub-repo-icon"><PackageOpen size={21} /></span><span className="hub-verified"><BadgeCheck size={14} /> {item.maintainerName || "社区维护"}</span></div>
          <Link href={`/hub/${encodeURIComponent(item.id)}`}><h3>{item.title}</h3></Link>
          <code>{item.packageId}</code>
          <p>{item.summary || "一个由 Role Atlas 托管的版本化岗位图谱仓库。"}</p>
          {reasons.length > 0 && <small>{reasons.join(" · ")}</small>}
          <div className="hub-topic-list">{item.categories.map(category => <span key={category}>{category}</span>)}<span>{item.evidencePolicy === "metadata" ? "证据元数据" : item.evidencePolicy}</span><span>协议 {item.protocolRange}</span></div>
          <footer><span><GitBranch size={13} /> 推荐版本</span><span><Box size={13} /> v{recommended.packageVersion}</span><Link href={`/hub/${encodeURIComponent(item.id)}`}>查看仓库 <ArrowRight size={13} /></Link></footer>
        </article>;
      })}</div> : <div className="hub-empty"><Search size={26} /><b>没有匹配的图谱仓库</b><span>{filter && !result.categoryCounts[filter] ? "该分类已开放，暂未收录公开岗位包。发布后会自动归类。" : "换一个关键词或分类筛选试试。"}</span><a href={roleAtlasHref(roleAtlasBaseUrl, "/projects/new")}>共建岗位图谱 <ArrowRight size={14} /></a></div>}
      {result.total > result.limit && <div className="hub-filter-row"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - result.limit))}>上一页</button><span>{Math.floor(offset / result.limit) + 1} / {Math.ceil(result.total / result.limit)}</span><button type="button" disabled={result.nextOffset === null} onClick={() => setOffset(result.nextOffset || 0)}>下一页</button></div>}
    </section>

    <section className="hub-publish-band"><div><span><UploadCloud size={22} /></span><div><b>把你的岗位图谱发布到 Hub</b><p>在 Role Atlas 中完成岗位包后，一次点击即可编译、校验并生成公开仓库。</p></div></div><a href={roleAtlasHref(roleAtlasBaseUrl, "/projects/new")}>开始构建 <ArrowRight size={15} /></a></section>
    <footer className="hub-footer"><span>Graph Hub · Role Atlas graph hosting</span><span>Content-addressed · Versioned · Evidence-aware</span></footer>
  </main>;
}
