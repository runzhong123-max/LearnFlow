import {useEffect, useRef, useState} from 'react'

/** Maintained documents keep an opaque origin and cannot access host credentials.
 * A document URL avoids inheriting the desktop shell's stricter inline-script CSP.
 * Older hosts retain srcdoc; missing execution now produces an explicit retry UI.
 */
export default function InteractiveHtmlPlayer({html, title, documentUrl}: {html: string; title: string; documentUrl?: string}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(620)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<'loading'|'ready'|'failed'>('loading')
  useEffect(() => {
    setStatus('loading')
    setHeight(620)
    const timer = setTimeout(() => setStatus('failed'), 12000)
    const resize = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'learnflow-visual-height') return
      const value = event.data.height
      if (typeof value === 'number' && Number.isFinite(value)) {
        clearTimeout(timer)
        setStatus('ready')
        setHeight(Math.max(260, Math.min(1800, Math.ceil(value) + 4)))
      }
    }
    window.addEventListener('message', resize)
    return () => { clearTimeout(timer); window.removeEventListener('message', resize) }
  }, [html, documentUrl, attempt])
  return <div aria-busy={status === 'loading'}>
    {status === 'loading' && <p role="status">正在加载图解…</p>}
    {status === 'failed' && <div role="alert"><p>图解未能加载，请重试。</p><button type="button" onClick={() => setAttempt(value => value + 1)}>重新加载图解</button></div>}
    <iframe key={attempt} ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" src={documentUrl} srcDoc={documentUrl ? undefined : html} onError={() => setStatus('failed')} style={{display:status === 'failed' ? 'none' : 'block', width:'100%', height, border:0, borderRadius:8}} />
  </div>
}
