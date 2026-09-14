import { useEffect } from 'react'

/** Reuse the public exhibition; entering it never signs in or writes evidence. */
export default function CompetitionDemoEntry() {
  useEffect(() => { window.location.replace('/showcase.html') }, [])
  return <p><a href="/showcase.html">打开作品总导航</a></p>
}
