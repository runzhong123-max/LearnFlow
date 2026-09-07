import {useEffect, useRef, type ReactNode} from 'react'
import './VisualPlayerChrome.css'

export function VisualStages({stages, step, onMove, disabled = false, blocked = false}: {
  stages: Array<{step: number; title: string}>; step: number; onMove: (step: number) => void; disabled?: boolean; blocked?: boolean;
}) {
  const navigation = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = navigation.current, active = nav?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!nav || !active) return
    const item = active.getBoundingClientRect(), viewport = nav.getBoundingClientRect()
    if (item.left < viewport.left) nav.scrollLeft -= viewport.left - item.left
    else if (item.right > viewport.right) nav.scrollLeft += item.right - viewport.right
  }, [step])
  if (stages.length < 2) return null
  return <nav ref={navigation} className="visual-player-stages" aria-label="教学阶段">{stages.map((stage, index) =>
    <button key={stage.step} type="button" disabled={disabled || (blocked && stage.step > step)}
      aria-current={stage.step <= step && (stages[index + 1]?.step ?? Infinity) > step ? 'step' : undefined}
      title={stage.title} aria-label={`${index + 1}. ${stage.title}`} onClick={() => onMove(stage.step)}>
      <span aria-hidden="true">{index + 1}</span><span>{stage.title.split(/[：:]/, 1)[0]}</span>
    </button>)}</nav>
}

export function VisualPlayback({step, count, playing, speed, animation, busy = false, blocked = false, reduced = false, onMove, onPlay, onSpeed, sliderLabel = '当前步骤'}: {
  step: number; count: number; playing: boolean; speed: number; animation: boolean;
  busy?: boolean; blocked?: boolean; reduced?: boolean; onMove: (step: number) => void;
  onPlay: () => void; onSpeed: (speed: number) => void; sliderLabel?: string;
}) {
  if (count < 2) return null
  const ended = step === count - 1
  return <div className="visual-player-playback">
    <input className="visual-player-progress" type="range" aria-label={sliderLabel} min={0} max={count - 1} step={1} value={step} disabled={busy}
      onChange={event => onMove(blocked ? Math.min(step, Number(event.target.value)) : Number(event.target.value))}/>
    <nav aria-label="播放控制">
      <button className="visual-player-skip" type="button" aria-label="上一步" title="上一步" disabled={busy || step === 0} onClick={() => onMove(step - 1)}>‹</button>
      {animation && <button className="visual-player-primary" type="button" disabled={busy || (blocked && !ended) || (reduced && !ended)} onClick={onPlay}>
        <span aria-hidden="true">{playing ? 'Ⅱ' : ended ? '↺' : '▶'}</span>{playing ? '暂停' : ended ? '重播' : '播放'}
      </button>}
      <button className="visual-player-skip" type="button" aria-label="下一步" title="下一步" disabled={busy || blocked || ended} onClick={() => onMove(step + 1)}>›</button>
      <output aria-label="播放进度">{step + 1}<span> / {count}</span></output>
      {animation && <select aria-label="播放速度" title="播放速度" value={speed} onChange={event => onSpeed(Number(event.target.value))}>
        {[0.5, 1, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
      </select>}
    </nav>
  </div>
}

export function VisualMore({children}: {children: ReactNode}) {
  return <details className="visual-player-more"><summary>更多</summary><div className="visual-player-more-content">{children}</div></details>
}
