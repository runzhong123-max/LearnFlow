import { useEffect, useRef, useState } from 'react'
import type { FormalAchievement } from './formal-runtime'
import './achievement-gallery.css'

export function AchievementGallery({ achievements }: { achievements?: FormalAchievement[] }) {
  const rail = useRef<HTMLUListElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  const updateEdges = () => {
    const element = rail.current
    if (element) setEdges({ start: element.scrollLeft <= 2, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 })
  }
  useEffect(() => {
    const element = rail.current
    if (!element) return
    updateEdges()
    const observer = new ResizeObserver(updateEdges)
    observer.observe(element)
    return () => observer.disconnect()
  }, [achievements])
  const slide = (direction: number) => {
    const element = rail.current
    element?.scrollBy({ left: direction * Math.max(180, element.clientWidth * .75), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }
  return <section className="achievement-gallery" aria-label="学习成就勋章">
    <header>
      <div><h2>学习成就</h2><p>每一步积累，都值得纪念</p></div>
      <div className="achievement-controls">
        {achievements && <span>已获得 {achievements.filter(item => item.earned).length} 枚</span>}
        <button type="button" aria-label="向左浏览勋章" disabled={edges.start} onClick={() => slide(-1)}>←</button>
        <button type="button" aria-label="向右浏览勋章" disabled={edges.end} onClick={() => slide(1)}>→</button>
      </div>
    </header>
    {!achievements ? <p className="achievement-unavailable">成就记录暂不可用，请刷新后重试。</p> :
      <ul ref={rail} className="achievement-rail" tabIndex={0} aria-label="左右滑动浏览全部勋章" onScroll={updateEdges} onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          slide(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}>
        {achievements.map(item => <li key={item.id} className={`achievement-card ${item.earned ? 'is-earned' : 'is-locked'} kind-${item.kind}`}>
          <svg className="achievement-medal" viewBox="0 0 100 112" aria-hidden="true">
            <path className="medal-ribbon" d="M28 67 20 105 39 97 50 110 56 72M49 72 61 110 73 97 89 105 75 65" />
            <path className="medal-edge" d="m50 3 12 6 13 1 7 11 10 8-1 14 3 12-9 10-5 12-14 3-12 7-12-6-14-1-7-11-10-8 1-14-3-12 9-10 5-12 14-3Z" />
            <circle className="medal-face" cx="50" cy="45" r="30" />
            <circle className="medal-ring" cx="50" cy="45" r="25" />
            {item.kind === 'tasks' ? <text x="50" y="53" textAnchor="middle">{item.target}</text> : item.kind === 'registration' ?
              <path className="medal-symbol" d="M50 63V42m0 9C32 52 31 37 32 32c15 0 20 9 18 19Zm0-7c-1-13 8-19 19-19 1 12-5 20-19 19Z" /> :
              <path className="medal-symbol" d="M38 29h24v16c0 9-5 14-12 14s-12-5-12-14Zm0 5H29v7c0 8 5 11 11 11m22-18h9v7c0 8-5 11-11 11M50 59v8m-10 0h20" />}
          </svg>
          <h3 title={item.title}>{item.title}</h3>
          <p>{item.description}</p>
          <span className="achievement-status">{item.earned ? '已获得' : `${item.current} / ${item.target} · 待解锁`}</span>
          {!item.earned && <progress value={item.current} max={item.target} aria-label={`${item.title}完成进度`} />}
        </li>)}
      </ul>}
  </section>
}
