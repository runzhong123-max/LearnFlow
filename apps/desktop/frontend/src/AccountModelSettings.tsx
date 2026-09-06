/// <reference types="vite/client" />

import { useEffect, useState, type FormEvent } from 'react'

import {
  deleteFormalModelCredential,
  deleteFormalVisionCredential,
  listFormalAdminAccounts,
  loadFormalModelCredential,
  loadFormalVisionCredential,
  saveFormalModelCredential,
  saveFormalVisionCredential,
  testFormalModelCredential,
  testFormalVisionCredential,
  type FormalAccount,
  type FormalAdminAccount,
  type FormalModelCredentialMetadata,
  type FormalVisionCredentialMetadata,
} from './formal-runtime.ts'
import styles from './AccountModelSettings.module.css'

type AccountModelSettingsProps = {
  account: FormalAccount
  baseUrl: string
  model: string
  onConnectionChange: (patch: Partial<{ baseUrl: string; model: string }>) => void
  onSignOut: () => Promise<void>
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function dateLabel(value?: string | null) {
  if (!value) return '尚未更新'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '已更新' : parsed.toLocaleString('zh-CN')
}

export default function AccountModelSettings({
  account,
  baseUrl,
  model,
  onConnectionChange,
  onSignOut,
}: AccountModelSettingsProps) {
  const [credential, setCredential] = useState<FormalModelCredentialMetadata>()
  const [visionCredential, setVisionCredential] = useState<FormalVisionCredentialMetadata>()
  const [adminAccounts, setAdminAccounts] = useState<FormalAdminAccount[]>([])
  const [apiKey, setApiKey] = useState('')
  const [visionApiKey, setVisionApiKey] = useState('')
  const [visionBaseUrl, setVisionBaseUrl] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [visionUsesTutorKey, setVisionUsesTutorKey] = useState(true)
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState('')
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    const credentialRequest = loadFormalModelCredential()
    const visionCredentialRequest = loadFormalVisionCredential()
    const accountsRequest = account.role === 'admin'
      ? listFormalAdminAccounts()
      : Promise.resolve([] as FormalAdminAccount[])
    Promise.all([credentialRequest, visionCredentialRequest, accountsRequest])
      .then(([metadata, visionMetadata, accounts]) => {
        if (!active) return
        setCredential(metadata)
        if (metadata.base_url) onConnectionChange({ baseUrl: metadata.base_url })
        if (metadata.model) onConnectionChange({ model: metadata.model })
        setVisionCredential(visionMetadata)
        setVisionBaseUrl(visionMetadata.base_url)
        setVisionModel(visionMetadata.model)
        setVisionUsesTutorKey(visionMetadata.uses_tutor_key)
        setAdminAccounts(accounts)
      })
      .catch(loadError => {
        if (active) setError(messageFrom(loadError, '账号设置加载失败'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [account.learner_id, account.role])

  const refreshAdminAccounts = async () => {
    if (account.role !== 'admin') return
    setAdminAccounts(await listFormalAdminAccounts())
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusyAction('save')
    setError('')
    setNotice('')
    try {
      const metadata = await saveFormalModelCredential(apiKey, baseUrl, model)
      setCredential(metadata)
      onConnectionChange({ baseUrl: metadata.base_url, model: metadata.model })
      setApiKey('')
      setDeleteArmed(false)
      await refreshAdminAccounts()
      setNotice(apiKey.trim() ? '模型凭据已加密更新；输入框已清空。' : '界面配置已保存；空 Key 保留了现有凭据。')
    } catch (saveError) {
      setError(messageFrom(saveError, '模型设置保存失败'))
    } finally {
      setBusyAction('')
    }
  }

  const removeCredential = async () => {
    if (!deleteArmed) {
      setDeleteArmed(true)
      setNotice('再次点击以确认删除本人模型凭据。')
      setError('')
      return
    }
    setBusyAction('delete')
    setError('')
    setNotice('')
    try {
      setCredential(await deleteFormalModelCredential())
      setApiKey('')
      setDeleteArmed(false)
      await refreshAdminAccounts()
      setNotice('本人模型凭据已删除。')
    } catch (deleteError) {
      setError(messageFrom(deleteError, '模型凭据删除失败'))
    } finally {
      setBusyAction('')
    }
  }

  const testCredential = async () => {
    if (apiKey.trim()) {
      setError('输入框中有尚未保存的 Key；请先保存，再测试服务端已加密的凭据。')
      return
    }
    setBusyAction('test')
    setError('')
    setNotice('')
    try {
      const result = await testFormalModelCredential(baseUrl, model)
      setNotice(`连接成功：${result.model}，${result.latency_ms} ms。`)
    } catch (testError) {
      setError(messageFrom(testError, '模型凭据测试失败'))
    } finally {
      setBusyAction('')
    }
  }

  const saveVisionCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!visionUsesTutorKey && !visionCredential?.configured && !visionApiKey.trim()) {
      setError('请填写独立视觉 API Key，或选择复用对话模型 Key。')
      return
    }
    setBusyAction('vision-save')
    setError('')
    setNotice('')
    try {
      const metadata = await saveFormalVisionCredential({
        apiKey: visionApiKey,
        baseUrl: visionBaseUrl,
        model: visionModel,
        useTutorKey: visionUsesTutorKey,
      })
      setVisionCredential(metadata)
      setVisionBaseUrl(metadata.base_url)
      setVisionModel(metadata.model)
      setVisionUsesTutorKey(metadata.uses_tutor_key)
      setVisionApiKey('')
      setDeleteArmed(false)
      setNotice(metadata.uses_tutor_key
        ? '视觉模型已保存，正在复用对话模型 Key。'
        : '独立视觉模型凭据已加密更新；输入框已清空。')
    } catch (saveError) {
      setError(messageFrom(saveError, '视觉模型设置保存失败'))
    } finally {
      setBusyAction('')
    }
  }

  const removeVisionCredential = async () => {
    if (!deleteArmed) {
      setDeleteArmed(true)
      setNotice('再次点击以移除视觉模型的独立配置；不会删除对话模型凭据。')
      setError('')
      return
    }
    setBusyAction('vision-delete')
    setError('')
    setNotice('')
    try {
      const metadata = await deleteFormalVisionCredential()
      setVisionCredential(metadata)
      setVisionBaseUrl(metadata.base_url)
      setVisionModel(metadata.model)
      setVisionUsesTutorKey(metadata.uses_tutor_key)
      setVisionApiKey('')
      setDeleteArmed(false)
      setNotice('视觉模型的独立配置已移除；对话模型凭据保持不变。')
    } catch (deleteError) {
      setError(messageFrom(deleteError, '视觉模型配置删除失败'))
    } finally {
      setBusyAction('')
    }
  }

  const testVisionCredential = async () => {
    if (visionApiKey.trim()) {
      setError('独立视觉 API Key 尚未保存；请先保存，再测试服务端已加密的凭据。')
      return
    }
    setBusyAction('vision-test')
    setError('')
    setNotice('')
    try {
      const result = await testFormalVisionCredential()
      setNotice(`图片理解连接成功：${result.model}，${result.latency_ms} ms。`)
    } catch (testError) {
      setError(messageFrom(testError, '视觉模型测试失败'))
    } finally {
      setBusyAction('')
    }
  }

  const signOut = async () => {
    setBusyAction('logout')
    setError('')
    try {
      await onSignOut()
    } catch (logoutError) {
      setError(messageFrom(logoutError, '退出登录失败'))
      setBusyAction('')
    }
  }

  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-labelledby="account-settings-title">
        <div className={styles.heading}>
          <span>01</span>
          <div><h2 id="account-settings-title">账号与缓存边界</h2><p>当前浏览器工作区只写入 learner #{account.learner_id} 的 scoped key。</p></div>
          <i>{account.role === 'admin' ? '管理员' : '学习者'}</i>
        </div>
        <div className={styles.accountRow}>
          <div className={styles.avatar}>{account.display_name.slice(0, 1).toUpperCase()}</div>
          <div><strong>{account.display_name}</strong><span>@{account.username} · 账号 #{account.account_number}</span></div>
          <button type="button" className={styles.secondary} disabled={Boolean(busyAction)} onClick={() => { void signOut() }}>{busyAction === 'logout' ? '正在退出…' : '退出并切换账号'}</button>
        </div>
        {account.must_change_password ? <p className={styles.warning}>此账号被标记为需要更新密码；请尽快使用账号密码接口完成修改。</p> : null}
      </section>

      <form className={styles.card} onSubmit={save}>
        <div className={styles.heading}>
          <span>02</span>
          <div><h2>模型连接与本人凭据</h2><p>API Key 加密保存；Base URL 与模型名称同样绑定当前账号，页面不会回显明文。</p></div>
          <i className={credential?.configured ? styles.configured : ''}>{loading ? '读取中' : credential?.configured ? 'configured' : 'not configured'}</i>
        </div>
        <div className={styles.fieldGrid}>
          <label><span>Base URL</span><input name="model_base_url" autoComplete="url" value={baseUrl} onChange={event => onConnectionChange({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
          <label><span>模型名称</span><input name="model_name" autoComplete="off" value={model} onChange={event => onConnectionChange({ model: event.target.value })} placeholder="例如 model-name" /></label>
        </div>
        <label className={styles.keyField}>
          <span>API Key</span>
          <input name="model_api_key" type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setDeleteArmed(false) }} autoComplete="new-password" placeholder={credential?.configured ? '留空以保留现有凭据' : '输入当前账号的模型 API Key'} />
          <small>{credential?.configured ? `已配置 ${credential.key_hint || 'masked key'} · ${dateLabel(credential.updated_at)}。空输入会保留现有 Key。` : '尚未配置。明文仅存在于本次输入状态，不写入 localStorage。'}</small>
        </label>
        {credential?.configured && (!credential.base_url || !credential.model) ? <p className={styles.notice}>请点击“保存 / 更新”一次，将当前 Base URL 和模型名称绑定到账号后再使用桌宠。</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        <div className={styles.actions}>
          <button type="submit" disabled={Boolean(busyAction)}>{busyAction === 'save' ? '正在保存…' : credential?.configured ? '保存 / 更新' : '保存凭据'}</button>
          <button type="button" className={styles.secondary} disabled={Boolean(busyAction) || !credential?.configured} onClick={() => { void testCredential() }}>{busyAction === 'test' ? '正在测试…' : '测试连接'}</button>
          <button type="button" className={deleteArmed ? styles.dangerArmed : styles.danger} disabled={Boolean(busyAction) || !credential?.configured} onClick={() => { void removeCredential() }}>{busyAction === 'delete' ? '正在删除…' : deleteArmed ? '确认删除凭据' : '删除凭据'}</button>
        </div>
      </form>

      <form className={styles.card} onSubmit={saveVisionCredential}>
        <div className={styles.heading}>
          <span>03</span>
          <div><h2>配置视觉模型</h2><p>仅用于你主动粘贴并确认的截图；原图不写入学习记录或长期记忆。</p></div>
          <i className={visionCredential?.configured ? styles.configured : ''}>{loading ? '读取中' : visionCredential?.configured ? 'configured' : 'not configured'}</i>
        </div>
        <div className={styles.fieldGrid}>
          <label><span>视觉 Base URL</span><input name="vision_model_base_url" autoComplete="url" value={visionBaseUrl} onChange={event => setVisionBaseUrl(event.target.value)} placeholder="留空时使用对话模型地址" /></label>
          <label><span>视觉模型名称</span><input name="vision_model_name" autoComplete="off" value={visionModel} onChange={event => setVisionModel(event.target.value)} placeholder="例如 qwen-vl-max" /></label>
        </div>
        <label className={styles.toggle}>
          <input name="vision_uses_tutor_key" type="checkbox" checked={visionUsesTutorKey} onChange={event => {
            setVisionUsesTutorKey(event.target.checked)
            setVisionApiKey('')
            setDeleteArmed(false)
          }} />
          <span>复用对话模型的 API Key</span>
        </label>
        <label className={styles.keyField}>
          <span>独立视觉 API Key</span>
          <input name="vision_model_api_key" type="password" value={visionApiKey} disabled={visionUsesTutorKey} onChange={event => { setVisionApiKey(event.target.value); setDeleteArmed(false) }} autoComplete="new-password" placeholder={visionUsesTutorKey ? '当前复用对话模型 Key' : visionCredential?.uses_tutor_key ? '输入视觉模型 API Key' : '留空以保留现有独立 Key'} />
          <small>{visionUsesTutorKey
            ? '视觉请求使用本账号已保存的对话模型 Key。'
            : visionCredential?.uses_tutor_key
              ? '明文仅存在于本次输入状态，不写入 localStorage。'
              : `已配置 ${visionCredential?.key_hint || 'masked key'} · ${dateLabel(visionCredential?.updated_at)}。空输入会保留现有独立 Key。`}</small>
        </label>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        <div className={styles.actions}>
          <button type="submit" disabled={Boolean(busyAction)}>{busyAction === 'vision-save' ? '正在保存…' : '保存视觉配置'}</button>
          <button type="button" className={styles.secondary} disabled={Boolean(busyAction) || !visionCredential?.configured} onClick={() => { void testVisionCredential() }}>{busyAction === 'vision-test' ? '正在测试…' : '测试图片理解'}</button>
          <button type="button" className={deleteArmed ? styles.dangerArmed : styles.danger} disabled={Boolean(busyAction) || !visionCredential?.configured} onClick={() => { void removeVisionCredential() }}>{busyAction === 'vision-delete' ? '正在删除…' : deleteArmed ? '确认移除视觉配置' : '移除视觉配置'}</button>
        </div>
      </form>

      {account.role === 'admin' ? (
        <section className={styles.card} aria-labelledby="admin-account-title">
          <div className={styles.heading}>
            <span>04</span>
            <div><h2 id="admin-account-title">账号凭据配置概览</h2><p>管理员视图只展示 configured 状态，不展示其他账号的 key hint 或密文。</p></div>
            <i>{adminAccounts.length} 个账号</i>
          </div>
          <div className={styles.accountList}>
            {adminAccounts.map(item => (
              <article key={item.account_number}>
                <div><strong>{item.display_name}</strong><span>@{item.username} · {item.role} · {item.status} · {item.project_count} 个项目</span></div>
                <b className={item.api_key_configured ? styles.yes : styles.no}>{item.api_key_configured ? 'configured' : 'not configured'}</b>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
