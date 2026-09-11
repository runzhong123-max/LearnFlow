/// <reference types="vite/client" />

import { useEffect, useState } from 'react'

import {
  listFormalAdminAccounts,
  type FormalAccount,
  type FormalAdminAccount,
} from './formal-runtime.ts'
import { UserIdentity } from '../../packages/learning-client/src/identity/UserIdentity'
import styles from './AccountModelSettings.module.css'
import PersonalApiKeys from './PersonalApiKeys'

type AccountModelSettingsProps = {
  account: FormalAccount
  baseUrl: string
  model: string
  onConnectionChange: (patch: Partial<{ baseUrl: string; model: string }>) => void
  onSignOut: () => Promise<void>
}

export default function AccountModelSettings({ account, onSignOut }: AccountModelSettingsProps) {
  const [adminAccounts, setAdminAccounts] = useState<FormalAdminAccount[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (account.role !== 'admin') return
    let active = true
    listFormalAdminAccounts()
      .then(items => { if (active) setAdminAccounts(items) })
      .catch(loadError => { if (active) setError(loadError instanceof Error ? loadError.message : '账号列表加载失败') })
    return () => { active = false }
  }, [account.learner_id, account.role])

  const quota = account.quota ?? { unit: 'credits' as const, unlimited: true, used: 0 }
  const quotaLabel = quota.unlimited
    ? '无限额度'
    : `${quota.remaining ?? 0} / ${quota.limit ?? 0} credits`

  return (
    <div className={styles.stack}>
      <section className={styles.card} aria-labelledby="account-settings-title">
        <div className={styles.heading}>
          <span>01</span>
          <div><h2 id="account-settings-title">账号与额度</h2><p>查看账号与使用额度。连接桌面端所需的个人 API Key 可在下方管理。</p></div>
          <i>{account.role === 'admin' ? '管理员' : '学习者'}</i>
        </div>
        <div className={styles.accountRow}>
          <UserIdentity displayName={account.display_name} username={account.username} avatar={account.avatar} detail={`账号 #${account.account_number} · ${quotaLabel}`} size="lg" />
          <button type="button" className={styles.secondary} disabled={busy} onClick={() => { setBusy(true); void onSignOut().catch(signOutError => { setError(signOutError instanceof Error ? signOutError.message : '退出失败'); setBusy(false) }) }}>{busy ? '正在退出…' : '退出并切换账号'}</button>
        </div>
      </section>

      <section className={styles.card} aria-labelledby="platform-model-title">
        <div className={styles.heading}>
          <span>02</span>
          <div><h2 id="platform-model-title">平台智能服务</h2><p>当前账户直接使用后台接入的模型。模型名称、服务地址和供应商密钥由平台维护。</p></div>
          <i className={styles.configured}>后台托管</i>
        </div>
        <p className={styles.notice}>当前额度：{quotaLabel}。首发阶段所有账户不设上限，后续可由后台调整额度而无需用户更换 API Key。</p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </section>

      <PersonalApiKeys key={account.id} />

      {account.role === 'admin' ? (
        <section className={styles.card} aria-labelledby="admin-account-title">
          <div className={styles.heading}>
            <span>03</span>
            <div><h2 id="admin-account-title">账户总览</h2><p>这里只展示平台账户，不展示任何模型密钥或供应商凭据。</p></div>
            <i>{adminAccounts.length} 个账号</i>
          </div>
          <div className={styles.accountList}>
            {adminAccounts.map(item => (
              <article key={item.account_number}>
                <div><strong>{item.display_name}</strong><span>@{item.username} · {item.role} · {item.status} · {item.project_count} 个项目</span></div>
                <b className={styles.yes}>平台托管</b>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
