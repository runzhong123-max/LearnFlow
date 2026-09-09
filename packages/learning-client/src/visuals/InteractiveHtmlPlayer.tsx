import {useEffect, useRef, useState} from 'react'

/** Only the authenticated workspace's maintained document reaches this renderer.
 * Opaque origin: no host DOM, cookies, storage, forms, navigation or network grants.
 * Messages carry bounded presentation geometry only, never actions or evidence.
 */
export default function InteractiveHtmlPlayer({html, title}: {html: string; title: string}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(620)
  useEffect(() => {
    const resize = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== 'learnflow-visual-height') return
      const value = event.data.height
      if (typeof value === 'number' && Number.isFinite(value)) setHeight(Math.max(260, Math.min(1800, Math.ceil(value) + 4)))
    }
    window.addEventListener('message', resize)
    return () => window.removeEventListener('message', resize)
  }, [])
  return <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} style={{display:'block', width:'100%', height, border:0, borderRadius:8}} />
}
