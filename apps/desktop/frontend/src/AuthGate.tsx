/// <reference types="vite/client" />

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import {
  activateFormalIdentity,
  getFormalAuthStatus,
  getFormalDemoStatus,
  invalidateFormalIdentity,
  listFormalDevAccounts,
  loginFormalAccount,
  loginFormalDemoAccount,
  loginFormalDevAccount,
  logoutFormalAccount,
  registerFormalAccount,
  type FormalAccount,
  type FormalDevAccount,
  type FormalRegistrationInput,
} from './formal-runtime.ts'
import styles from './AuthGate.module.css'
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_MESSAGE, passwordPolicyError } from './password-policy.ts'

export type AuthGateSession = {
  account: FormalAccount
  signOut: () => Promise<void>
}

type AuthGateProps = {
  children: (session: AuthGateSession) => ReactNode
}

function field(form: FormData, name: string) {
  return rawField(form, name).trim()
}

function rawField(form: FormData, name: string) {
  return String(form.get(name) || '')
}

function listField(form: FormData, name: string) {
  return field(form, name)
    .split(/[,，\n]/)
    .map(value => value.trim())
    .filter(Boolean)
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export default function AuthGate({ children }: AuthGateProps) {
  const [checking, setChecking] = useState(true)
  const [account, setAccount] = useState<FormalAccount>()
  const [devLoginEnabled, setDevLoginEnabled] = useState(false)
  const [devAccounts, setDevAccounts] = useState<FormalDevAccount[]>([])
  const [devAccountsLoading, setDevAccountsLoading] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const probeSession = async () => {
    setChecking(true)
    setError('')
    try {
      const status = await getFormalAuthStatus()
      if (status.authenticated) {
        activateFormalIdentity(status)
        setAccount(status)
        setDevLoginEnabled(status.dev_test_login_enabled === true)
      } else {
        const isReviewEntry = typeof window !== 'undefined' && window.location.pathname === '/review'
        if (isReviewEntry) {
          const demo = await getFormalDemoStatus()
          if (demo.enabled) {
            const demoAccount = await loginFormalDemoAccount()
            setAccount(demoAccount)
            setDevLoginEnabled(false)
            return
          }
        }
        invalidateFormalIdentity()
        setAccount(undefined)
        setDevLoginEnabled(status.dev_test_login_enabled === true)
      }
    } catch (probeError) {
      invalidateFormalIdentity()
      setAccount(undefined)
      setError(errorMessage(probeError, '无法连接 LearnFlow 认证服务'))
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void probeSession()
  }, [])

  useEffect(() => {
    const handleUnauthorized = () => {
      invalidateFormalIdentity()
      setAccount(undefined)
      setChecking(false)
      setBusy(false)
      setMode('login')
      setDevLoginEnabled(false)
      setError('登录已失效，请重新登录。')
    }
    window.addEventListener('learnflow:unauthorized', handleUnauthorized)
    return () => window.removeEventListener('learnflow:unauthorized', handleUnauthorized)
  }, [])

  useEffect(() => {
    if (!devLoginEnabled || account) {
      setDevAccounts([])
      return
    }
    let active = true
    setDevAccountsLoading(true)
    listFormalDevAccounts()
      .then(accounts => {
        if (active) setDevAccounts(accounts)
      })
      .catch(loadError => {
        if (active) setError(errorMessage(loadError, '开发账号加载失败'))
      })
      .finally(() => {
        if (active) setDevAccountsLoading(false)
      })
    return () => { active = false }
  }, [devLoginEnabled, Boolean(account)])

  const authenticate = (nextAccount: FormalAccount) => {
    setError('')
    setAccount(nextAccount)
    setDevLoginEnabled(nextAccount.dev_test_login_enabled === true)
  }

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      authenticate(await loginFormalAccount(field(data, 'username'), rawField(data, 'password')))
    } catch (loginError) {
      setError(errorMessage(loginError, '登录失败'))
    } finally {
      setBusy(false)
    }
  }

  const submitRegistration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const password = rawField(data, 'password')
    const policyError = passwordPolicyError(password)
    if (policyError) {
      setError(policyError)
      return
    }
    if (password !== rawField(data, 'password_confirmation')) {
      setError('两次输入的密码不一致。')
      return
    }
    const focusAreas = listField(data, 'focus_areas')
    const preferredModes = listField(data, 'preferred_modes')
    if (focusAreas.length === 0 || preferredModes.length === 0) {
      setError('请至少填写一个关注方向和一种偏好的学习方式。')
      return
    }
    const input: FormalRegistrationInput = {
      username: field(data, 'username'),
      password,
      display_name: field(data, 'display_name'),
      education_stage: field(data, 'education_stage') as FormalRegistrationInput['education_stage'],
      background: field(data, 'background'),
      focus_areas: focusAreas,
      weekly_hours: Number(field(data, 'weekly_hours')),
      preferred_modes: preferredModes,
      career_goal: field(data, 'career_goal'),
      career_goal_status: 'exploring',
    }
    setBusy(true)
    setError('')
    try {
      authenticate(await registerFormalAccount(input))
    } catch (registrationError) {
      setError(errorMessage(registrationError, '注册失败'))
    } finally {
      setBusy(false)
    }
  }

  const useDevAccount = async (accountId: number) => {
    setBusy(true)
    setError('')
    try {
      authenticate(await loginFormalDevAccount(accountId))
    } catch (devError) {
      setError(errorMessage(devError, '开发账号登录失败'))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await logoutFormalAccount()
    setAccount(undefined)
    setDevLoginEnabled(false)
    setMode('login')
    setError('')
    await probeSession()
  }

  if (checking) {
    return (
      <main className={styles.shell} aria-busy="true">
        <section className={styles.loadingCard}>
          <span className={styles.brandMark}>LF</span>
          <h1>正在确认你的学习空间</h1>
          <p>身份确认后才会读取对应 learner 的本地缓存与正式学习状态。</p>
        </section>
      </main>
    )
  }

  if (account) return children({ account, signOut })

  return (
    <main className={styles.shell}>
      <section className={styles.hero}>
        <div className={styles.brand}><span className={styles.brandMark}>LF</span><strong>LearnFlow</strong></div>
        <p className={styles.eyebrow}>你的专属学习空间</p>
        <h1>每个账号，一段独立的学习旅程。</h1>
        <p className={styles.heroCopy}>从一次提问到一段长期计划，LearnFlow 会陪你延续理解、练习与成长。</p>
        <div className={styles.securityNote}><span>↗</span><p><strong>学习记录只属于你</strong><small>登录后继续上一次学习，不同账号彼此独立。</small></p></div>
      </section>

      <section className={styles.card} aria-labelledby="auth-title">
        <div className={styles.tabs} role="tablist" aria-label="账号入口">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? styles.activeTab : ''} onClick={() => { setMode('login'); setError('') }}>登录</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? styles.activeTab : ''} onClick={() => { setMode('register'); setError('') }}>注册</button>
        </div>

        {mode === 'login' ? (
          <form className={styles.form} onSubmit={submitLogin}>
            <header><p className={styles.eyebrow}>WELCOME BACK</p><h2 id="auth-title">继续你的学习</h2><span>输入账号与密码。LearnFlow 不再自动选择开发学习者。</span></header>
            <label><span>用户名</span><input name="username" autoComplete="username" required maxLength={32} autoFocus /></label>
            <label><span>密码</span><input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <button className={styles.primary} type="submit" disabled={busy}>{busy ? '正在登录…' : '登录 LearnFlow'}</button>
          </form>
        ) : (
          <form className={styles.form} onSubmit={submitRegistration}>
            <header><p className={styles.eyebrow}>创建账号</p><h2 id="auth-title">建立独立学习档案</h2><span>填写基本信息，创建你的专属学习空间。</span></header>
            <div className={styles.grid}>
              <label><span>用户名</span><input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern={"[A-Za-z0-9_\\-]+"} title="仅支持字母、数字、下划线和连字符" /></label>
              <label><span>显示名称</span><input name="display_name" autoComplete="name" required maxLength={40} /></label>
              <label><span>学习阶段</span><select name="education_stage" defaultValue="working" required><option value="middle_school">初中</option><option value="high_school">高中</option><option value="undergraduate">本科</option><option value="graduate">研究生</option><option value="working">工作中</option><option value="other">其他</option></select></label>
              <label><span>每周学习小时</span><input name="weekly_hours" type="number" defaultValue="5" min={1} max={80} required /></label>
            </div>
            <label><span>当前背景</span><textarea name="background" required maxLength={500} placeholder="例如：有 Python 基础，正在系统学习 Agent 工程" /></label>
            <label><span>关注方向</span><input name="focus_areas" required placeholder="用逗号分隔，例如：Agent、后端工程" /></label>
            <label><span>偏好的学习方式</span><input name="preferred_modes" required defaultValue="讲解，练习" /></label>
            <label><span>职业目标（可选）</span><input name="career_goal" maxLength={200} placeholder="可以稍后在画像中完善" /></label>
            <div className={styles.grid}>
              <label><span>密码</span><input name="password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={128} title={PASSWORD_POLICY_MESSAGE} /></label>
              <label><span>确认密码</span><input name="password_confirmation" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={128} title={PASSWORD_POLICY_MESSAGE} /></label>
            </div>
            <p className={styles.passwordHint}>{PASSWORD_POLICY_MESSAGE}</p>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <button className={styles.primary} type="submit" disabled={busy}>{busy ? '正在创建…' : '创建账号并进入'}</button>
          </form>
        )}

        {devLoginEnabled ? (
          <aside className={styles.devAccounts} aria-label="开发账号">
            <div><strong>开发账号</strong><span>后端 auth status 已明确启用</span></div>
            {devAccountsLoading ? <p>正在读取开发账号…</p> : devAccounts.map(devAccount => (
              <button type="button" key={devAccount.id} disabled={busy} onClick={() => { void useDevAccount(devAccount.id) }}>
                <span>{devAccount.display_name}</span><small>@{devAccount.username}</small>
              </button>
            ))}
          </aside>
        ) : null}

        <button type="button" className={styles.retry} onClick={() => { void probeSession() }}>重新检查会话</button>
      </section>
    </main>
  )
}
