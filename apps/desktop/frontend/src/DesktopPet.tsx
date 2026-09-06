import { lazy, Suspense, type ChangeEvent, type ClipboardEvent, type FormEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'

import {
  actOnFormalLearningSkillRun,
  actOnFormalLearningTask,
  confirmFormalDesktopPetContext,
  createFormalDesktopPetContext,
  createFormalDesktopPetImageContext,
  deleteFormalDesktopPetContext,
  loadFormalDesktopPetBootstrap,
  loadFormalTutorSession,
  transcribeFormalDesktopPetSelection,
  type FormalDesktopPetBootstrap,
  type FormalDesktopPetContext,
  type FormalLearningTask,
  type FormalTutorMessage,
  type FormalTutorSession,
} from './formal-runtime.ts'
import { readDesktopPetSession, runtimeFetch } from './runtime-client.ts'
import PetAvatar, { type PetAvatarState } from './PetAvatar.tsx'
import styles from './DesktopPet.module.css'

const MarkdownContent = lazy(() => import('./MarkdownContent.tsx'))

type PetMessage = Pick<FormalTutorMessage, 'role' | 'content' | 'created_at'> & { id: number | string }

type PetOutbox = {
  sessionId: number
  clientTurnId: string
  content: string
  contextRefs: string[]
}

type PastedImage = {
  file: File
  previewUrl: string
  clientContextId: string
}

type DesktopPetSelectionCapture = {
  imageBase64: string
  mimeType: string
  sourceLabel: string
  text?: string | null
}

type DesktopPetPreferences = {
  schemaVersion: number
  appearance: 'mist' | 'warm' | 'dusk'
  shortcut: string
  reviewRemindersEnabled: boolean
  reviewReminderIntervalMinutes: 15 | 30 | 60
  mouseThrough: boolean
  edgeAutoHide: boolean
  geometry?: { x: number; y: number; width: number; height: number } | null
}

const DEFAULT_PET_SHORTCUT = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  ? 'Command+Option+P'
  : 'Ctrl+Alt+P'

const PET_SHORTCUT_OPTIONS = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  ? [
      ['Command+Option+P', '⌘ + ⌥ + P'],
      ['Command+Shift+P', '⌘ + ⇧ + P'],
      ['Option+Shift+P', '⌥ + ⇧ + P'],
    ]
  : [
      ['Ctrl+Alt+P', 'Ctrl + Alt + P'],
      ['Ctrl+Shift+P', 'Ctrl + Shift + P'],
      ['Alt+Shift+P', 'Alt + Shift + P'],
    ]

const OUTBOX_STORAGE_KEY = 'learnflow.desktop.pet.outbox.v1'
const PET_VIEW_STORAGE_KEY = 'learnflow.desktop.pet.view.v1'
const DEFAULT_CONTEXT_LABEL = '用户主动粘贴的外部参考'
const MAX_CONTEXT_CHARS = 12_000
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function isSupportedImage(file: File) {
  return SUPPORTED_IMAGE_TYPES.has(file.type)
    || (!file.type && /\.(png|jpe?g|webp)$/i.test(file.name))
}

type DesktopPetNavigationAck = {
  requestId: string
  path: string
  accepted: boolean
}

async function createNavigationAckWaiter(requestId: string) {
  const { listen } = await import('@tauri-apps/api/event')
  let unlisten: (() => void) | undefined
  let timeout: number | undefined
  let settle: ((value: DesktopPetNavigationAck) => void) | undefined
  let reject: ((reason?: unknown) => void) | undefined
  const response = new Promise<DesktopPetNavigationAck>((resolve, rejectRequest) => {
    settle = resolve
    reject = rejectRequest
  })
  unlisten = await listen<DesktopPetNavigationAck>('learnflow:desktop-pet-navigation-ack', event => {
    if (event.payload?.requestId !== requestId) return
    if (timeout !== undefined) window.clearTimeout(timeout)
    unlisten?.()
    settle?.(event.payload)
  })
  timeout = window.setTimeout(() => {
    unlisten?.()
    reject?.(new Error('主窗口未确认页面定位，请稍后重试。'))
  }, 4_000)
  return {
    response,
    dispose() {
      if (timeout !== undefined) window.clearTimeout(timeout)
      unlisten?.()
    },
  }
}

function newTurnId() {
  return `desktop-pet-turn:${crypto.randomUUID()}`
}

function displayError(error: unknown) {
  return error instanceof Error && error.message ? error.message : '桌宠暂时无法连接，请稍后重试。'
}

function base64File(base64: string, mimeType: string, filename: string) {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], filename, { type: mimeType })
}

function readOutbox(): PetOutbox | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(OUTBOX_STORAGE_KEY) || 'null') as Partial<PetOutbox> | null
    if (!value || !Number.isInteger(value.sessionId) || !value.clientTurnId || !value.content) return null
    return {
      sessionId: Number(value.sessionId),
      clientTurnId: String(value.clientTurnId),
      content: String(value.content),
      contextRefs: Array.isArray(value.contextRefs) ? value.contextRefs.map(String).slice(0, 3) : [],
    }
  } catch {
    return null
  }
}

function saveOutbox(outbox: PetOutbox | null) {
  try {
    if (outbox) sessionStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(outbox))
    else sessionStorage.removeItem(OUTBOX_STORAGE_KEY)
  } catch {
  }
}

function taskAction(task: FormalLearningTask) {
  if (task.status === 'queued' && task.available_actions.includes('start')) return 'start' as const
  if (task.status === 'active' && task.available_actions.includes('pause')) return 'pause' as const
  if (task.status === 'paused' && task.available_actions.includes('resume')) return 'resume' as const
  return undefined
}

function taskActionLabel(action: 'start' | 'pause' | 'resume') {
  return action === 'start' ? '开始' : action === 'pause' ? '暂停' : '恢复'
}

function subtitleTranscript(raw: string) {
  return raw.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line
      && !/^\d+$/.test(line)
      && !/^\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(line)
      && line !== 'WEBVTT'
      && !line.startsWith('NOTE'))
    .join('\n')
    .slice(0, MAX_CONTEXT_CHARS)
    .trim()
}

export default function DesktopPet() {
  const [bootstrap, setBootstrap] = useState<FormalDesktopPetBootstrap>()
  const [session, setSession] = useState<FormalTutorSession>()
  const [messages, setMessages] = useState<PetMessage[]>([])
  const [draft, setDraft] = useState('')
  const [contexts, setContexts] = useState<FormalDesktopPetContext[]>([])
  const [status, setStatus] = useState('正在连接你的 LearnFlow 会话…')
  const [pending, setPending] = useState(false)
  const [busyKey, setBusyKey] = useState('')
  const [preferences, setPreferences] = useState<DesktopPetPreferences>()
  const [preferencesOpen, setPreferencesOpen] = useState(false)
  const [pastedImage, setPastedImage] = useState<PastedImage>()
  const [selectionText, setSelectionText] = useState('')
  const [selectionEditorOpen, setSelectionEditorOpen] = useState(false)
  const [compactView, setCompactView] = useState(() => {
    try { return localStorage.getItem(PET_VIEW_STORAGE_KEY) !== 'chat' } catch { return true }
  })
  const outbox = useRef<PetOutbox | null>(readOutbox())
  const activeSessionId = useRef<number | undefined>(undefined)
  const requestedSessionId = useRef<number | undefined>(undefined)
  const contextStore = useRef<FormalDesktopPetContext[]>([])
  const turnAbortController = useRef<AbortController | undefined>(undefined)
  const preferencesStore = useRef<DesktopPetPreferences>()
  const pastedImageStore = useRef<PastedImage>()
  const selectionTextStore = useRef('')
  const lastReviewNotification = useRef(0)
  const documentInput = useRef<HTMLInputElement>(null)
  const subtitleInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    contextStore.current = contexts
  }, [contexts])

  useEffect(() => {
    preferencesStore.current = preferences
  }, [preferences])

  const clearPastedImage = () => {
    const current = pastedImageStore.current
    if (current) URL.revokeObjectURL(current.previewUrl)
    pastedImageStore.current = undefined
    setPastedImage(undefined)
  }

  const clearSelectionText = () => {
    selectionTextStore.current = ''
    setSelectionText('')
    setSelectionEditorOpen(false)
  }

  const replacePastedImage = (file: File) => {
    const current = pastedImageStore.current
    if (current) URL.revokeObjectURL(current.previewUrl)
    const next = {
      file,
      previewUrl: URL.createObjectURL(file),
      clientContextId: `desktop-pet-image:${crypto.randomUUID()}`,
    }
    pastedImageStore.current = next
    setPastedImage(next)
  }

  const attachImage = (file: File) => {
    if (!isSupportedImage(file)) {
      setStatus('图片仅支持 PNG、JPEG 或 WebP。')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setStatus('图片不能超过 12 MB。')
      return
    }
    replacePastedImage(file)
    setStatus('图片已附加；点击发送时将由视觉模型理解，并仅用于本次正式对话。')
  }

  useEffect(() => () => {
    const current = pastedImageStore.current
    if (current) URL.revokeObjectURL(current.previewUrl)
  }, [])

  const startWindowDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    void getCurrentWindow().startDragging().catch(() => undefined)
  }

  const setPetView = (compact: boolean) => {
    if (compact) clearSelectionText()
    setCompactView(compact)
    try { localStorage.setItem(PET_VIEW_STORAGE_KEY, compact ? 'avatar' : 'chat') } catch {
    }
    void getCurrentWindow().setSize(new LogicalSize(
      compact ? 186 : 360,
      compact ? 220 : 520,
    )).catch(() => undefined)
  }

  useEffect(() => {
    if (compactView) {
      void getCurrentWindow().setSize(new LogicalSize(186, 220)).catch(() => undefined)
    }
  }, [])

  const captureDesktopSelection = async () => {
    if (!session || pending || busyKey) return
    setBusyKey('context:selection')
    setStatus('正在读取当前选中文字…')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const capture = await invoke<DesktopPetSelectionCapture>('capture_desktop_pet_selection')
      const nativeText = capture.text?.trim()
      if (nativeText) {
        if (compactView) setPetView(false)
        selectionTextStore.current = nativeText
        setSelectionText(nativeText)
        setSelectionEditorOpen(false)
        setStatus(`已从当前窗口直接读取 ${nativeText.length} 个字符，点击提示可编辑。`)
        return
      }
      if (!capture.imageBase64) throw new Error('前台窗口抓取结果为空。')
      setStatus('正在识别当前窗口中的选中文字…')
      const file = base64File(capture.imageBase64, capture.mimeType || 'image/png', 'desktop-selection.png')
      const result = await transcribeFormalDesktopPetSelection(file)
      const text = result.text.trim()
      if (!text) throw new Error('未识别到系统高亮文字。')
      if (compactView) setPetView(false)
      selectionTextStore.current = text
      setSelectionText(text)
      setSelectionEditorOpen(false)
      setStatus(`视觉识别到 ${text.length} 个字符，点击提示可编辑。若内容不完整，请确认原应用允许复制。`)
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        unlisten = await listen('learnflow:desktop-pet-selection-capture-requested', () => {
          void captureDesktopSelection()
        })
      })
      .catch(() => undefined)
    return () => { unlisten?.() }
  }, [compactView, session?.id, pending, busyKey])

  const loadSession = async (sessionId: number, nextBootstrap?: FormalDesktopPetBootstrap) => {
    const selected = await loadFormalTutorSession(sessionId)
    activeSessionId.current = sessionId
    setSession(selected)
    setMessages((selected.messages || []).slice(-8))
    setStatus(nextBootstrap?.model.status === 'unavailable' ? '模型暂不可用，请到主窗口配置。' : '')
  }

  const notifyDueReviews = async (nextBootstrap: FormalDesktopPetBootstrap) => {
    const currentPreferences = preferencesStore.current
    const due = nextBootstrap.review.due
    if (!currentPreferences?.reviewRemindersEnabled || due < 1) return
    const now = Date.now()
    const interval = currentPreferences.reviewReminderIntervalMinutes * 60 * 1000
    if (now - lastReviewNotification.current < interval) return
    try {
      const { isPermissionGranted, sendNotification } = await import('@tauri-apps/plugin-notification')
      if (!await isPermissionGranted()) return
      const focusSubjects = nextBootstrap.review.focus_subjects.slice(0, 2).map(item => item.subject).join('、')
      sendNotification({
        title: 'LearnFlow 复习提醒',
        body: focusSubjects
          ? `你有 ${due} 项到期复习，优先巩固：${focusSubjects}。`
          : `你有 ${due} 项到期复习。打开 LearnFlow 的“复习与错题”继续。`,
      })
      lastReviewNotification.current = now
    } catch {
    }
  }

  const clearSessionScopedState = async (nextSessionId?: number) => {
    turnAbortController.current?.abort()
    clearPastedImage()
    clearSelectionText()
    const removable = contextStore.current.map(item => item.id)
    await Promise.all(removable.map(id => deleteFormalDesktopPetContext(id).catch(() => undefined)))
    contextStore.current = []
    setContexts([])
    if (outbox.current?.sessionId !== nextSessionId) {
      outbox.current = null
      saveOutbox(null)
    }
  }

  const refresh = async (reloadCurrentSession = true) => {
    const next = await loadFormalDesktopPetBootstrap()
    setBootstrap(next)
    void notifyDueReviews(next)
    const previousSessionId = activeSessionId.current
    const targetId = requestedSessionId.current
    if (!targetId) {
      await clearSessionScopedState()
      activeSessionId.current = undefined
      setSession(undefined)
      setMessages([])
      setStatus('请先在 LearnFlow 主窗口打开正式 Tutor 会话。')
      return
    }
    if (previousSessionId !== targetId) {
      await clearSessionScopedState(targetId)
      activeSessionId.current = undefined
    }
    if (!reloadCurrentSession && previousSessionId === targetId) {
      if (next.model.status === 'unavailable') setStatus('模型暂不可用，请到主窗口配置。')
      return
    }
    try {
      await loadSession(targetId, next)
    } catch (error) {
      if (requestedSessionId.current !== targetId) return
      activeSessionId.current = undefined
      setSession(undefined)
      setMessages([])
      setStatus(`主窗口当前正式会话不可用：${displayError(error)}`)
    }
  }

  useEffect(() => {
    let active = true
    void readDesktopPetSession()
      .then(sessionId => {
        if (!active) return
        requestedSessionId.current = sessionId
        return refresh()
      })
      .catch(error => {
        if (active) setStatus(displayError(error))
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!preferences?.reviewRemindersEnabled) return
    const interval = window.setInterval(() => {
      void refresh(false).catch(() => undefined)
    }, preferences.reviewReminderIntervalMinutes * 60 * 1000)
    return () => window.clearInterval(interval)
  }, [preferences?.reviewRemindersEnabled, preferences?.reviewReminderIntervalMinutes])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/core')
      .then(async ({ invoke }) => {
        const loaded = await invoke<DesktopPetPreferences>('desktop_pet_preferences')
        setPreferences(loaded)
        await invoke('restore_desktop_pet_geometry').catch(() => undefined)
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<DesktopPetPreferences>('learnflow:desktop-pet-preferences-updated', event => {
          setPreferences(event.payload)
        })
      })
      .catch(() => undefined)
    return () => { unlisten?.() }
  }, [])

  useEffect(() => {
    let unlistenUpdated: (() => void) | undefined
    let unlistenCleared: (() => void) | undefined
    let unlistenSession: (() => void) | undefined
    let unlistenHidden: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        unlistenUpdated = await listen('learnflow:pet-identity-updated', () => {
          void refresh(false).catch(error => setStatus(displayError(error)))
        })
        unlistenSession = await listen<number | null>('learnflow:desktop-pet-session-updated', event => {
          requestedSessionId.current = Number.isSafeInteger(event.payload) && Number(event.payload) > 0
            ? Number(event.payload)
            : undefined
          void refresh().catch(error => setStatus(displayError(error)))
        })
        unlistenCleared = await listen('learnflow:pet-identity-cleared', () => {
          requestedSessionId.current = undefined
          turnAbortController.current?.abort()
          outbox.current = null
          saveOutbox(null)
          setBootstrap(undefined)
          setSession(undefined)
          setMessages([])
          setContexts([])
          clearPastedImage()
          clearSelectionText()
          setStatus('请先在 LearnFlow 主窗口登录。')
        })
        unlistenHidden = await listen('learnflow:desktop-pet-hidden', () => {
          clearSelectionText()
        })
      })
      .catch(() => undefined)
    return () => {
      unlistenUpdated?.()
      unlistenCleared?.()
      unlistenSession?.()
      unlistenHidden?.()
    }
  }, [])

  const runTaskAction = async (task: FormalLearningTask) => {
    const action = taskAction(task)
    if (!action) return
    setBusyKey(`task:${task.id}`)
    try {
      const updated = await actOnFormalLearningTask(task, action)
      setBootstrap(previous => previous ? {
        ...previous,
        tasks: previous.tasks.map(item => item.id === updated.id ? updated : item),
      } : previous)
      setStatus(`任务已${taskActionLabel(action)}，学习状态仍由正式任务运行时维护。`)
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const runSkillAction = async (action: 'pause' | 'resume') => {
    const run = session?.active_skill_run
    if (!session || !run) return
    setBusyKey(`skill:${action}`)
    try {
      const result = await actOnFormalLearningSkillRun(session.id, run, action)
      setSession(previous => previous ? { ...previous, active_skill_run: result.active_skill_run } : previous)
      setStatus(`学习方法已${action === 'pause' ? '暂停' : '恢复'}。`)
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const createContext = async () => {
    const content = draft.trim()
    if (!content) return
    setBusyKey('context:create')
    try {
      const created = await createFormalDesktopPetContext({ content, sourceLabel: DEFAULT_CONTEXT_LABEL })
      setContexts(previous => [...previous, created])
      setDraft('')
      setStatus('')
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const pasteScreenshot = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = [...event.clipboardData.items].find(item => item.kind === 'file' && item.type.startsWith('image/'))
    const file = imageItem?.getAsFile()
    if (!file) return
    event.preventDefault()
    attachImage(file)
  }

  const selectImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) attachImage(file)
  }

  const createPastedImageContext = async () => {
    const current = pastedImageStore.current
    if (!current || !session) return undefined
    const created = await createFormalDesktopPetImageContext({
      file: current.file,
      questionHint: draft.trim().slice(0, 600),
      clientContextId: current.clientContextId,
    })
    clearPastedImage()
    return created
  }

  const importDocumentExcerpt = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !session) return
    setBusyKey('context:document')
    try {
      const form = new FormData()
      form.append('file', file, file.name)
      const response = await runtimeFetch('/api/pet/context-packages/document', {
        method: 'POST',
        body: form,
      })
      const payload = await response.json().catch(() => null) as (FormalDesktopPetContext & { detail?: unknown }) | null
      if (!response.ok || !payload?.id) {
        const detail = payload?.detail
        const message = typeof detail === 'string'
          ? detail
          : detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string'
            ? String((detail as { message: string }).message)
            : `文档摘录返回 HTTP ${response.status}`
        throw new Error(message)
      }
      setContexts(previous => [...previous, payload])
      setStatus('已生成文档摘录，请确认后才会作为本次 Tutor 回合的参考。')
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const importVideoTranscript = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !session) return
    if (file.size > 2 * 1024 * 1024) {
      setStatus('字幕文件不能超过 2 MB。')
      return
    }
    setBusyKey('context:subtitle')
    try {
      const content = subtitleTranscript(await file.text())
      if (!content) throw new Error('字幕文件没有可用文字。')
      const created = await createFormalDesktopPetContext({
        kind: 'video_transcript',
        content,
        sourceLabel: `用户主动选择的视频字幕 · ${file.name}`,
        capturedAt: new Date().toISOString(),
      })
      setContexts(previous => [...previous, created])
      setStatus('已生成视频字幕预览，请确认后才会作为本次 Tutor 回合的参考。')
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const confirmContext = async (context: FormalDesktopPetContext) => {
    if (!session) return
    setBusyKey(`context:${context.id}`)
    try {
      const confirmed = await confirmFormalDesktopPetContext(context.id, session.id)
      setContexts(previous => previous.map(item => item.id === context.id ? confirmed : item))
      setStatus('')
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const removeContext = async (context: FormalDesktopPetContext) => {
    setBusyKey(`context:${context.id}`)
    try {
      await deleteFormalDesktopPetContext(context.id)
      setContexts(previous => previous.filter(item => item.id !== context.id))
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const updatePreferences = async (update: Partial<Pick<DesktopPetPreferences, 'appearance' | 'shortcut' | 'mouseThrough' | 'edgeAutoHide'>>) => {
    setBusyKey('preferences:update')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const next = await invoke<DesktopPetPreferences>('update_desktop_pet_preferences', { update })
      setPreferences(next)
      setStatus(update.mouseThrough
        ? '鼠标穿透已开启；可从托盘菜单恢复桌宠鼠标交互。'
        : '桌宠本机设置已保存。')
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const updateReviewReminders = async (enabled: boolean, interval?: DesktopPetPreferences['reviewReminderIntervalMinutes']) => {
    setBusyKey('preferences:reminders')
    try {
      if (enabled && !preferences?.reviewRemindersEnabled) {
        const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification')
        const granted = await isPermissionGranted() || await requestPermission() === 'granted'
        if (!granted) {
          setStatus('系统未授予通知权限，因此未启用复习提醒。')
          return
        }
      }
      const { invoke } = await import('@tauri-apps/api/core')
      const next = await invoke<DesktopPetPreferences>('update_desktop_pet_preferences', {
        update: {
          reviewRemindersEnabled: enabled,
          ...(interval ? { reviewReminderIntervalMinutes: interval } : {}),
        },
      })
      setPreferences(next)
      setStatus(enabled ? '复习提醒已开启；只提示到期项，不改变掌握度。' : '复习提醒已关闭。')
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const resetPosition = async () => {
    setBusyKey('preferences:reset')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const next = await invoke<DesktopPetPreferences>('reset_desktop_pet_geometry')
      setPreferences(next)
      setStatus('已清除保存的位置和尺寸；下次打开桌宠会使用默认窗口。')
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const openFormalWorkbench = async (path: '/review' | '/tasks', statusText: string) => {
    setBusyKey(`navigation:${path}`)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const requestId = `desktop-pet-navigation:${crypto.randomUUID()}`
      const acknowledgement = await createNavigationAckWaiter(requestId)
      try {
        await invoke('open_desktop_main_path', { path, requestId })
        const result = await acknowledgement.response
        if (!result.accepted) throw new Error('主窗口无法定位请求的 LearnFlow 页面。')
      } finally {
        acknowledgement.dispose()
      }
      setStatus(statusText)
    } catch (error) {
      setStatus(displayError(error))
    } finally {
      setBusyKey('')
    }
  }

  const openFormalReview = () => openFormalWorkbench('/review', '已在 LearnFlow 主窗口打开正式复习。')

  const openFormalTasks = () => openFormalWorkbench('/tasks', '已在 LearnFlow 主窗口打开正式学习任务。')

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!session || pending) return
    const retry = outbox.current?.sessionId === session.id ? outbox.current : null
    const content = (retry?.content || draft).trim()
    if (!content && !pastedImageStore.current) return
    let imageContext: FormalDesktopPetContext | undefined
    let selectionContext: FormalDesktopPetContext | undefined
    if (!retry && pastedImageStore.current) {
      setBusyKey('context:image')
      setPending(true)
      setStatus('正在理解附加图片…')
      try {
        const created = await createPastedImageContext()
        if (created) {
          setContexts(previous => previous.some(item => item.id === created.id) ? previous : [...previous, created])
          const confirmed = await confirmFormalDesktopPetContext(created.id, session.id)
          imageContext = confirmed
          setContexts(previous => previous.map(item => item.id === confirmed.id ? confirmed : item))
        }
      } catch (error) {
        setStatus(displayError(error))
        return
      } finally {
        setBusyKey('')
        setPending(false)
      }
    }
    if (!retry && selectionTextStore.current.trim()) {
      setBusyKey('context:selection')
      setPending(true)
      setStatus('正在准备选中文字…')
      try {
        const created = await createFormalDesktopPetContext({
          kind: 'ocr_text',
          content: selectionTextStore.current,
          sourceLabel: '用户主动抓取的系统高亮文字',
        })
        selectionContext = await confirmFormalDesktopPetContext(created.id, session.id)
      } catch (error) {
        setStatus(displayError(error))
        return
      } finally {
        setBusyKey('')
        setPending(false)
      }
    }
    const contextRefs = retry?.contextRefs || [
      ...(selectionContext ? [selectionContext.id] : []),
      ...(imageContext ? [imageContext.id] : []),
      ...contexts.filter(item => item.status === 'confirmed').map(item => item.id),
    ].filter((item, index, all) => all.indexOf(item) === index).slice(0, 3)
    const message = content || '请分析我附上的图片。'
    const turn = retry || {
      sessionId: session.id,
      clientTurnId: newTurnId(),
      content: message,
      contextRefs,
    }
    outbox.current = turn
    saveOutbox(turn)
    setMessages(previous => previous.some(item => item.id === turn.clientTurnId)
      ? previous
      : [...previous, { id: turn.clientTurnId, role: 'user', content: message, created_at: new Date().toISOString() }])
    setDraft('')
    setPending(true)
    setStatus('正在思考…')
    const sendingSessionId = session.id
    const abortController = new AbortController()
    turnAbortController.current = abortController
    try {
      const response = await runtimeFetch(`/api/agent/sessions/${sendingSessionId}/turns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          message,
          client_turn_id: turn.clientTurnId,
          context: { surface: 'desktop_pet' },
          context_refs: turn.contextRefs,
        }),
      })
      const payload = await response.json().catch(() => null) as { message?: unknown; detail?: unknown } | null
      const reply = payload?.message
      if (!response.ok || typeof reply !== 'string') {
        throw new Error(typeof payload?.detail === 'string' ? payload.detail : `Tutor 返回 HTTP ${response.status}`)
      }
      if (activeSessionId.current !== sendingSessionId) return
      setMessages(previous => previous.some(item => item.id === `${turn.clientTurnId}:reply`)
        ? previous
        : [...previous, { id: `${turn.clientTurnId}:reply`, role: 'assistant', content: reply, created_at: new Date().toISOString() }])
      setContexts(previous => previous.filter(item => !turn.contextRefs.includes(item.id)))
      clearSelectionText()
      if (outbox.current?.clientTurnId === turn.clientTurnId) {
        outbox.current = null
        saveOutbox(null)
      }
      setStatus('')
    } catch (error) {
      if (activeSessionId.current !== sendingSessionId) return
      setDraft(message)
      setStatus(`${displayError(error)} 可直接重试，本次回合会复用原幂等 ID。`)
    } finally {
      if (turnAbortController.current === abortController) turnAbortController.current = undefined
      setPending(false)
    }
  }

  const activeSkill = session?.active_skill_run
  const petVisualState: PetAvatarState = pending || busyKey === 'context:image'
    ? 'thinking'
    : status.includes('暂时无法') || status.includes('不可用') || status.includes('失败')
      ? 'error'
      : (bootstrap?.review.due || 0) > 0
        ? 'review_due'
        : bootstrap?.tasks.some(task => task.status === 'active') || Boolean(activeSkill)
          ? 'task_active'
          : 'idle'
  const compactCue = petVisualState === 'thinking'
    ? '正在思考…'
    : petVisualState === 'review_due'
      ? `有 ${bootstrap?.review.due || 0} 项待复习`
      : petVisualState === 'task_active'
        ? '正在陪你学习'
        : petVisualState === 'error'
          ? '点我查看状态'
          : session
            ? `选中文字后按 ${preferences?.shortcut || DEFAULT_PET_SHORTCUT}`
            : '点我聊聊'

  if (compactView) return <main className={`${styles.pet} ${styles.compactPet}`} data-appearance={preferences?.appearance || 'mist'}>
    <header className={styles.compactHeader} data-tauri-drag-region onPointerDown={startWindowDrag}>
      <strong data-tauri-drag-region>Flow</strong>
      <button type="button" onPointerDown={event => event.stopPropagation()} onClick={() => void import('@tauri-apps/api/core').then(({ invoke }) => invoke('close_desktop_pet'))} aria-label="隐藏桌宠">×</button>
    </header>
    <div className={styles.compactAvatar} onPointerDown={event => event.stopPropagation()}>
      <PetAvatar state={petVisualState} compact onClick={() => setPetView(false)} />
    </div>
    <button type="button" className={styles.compactCue} onClick={() => setPetView(false)}>{compactCue}</button>
  </main>

  return <main className={styles.pet} data-appearance={preferences?.appearance || 'mist'}>
    <header className={styles.header} data-tauri-drag-region onPointerDown={startWindowDrag}>
      <span onPointerDown={event => event.stopPropagation()}><PetAvatar state={petVisualState} onClick={() => setPetView(true)} /></span>
      <strong data-tauri-drag-region>Flow</strong>
      <div className={styles.headerActions}>
        <button type="button" className={styles.settingsButton} onPointerDown={event => event.stopPropagation()} onClick={() => setPreferencesOpen(value => !value)} aria-label="桌宠设置" aria-expanded={preferencesOpen}>⚙</button>
        <button type="button" onPointerDown={event => event.stopPropagation()} onClick={() => void import('@tauri-apps/api/core').then(({ invoke }) => invoke('close_desktop_pet'))} aria-label="隐藏桌宠">×</button>
      </div>
    </header>

    {preferencesOpen && <section className={styles.preferences} aria-label="桌宠本机设置">
      <label>外观
        <select value={preferences?.appearance || 'mist'} disabled={busyKey === 'preferences:update'} onChange={event => void updatePreferences({ appearance: event.target.value as DesktopPetPreferences['appearance'] })}>
          <option value="mist">云雾</option><option value="warm">暖光</option><option value="dusk">夜色</option>
        </select>
      </label>
      <label>快捷键
        <select value={preferences?.shortcut || DEFAULT_PET_SHORTCUT} disabled={busyKey === 'preferences:update'} onChange={event => void updatePreferences({ shortcut: event.target.value })}>
          {PET_SHORTCUT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className={styles.reminderPreference}>复习提醒
        <span><input type="checkbox" checked={preferences?.reviewRemindersEnabled || false} disabled={busyKey === 'preferences:reminders'} onChange={event => void updateReviewReminders(event.target.checked)} /> 到期时通知</span>
        <select value={preferences?.reviewReminderIntervalMinutes || 30} disabled={!preferences?.reviewRemindersEnabled || busyKey === 'preferences:reminders'} onChange={event => void updateReviewReminders(true, Number(event.target.value) as DesktopPetPreferences['reviewReminderIntervalMinutes'])}>
          <option value={15}>每 15 分钟</option><option value={30}>每 30 分钟</option><option value={60}>每小时</option>
        </select>
      </label>
      <label className={styles.reminderPreference}>窗口交互
        <span><input type="checkbox" checked={preferences?.edgeAutoHide || false} disabled={busyKey === 'preferences:update'} onChange={event => void updatePreferences({ edgeAutoHide: event.target.checked })} /> 贴边隐藏</span>
        <span><input type="checkbox" checked={preferences?.mouseThrough || false} disabled={busyKey === 'preferences:update'} onChange={event => void updatePreferences({ mouseThrough: event.target.checked })} /> 鼠标穿透</span>
      </label>
      <button type="button" disabled={busyKey === 'preferences:reset'} onClick={() => void resetPosition()}>重置位置和尺寸</button>
    </section>}

    {preferences?.reviewRemindersEnabled && bootstrap && (bootstrap.review.due > 0 || bootstrap.review.focus_subjects.length > 0) && <section className={styles.reviewReminder} aria-label="正式复习提醒">
      <div>
        <strong>{bootstrap.review.due > 0 ? `待复习 ${bootstrap.review.due} 项` : '需巩固主题'}</strong>
        {bootstrap.review.focus_subjects.length > 0 && <span>优先巩固：{bootstrap.review.focus_subjects.map(item => item.subject).join('、')}</span>}
      </div>
      <button type="button" disabled={busyKey === 'navigation:review'} onClick={() => void openFormalReview()}>去复习</button>
    </section>}

    {(bootstrap?.tasks.length || activeSkill) && <section className={styles.taskPanel} aria-label="任务陪伴">
      {bootstrap?.tasks.slice(0, 2).map(task => {
        const action = taskAction(task)
        return <article key={task.id} className={styles.taskCard}>
          <span>{task.status === 'active' ? '进行中' : task.status === 'paused' ? '已暂停' : '待开始'}</span>
          <button type="button" className={styles.taskTitle} disabled={busyKey === 'navigation:/tasks'} onClick={() => void openFormalTasks()}>{task.title}</button>
          {action && <button type="button" disabled={busyKey === `task:${task.id}`} onClick={() => void runTaskAction(task)}>{taskActionLabel(action)}</button>}
        </article>
      })}
      {activeSkill && <article className={styles.taskCard}>
        <span>{activeSkill.stage_label || '学习方法'}</span>
        <strong>{activeSkill.skill.name}</strong>
        {activeSkill.can_pause && <button type="button" disabled={busyKey === 'skill:pause'} onClick={() => void runSkillAction('pause')}>暂停</button>}
        {activeSkill.can_resume && <button type="button" disabled={busyKey === 'skill:resume'} onClick={() => void runSkillAction('resume')}>恢复</button>}
      </article>}
    </section>}

    {status && <p className={styles.status} role="status">{status}</p>}
    <section className={styles.messages} aria-live="polite">
      {messages.length === 0 && <p className={styles.empty}>直接输入问题；粘贴外部文字后可作为待确认引用，不会自动发送。</p>}
      {messages.map(message => <article key={`${message.id}-${message.role}`} className={message.role === 'user' ? styles.user : styles.assistant}>
        {message.role === 'assistant' ? <Suspense fallback={message.content}><MarkdownContent content={message.content} /></Suspense> : message.content}
      </article>)}
    </section>
    {contexts.length > 0 && <section className={styles.referenceTray} aria-label="待确认引用">
      {contexts.map(context => <article key={context.id} className={styles.contextChip}>
        <div><strong>{context.status === 'confirmed' ? '已确认引用' : '待确认预览'}</strong><span>{context.source_label || '外部参考'} · {context.content_length} 字</span><p>{context.preview}</p></div>
        <aside>
          {context.requires_confirmation && <button type="button" disabled={!session || busyKey === `context:${context.id}`} onClick={() => void confirmContext(context)}>确认引用</button>}
          <button type="button" disabled={busyKey === `context:${context.id}`} onClick={() => void removeContext(context)}>移除</button>
        </aside>
      </article>)}
    </section>}
    {pastedImage && <section className={styles.pastedImageTray} aria-label="本地截图预览">
      <img src={pastedImage.previewUrl} alt="待视觉理解的本地截图预览" />
      <div><strong>图片已附加</strong><span>发送即确认视觉理解，仅用于本次对话。</span></div>
      <button type="button" disabled={busyKey === 'context:image'} onClick={clearPastedImage} aria-label="移除附加图片">×</button>
    </section>}
    {selectionText && <section className={styles.selectionStatus} aria-label="已获取的选中文字">
      <button type="button" onClick={() => setSelectionEditorOpen(value => !value)}>
        已获取 {selectionText.length} 个字符{selectionEditorOpen ? '，收起' : '，点击编辑'}
      </button>
      {selectionEditorOpen && <div className={styles.selectionEditor}>
        <textarea value={selectionText} onChange={event => {
          selectionTextStore.current = event.target.value
          setSelectionText(event.target.value)
        }} aria-label="编辑选中文字" rows={4} />
        <button type="button" onClick={clearSelectionText}>清除</button>
      </div>}
    </section>}
    <form className={styles.composer} onSubmit={send}>
      <textarea value={draft} onChange={event => setDraft(event.target.value)} onPaste={pasteScreenshot} disabled={!session || pending} placeholder="输入消息…" rows={3} />
      <input ref={documentInput} className={styles.documentInput} type="file" accept=".pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv" onChange={event => void importDocumentExcerpt(event)} />
      <input ref={subtitleInput} className={styles.documentInput} type="file" accept=".srt,.vtt,.txt" onChange={event => void importVideoTranscript(event)} />
      <input ref={imageInput} className={styles.documentInput} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" onChange={selectImage} />
      <footer className={styles.composerFooter}>
        <details className={styles.attachmentMenu}>
          <summary aria-label="添加图片或参考" title="添加图片或参考">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 12.7 5.8-5.8a3.2 3.2 0 1 1 4.5 4.5l-7.7 7.7a5 5 0 0 1-7-7l7-7a3.2 3.2 0 0 1 4.5 4.5l-7 7a1.4 1.4 0 0 1-2-2l6.1-6.1" /></svg>
          </summary>
          <div className={styles.attachmentPopover}>
            <button type="button" disabled={!session || pending || busyKey === 'context:image'} onClick={() => imageInput.current?.click()}>添加图片</button>
            <button type="button" disabled={!session || pending || busyKey === 'context:document'} onClick={() => documentInput.current?.click()}>选择文档</button>
            <button type="button" disabled={!session || pending || busyKey === 'context:subtitle'} onClick={() => subtitleInput.current?.click()}>选择字幕</button>
            <button type="button" disabled={!draft.trim() || !session || pending || busyKey === 'context:create'} onClick={() => void createContext()}>将文字作为参考</button>
          </div>
        </details>
        <button className={styles.sendButton} type="submit" disabled={!(draft.trim() || pastedImage || outbox.current) || !session || pending} aria-label="发送消息" title="发送消息">
          {pending ? '…' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0L6.5 10.5M12 5l5.5 5.5" /></svg>}
        </button>
      </footer>
    </form>
  </main>
}
