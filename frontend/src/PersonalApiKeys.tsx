import { useEffect, useRef, useState, type FormEvent } from 'react'
import { runtimeFetch } from './runtime-client'
import styles from './PersonalApiKeys.module.css'

type AccessKey = {
  id: number; name: string; key_hint: string; copy_available: boolean
  expires_at: string; last_used_at: string | null; revoked_at: string | null
}
type Secret = { api_key: string; metadata: AccessKey }
type Action = { kind: 'create' } | { kind: 'copy' | 'revoke'; key: AccessKey }

async function request<T>(path = '', method = 'GET', body?: object): Promise<T> {
  const response = await runtimeFetch(`/api/auth/api-keys${path}`, {
    method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof payload?.detail === 'string' ? payload.detail : '密钥服务暂时不可用，请稍后重试')
  return payload as T
}
const date = (value: string) => new Date(value).toLocaleDateString('zh-CN')

// Remounted for each account; secrets never enter workspace settings or browser storage.
export default function PersonalApiKeys() {
  const [keys, setKeys] = useState<AccessKey[]>([])
  const [action, setAction] = useState<Action | null>(null)
  const [name, setName] = useState('我的桌面端')
  const [days, setDays] = useState('30')
  const [password, setPassword] = useState('')
  const [secret, setSecret] = useState<Secret | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const current = ++generation.current
    request<{ api_keys: AccessKey[] }>().then(data => {
      if (current === generation.current) setKeys(data.api_keys)
    }).catch(err => { if (current === generation.current) setError(err.message) })
      .finally(() => { if (current === generation.current) setLoading(false) })
    return () => { generation.current += 1 }
  }, [])

  useEffect(() => {
    if (!secret) return
    const timer = window.setTimeout(() => { setSecret(null); setNotice('密钥已收起，需要时可再次验证并复制。') }, 60_000)
    return () => window.clearTimeout(timer)
  }, [secret])

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') {
        generation.current += 1
        setSecret(null); setPassword(''); setBusy(false); setAction(null); setLoading(false)
      } else {
        const current = generation.current
        setLoading(true)
        request<{ api_keys: AccessKey[] }>().then(data => {
          if (current === generation.current) setKeys(data.api_keys)
        }).catch(err => { if (current === generation.current) setError(err.message) })
          .finally(() => { if (current === generation.current) setLoading(false) })
      }
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [])

  function begin(next: Action) {
    setAction(next); setPassword(''); setSecret(null); setNotice(''); setError('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!action || busy) return
    const current = generation.current
    setBusy(true); setError(''); setNotice('')
    const submittedPassword = password
    setPassword('')
    try {
      if (action.kind === 'revoke') {
        await request(`/${action.key.id}`, 'DELETE')
        if (current !== generation.current) return
        setKeys(items => items.map(item => item.id === action.key.id ? { ...item, revoked_at: new Date().toISOString(), copy_available: false } : item))
        setNotice('密钥已撤销，使用它的连接将失效。')
      } else {
        const result = action.kind === 'create'
          ? await request<Secret>('', 'POST', { name: name.trim(), expires_in_days: Number(days), password: submittedPassword })
          : await request<Secret>(`/${action.key.id}/reveal`, 'POST', { password: submittedPassword })
        if (current !== generation.current) return
        setSecret(result)
        setKeys(items => [result.metadata, ...items.filter(item => item.id !== result.metadata.id)])
        setNotice(action.kind === 'create' ? '已签发。复制后即可连接桌面端。' : '验证成功，可以复制密钥。')
      }
      setAction(null)
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : '操作失败，请重试')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }

  async function copy() {
    if (!secret) return
    const current = generation.current
    try {
      await navigator.clipboard.writeText(secret.api_key)
      if (current === generation.current) setNotice('已复制，可粘贴到桌面端。')
    } catch {
      if (current !== generation.current) return
      input.current?.focus(); input.current?.select()
      setNotice('浏览器未允许自动复制，已选中密钥，请按 ⌘C 或 Ctrl+C。')
    }
  }

  return <section className={styles.card} aria-labelledby="personal-api-keys-title">
    <header className={styles.heading}>
      <div><h2 id="personal-api-keys-title">个人 API Key</h2><p>用来连接 LearnFlow 桌面端。仅访问你的账号数据，可随时复制或撤销。</p></div>
      <button type="button" disabled={busy || loading} onClick={() => begin({ kind: 'create' })}>签发新 Key</button>
    </header>
    {loading ? <p className={styles.hint}>正在读取密钥…</p> : keys.length === 0 && !error ? <p className={styles.hint}>还没有个人密钥。签发一把，即可在桌面端继续学习。</p> : null}
    <ul className={styles.list}>
      {keys.map(key => {
        const inactive = !!key.revoked_at || Date.parse(key.expires_at) <= Date.now()
        return <li key={key.id}>
          <div className={styles.keyInfo}><strong>{key.name}</strong><code>{key.key_hint}</code>
            <small>{key.revoked_at ? '已撤销' : inactive ? '已到期' : `${date(key.expires_at)} 到期`}{!inactive ? ` · ${key.last_used_at ? `${date(key.last_used_at)} 使用过` : '尚未使用'}` : ''}</small>
            {!inactive && !key.copy_available ? <small>旧版密钥无法找回原文，请签发新 Key。</small> : null}
          </div>
          {!inactive ? <div className={styles.rowActions}>
            <button type="button" className={styles.secondary} disabled={busy || !key.copy_available} onClick={() => begin({ kind: 'copy', key })} aria-label={`复制 ${key.name}`}>复制</button>
            <button type="button" className={styles.textButton} disabled={busy} onClick={() => begin({ kind: 'revoke', key })} aria-label={`撤销 ${key.name}`}>撤销</button>
          </div> : null}
        </li>
      })}
    </ul>
    {action ? <form className={styles.form} onSubmit={submit}>
      <h3>{action.kind === 'create' ? '签发个人密钥' : action.kind === 'copy' ? `复制「${action.key.name}」` : `撤销「${action.key.name}」？`}</h3>
      {action.kind === 'create' ? <div className={styles.fields}>
        <label>名称<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy} placeholder="例如：办公室电脑" /></label>
        <label>有效期<select value={days} onChange={e => setDays(e.target.value)} disabled={busy}><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select></label>
      </div> : null}
      {action.kind !== 'revoke' ? <label>账号密码<input autoFocus type="password" autoComplete="current-password" value={password} maxLength={128} required disabled={busy} onChange={e => setPassword(e.target.value)} placeholder="验证是你本人在操作" /></label> : <p>使用这把密钥的桌面端将无法继续连接。此操作无法撤回。</p>}
      <div className={styles.actions}>
        <button type="submit" disabled={busy || action.kind !== 'revoke' && !password || action.kind === 'create' && !name.trim()}>{busy ? '处理中…' : action.kind === 'create' ? '确认签发' : action.kind === 'copy' ? '验证并取出' : '确认撤销'}</button>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setAction(null); setPassword(''); setError('') }}>取消</button>
      </div>
    </form> : null}
    {secret ? <div className={styles.secret}>
      <label>「{secret.metadata.name}」的密钥<input ref={input} aria-label="可复制的 API Key" value={secret.api_key} readOnly autoComplete="off" spellCheck={false} onFocus={e => e.target.select()} /></label>
      <div className={styles.actions}><button type="button" onClick={() => { void copy() }}>复制密钥</button><button type="button" className={styles.secondary} onClick={() => setSecret(null)}>收起</button><small>60 秒后自动收起，下次仍可复制。</small></div>
    </div> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
  </section>
}
