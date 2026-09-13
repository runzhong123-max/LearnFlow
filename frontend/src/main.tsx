import PlanningResourceWorkbench from './PlanningResourceWorkbench'
import { UserAvatar, UserIdentity } from '../../packages/learning-client/src/identity/UserIdentity'
import { conversationTitle, recentConversations } from './conversation-display.ts'
import { readTabLayout, saveTabLayout, consumeLayoutReset, withoutTabLayout } from './workspace-layout.ts'
import { conversionMessagePresentation } from '../../packages/learning-client/src/work-task-conversion/presentation.ts'
import { taskLearningFiles, fileKindForStage, fileProgressMessage } from './learning-file-flow'
import { ecosystemEntryPath } from './ecosystem-entry.ts'
import { directVisualWorkflowCall } from '../../packages/learning-client/src/visuals/workflow.ts'
import { resolveExplicitVisualIntent } from '../server/visual-tool-execution.ts'
import { FormEvent, Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  initializeRuntimeClient,
  isolateLegacyWorkspaceCache,
  isDesktopRuntime,
  learnerWorkspaceStorageKey,
} from './runtime-client.ts'
import {
  isTutorMode,
  requestTutorReply,
  resolveTutorMode,
  TUTOR_MODE_LABELS,
  tutorConfigurationIssue,
  type TutorMode,
} from './tutor'
import {
  activeLearningTaskProjection,
  activateFormalLearningTask,
  restoreFormalSkillRunBinding,
  advanceLearningSkillStep,
  appendLearningEvents,
  bindFormalSkillRun,
  canAdvanceLearningSkillStep,
  createLearningTask,
  currentLearningSkillStep,
  isLearningSkillId,
  isSupportRequest,
  latestLearningTaskProjection,
  LEARNING_SKILLS,
  PRIMARY_LEARNING_SKILL_IDS,
  learningObjectiveFromInput,
  learningTaskTutorContext,
  nextLearningSkillStep,
  projectLearningTask,
  reconcileLearningEventsWithFormalSkillRun,
  switchLearningSkill,
  type LearningEvent,
  type LearningSkillId,
  type LearningSubstateId,
  type LearningTask,
  type LearningTaskProjection,
} from './learning'
import VisualArtifact from './VisualArtifact'
import PluginToolResultView from './PluginToolResultView'
import {
  PLUGIN_OBJECT_DRAG_TYPE,
  resolvePluginObjectDrop,
  pluginObjectContentKey,
  pluginObjectReferenceText,
  type LearnFlowPluginObject,
} from './plugin-api'
import PluginCapabilityPicker from './PluginCapabilityPicker'
import {
  activeConversationPluginIds,
  lockedConversationPluginIds,
  stickyConversationPluginIds,
} from './conversation-plugin-state.ts'
import { humanizeLearningFileReferences } from './learning-file-message'
import { detectHumanAdaptationSignals } from './human-adaptation'
import {
  type TutorToolChoice,
  type TutorToolRun,
} from './tooling'
import ComposerCapabilityPicker from './ComposerCapabilityPicker'
import AuthGate, { type AuthGateSession } from './AuthGate'
import AccountModelSettings from './AccountModelSettings'
import PersonalApiKeys from './PersonalApiKeys'
import { isIpAccountConsole } from './ip-account-console'
import {
  activeLearningPlanProjection,
  closeLearningPlan,
  createLearningPlan,
  decideValueClaimProposal,
  extractPlanningProfileSelfReport,
  learningPlanTutorContext,
  planningGoalSummary,
  planningKindLabel,
  projectLearningPlan,
  updateLearningPlan,
  type LearningPlan,
  type LearningPlanProjection,
  type PlanningEvent,
  type ValueProposalDecision,
} from './planning'
import {
  addPersonalPathNode,
  archiveLearningPathPlan,
  commitLearningPathPlan,
  createInitialLearnerPathState,
  projectLearnerPath,
  removePersonalPathNode,
  sanitizeLearnerPathState,
  setLearnerPathStatus,
  type LearnerPathState,
  type LearningPathPlanProposal,
  type LearnerPathStatus,
  type PersonalPathNodeProposal,
} from './learning-path-graph'
import {
  actOnFormalLearningSkillRun,
  actOnFormalLearningTask,
  addFormalProjectUrl,
  addKnowledgeLibraryUrl,
  advanceFormalLearningSkillTurn,
  addFormalPersonalPathNode,
  archiveFormalLearningPathPlan,
  applyFormalProjectRoadmap,
  bootstrapFormalRuntime,
  confirmFormalValueClaim,
  commitFormalLearningPathPlan,
  createFormalProject,
  consumeFormalRolePackageLaunch,
  createFormalTutorSession,
  createFormalProjectFreeSession,
  deleteFormalTutorSession,
  generateFormalLearningFiles,
  learnerPathStateFromFormal,
  loadFormalGlobalChatsForHydration,
  listFormalProjects,
  loadFormalProject,
  loadFormalTutorSession,
  loadFormalLearnerSnapshot,
  loadLearningFiles,
  removeFormalPersonalPathNode,
  recordFormalConceptStatement,
  recordLearningFileAccess,
  processKnowledgeLibrarySource,
  processFormalProjectSource,
  removeFormalProjectSource,
  reviseFormalProjectRoadmap,
  setFormalMemoryArchived,
  setFormalPathStatus,
  submitFormalClaimFeedback,
  startFormalLearningSkillRun,
  syncFormalGlobalChatWithRecovery,
  syncFormalEvent,
  syncFormalTeachingInput,
  syncFormalEvents,
  updateFormalLearnerProfile,
  uploadKnowledgeLibraryFile,
  uploadFormalProjectFile,
  type FormalLearnerProfilePatch,
  type FormalLearnerSnapshot,
  type FormalLearningTask,
  type FormalLearningTaskAction,
  type FormalLearningFileRef,
  type FormalLearningSkillRun,
  type FormalKnowledgeSource,
  type FormalRuntimeConnection,
  type FormalTutorMessage,
  type FormalTutorSession,
  clearFormalAvatar,
  listFormalModelCredentialModels,
  saveFormalAvatar,
} from './formal-runtime'
import { parseLearningTaskDraftConfirmation } from '../plugins/learning_task_conversion/intake.ts'
import type { AgentDecisionSummary, AgentTurnStreamEvent, AgentTurnTrace } from './agent-contracts'
import type { FormalProjectCheckpoint, FormalProjectWorkspace, ProjectLearningFileProposal, ProjectRoadmapProposal } from './project'
import { projectSidebarChats } from './project-sidebar'
import { buildTutorContextMessages, hasVisibleStudentMessage, recoverableTutorTurn } from './turn-recovery'
import { UiIcon } from './ui-icons'
import {
  deletePaperSheet,
  findPaperSheetByArtifact,
  paperArtifactKey,
  paperAncestorChain,
  sanitizePaperSheets,
  type PaperArtifact,
  type PaperSheet,
} from './paper-workbench'
import './styles.css'

type Message = {
  displayContent?: string
  id: string
  role: 'assistant' | 'user' | 'system'
  content: string
  createdAt: number
  tutorMode?: TutorMode
  toolRuns?: TutorToolRun[]
  /** Opaque provider payload required to continue some thinking-model conversations. */
  reasoningContent?: string
  agentTrace?: AgentTurnTrace
  decisionSummaries?: AgentDecisionSummary[]
  learningActionLabel?: string
  learningSkillId?: LearningSkillId
  learningSubstateId?: LearningSubstateId
  learningSubstateLabel?: string
  learningTaskId?: string
  formalTaskId?: number
  learningGoal?: string
  learningGoalKind?: 'learning_task' | 'planning_goal' | 'conversation_topic'
  persistedByTutor?: boolean
  streaming?: boolean
  streamingPhase?: string
  pluginResultProjection?: boolean
  /** Direct composer text, excluding attached plugin context; preserved for retries. */
  directUserText?: string
  teachingInputRecordedBySkillTurn?: boolean
  retryableTutorError?: boolean
  formalSkillSyncPending?: 'start' | 'advance'
  /** Internal control payload produced by an explicit plugin button click. */
  hiddenFromTranscript?: boolean
}

type LiveTurn = {
  sheetId: string
  messageId: string
  content: string
  committedContent: string
  toolRuns: TutorToolRun[]
  decisionSummaries: AgentDecisionSummary[]
  phase: string
  startedAt: number
}

type FollowUpSheet = PaperSheet<Message>

type PendingSheetDelete = {
  conversationId: string
  sheetId: string
  title: string
  childCount: number
}

type PaperDeskView = {
  conversationId: string
  mode: 'overview' | 'tree'
}

type Conversation = {
  id: string
  title: string
  /** Pinned conversations sort above the rest; absent means not pinned. */
  pinned?: boolean
  messages: Message[]
  updatedAt: number
  mode: TutorMode
  sheets: FollowUpSheet[]
  activeSheetId: string
  learningTasks: LearningTask[]
  learningEvents: LearningEvent[]
  preferredSkillId?: LearningSkillId
  learningPlans: LearningPlan[]
  planningEvents: PlanningEvent[]
  formalSessionId?: number
  domainSources: FormalKnowledgeSource[]
  projectSources: FormalProjectWorkspace['sources']
  projectId?: number
  checkpointId?: number
  projectRole?: 'tutor' | 'checkpoint' | 'free'
  pluginIds: string[]
}

type WorkspaceTab = {
  id: string
  kind: 'visual-hub' | 'chat' | 'settings' | 'projects' | 'project' | 'learning-path' | 'ecosystem' | 'profile' | 'tasks' | 'review' | 'learning-files' | 'lecture-file' | 'practice-file'
  title: string
  conversationId?: string
  originConversationId?: string
  originSheetId?: string
  fileRef?: string
  projectId?: number
}

type SettingsState = {
  baseUrl: string
  model: string
  /** Extra model names selectable per conversation. They share the account
      credential, so switching stays inside one provider unless the operator
      also updates the base URL. */
  modelProfiles?: string[]
}

type PersistedState = {
  conversations: Conversation[]
  tabs: WorkspaceTab[]
  activeTabId: string
  splitTabId: string
  settings: SettingsState
  learningPath: LearnerPathState
}

const VISUAL_HUB_TAB: WorkspaceTab = {id:'visual-hub',kind:'visual-hub',title:'图解与动画'}
const VisualHubPage = lazy(() => import('./VisualHubPage'))
const SETTINGS_TAB: WorkspaceTab = { id: 'settings', kind: 'settings', title: '设置' }
const PROJECTS_TAB: WorkspaceTab = { id: 'projects', kind: 'projects', title: '学习项目' }
const LEARNING_PATH_TAB: WorkspaceTab = { id: 'learning-path', kind: 'learning-path', title: '学习路径' }
const ECOSYSTEM_TAB: WorkspaceTab = { id: 'ecosystem', kind: 'ecosystem', title: '岗位图谱' }
const PROFILE_TAB: WorkspaceTab = { id: 'profile', kind: 'profile', title: '我的画像' }
const SIDEBAR_WIDTH_STORAGE_KEY = 'learnflow:sidebar-width'
const SIDEBAR_MIN_WIDTH = 220
const SIDEBAR_MAX_WIDTH = 380

function boundedSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Number.isFinite(value) ? value : 252))
}

/** One list drives both the key handler and the reference sheet, so a shortcut
 *  can never be documented differently from the way it actually behaves. */
const KEYBOARD_SHORTCUTS: Array<{ keys: string; label: string; group: string }> = [
  { group: '工作区', keys: 'Ctrl + N', label: '新建对话' },
  { group: '工作区', keys: 'Ctrl + W', label: '关闭当前标签页' },
  { group: '工作区', keys: 'Ctrl + B', label: '收起 / 展开侧栏' },
  { group: '工作区', keys: 'Ctrl + 1…9', label: '跳到第 N 个标签页' },
  { group: '工作区', keys: 'Ctrl + ,', label: '打开设置' },
  { group: '工作区', keys: 'Ctrl + /', label: '显示这份快捷键表' },
  { group: '输入框', keys: 'Enter', label: '发送消息' },
  { group: '输入框', keys: 'Shift + Enter', label: '换行' },
  { group: '通用', keys: 'Esc', label: '关闭弹出菜单或对话框' },
]
const TASKS_TAB: WorkspaceTab = { id: 'tasks', kind: 'tasks', title: '学习任务' }
const REVIEW_TAB: WorkspaceTab = { id: 'review', kind: 'review', title: '复习' }
const LEARNING_FILES_TAB: WorkspaceTab = { id: 'learning-files', kind: 'learning-files', title: '讲义与练习' }
const MarkdownContent = lazy(() => import('./MarkdownContent'))
const LearningFileMessagePreview = lazy(() => import('./LearningFileMessagePreview'))
const EcosystemPage = lazy(() => import('./EcosystemPage'))
const LearningPathPage = lazy(() => import('./LearningPathPage'))
const LearnerProfilePage = lazy(() => import('./LearnerProfilePage'))
const LearningTasksPage = lazy(() => import('./LearningTasksPage'))
const ReviewWorkbenchPage = lazy(() => import('./ReviewWorkbenchPage'))
const LearningFilesPage = lazy(() => import('./LearningFilesPage'))
const LectureFilePage = lazy(() => import('./LectureFilePage'))
const LearningVerificationPanel = lazy(() => import('./LearningVerificationPanel'))
const PracticeFilePage = lazy(() => import('./PracticeFilePage'))
const SourceFilePage = lazy(() => import('./SourceFilePage'))
const ProjectsPage = lazy(() => import('./ProjectsPage'))
const ProjectWorkspacePage = lazy(() => import('./ProjectWorkspacePage'))
const ProjectContextPanel = lazy(() => import('./ProjectContextPanel'))

function uid(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

function formalModeId(mode: TutorMode) {
  if (mode === 'simple_explain') return 'explain'
  if (mode === 'guided_learning') return 'learn'
  if (mode === 'learning_plan') return 'plan'
  return 'free'
}

function createConversation(): Conversation {
  const now = Date.now()
  return {
    id: uid('chat'),
    title: '新对话',
    updatedAt: now,
    mode: 'free',
    sheets: [],
    activeSheetId: 'main',
    learningTasks: [],
    learningEvents: [],
    learningPlans: [],
    planningEvents: [],
    domainSources: [],
    projectSources: [],
    pluginIds: [],
    messages: [{
      id: uid('message'),
      role: 'assistant',
      content: '现在处于自由状态。你可以直接讨论学习问题；明确的解释请求会进入简单讲解，“带我学 / 带我练”会开始原子学习任务，较大的学习、项目或发展方向会进入学习规划。',
      createdAt: now,
      tutorMode: 'free',
    }],
  }
}

function tutorModeFromFormal(session: FormalTutorSession): TutorMode {
  if (isTutorMode(session.vnext_mode)) return session.vnext_mode
  const mode = session.chat_mode?.id
  if (mode === 'explain') return 'simple_explain'
  if (mode === 'learn') return 'guided_learning'
  if (mode === 'plan') return 'learning_plan'
  return 'free'
}

function messageFromFormal(message: FormalTutorMessage): Message {
  const vnext = message.meta_data?.vnext || {}
  const tutorMode = isTutorMode(vnext.tutorMode) ? vnext.tutorMode : undefined
  return {
    id: String(message.meta_data?.client_message_id || `formal-message-${message.id}`),
    role: message.role,
    content: message.content,
    displayContent: conversionMessagePresentation(message.meta_data?.work_task_conversion) || (typeof vnext.displayContent === 'string' ? vnext.displayContent : undefined),
    createdAt: message.created_at ? Date.parse(message.created_at) || Date.now() : Date.now(),
    tutorMode,
    toolRuns: Array.isArray(vnext.toolRuns) ? vnext.toolRuns as TutorToolRun[] : undefined,
    reasoningContent: typeof vnext.reasoningContent === 'string' ? vnext.reasoningContent : undefined,
    agentTrace: vnext.agentTrace && typeof vnext.agentTrace === 'object'
      ? vnext.agentTrace as AgentTurnTrace
      : undefined,
    learningActionLabel: typeof vnext.learningActionLabel === 'string' ? vnext.learningActionLabel : undefined,
    learningSkillId: isLearningSkillId(vnext.learningSkillId) ? vnext.learningSkillId : undefined,
    learningSubstateId: typeof vnext.learningSubstateId === 'string' ? vnext.learningSubstateId as LearningSubstateId : undefined,
    learningSubstateLabel: typeof vnext.learningSubstateLabel === 'string' ? vnext.learningSubstateLabel : undefined,
    learningTaskId: typeof vnext.learningTaskId === 'string' ? vnext.learningTaskId : undefined,
    formalTaskId: typeof vnext.formalTaskId === 'number' ? vnext.formalTaskId : undefined,
    learningGoal: typeof vnext.learningGoal === 'string' ? vnext.learningGoal : undefined,
    learningGoalKind: ['learning_task', 'planning_goal', 'conversation_topic'].includes(String(vnext.learningGoalKind))
      ? vnext.learningGoalKind as Message['learningGoalKind']
      : undefined,
    directUserText: typeof vnext.directUserText === 'string' ? vnext.directUserText : undefined,
    teachingInputRecordedBySkillTurn: vnext.teachingInputRecordedBySkillTurn === true,
    retryableTutorError: vnext.retryableTutorError === true,
    formalSkillSyncPending: vnext.formalSkillSyncPending === 'start' || vnext.formalSkillSyncPending === 'advance' ? vnext.formalSkillSyncPending : undefined,
    hiddenFromTranscript: vnext.hiddenFromTranscript === true,
    persistedByTutor: message.meta_data?.source !== 'vnext_chat_session_store',
  }
}

function syncMessageMetaData(message: Message): Record<string, unknown> {
  return {
    displayContent: message.displayContent,
    tutorMode: message.tutorMode,
    toolRuns: message.toolRuns,
    reasoningContent: message.reasoningContent,
    agentTrace: message.agentTrace,
    learningActionLabel: message.learningActionLabel,
    learningSkillId: message.learningSkillId,
    learningSubstateId: message.learningSubstateId,
    learningSubstateLabel: message.learningSubstateLabel,
    learningTaskId: message.learningTaskId,
    formalTaskId: message.formalTaskId,
    learningGoal: message.learningGoal,
    learningGoalKind: message.learningGoalKind,
    directUserText: message.directUserText,
    teachingInputRecordedBySkillTurn: message.teachingInputRecordedBySkillTurn,
    retryableTutorError: message.retryableTutorError,
    formalSkillSyncPending: message.formalSkillSyncPending,
    hiddenFromTranscript: message.hiddenFromTranscript,
  }
}

function conversationFromFormal(session: FormalTutorSession, existing?: Conversation): Conversation {
  const base = existing || createConversation()
  const messages = (session.messages || []).map(messageFromFormal)
  const conversation = {
    ...base,
    id: session.client_conversation_id || base.id,
    title: conversationTitle(session.title && session.title !== '新对话' ? session.title : base.title, messages.length ? messages : base.messages),
    mode: tutorModeFromFormal(session),
    messages: messages.length > 0 ? messages : base.messages,
    formalSessionId: session.id,
    updatedAt: session.updated_at ? Date.parse(session.updated_at) || base.updatedAt : base.updatedAt,
  }
  const withSessionPlugins = {
    ...conversation,
    pluginIds: stickyConversationPluginIds(session.plugin_ids || [], conversation.pluginIds),
  }
  return { ...withSessionPlugins, pluginIds: activeConversationPluginIds(withSessionPlugins) }
}

function rolePackageLaunchTokenFromPath() {
  const prefix = '/launch/role-package/'
  if (!window.location.pathname.startsWith(prefix)) return ''
  try {
    const token = decodeURIComponent(window.location.pathname.slice(prefix.length))
    return token.length <= 8_192 ? token : ''
  } catch {
    return ''
  }
}

function formalChatFingerprint(conversation: Conversation) {
  return JSON.stringify({
    sessionId: conversation.formalSessionId || null,
    title: conversation.title,
    mode: conversation.mode,
    messages: conversation.messages.map(message => [message.id, message.role, message.content]),
  })
}

function chatTab(conversation: Conversation): WorkspaceTab {
  return {
    id: `chat:${conversation.id}`,
    kind: 'chat',
    title: conversation.title,
    conversationId: conversation.id,
  }
}

function projectTab(project: Pick<FormalProjectWorkspace['project'], 'id' | 'name'>): WorkspaceTab {
  return { id: `project:${project.id}`, kind: 'project', title: project.name, projectId: project.id }
}

function learningFileTab(
  file: Pick<FormalLearningFileRef, 'kind' | 'ref' | 'title'>,
  origin?: { conversationId?: string; sheetId?: string },
): WorkspaceTab {
  return {
    id: `${file.kind}-file:${file.ref}`,
    kind: file.kind === 'lecture' ? 'lecture-file' : 'practice-file',
    title: file.title,
    fileRef: file.ref,
    originConversationId: origin?.conversationId,
    originSheetId: origin?.sheetId,
  }
}

function tabFromCurrentPath(conversations: Conversation[]): WorkspaceTab | undefined {
  const path = window.location.pathname
  if (path === '/visual-hub' || path === '/visualize') return VISUAL_HUB_TAB
  if (path === '/settings') return SETTINGS_TAB
  if (path === '/projects') return PROJECTS_TAB
  if (path.startsWith('/projects/')) {
    const projectId = Number(path.slice('/projects/'.length))
    if (Number.isInteger(projectId) && projectId > 0) return { id: `project:${projectId}`, kind: 'project', title: `项目 #${projectId}`, projectId }
  }
  if (path === '/ecosystem') return ECOSYSTEM_TAB
  if (path === '/learning-path') return LEARNING_PATH_TAB
  if (path === '/learner-profile') return PROFILE_TAB
  if (path === '/tasks') return TASKS_TAB
  if (path === '/demo') return REVIEW_TAB
  if (path === '/review') return REVIEW_TAB
  if (path === '/learning-files') return LEARNING_FILES_TAB
  if (path.startsWith('/files/lecture/')) {
    const ref = decodeURIComponent(path.slice('/files/lecture/'.length))
    return { id: `lecture-file:${ref}`, kind: 'lecture-file', title: `讲义 #${ref}`, fileRef: ref }
  }
  if (path.startsWith('/files/practice/')) {
    const ref = decodeURIComponent(path.slice('/files/practice/'.length))
    return { id: `practice-file:${ref}`, kind: 'practice-file', title: '练习', fileRef: ref }
  }
  if (path.startsWith('/chat/')) {
    const conversationId = decodeURIComponent(path.slice('/chat/'.length))
    const conversation = conversations.find(item => item.id === conversationId)
    if (conversation) return chatTab(conversation)
  }
  return undefined
}

function initialState(): PersistedState {
  const conversation = createConversation()
  const tab = tabFromCurrentPath([conversation]) || chatTab(conversation)
  return {
    conversations: [conversation],
    tabs: [tab],
    activeTabId: tab.id,
    splitTabId: '',
    settings: {
      baseUrl: 'https://api.example.com/v1',
      model: '',
    },
    learningPath: createInitialLearnerPathState(),
  }
}

function restoreState(learnerId: number): PersistedState {
  try {
    isolateLegacyWorkspaceCache(localStorage)
    const cached = JSON.parse(localStorage.getItem(learnerWorkspaceStorageKey(learnerId)) || 'null') as Partial<PersistedState> | null
    const resetLayout = consumeLayoutReset(sessionStorage, learnerId)
    const layout = readTabLayout(sessionStorage, learnerId)
    const savedConversations = Array.isArray(cached?.conversations) ? [...cached.conversations] : []
    for (const tab of (layout?.tabs || []) as WorkspaceTab[]) {
      if (tab.kind !== 'chat' || !tab.conversationId) continue
      const page = layout?.pages?.[tab.conversationId] as Partial<Conversation> | undefined
      const index = savedConversations.findIndex(item => item.id === tab.conversationId)
      const base = index >= 0 ? savedConversations[index] : { ...createConversation(), id: tab.conversationId, title: tab.title }
      const restoredPage = { ...base, ...(page || {}), id: tab.conversationId }
      if (index >= 0) savedConversations[index] = restoredPage
      else savedConversations.push(restoredPage)
    }
    const value = { ...cached, conversations: savedConversations, tabs: (layout?.tabs || []) as WorkspaceTab[], activeTabId: layout?.activeTabId, splitTabId: layout?.splitTabId }
    if (!value || !Array.isArray(value.conversations) || value.conversations.length === 0) return initialState()
    const conversations: Conversation[] = value.conversations.map(conversation => {
      const sheets = sanitizePaperSheets<Message>(conversation.sheets)
      const restored = {
        ...conversation,
        title: conversationTitle(conversation.title, conversation.messages || []),
        mode: isTutorMode(conversation.mode) ? conversation.mode : 'free' as const,
        sheets,
        learningTasks: Array.isArray(conversation.learningTasks)
          ? conversation.learningTasks.map(task => ({
            ...task,
            objective: learningObjectiveFromInput(task.objective),
          }))
          : [],
        learningEvents: Array.isArray(conversation.learningEvents) ? conversation.learningEvents : [],
        learningPlans: Array.isArray(conversation.learningPlans) ? conversation.learningPlans : [],
        planningEvents: Array.isArray(conversation.planningEvents) ? conversation.planningEvents : [],
        domainSources: Array.isArray(conversation.domainSources) ? conversation.domainSources : [],
        projectSources: Array.isArray(conversation.projectSources) ? conversation.projectSources : [],
        pluginIds: Array.isArray(conversation.pluginIds) ? conversation.pluginIds : [],
        preferredSkillId: isLearningSkillId(conversation.preferredSkillId) ? conversation.preferredSkillId : undefined,
        activeSheetId: conversation.activeSheetId === 'main'
          || sheets.some(sheet => sheet.id === conversation.activeSheetId)
          ? conversation.activeSheetId || 'main'
          : 'main',
      }
      return { ...restored, pluginIds: activeConversationPluginIds(restored) }
    })
    const conversationIds = new Set(conversations.map(item => item.id))
    const tabs = Array.isArray(value.tabs)
      ? value.tabs.filter(tab => ['visual-hub', 'settings', 'projects', 'project', 'learning-path', 'ecosystem', 'profile', 'tasks', 'review', 'learning-files', 'lecture-file', 'practice-file'].includes(tab?.kind) || (tab?.kind === 'chat' && tab?.conversationId && conversationIds.has(tab.conversationId)))
      : []
    const currentPages = [VISUAL_HUB_TAB, SETTINGS_TAB, PROJECTS_TAB, LEARNING_PATH_TAB, ECOSYSTEM_TAB, PROFILE_TAB, TASKS_TAB, REVIEW_TAB, LEARNING_FILES_TAB]
    const validTabs = tabs.filter(tab => !['lecture-file', 'practice-file'].includes(tab.kind) || Boolean(tab.fileRef))
      .map(tab => currentPages.find(page => page.kind === tab.kind) || (tab.kind === 'chat' ? chatTab(conversations.find(item => item.id === tab.conversationId)!) : tab))
    const routeTab = resetLayout ? undefined : tabFromCurrentPath(conversations)
    let safeTabs = validTabs.slice(-12)
    if (!safeTabs.length) {
      if (routeTab) safeTabs = [routeTab]
      else {
        const fresh = createConversation()
        conversations.unshift(fresh)
        safeTabs = [chatTab(fresh)]
      }
    }
    if (routeTab && !safeTabs.some(tab => tab.id === routeTab.id)) safeTabs = [...safeTabs, routeTab].slice(-12)
    const activeTabId = routeTab?.id || (safeTabs.some(tab => tab.id === value.activeTabId)
      ? String(value.activeTabId)
      : safeTabs[0].id)
    const splitTabId = safeTabs.some(tab => tab.id === value.splitTabId)
      && value.splitTabId !== activeTabId
      ? String(value.splitTabId)
      : ''
    return {
      conversations,
      tabs: safeTabs,
      activeTabId,
      splitTabId,
      settings: {
        baseUrl: value.settings?.baseUrl || 'https://api.example.com/v1',
        model: value.settings?.model || '',
      },
      learningPath: sanitizeLearnerPathState(value.learningPath),
    }
  } catch {
    return initialState()
  }
}

function pathForTab(tab: WorkspaceTab) {
  if (tab.kind === 'visual-hub') return '/visualize'
  if (tab.kind === 'settings') return '/settings'
  if (tab.kind === 'projects') return '/projects'
  if (tab.kind === 'project') return `/projects/${tab.projectId}`
  if (tab.kind === 'ecosystem') return '/ecosystem'
  if (tab.kind === 'learning-path') return '/learning-path'
  if (tab.kind === 'profile') return '/learner-profile'
  if (tab.kind === 'tasks') return '/tasks'
  if (tab.kind === 'review') return '/review'
  if (tab.kind === 'learning-files') return '/learning-files'
  if (tab.kind === 'lecture-file') return `/files/lecture/${encodeURIComponent(tab.fileRef || '')}`
  if (tab.kind === 'practice-file') return `/files/practice/${encodeURIComponent(tab.fileRef || '')}`
  return `/chat/${tab.conversationId}`
}

function surfaceKey(conversationId: string, sheetId: string) {
  return `${conversationId}:${sheetId}`
}

function activeSheet(conversation: Conversation) {
  return conversation.activeSheetId === 'main'
    ? undefined
    : conversation.sheets.find(sheet => sheet.id === conversation.activeSheetId)
}

function activeMessages(conversation: Conversation) {
  return (activeSheet(conversation)?.messages || conversation.messages)
    .filter(message => !message.learningActionLabel)
}

function paperPreview(messages: Message[]) {
  const latest = [...messages].reverse().find(
    message => message.role !== 'system' && !message.hiddenFromTranscript,
  )
  return latest?.content
    .replace(/```[\s\S]*?```/g, ' 代码片段 ')
    .replace(/[#>*_`\[\]()~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150) || '还没有写入内容'
}

function humanizeTutorMessageContent(message: Message) {
  if (
    message.role === 'system'
    && /reasoning_content.*thinking mode must be passed back to the API/i.test(message.content)
  ) {
    const mode = message.content.match(/^“([^”]+)”/)?.[1] || 'Tutor'
    return `“${mode}”续接失败：模型上下文中的思考数据不完整，本轮没有执行。请重新发送本轮消息。`
  }
  return message.displayContent || message.content
}

function inheritedContextMessages(conversation: Conversation) {
  const mainMessages = conversation.messages.filter(
    message => !message.learningActionLabel && !message.hiddenFromTranscript,
  )
  if (conversation.activeSheetId === 'main') return mainMessages
  const chain = paperAncestorChain(conversation.sheets, conversation.activeSheetId)
  return [
    ...mainMessages,
    ...chain.flatMap(sheet => sheet.messages.filter(
      message => !message.learningActionLabel && !message.hiddenFromTranscript,
    )),
  ]
}

function WorkspaceIcon({ kind }: { kind: WorkspaceTab['kind'] }) {
  const icon = kind === 'settings' ? '⚙' : ['projects', 'project'].includes(kind) ? '◇' : kind === 'learning-path' ? '⌁' : kind === 'profile' ? '◉' : kind === 'tasks' ? '☷' : kind === 'review' ? '↺' : ['learning-files', 'lecture-file', 'practice-file'].includes(kind) ? '▤' : '□'
  return <span aria-hidden="true" className="tab-icon">{icon}</span>
}

/** Downscale to a square thumbnail before upload: the account column holds a
 *  data URL, and an untouched phone photo would be megabytes of it. Drawing
 *  through a canvas also drops EXIF, GPS tags included. */
const AVATAR_EDGE = 256

async function avatarDataUrlFromFile(file: File) {
  const bitmap = await createImageBitmap(file)
  try {
    const edge = Math.min(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_EDGE
    canvas.height = AVATAR_EDGE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前环境不支持画布，无法处理图片')
    context.drawImage(
      bitmap,
      (bitmap.width - edge) / 2, (bitmap.height - edge) / 2, edge, edge,
      0, 0, AVATAR_EDGE, AVATAR_EDGE,
    )
    return canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}

function App({ auth }: { auth: AuthGateSession }) {
  const [workspace, setWorkspace] = useState<PersistedState>(() => restoreState(auth.account.learner_id))
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readTabLayout(sessionStorage, auth.account.learner_id)?.drafts || {})
  const [pluginDraftReferences, setPluginDraftReferences] = useState<Record<string, LearnFlowPluginObject[]>>({})
  const [toolChoices, setToolChoices] = useState<Record<string, TutorToolChoice>>({})
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => boundedSidebarWidth(Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))))
  const [renamingConversationId, setRenamingConversationId] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [draggingTabId, setDraggingTabId] = useState('')
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarError, setAvatarError] = useState('')

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(sidebarWidth)))
  }, [sidebarWidth])

  const changeAvatar = async (file: File) => {
    setAvatarError('')
    setAvatarBusy(true)
    try {
      const result = await saveFormalAvatar(await avatarDataUrlFromFile(file))
      auth.patchAccount({ avatar: result.avatar })
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : '头像更新失败')
    } finally {
      setAvatarBusy(false)
    }
  }

  const removeAvatar = async () => {
    setAvatarError('')
    setAvatarBusy(true)
    try {
      await clearFormalAvatar()
      auth.patchAccount({ avatar: null })
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : '头像移除失败')
    } finally {
      setAvatarBusy(false)
    }
  }
  const [providerModels, setProviderModels] = useState<string[]>([])
  const [providerModelsError, setProviderModelsError] = useState('')

  /** Ask the configured provider what it serves, instead of shipping a list
   *  that goes stale as vendors rename and retire models. */
  const loadProviderModels = async () => {
    setProviderModelsError('')
    try {
      const result = await listFormalModelCredentialModels()
      setProviderModels(result.models)
      if (!result.models.length) setProviderModelsError('服务商没有返回模型列表')
    } catch (error) {
      setProviderModels([])
      setProviderModelsError(error instanceof Error ? error.message : '读取模型列表失败')
    }
  }


  /** Reorder open tabs by dragging one onto another. */
  const moveTab = (fromId: string, toId: string) => {
    if (!fromId || fromId === toId) return
    setWorkspace(previous => {
      const order = previous.tabs.slice()
      const from = order.findIndex(item => item.id === fromId)
      const to = order.findIndex(item => item.id === toId)
      if (from < 0 || to < 0) return previous
      const [moved] = order.splice(from, 1)
      order.splice(to, 0, moved)
      return { ...previous, tabs: order }
    })
  }


  const renameConversation = (conversationId: string, title: string) => {
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(item => item.id === conversationId ? { ...item, title } : item),
      tabs: previous.tabs.map(tab => tab.id === `chat:${conversationId}` ? { ...tab, title } : tab),
    }))
  }

  const togglePinConversation = (conversationId: string) => {
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(item => item.id === conversationId ? { ...item, pinned: !item.pinned } : item),
    }))
  }

  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  const [pendingSheetDelete, setPendingSheetDelete] = useState<PendingSheetDelete | null>(null)
  const [paperDeskView, setPaperDeskView] = useState<PaperDeskView | null>(null)
  const [pendingTurns, setPendingTurns] = useState<Record<string, TutorMode>>({})
  const [liveTurns, setLiveTurns] = useState<Record<string, LiveTurn>>({})
  const [formalConnection, setFormalConnection] = useState<FormalRuntimeConnection>({ status: 'connecting', detail: '正在连接正式五核事件链' })
  const [formalSnapshot, setFormalSnapshot] = useState<FormalLearnerSnapshot>()
  const [formalBusyKey, setFormalBusyKey] = useState('')
  const [verificationConversationId, setVerificationConversationId] = useState('')
  const [formalError, setFormalError] = useState('')
  const [learningFileProposalErrors, setLearningFileProposalErrors] = useState<Record<number, string>>({})
  const [pathPlanWriteErrors, setPathPlanWriteErrors] = useState<Record<string, string>>({})
  const [sourceBusy, setSourceBusy] = useState<Record<string, string>>({})
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({})
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({})
  const [formalProjects, setFormalProjects] = useState<FormalProjectWorkspace['project'][]>([])
  const [formalProjectWorkspaces, setFormalProjectWorkspaces] = useState<Record<number, FormalProjectWorkspace>>({})
  const [expandedProjects, setExpandedProjects] = useState<Record<number, boolean>>({})
  const [projectPanelConversationId, setProjectPanelConversationId] = useState('')
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const fileProgressSyncs = useRef(new Map<string, Promise<void>>())
  const fileGenerationLocks = useRef(new Set<number>())
  const learningActionLocks = useRef(new Set<string>())
  const formalChatHydrated = useRef(false)
  const pendingRolePackageLaunchToken = useRef(rolePackageLaunchTokenFromPath())
  const pendingConversionChatId = useRef(window.location.pathname.startsWith('/chat/w2l_')
    ? window.location.pathname.slice('/chat/'.length) : '')
  const rolePackageLaunchStarted = useRef(false)
  const formalChatFingerprints = useRef<Record<string, string>>({})
  const paperAttachIntents = useRef(new Map<string, string>())

  const activeTab = workspace.tabs.find(tab => tab.id === workspace.activeTabId) || workspace.tabs[0]
  const splitTab = workspace.tabs.find(tab => tab.id === workspace.splitTabId && tab.id !== activeTab?.id)
  const activeConversation = activeTab?.kind === 'chat'
    ? workspace.conversations.find(item => item.id === activeTab.conversationId)
    : undefined
  const splitConversation = splitTab?.kind === 'chat'
    ? workspace.conversations.find(item => item.id === splitTab.conversationId)
    : undefined


  // Native details popovers stay open until their own summary is clicked
  // again, which does not match how every other menu in the app behaves.
  // One document listener closes any open menu on an outside click or Escape,
  // so each popover does not need its own state.
  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node | null
      for (const element of Array.from(document.querySelectorAll('details[open]'))) {
        if (!target || !element.contains(target)) element.removeAttribute('open')
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setShortcutsOpen(false)
      for (const element of Array.from(document.querySelectorAll('details[open]'))) {
        element.removeAttribute('open')
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(learnerWorkspaceStorageKey(auth.account.learner_id), JSON.stringify(withoutTabLayout(workspace)))
    } catch {
      // The formal backend remains authoritative when browser storage is
      // unavailable or over quota.
    }
  }, [auth.account.learner_id, workspace])

  useEffect(() => {
    saveTabLayout(sessionStorage, auth.account.learner_id, { tabs: workspace.tabs, activeTabId: workspace.activeTabId, splitTabId: workspace.splitTabId, drafts, pages: Object.fromEntries(workspace.conversations.filter(item => workspace.tabs.some(tab => tab.conversationId === item.id)).map(item => [item.id, { title: item.title, formalSessionId: item.formalSessionId, projectId: item.projectId, checkpointId: item.checkpointId, projectRole: item.projectRole, sheets: item.sheets, activeSheetId: item.activeSheetId }])) })
  }, [auth.account.learner_id, workspace.tabs, workspace.activeTabId, workspace.splitTabId, drafts, workspace.conversations])

  const refreshFormalProjects = () => {
    void listFormalProjects()
      .then(async result => {
        setFormalProjects(result.projects)
        const loaded = await Promise.allSettled(result.projects.map(project => loadFormalProject(project.id)))
        setFormalProjectWorkspaces(previous => Object.fromEntries(result.projects.flatMap((project, index) => {
          const resolved = loaded[index]
          if (resolved.status === 'fulfilled') return [[project.id, resolved.value]]
          return previous[project.id] ? [[project.id, previous[project.id]]] : []
        })))
      })
      .catch(() => {
        setFormalProjects([])
        setFormalProjectWorkspaces({})
      })
  }

  const persistGlobalConversation = async (conversation: Conversation) => {
    if (conversation.projectId) return undefined
    return syncFormalGlobalChatWithRecovery(conversation.formalSessionId, {
      id: conversation.id,
      title: conversation.title,
      mode: conversation.mode,
      messages: conversation.messages.filter(message => !message.persistedByTutor).map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        metaData: syncMessageMetaData(message),
      })),
    })
  }

  const hydrateFormalGlobalConversations = async (seed: Conversation[]) => {
    const localGlobal = seed.filter(conversation => !conversation.projectId)
    // Only browser-only conversations are migration candidates. Replaying a
    // conversation that already has a formal session id would resurrect it
    // after another browser deliberately deleted the authoritative session.
    const migrationCandidates = localGlobal.filter(conversation => !conversation.formalSessionId)
    const migrations = await Promise.allSettled(migrationCandidates.map(persistGlobalConversation))
    const migratedSessionIds = new Map<string, number>()
    migrations.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        migratedSessionIds.set(migrationCandidates[index].id, result.value.id)
      }
    })

    const hydration = await loadFormalGlobalChatsForHydration(
      localGlobal.flatMap(conversation => conversation.formalSessionId ? [conversation.formalSessionId] : []),
    )
    const remoteSessions = hydration.sessions
    const missingSessionIds = new Set(hydration.missingSessionIds)
    setWorkspace(previous => {
      const localById = new Map(previous.conversations.filter(item => !item.projectId).map(item => [item.id, item]))
      const localBySession = new Map(previous.conversations.filter(item => !item.projectId && item.formalSessionId)
        .map(item => [item.formalSessionId!, item]))
      migratedSessionIds.forEach((sessionId, conversationId) => {
        const local = localById.get(conversationId)
        if (local) localBySession.set(sessionId, { ...local, formalSessionId: sessionId })
      })

      const canonical = remoteSessions.map(session => {
        const existing = localById.get(session.client_conversation_id || '') || localBySession.get(session.id)
        const merged = conversationFromFormal(session, existing)
        localById.delete(merged.id)
        if (existing && existing.id !== merged.id) localById.delete(existing.id)
        return merged
      })
      const remainingLocal = [...localById.values()].flatMap(conversation => {
        const formalSessionId = migratedSessionIds.get(conversation.id) || conversation.formalSessionId
        if (formalSessionId && missingSessionIds.has(formalSessionId)) return []
        return [formalSessionId ? { ...conversation, formalSessionId } : conversation]
      })
      // A global chat can be promoted into a project-backed WF03 workspace
      // while the initial global hydration request is still in flight. Keep
      // the promoted conversation authoritative and discard the stale global
      // projection; otherwise two rows with the same client id/session remain
      // in local state and the stale row keeps PUTing to the now-project
      // session, producing a 409 every time the learning scene is reopened.
      const projectConversations = previous.conversations.filter(item => item.projectId)
      const projectConversationIds = new Set(projectConversations.map(item => item.id))
      const projectSessionIds = new Set(projectConversations.flatMap(item => (
        item.formalSessionId ? [item.formalSessionId] : []
      )))
      const isPromotedProjectConversation = (conversation: Conversation) => (
        projectConversationIds.has(conversation.id)
        || Boolean(conversation.formalSessionId && projectSessionIds.has(conversation.formalSessionId))
      )
      const conversations = [
        ...projectConversations,
        ...canonical.filter(conversation => !isPromotedProjectConversation(conversation)),
        ...remainingLocal.filter(conversation => !isPromotedProjectConversation(conversation)),
      ]
      const byId = new Map(conversations.map(item => [item.id, item]))
      let tabs = previous.tabs.flatMap(tab => {
        if (!tab.conversationId) return [tab]
        const conversation = tab.conversationId ? byId.get(tab.conversationId) : undefined
        return conversation ? [{ ...tab, title: conversation.title }] : []
      })
      if (tabs.length === 0 && conversations[0]) tabs = [chatTab(conversations[0])]
      const incoming = conversations.find(item => item.id === pendingConversionChatId.current)
      if (incoming && !tabs.some(tab => tab.id === `chat:${incoming.id}`)) tabs = [...tabs, chatTab(incoming)]
      const activeTabId = incoming ? `chat:${incoming.id}` : tabs.some(tab => tab.id === previous.activeTabId)
        ? previous.activeTabId
        : tabs[0]?.id || ''
      pendingConversionChatId.current = ''
      const splitTabId = tabs.some(tab => tab.id === previous.splitTabId)
        && previous.splitTabId !== activeTabId
        ? previous.splitTabId
        : ''
      return { ...previous, conversations, tabs, activeTabId, splitTabId }
    })
    formalChatHydrated.current = true
  }

  useEffect(() => { refreshFormalProjects() }, [])

  useEffect(() => {
    const token = pendingRolePackageLaunchToken.current
    if (!token || rolePackageLaunchStarted.current) return
    rolePackageLaunchStarted.current = true
    const clientConversationId = uid('chat')
    void consumeFormalRolePackageLaunch(token, clientConversationId).then(session => {
      const conversation = conversationFromFormal(session)
      const tab = chatTab(conversation)
      setWorkspace(previous => {
        const conversations = [conversation, ...previous.conversations.filter(item => (
          item.id !== conversation.id && item.formalSessionId !== conversation.formalSessionId
        ))]
        const tabs = [...previous.tabs.filter(item => item.id !== tab.id), tab].slice(-12)
        return { ...previous, conversations, tabs, activeTabId: tab.id, splitTabId: '' }
      })
      pendingRolePackageLaunchToken.current = ''
    }).catch(error => {
      setFormalError(error instanceof Error ? error.message : '岗位包交接失败')
    })
  }, [])

  useEffect(() => {
    let active = true
    bootstrapFormalRuntime().then(result => {
      if (!active) return
      setFormalConnection(result.connection)
      if (result.snapshot) {
        setFormalSnapshot(result.snapshot)
        setWorkspace(previous => ({
          ...previous,
          learningPath: learnerPathStateFromFormal(result.snapshot!.learning_path),
        }))
        void hydrateFormalGlobalConversations(workspace.conversations).catch(error => {
          setFormalError(error instanceof Error ? error.message : '普通对话同步失败')
          formalChatHydrated.current = true
        })
      }
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (formalConnection.status !== 'connected' || !formalChatHydrated.current) return
    const timer = window.setTimeout(() => {
      workspace.conversations.filter(conversation => !conversation.projectId).forEach(conversation => {
        const fingerprint = formalChatFingerprint(conversation)
        if (formalChatFingerprints.current[conversation.id] === fingerprint) return
        formalChatFingerprints.current[conversation.id] = fingerprint
        void persistGlobalConversation(conversation).then(session => {
          if (!session || conversation.formalSessionId === session.id) return
          setWorkspace(previous => ({
            ...previous,
            conversations: previous.conversations.map(item => item.id === conversation.id
              ? { ...item, formalSessionId: session.id }
              : item),
          }))
        }).catch(error => {
          delete formalChatFingerprints.current[conversation.id]
          setFormalError(error instanceof Error ? error.message : '普通对话保存失败')
        })
      })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [formalConnection.status, workspace.conversations])

  useEffect(() => {
    if (!activeTab) return
    if (pendingConversionChatId.current) return
    const path = pathForTab(activeTab)
    window.history.replaceState({ tabId: activeTab.id }, '', activeTab.kind === 'ecosystem' && window.location.pathname === '/ecosystem' ? ecosystemEntryPath(window.location.search) : activeTab.kind === 'visual-hub' ? path + window.location.hash : path)
    document.title = `${activeTab.title} · LearnFlow`
  }, [activeTab])

  const refreshFormalSnapshot = async (includeTerminalTasks = false) => {
    setFormalError('')
    try {
      const snapshot = await loadFormalLearnerSnapshot(includeTerminalTasks)
      setFormalSnapshot(snapshot)
      setFormalConnection({ status: 'connected', detail: snapshot.authority, learner: snapshot.learner })
      setWorkspace(previous => ({ ...previous, learningPath: learnerPathStateFromFormal(snapshot.learning_path) }))
      return snapshot
    } catch (error) {
      const detail = error instanceof Error ? error.message : '正式五核刷新失败'
      setFormalError(detail)
      setFormalConnection(previous => ({ ...previous, status: 'offline', detail }))
      return undefined
    }
  }

  useEffect(() => {
    if (!pendingDelete && !pendingSheetDelete) return
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPendingDelete(null)
        setPendingSheetDelete(null)
      }
    }
    window.addEventListener('keydown', cancelOnEscape)
    return () => window.removeEventListener('keydown', cancelOnEscape)
  }, [pendingDelete, pendingSheetDelete])

  useEffect(() => {
    if (!paperDeskView) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPaperDeskView(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [paperDeskView])

  const openTab = (next: WorkspaceTab) => {
    setWorkspace(previous => {
      const existing = previous.tabs.find(tab => tab.id === next.id)
      const tabs = existing
        ? previous.tabs.map(tab => tab.id === next.id ? { ...tab, ...next } : tab)
        : [...previous.tabs, next].slice(-12)
      const splitTabId = previous.splitTabId === next.id
        ? previous.activeTabId
        : previous.splitTabId
      return {
        ...previous,
        tabs,
        activeTabId: next.id,
        splitTabId: splitTabId !== next.id && tabs.some(tab => tab.id === splitTabId) ? splitTabId : '',
      }
    })
    setSidebarOpen(false)
  }

  const returnToLearningScene = async (task: FormalLearningTask) => {
    setFormalBusyKey(`task:${task.id}`)
    setFormalError('')
    let executableTask = task
    try {
      if (task.status === 'queued' || task.status === 'paused') {
        executableTask = await actOnFormalLearningTask(
          task,
          task.status === 'queued' ? 'start' : 'resume',
        )
        setFormalSnapshot(previous => previous ? {
          ...previous,
          learning_tasks: previous.learning_tasks.map(item => item.id === executableTask.id ? executableTask : item),
        } : previous)
      }
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '正式学习任务无法启动')
      setFormalBusyKey('')
      return
    }
    const routeMatch = task.origin_navigation?.path.match(/^\/chat\/([^/?#]+)/)
    const routeConversationId = routeMatch
      ? decodeURIComponent(routeMatch[1])
      : ''
    const sourceRef = task.source_refs.find(ref => ref.type === 'conversation')
    const sourceConversationId = typeof sourceRef?.id === 'string' ? sourceRef.id : ''
    const target = workspace.conversations.find(conversation => (
      conversation.id === routeConversationId
      || conversation.id === sourceConversationId
      || (task.session_id && conversation.formalSessionId === task.session_id)
    )) || [...workspace.conversations]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .find(conversation => (
        task.project_id
        && conversation.projectId === task.project_id
        && activeConversationPluginIds(conversation).includes('learning_task_conversion')
      ))
    if (target) {
      const sheetId = typeof sourceRef?.sheetId === 'string' ? sourceRef.sheetId : 'main'
      // A WF03 candidate may originate in a global chat but be promoted into
      // a project-backed formal task.  The task session owns its SkillRun, so
      // returning to the visible source conversation must restore that exact
      // project session instead of reusing the chat's former global session.
      let formalSessionId = executableTask.session_id || target.formalSessionId
      let restoredSkillRun: FormalLearningSkillRun | undefined
      if (!formalSessionId) {
        try {
          const session = await createFormalTutorSession(true, {
            projectId: target.projectId || executableTask.project_id || undefined,
            checkpointId: target.checkpointId || executableTask.checkpoint_id || undefined,
            title: target.title,
            clientConversationId: target.id,
          })
          formalSessionId = session.id
        } catch (error) {
          setFormalError(error instanceof Error ? error.message : '学习现场会话创建失败')
          setFormalBusyKey('')
          return
        }
      }
      if (executableTask.session_id && formalSessionId === executableTask.session_id) {
        try {
          const taskSession = await loadFormalTutorSession(formalSessionId)
          if (taskSession.active_skill_run?.learning_task?.id === executableTask.id) {
            restoredSkillRun = taskSession.active_skill_run
          }
        } catch (error) {
          setFormalError(error instanceof Error ? error.message : '正式 SkillRun 恢复失败')
        }
      }
      setWorkspace(previous => ({
        ...previous,
        conversations: previous.conversations.map(conversation => conversation.id === target.id
          ? (() => {
              const activated = activateFormalLearningTask(
                executableTask,
                conversation.learningTasks,
                conversation.learningEvents,
              )
              let learningTasks = activated.tasks
              let learningEvents = activated.events
              let learningTask = activated.task
              if (restoredSkillRun) {
                let projection = projectLearningTask(learningTask, learningEvents)
                if (projection.skillId !== restoredSkillRun.skill.id) {
                  learningEvents = switchLearningSkill(
                    learningEvents,
                    projection,
                    restoredSkillRun.skill.id,
                    Date.now() + 1,
                  )
                }
                learningTask = bindFormalSkillRun(learningTask, restoredSkillRun)
                learningTasks = learningTasks.map(item => item.id === learningTask.id ? learningTask : item)
                projection = projectLearningTask(learningTask, learningEvents)
                learningEvents = reconcileLearningEventsWithFormalSkillRun(
                  learningEvents,
                  projection,
                  restoredSkillRun,
                  Date.now() + 2,
                )
              }
              const projection = projectLearningTask(learningTask, learningEvents)
              return {
                ...conversation,
                formalSessionId,
                projectId: executableTask.project_id || conversation.projectId,
                projectRole: executableTask.project_id ? 'free' as const : conversation.projectRole,
                mode: 'guided_learning' as const,
                learningTasks,
                learningEvents,
                preferredSkillId: projection.skillId,
                activeSheetId: sheetId === 'main' || conversation.sheets.some(sheet => sheet.id === sheetId)
                  ? sheetId
                  : 'main',
                updatedAt: Date.now(),
              }
            })()
          : conversation),
      }))
      openTab(chatTab(target))
      setFormalBusyKey('')
      return
    }
    if (task.project_id) {
      openTab({ id: `project:${task.project_id}`, kind: 'project', title: task.title, projectId: task.project_id })
      setFormalBusyKey('')
      return
    }
    const fallback = task.origin_navigation?.path
    if (fallback && !fallback.startsWith('/tasks')) window.location.assign(fallback)
    setFormalBusyKey('')
  }

  const newConversation = () => {
    const conversation = createConversation()
    const tab = chatTab(conversation)
    setWorkspace(previous => {
      const tabs = [...previous.tabs, tab].slice(-12)
      return {
        ...previous,
        conversations: [conversation, ...previous.conversations],
        tabs,
        activeTabId: tab.id,
        splitTabId: tabs.some(item => item.id === previous.splitTabId) ? previous.splitTabId : '',
      }
    })
    setSidebarOpen(false)
  }

  const syncProjectWorkspace = (projectWorkspace: FormalProjectWorkspace) => {
    setFormalProjectWorkspaces(previous => ({ ...previous, [projectWorkspace.project.id]: projectWorkspace }))
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => conversation.projectId === projectWorkspace.project.id
        ? { ...conversation, projectSources: projectWorkspace.sources }
        : conversation),
    }))
  }

  const openProjectConversation = (
    projectWorkspace: FormalProjectWorkspace,
    role: 'tutor' | 'checkpoint' | 'free',
    options: { checkpoint?: FormalProjectCheckpoint; session?: { session_id: number; title: string } } = {},
  ) => {
    const checkpoint = options.checkpoint
    const formalSessionId = role === 'tutor'
      ? projectWorkspace.project_tutor.session_id
      : role === 'checkpoint' ? checkpoint?.session_id : options.session?.session_id
    const existing = workspace.conversations.find(item =>
      item.projectId === projectWorkspace.project.id
      && item.projectRole === role
      && (role !== 'checkpoint' || item.checkpointId === checkpoint?.id)
      && item.formalSessionId === formalSessionId)
    if (existing) {
      syncProjectWorkspace(projectWorkspace)
      openTab(chatTab({ ...existing, projectSources: projectWorkspace.sources }))
      return
    }
    const now = Date.now()
    const base = createConversation()
    let learningTasks: LearningTask[] = []
    let learningEvents: LearningEvent[] = []
    if (role === 'checkpoint' && checkpoint) {
      const created = createLearningTask(checkpoint.objective || checkpoint.title, now, [], undefined)
      learningTasks = [{
        ...created.task,
        objective: checkpoint.objective || checkpoint.title,
        formalTaskId: checkpoint.learning_task?.id,
      }]
      learningEvents = created.events
    }
    const mode: TutorMode = role === 'tutor' ? 'learning_plan' : role === 'checkpoint' ? 'guided_learning' : 'free'
    const title = role === 'tutor'
      ? `${projectWorkspace.project.name} · 项目 Tutor`
      : role === 'checkpoint' ? checkpoint!.title : options.session?.title || `${projectWorkspace.project.name} · 自由对话`
    const intro = role === 'tutor'
      ? `这是“${projectWorkspace.project.name}”的项目 Tutor。规划必须围绕项目目标“${projectWorkspace.project.objective}”与真实产物展开；我会先读取项目来源和五核，再给出需要你确认的关卡路线。`
      : role === 'checkpoint'
        ? `现在进入关卡“${checkpoint!.title}”。本对话绑定正式学习任务，会自然使用带领学习；讲义与练习可以生成、留存并在对话纸张或独立标签页中打开。`
        : `这是“${projectWorkspace.project.name}”的项目自由对话。它共享项目来源与五核 scope，但不会自动推进关卡。`
    const conversation: Conversation = {
      ...base, id: uid('chat'), title, updatedAt: now, mode,
      projectId: projectWorkspace.project.id,
      checkpointId: checkpoint?.id,
      projectRole: role,
      formalSessionId,
      projectSources: projectWorkspace.sources,
      learningTasks,
      learningEvents,
      messages: [{ id: uid('message'), role: 'assistant', content: intro, createdAt: now, tutorMode: mode }],
    }
    const tab = chatTab(conversation)
    setWorkspace(previous => ({
      ...previous,
      conversations: [conversation, ...previous.conversations],
      tabs: [...previous.tabs, tab].slice(-12),
      activeTabId: tab.id,
    }))
  }

  const openProjectTutor = async (projectId: number) => {
    try {
      const projectWorkspace = await loadFormalProject(projectId)
      syncProjectWorkspace(projectWorkspace)
      setExpandedProjects(previous => ({ ...previous, [projectId]: true }))
      openProjectConversation(projectWorkspace, 'tutor')
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '项目加载失败')
    }
  }

  const addProjectFreeConversation = async (projectId: number) => {
    setFormalBusyKey(`project-free:${projectId}`)
    setFormalError('')
    try {
      const projectWorkspace = await loadFormalProject(projectId)
      const session = await createFormalProjectFreeSession(projectId, `${projectWorkspace.project.name} · 自由对话`)
      const refreshed = await loadFormalProject(projectId)
      syncProjectWorkspace(refreshed)
      setExpandedProjects(previous => ({ ...previous, [projectId]: true }))
      openProjectConversation(refreshed, 'free', { session })
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '项目自由对话创建失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const closeTab = (tabId: string) => {
    setWorkspace(previous => {
      const index = previous.tabs.findIndex(tab => tab.id === tabId)
      if (index < 0) return previous
      let tabs = previous.tabs.filter(tab => tab.id !== tabId)
      if (tabs.length === 0) {
        // Closing the last tab starts a fresh conversation rather than
        // reopening the most recent one: the workspace is never empty, and the
        // learner is not dropped back into a thread they just dismissed.
        const fallbackConversation = createConversation()
        const fallbackTab = chatTab(fallbackConversation)
        tabs = [fallbackTab]
        return {
          ...previous,
          conversations: [fallbackConversation, ...previous.conversations],
          tabs,
          activeTabId: fallbackTab.id,
          splitTabId: '',
        }
      }
      const survivingSplit = tabs.find(tab => tab.id === previous.splitTabId)
      const activeTabId = previous.activeTabId === tabId
        ? (survivingSplit || tabs[index] || tabs[index - 1] || tabs[0]).id
        : previous.activeTabId
      const splitTabId = previous.activeTabId === tabId || previous.splitTabId === tabId
        ? ''
        : previous.splitTabId
      return {
        ...previous,
        tabs,
        activeTabId,
        splitTabId: splitTabId !== activeTabId && tabs.some(tab => tab.id === splitTabId) ? splitTabId : '',
      }
    })
  }

  const toggleSplit = (tabId: string) => {
    setWorkspace(previous => {
      if (tabId === previous.activeTabId || !previous.tabs.some(tab => tab.id === tabId)) return previous
      return { ...previous, splitTabId: previous.splitTabId === tabId ? '' : tabId }
    })
  }

  const closeSplit = () => {
    setWorkspace(previous => ({ ...previous, splitTabId: '' }))
  }

  /** Window-level shortcuts.  Declared after the handlers they call so the
   *  bindings are already in scope, and gated on the modifier key so typing a
   *  plain character in the composer can never trigger a workspace action. */
  useEffect(() => {
    const run = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key
      if (key >= '1' && key <= '9') {
        const target = workspace.tabs[Number(key) - 1]
        if (!target) return
        event.preventDefault()
        openTab(target)
        return
      }
      switch (key.toLowerCase()) {
        case 'n':
          event.preventDefault()
          newConversation()
          break
        case 'w':
          if (!activeTab) return
          event.preventDefault()
          closeTab(activeTab.id)
          break
        case 'b':
          event.preventDefault()
          setSidebarCollapsed(value => !value)
          break
        case ',':
          event.preventDefault()
          openTab(SETTINGS_TAB)
          break
        case '/':
          event.preventDefault()
          setShortcutsOpen(value => !value)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', run)
    return () => window.removeEventListener('keydown', run)
  })

  const deleteConversation = async (conversationId: string) => {
    const target = workspace.conversations.find(conversation => conversation.id === conversationId)
    if (target?.formalSessionId && !target.projectId && formalConnection.status === 'connected') {
      try {
        await deleteFormalTutorSession(target.formalSessionId)
      } catch (error) {
        setFormalError(error instanceof Error ? error.message : '正式对话删除失败')
        return
      }
    }
    setWorkspace(previous => {
      let conversations = previous.conversations.filter(conversation => conversation.id !== conversationId)
      let tabs = previous.tabs.filter(tab => tab.conversationId !== conversationId)

      if (conversations.length === 0) {
        const conversation = createConversation()
        const tab = chatTab(conversation)
        return {
          ...previous,
          conversations: [conversation],
          tabs: [tab],
          activeTabId: tab.id,
          splitTabId: '',
        }
      }

      if (tabs.length === 0) tabs = [chatTab(conversations[0])]
      const activeSurvives = tabs.some(tab => tab.id === previous.activeTabId)
      const splitSurvives = tabs.find(tab => tab.id === previous.splitTabId)
      const activeTabId = activeSurvives ? previous.activeTabId : (splitSurvives || tabs[0]).id
      const splitTabId = activeSurvives && splitSurvives && splitSurvives.id !== activeTabId
        ? splitSurvives.id
        : ''

      return { ...previous, conversations, tabs, activeTabId, splitTabId }
    })
    setDrafts(previous => {
      return Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${conversationId}:`)))
    })
    setPluginDraftReferences(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${conversationId}:`))))
    setToolChoices(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${conversationId}:`))))
    setPendingTurns(previous => {
      const next = { ...previous }
      delete next[conversationId]
      return next
    })
    setPaperDeskView(current => current?.conversationId === conversationId ? null : current)
    delete formalChatFingerprints.current[conversationId]
    setPendingDelete(null)
  }

  const requestSheetDelete = (conversation: Conversation, sheetId: string) => {
    if (sheetId === 'main' || pendingTurns[conversation.id]) return
    const sheet = conversation.sheets.find(item => item.id === sheetId)
    if (!sheet) return
    setPendingSheetDelete({
      conversationId: conversation.id,
      sheetId,
      title: sheet.title,
      childCount: conversation.sheets.filter(item => item.parentSheetId === sheetId).length,
    })
  }

  const deleteSheet = (conversationId: string, sheetId: string) => {
    if (sheetId === 'main') return
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => {
        if (conversation.id !== conversationId) return conversation
        const result = deletePaperSheet(conversation.sheets, sheetId)
        if (result.sheets === conversation.sheets) return conversation
        return {
          ...conversation,
          activeSheetId: conversation.activeSheetId === sheetId ? result.parentSheetId : conversation.activeSheetId,
          sheets: result.sheets,
          updatedAt: Date.now(),
        }
      }),
    }))
    const deletedSurface = surfaceKey(conversationId, sheetId)
    setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== deletedSurface)))
    setPluginDraftReferences(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== deletedSurface)))
    setToolChoices(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== deletedSurface)))
    setPendingSheetDelete(null)
  }

  const setConversationMode = (conversationId: string, mode: TutorMode) => {
    if (pendingTurns[conversationId]) return
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => (
        conversation.id === conversationId
          ? { ...conversation, mode, preferredSkillId: mode === 'guided_learning' ? conversation.preferredSkillId : undefined }
          : conversation
      )),
    }))
  }

  const setActiveSheet = (conversationId: string, sheetId: string) => {
    if (pendingTurns[conversationId]) return
    setPaperDeskView(current => current?.conversationId === conversationId ? null : current)
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => (
        conversation.id === conversationId
          && (sheetId === 'main' || conversation.sheets.some(sheet => sheet.id === sheetId))
          ? { ...conversation, activeSheetId: sheetId }
          : conversation
      )),
    }))
  }

  const createFollowUpSheet = (conversationId: string, sourceMessageId: string, quote: string) => {
    const cleaned = quote.replace(/\s+/g, ' ').trim().slice(0, 1200)
    if (cleaned.length < 2) return
    setPaperDeskView(null)
    const sheet: FollowUpSheet = {
      id: uid('sheet'),
      title: cleaned.slice(0, 28),
      quote: cleaned,
      sourceMessageId,
      parentSheetId: workspace.conversations.find(item => item.id === conversationId)?.activeSheetId || 'main',
      messages: [],
      createdAt: Date.now(),
    }
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => (
        conversation.id === conversationId
          ? { ...conversation, sheets: [...conversation.sheets, sheet], activeSheetId: sheet.id, updatedAt: Date.now() }
          : conversation
      )),
    }))
  }

  const addPluginDraftReference = (draftKey: string, object: LearnFlowPluginObject) => {
    setPluginDraftReferences(previous => {
      const current = previous[draftKey] || []
      const key = pluginObjectContentKey(object)
      if (current.some(item => pluginObjectContentKey(item) === key)) return previous
      return { ...previous, [draftKey]: [...current, object].slice(-12) }
    })
  }

  const openPluginResultPaper = (conversationId: string, sourceMessageId: string, run: TutorToolRun) => {
    if (!run.plugin) return
    setPaperDeskView(null)
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => {
        if (conversation.id !== conversationId) return conversation
        const existing = conversation.sheets.find(sheet => sheet.messages.some(message => (
          message.pluginResultProjection && message.toolRuns?.some(candidate => candidate.id === run.id)
        )))
        if (existing) return { ...conversation, activeSheetId: existing.id, updatedAt: Date.now() }
        const snapshotLabel = run.plugin?.result.objects?.[0]?.label || run.title
        const sheet: FollowUpSheet = {
          id: uid('sheet'),
          title: snapshotLabel.slice(0, 28),
          quote: `插件快照：${snapshotLabel}`,
          sourceMessageId,
          parentSheetId: conversation.activeSheetId || 'main',
          messages: [{
            id: uid('message'),
            role: 'assistant',
            content: '这是主对话中该次插件工具结果的只读投影。',
            createdAt: Date.now(),
            toolRuns: [run],
            pluginResultProjection: true,
          }],
          createdAt: Date.now(),
        }
        return { ...conversation, sheets: [...conversation.sheets, sheet], activeSheetId: sheet.id, updatedAt: Date.now() }
      }),
    }))
  }

  const attachDomainSource = (conversationId: string, source: FormalKnowledgeSource) => {
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => conversation.id === conversationId
        ? {
            ...conversation,
            domainSources: [...conversation.domainSources.filter(item => item.id !== source.id), source],
            updatedAt: Date.now(),
          }
        : conversation),
    }))
  }

  const importDomainFile = async (conversationId: string, file: File) => {
    setSourceBusy(previous => ({ ...previous, [conversationId]: `正在读取 ${file.name}` }))
    setSourceErrors(previous => ({ ...previous, [conversationId]: '' }))
    try {
      const conversation = workspace.conversations.find(item => item.id === conversationId)
      if (conversation?.projectId) {
        const pending = await uploadFormalProjectFile(conversation.projectId, file)
        setSourceBusy(previous => ({ ...previous, [conversationId]: `正在建立 ${file.name} 的项目索引` }))
        await processFormalProjectSource(conversation.projectId, pending.id)
        syncProjectWorkspace(await loadFormalProject(conversation.projectId))
        return
      }
      const pending = await uploadKnowledgeLibraryFile(file)
      setSourceBusy(previous => ({ ...previous, [conversationId]: `正在建立 ${file.name} 的领域索引` }))
      const processed = await processKnowledgeLibrarySource(pending.id)
      attachDomainSource(conversationId, processed.source)
    } catch (error) {
      setSourceErrors(previous => ({ ...previous, [conversationId]: error instanceof Error ? error.message : '资料导入失败' }))
    } finally {
      setSourceBusy(previous => ({ ...previous, [conversationId]: '' }))
    }
  }

  const importDomainUrl = async (conversationId: string) => {
    const url = (sourceUrls[conversationId] || '').trim()
    if (!url) return
    setSourceBusy(previous => ({ ...previous, [conversationId]: '正在读取 URL' }))
    setSourceErrors(previous => ({ ...previous, [conversationId]: '' }))
    try {
      const conversation = workspace.conversations.find(item => item.id === conversationId)
      if (conversation?.projectId) {
        const pending = await addFormalProjectUrl(conversation.projectId, url)
        setSourceBusy(previous => ({ ...previous, [conversationId]: '正在建立 URL 的项目索引' }))
        await processFormalProjectSource(conversation.projectId, pending.id)
        syncProjectWorkspace(await loadFormalProject(conversation.projectId))
        setSourceUrls(previous => ({ ...previous, [conversationId]: '' }))
        return
      }
      const pending = await addKnowledgeLibraryUrl(url)
      setSourceBusy(previous => ({ ...previous, [conversationId]: '正在建立 URL 的领域索引' }))
      const processed = await processKnowledgeLibrarySource(pending.id)
      attachDomainSource(conversationId, processed.source)
      setSourceUrls(previous => ({ ...previous, [conversationId]: '' }))
    } catch (error) {
      setSourceErrors(previous => ({ ...previous, [conversationId]: error instanceof Error ? error.message : 'URL 导入失败' }))
    } finally {
      setSourceBusy(previous => ({ ...previous, [conversationId]: '' }))
    }
  }

  const detachDomainSource = async (conversationId: string, sourceId: number) => {
    const target = workspace.conversations.find(item => item.id === conversationId)
    const removesLastSource = target?.projectId
      ? target.projectSources.length <= 1
      : (target?.domainSources.length || 0) <= 1
    if (target?.projectId) {
      try {
        await removeFormalProjectSource(target.projectId, sourceId)
        syncProjectWorkspace(await loadFormalProject(target.projectId))
      } catch (error) {
        setSourceErrors(previous => ({ ...previous, [conversationId]: error instanceof Error ? error.message : '项目来源移除失败' }))
        return
      }
    } else {
      setWorkspace(previous => ({
        ...previous,
        conversations: previous.conversations.map(conversation => conversation.id === conversationId
          ? { ...conversation, domainSources: conversation.domainSources.filter(source => source.id !== sourceId), updatedAt: Date.now() }
          : conversation),
      }))
    }
    if (removesLastSource) {
      setToolChoices(previous => Object.fromEntries(Object.entries(previous).map(([key, choice]) => (
        key.startsWith(`${conversationId}:`) && choice === 'domain' ? [key, 'auto'] : [key, choice]
      ))) as Record<string, TutorToolChoice>)
    }
  }

  const attachLearningFileToConversation = (
    file: PaperArtifact,
    preferredConversationId?: string,
    anchor?: { sourceMessageId?: string; parentSheetId?: string },
  ) => {
    setPaperDeskView(null)
    const activeConversationId = workspace.tabs.find(tab => tab.id === workspace.activeTabId)?.conversationId
    const origin = workspace.conversations.find(item => item.id === preferredConversationId)
      || workspace.conversations.find(item => item.id === activeConversationId)
      || workspace.conversations[0]
    if (!origin) return
    const knownSheetId = findPaperSheetByArtifact(origin.sheets, file)?.id
    const intentKey = `${origin.id}:${paperArtifactKey(file)}`
    const sheetId = knownSheetId || paperAttachIntents.current.get(intentKey) || uid('sheet')
    paperAttachIntents.current.set(intentKey, sheetId)
    const candidateSheet: FollowUpSheet = {
      id: sheetId,
      title: file.title.slice(0, 28),
      quote: `${file.kind === 'lecture' ? '讲义' : file.kind === 'practice' ? '练习' : '资料'}：${file.title}`,
      sourceMessageId: anchor?.sourceMessageId || '',
      parentSheetId: anchor?.parentSheetId || origin.activeSheetId || 'main',
      messages: [],
      createdAt: Date.now(),
      artifact: file,
    }
    setWorkspace(previous => {
      const target = previous.conversations.find(item => item.id === origin.id)
      if (!target) return previous
      const existing = findPaperSheetByArtifact(target.sheets, file)
      const sheet = existing || candidateSheet
      const tab = chatTab(target)
      const tabs = previous.tabs.some(item => item.id === tab.id) ? previous.tabs : [...previous.tabs, tab].slice(-12)
      return {
        ...previous,
        conversations: previous.conversations.map(item => item.id === target.id
          ? {
              ...item,
              sheets: existing ? item.sheets : [...item.sheets, sheet],
              activeSheetId: sheet.id,
              updatedAt: Date.now(),
            }
          : item),
        tabs,
        activeTabId: tab.id,
      }
    })
    void recordLearningFileAccess(file.kind, file.ref, 'attached', {
      conversation_id: origin.id,
      sheet_id: sheetId,
    }).catch(() => undefined)
  }

  const attachSourceToConversation = (conversation: Conversation, source: Pick<FormalKnowledgeSource, 'id' | 'name'>) => {
    attachLearningFileToConversation({
      kind: 'source',
      ref: String(source.id),
      title: source.name,
      projectId: conversation.projectId,
    }, conversation.id, { parentSheetId: conversation.activeSheetId })
  }

  const openLearningFile = (
    file: { kind: 'lecture' | 'practice'; ref: string; title: string },
    origin?: { conversationId?: string; sheetId?: string },
  ) => {
    openTab(learningFileTab(file, origin))
    void recordLearningFileAccess(file.kind, file.ref, 'opened', {
      conversation_id: origin?.conversationId,
      sheet_id: origin?.sheetId,
    }).catch(() => undefined)
  }

  const finishTurn = (
    conversationId: string,
    sheetId: string,
    mode: TutorMode,
    message: Omit<Message, 'id' | 'createdAt'>,
    formalSessionIdOverride?: number,
  ) => {
    setLiveTurns(previous => {
      const next = { ...previous }
      delete next[conversationId]
      return next
    })
    const formalSessionId = formalSessionIdOverride
      || workspace.conversations.find(item => item.id === conversationId)?.formalSessionId
    const finishedMessage = { ...message, id: uid('message'), createdAt: Date.now(), tutorMode: message.role === 'assistant' ? mode : undefined }
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => {
        if (conversation.id !== conversationId) return conversation
        return {
          ...conversation,
          updatedAt: Date.now(),
          messages: sheetId === 'main' ? [...conversation.messages, finishedMessage] : conversation.messages,
          sheets: sheetId === 'main' ? conversation.sheets : conversation.sheets.map(sheet => (
            sheet.id === sheetId ? { ...sheet, messages: [...sheet.messages, finishedMessage] } : sheet
          )),
        }
      }),
    }))
    setPendingTurns(previous => {
      const next = { ...previous }
      delete next[conversationId]
      return next
    })
    if (message.role === 'assistant' && formalConnection.status === 'connected') {
      void syncFormalEvent({
        id: `learning-segment:${finishedMessage.id}`,
        type: 'learning_action_segment_completed',
        at: finishedMessage.createdAt,
        detail: `完成一段${TUTOR_MODE_LABELS[mode]}输出；只表示发生学习暴露，不表示掌握`,
        payload: {
          segment_id: finishedMessage.id,
          mode: formalModeId(mode),
          goal: message.learningGoal || '',
          goal_kind: message.learningGoalKind || 'conversation_topic',
          outcome: 'tutor_output_delivered',
          content_exposure: mode === 'simple_explain' || mode === 'guided_learning',
          learning_task_id: message.formalTaskId || message.learningTaskId,
          skills: message.learningSkillId ? [message.learningSkillId] : [],
          conversation_id: conversationId,
          session_id: formalSessionId,
          exit_message_id: finishedMessage.id,
        },
      }).catch(error => setFormalError(error instanceof Error ? error.message : '学习片段事件同步失败'))
    }
    return finishedMessage
  }

  const updateLiveTurn = (conversationId: string, event: AgentTurnStreamEvent) => {
    setLiveTurns(previous => {
      const current = previous[conversationId]
      if (!current || event.type === 'done' || event.type === 'error') return previous
      if (event.type === 'text_reset') {
        return { ...previous, [conversationId]: { ...current, content: current.committedContent, phase: '正在调整回答' } }
      }
      if (event.type === 'teaching_segment_committed') {
        return {
          ...previous,
          [conversationId]: {
            ...current,
            committedContent: event.content,
            content: event.content,
            phase: '讲解已保留，正在生成视觉增强',
          },
        }
      }
      if (event.type === 'text_delta') {
        return { ...previous, [conversationId]: { ...current, content: current.content + event.delta, phase: '正在回答' } }
      }
      if (event.type === 'trajectory') {
        return { ...previous, [conversationId]: { ...current, phase: event.event.detail } }
      }
      if (event.type === 'decision_summary') {
        return {
          ...previous,
          [conversationId]: {
            ...current,
            decisionSummaries: [
              ...current.decisionSummaries.filter(item => item.toolCallId !== event.summary.toolCallId),
              event.summary,
            ].sort((left, right) => left.sequence - right.sequence),
            phase: event.summary.nextAction,
          },
        }
      }
      if (event.type === 'tool_started') {
        const running: TutorToolRun = {
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          kind: /practice|learning_file/i.test(event.toolName) ? 'file' : event.toolName.includes('search') ? 'search' : 'workspace',
          status: 'running', title: event.title, detail: '正在调用工具并等待结构化观察…',
          durationMs: 0, startedAt: event.startedAt,
        }
        return { ...previous, [conversationId]: { ...current, toolRuns: [...current.toolRuns, running], phase: `正在使用 ${event.title}` } }
      }
      const completed = event.run
      const exists = current.toolRuns.some(run => run.toolCallId === completed.toolCallId)
      return {
        ...previous,
        [conversationId]: {
          ...current,
          toolRuns: exists
            ? current.toolRuns.map(run => run.toolCallId === completed.toolCallId ? completed : run)
            : [...current.toolRuns, completed],
          phase: completed.status === 'completed' ? `${completed.title}完成，正在决定下一步` : `${completed.title}失败，正在调整`,
        },
      }
    })
  }

  const runTutorTurn = async (
    conversationId: string,
    rawContent: string,
    options: {
      directUserText?: string
      replayInterruptedTurn?: boolean
      hideUserMessage?: boolean
      referencedPluginObjects?: LearnFlowPluginObject[]
    } = {},
  ) => {
    let conversation = workspace.conversations.find(item => item.id === conversationId)
    if (!conversation) {
      console.warn('[tutor-ui] ignored turn for missing conversation', { conversationId })
      return
    }
    const sheetId = conversation.activeSheetId
    const draftKey = surfaceKey(conversationId, sheetId)
    const content = rawContent.trim()
    if (!content || pendingTurns[conversationId]) {
      console.warn('[tutor-ui] ignored turn', {
        conversationId,
        reason: !content ? 'empty_content' : 'already_pending',
      })
      return
    }
    console.info('[tutor-ui] turn requested', {
      conversationId,
      sheetId,
      replayInterruptedTurn: Boolean(options.replayInterruptedTurn),
    })

    const now = Date.now()
    const priorLearningEventIds = new Set(conversation.learningEvents.map(item => item.id))
    const priorPlanningEventIds = new Set(conversation.planningEvents.map(item => item.id))
    let learningTasks = [...conversation.learningTasks]
    let learningEvents = [...conversation.learningEvents]
    let learningProjection = activeLearningTaskProjection(learningTasks, learningEvents)
    let learningPlans = [...conversation.learningPlans]
    let planningEvents = [...conversation.planningEvents]
    let planningProjection = activeLearningPlanProjection(learningPlans, planningEvents)
    let createdLocalTask: LearningTask | undefined
    let formalSessionId = conversation.formalSessionId
    const rememberFormalSession = (sessionId: number) => {
      formalSessionId = sessionId
      // Persist the scope before the next network request can fail or time out.
      setWorkspace(previous => ({
        ...previous,
        conversations: previous.conversations.map(item => item.id === conversationId
          ? { ...item, formalSessionId: sessionId } : item),
      }))
      return sessionId
    }
    let formalSkillRun: FormalLearningSkillRun | undefined
    let formalSnapshotForTurn = formalSnapshot
    const replayInterruptedTurn = Boolean(options.replayInterruptedTurn)
    const activeConversationMessages = activeMessages(conversation)
    const previousUserMessage = [...activeConversationMessages].reverse().find(item => item.role === 'user' && !item.hiddenFromTranscript)
    let preparedSkillTurn = Boolean(replayInterruptedTurn && previousUserMessage?.teachingInputRecordedBySkillTurn)
    const userMessageId = replayInterruptedTurn && previousUserMessage ? previousUserMessage.id : uid('message')
    const updateUserMessageMetadata = (patch: Partial<Message>) => setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(item => item.id === conversationId ? {
        ...item,
        messages: item.messages.map(message => message.id === userMessageId ? { ...message, ...patch } : message),
        sheets: item.sheets.map(sheet => ({ ...sheet,
          messages: sheet.messages.map(message => message.id === userMessageId ? { ...message, ...patch } : message),
        })),
      } : item),
    }))
    const clientTurnId = `vnext-turn:${userMessageId}`.slice(0, 120)
    const directUserText = options.hideUserMessage ? '' : options.directUserText?.trim() || (replayInterruptedTurn ? previousUserMessage?.directUserText || '' : '')
    const interruptedMode = previousUserMessage?.tutorMode
    const mode = replayInterruptedTurn && isTutorMode(interruptedMode)
      ? interruptedMode
      : conversation.projectRole === 'tutor'
      ? 'learning_plan'
      : conversation.projectRole === 'checkpoint'
        ? 'guided_learning'
        : resolveTutorMode(conversation.mode, content, Boolean(learningProjection))

    if (!replayInterruptedTurn && mode === 'guided_learning') {
      if (!learningProjection) {
        const created = createLearningTask(content, now, learningEvents, conversation.preferredSkillId)
        learningTasks = [...learningTasks, created.task]
        createdLocalTask = created.task
        learningEvents = created.events
        learningProjection = projectLearningTask(created.task, learningEvents)
      }
      if (learningProjection) {
        const step = currentLearningSkillStep(learningProjection)
        const supportRequested = isSupportRequest(content)
        const additions: Array<Omit<LearningEvent, 'id' | 'sequence' | 'taskId' | 'at'>> = [{
          type: 'vnext_learning_task_learner_replied',
          detail: `学生回应：${content.slice(0, 80)}`,
          skillId: learningProjection.skillId,
          stepId: step.id,
        }]
        if (supportRequested) additions.push(
          {
            type: 'vnext_learning_support_requested',
            detail: '学生需要补充支架，本轮不自动推进',
            skillId: learningProjection.skillId,
            stepId: step.id,
          },
          {
            type: 'vnext_learning_skill_looped',
            detail: `补充支架并重做：${step.title}`,
            skillId: learningProjection.skillId,
            stepId: step.id,
          },
        )
        learningEvents = appendLearningEvents(learningEvents, learningProjection.task.id, additions, now + 16)
        learningProjection = projectLearningTask(learningProjection.task, learningEvents)
        if (
          !createdLocalTask
          && !supportRequested
          && !learningProjection.task.formalSkillRunId
          && canAdvanceLearningSkillStep(learningProjection)
        ) {
          learningEvents = advanceLearningSkillStep(learningEvents, learningProjection, now + 24)
          learningProjection = projectLearningTask(learningProjection.task, learningEvents)
        }
      }
    }

    const visualPluginTurn = resolveExplicitVisualIntent(toolChoices[draftKey] || 'auto',content) !== 'none'
      || activeConversationPluginIds(conversation).includes('educational_visuals') && Boolean(directVisualWorkflowCall({message:content,kind:'none',requestId:'detect'}))
    const learningTaskConversionActive = activeConversationPluginIds(conversation)
      .includes('learning_task_conversion')
    if (!replayInterruptedTurn && mode === 'learning_plan' && !learningTaskConversionActive) {
      if (!planningProjection) {
        const created = createLearningPlan(content, now, planningEvents)
        learningPlans = [...learningPlans, created.plan]
        planningEvents = created.events
        planningProjection = projectLearningPlan(created.plan, planningEvents)
      } else {
        planningEvents = updateLearningPlan(planningEvents, planningProjection, content, now + 8)
        planningProjection = projectLearningPlan(planningProjection.plan, planningEvents)
      }
    }

    // The hosted web app uses the provider configured by the server proxy.
    // Learner-local provider fields only apply to the desktop runtime.
    const configurationIssue = isDesktopRuntime()
      ? tutorConfigurationIssue(workspace.settings.baseUrl, workspace.settings.model)
      : ''
    const optimisticTurnStep = learningProjection ? currentLearningSkillStep(learningProjection) : undefined

    // Paint the learner turn before any formal persistence or context work.
    // The awaited operations below remain authoritative, but they must not
    // block input acknowledgement or make the composer feel frozen.
    setPendingTurns(previous => ({ ...previous, [conversationId]: mode }))
    setLiveTurns(previous => ({
      ...previous,
      [conversationId]: {
        sheetId,
        messageId: uid('stream'),
        content: '',
        committedContent: '',
        toolRuns: [],
        decisionSummaries: [],
        phase: formalConnection.status === 'connected' ? '正在同步学习状态' : '正在理解问题',
        startedAt: Date.now(),
      },
    }))
    setWorkspace(previous => {
      const conversations = previous.conversations.map(item => {
        if (item.id !== conversationId) return item
        const firstStudentMessage = !hasVisibleStudentMessage(item.messages)
        const userMessage: Message = {
          id: userMessageId, role: 'user', content, createdAt: now, tutorMode: mode,
          persistedByTutor: isDesktopRuntime() && !visualPluginTurn,
          hiddenFromTranscript: Boolean(options.hideUserMessage),
          directUserText: directUserText || undefined,
          learningSkillId: learningProjection?.skillId,
          learningSubstateId: optimisticTurnStep?.substateId,
          learningSubstateLabel: optimisticTurnStep?.substateLabel,
        }
        return {
          ...item,
          title: !replayInterruptedTurn && !options.hideUserMessage && sheetId === 'main' && firstStudentMessage
            ? content.slice(0, 22)
            : item.title,
          updatedAt: now,
          learningTasks,
          learningEvents,
          learningPlans,
          planningEvents,
          messages: sheetId === 'main' && !replayInterruptedTurn ? [...item.messages, userMessage] : item.messages,
          sheets: sheetId === 'main' || replayInterruptedTurn ? item.sheets : item.sheets.map(sheet => (
            sheet.id === sheetId ? { ...sheet, messages: [...sheet.messages, userMessage] } : sheet
          )),
        }
      })
      const current = conversations.find(item => item.id === conversationId)
      if (!current) return previous
      return {
        ...previous,
        conversations,
        tabs: previous.tabs.map(tab => tab.conversationId === current.id ? { ...tab, title: current.title } : tab),
      }
    })
    if (!replayInterruptedTurn) setDrafts(previous => ({ ...previous, [draftKey]: '' }))

    // A global conversation is a valid place to prepare a WF03 task. The
    // backend candidate artifact does need a project boundary, so create and
    // bind that boundary only after the learner explicitly confirms the
    // prepared contract. Without this bridge the confirmation used to fall
    // back into Tutor and could start an unrelated visual/personalized lesson.
    const draftConfirmation = activeConversationPluginIds(conversation).includes('learning_task_conversion')
      ? parseLearningTaskDraftConfirmation(content)
      : undefined
    if (draftConfirmation && !conversation.projectId) {
      try {
        setLiveTurns(previous => previous[conversationId] ? {
          ...previous,
          [conversationId]: { ...previous[conversationId], phase: '正在建立 WF03 任务承载空间' },
        } : previous)
        const created = await createFormalProject({
          name: draftConfirmation.taskTitle.slice(0, 80),
          objective: draftConfirmation.taskTitle,
          expectedOutcome: '形成可复核的学习型任务步骤、知识点与技能点映射',
        })
        await createFormalProjectFreeSession(created.project.id, `${created.project.name} · WF03 转化`)
        const boundWorkspace = await loadFormalProject(created.project.id)
        formalSessionId = boundWorkspace.free_sessions[boundWorkspace.free_sessions.length - 1]?.session_id
        conversation = {
          ...conversation,
          projectId: boundWorkspace.project.id,
          projectRole: 'free',
          formalSessionId,
          projectSources: boundWorkspace.sources,
        }
        setFormalProjectWorkspaces(previous => ({ ...previous, [boundWorkspace.project.id]: boundWorkspace }))
        setFormalProjects(previous => [
          boundWorkspace.project,
          ...previous.filter(project => project.id !== boundWorkspace.project.id),
        ])
        setExpandedProjects(previous => ({ ...previous, [boundWorkspace.project.id]: true }))
        setWorkspace(previous => ({
          ...previous,
          conversations: previous.conversations.map(item => item.id === conversationId
            ? {
                ...item,
                projectId: boundWorkspace.project.id,
                projectRole: 'free',
                formalSessionId,
                projectSources: boundWorkspace.sources,
              }
            : item),
        }))
      } catch (error) {
        finishTurn(conversationId, sheetId, mode, {
          role: 'system',
          content: `学习型任务契约已经确认，但 WF03 任务承载空间创建失败：${error instanceof Error ? error.message : '未知错误'}。本轮没有进入个性化学习或其他 Tutor 功能。`,
        })
        return
      }
    }

    const retryFormalSkillTurn = replayInterruptedTurn && mode === 'guided_learning' && !preparedSkillTurn
      && Boolean(previousUserMessage?.formalSkillSyncPending) && Boolean(learningProjection)
    if ((!replayInterruptedTurn || retryFormalSkillTurn) && formalConnection.status === 'connected') {
      // Remember the intended formal action before even session/profile sync:
      // failure in those preceding requests must resume the same skill action.
      const skillSyncAction = mode === 'guided_learning' && learningProjection
        ? replayInterruptedTurn && previousUserMessage?.formalSkillSyncPending
          ? previousUserMessage.formalSkillSyncPending
          : createdLocalTask || !learningProjection.task.formalSkillRunId || !learningProjection.task.formalSkillRunVersion ? 'start' : 'advance'
        : undefined
      if (skillSyncAction) updateUserMessageMetadata({ formalSkillSyncPending: skillSyncAction })
      try {
        if (!conversation.projectId) {
          const session = await persistGlobalConversation(conversation)
          if (session) formalSessionId = rememberFormalSession(session.id)
        }
        const humanAdaptationSignals = detectHumanAdaptationSignals(directUserText)
        for (const [index, signal] of humanAdaptationSignals.entries()) {
          await syncFormalEvent({
            id: `human-adaptation:${clientTurnId}:${index}`,
            type: 'vnext_human_adaptation_requested',
            at: now + index,
            detail: '学习者明确提出当前教学适配需求',
            payload: {
              signal_kind: signal.signalKind,
              value: signal.value,
              strength: signal.strength,
              explicit: signal.explicit,
              evidence_quote: signal.evidenceQuote,
              conversation_id: conversationId,
              session_id: formalSessionId,
              project_id: conversation.projectId,
              checkpoint_id: conversation.checkpointId,
            },
          })
        }
        if (mode === 'learning_plan' && planningProjection) {
          const selfReport = directUserText ? extractPlanningProfileSelfReport(
            directUserText,
            planningGoalSummary(planningProjection),
          ) : null
          if (selfReport) {
            await syncFormalEvent({
              id: `planning-profile:${clientTurnId}`,
              type: 'vnext_planning_profile_self_reported',
              at: now + humanAdaptationSignals.length + 1,
              detail: '学习者在规划对话中明确提供当前基础、投入或实践经历',
              payload: {
                self_report: {
                  version: selfReport.version,
                  evidence_quote: selfReport.evidenceQuote,
                  education_stage: selfReport.educationStage,
                  weekly_hours: selfReport.weeklyHours,
                  current_load: selfReport.currentLoad,
                  knowledge_exposures: selfReport.knowledgeExposures,
                  knowledge_gaps: selfReport.knowledgeGaps,
                  practice_exposures: selfReport.practiceExposures,
                  goal_candidate: selfReport.goalCandidate,
                },
                planning_goal: planningGoalSummary(planningProjection),
                conversation_id: conversationId,
                session_id: formalSessionId,
                project_id: conversation.projectId,
                checkpoint_id: conversation.checkpointId,
              },
            })
          }
        }
        if (mode === 'guided_learning' && learningProjection) {
          if (!formalSessionId) {
            const session = await createFormalTutorSession(true, {
              projectId: conversation.projectId,
              checkpointId: conversation.checkpointId,
            })
            formalSessionId = rememberFormalSession(session.id)
          }
          const binding = learningProjection.task
          if (skillSyncAction === 'start') {
            const started = await startFormalLearningSkillRun(
              formalSessionId,
              learningProjection.skillId,
              binding.objective,
              `vnext-skill:${binding.id}`.slice(0, 120),
              conversation.projectId ? [] : conversation.domainSources.map(source => source.id),
              binding.formalTaskId,
            )
            formalSkillRun = started.active_skill_run
            updateUserMessageMetadata({ formalSkillSyncPending: undefined })
          } else {
            if (!binding.formalSkillRunId || !binding.formalSkillRunVersion) throw new Error('待恢复的正式学习回合缺少技能绑定')
            const advanced = await advanceFormalLearningSkillTurn(
              formalSessionId,
              binding.formalSkillRunId,
              content,
              binding.formalSkillRunVersion,
              clientTurnId,
              conversation.projectId ? [] : conversation.domainSources.map(source => source.id),
              directUserText,
            )
            formalSkillRun = advanced.active_skill_run
            preparedSkillTurn = true
            updateUserMessageMetadata({ teachingInputRecordedBySkillTurn: true, formalSkillSyncPending: undefined })
          }
          learningTasks = learningTasks.map(task => task.id === binding.id && formalSkillRun
            ? bindFormalSkillRun(task, formalSkillRun)
            : task)
          const linkedTask = learningTasks.find(task => task.id === binding.id)
          if (linkedTask && formalSkillRun) {
            learningProjection = projectLearningTask(linkedTask, learningEvents)
            learningEvents = reconcileLearningEventsWithFormalSkillRun(
              learningEvents, learningProjection, formalSkillRun, now + 24,
            )
            learningProjection = projectLearningTask(linkedTask, learningEvents)
          }
          formalSnapshotForTurn = await loadFormalLearnerSnapshot()
          setFormalSnapshot(formalSnapshotForTurn)
          setWorkspace(previous => ({
            ...previous,
            learningPath: learnerPathStateFromFormal(formalSnapshotForTurn!.learning_path),
          }))
        }
        const atomicEvents = [
          ...learningEvents.filter(item => !priorLearningEventIds.has(item.id) && !formalSkillRun),
          ...planningEvents.filter(item => !priorPlanningEventIds.has(item.id)),
        ]
        await syncFormalEvent({
          id: `chat-mode:${conversationId}:${now}`,
          type: 'chat_mode_entered',
          at: now,
          detail: `对话进入${TUTOR_MODE_LABELS[mode]}`,
          payload: {
            mode: formalModeId(mode), previous_mode: formalModeId(conversation.mode),
            conversation_id: conversationId, session_id: formalSessionId,
            project_id: conversation.projectId, checkpoint_id: conversation.checkpointId,
          },
        })
        await syncFormalEvents(atomicEvents)
      } catch (error) {
        const detail = error instanceof Error ? error.message : '原子事件同步失败'
        setFormalError(detail)
        if (mode === 'guided_learning') {
          // Do not fall through to a second evidence channel when the first
          // request may have committed but its response was lost.
          finishTurn(conversationId, sheetId, mode, {
            role: 'system', retryableTutorError: true,
            content: `本轮学习状态同步未确认，暂未开始回答：${detail}。请点击重新回答，系统会沿用本轮标识核对并继续。`,
          })
          return
        }
      }
    }

    // Complete the authoritative immediate-state write before the Tutor reads
    // context. Replay reuses the persisted message ID, so it cannot add evidence.
    if (!isDesktopRuntime() && !preparedSkillTurn && formalConnection.status === 'connected' && directUserText) {
      try {
        if (!formalSessionId) {
          const session = await createFormalTutorSession(true, {
            projectId: conversation.projectId, checkpointId: conversation.checkpointId,
          })
          formalSessionId = rememberFormalSession(session.id)
        }
        await syncFormalTeachingInput({
          messageId: userMessageId,
          text: directUserText,
          occurredAt: replayInterruptedTurn && previousUserMessage ? previousUserMessage.createdAt : now,
          sessionId: formalSessionId,
          projectId: conversation.projectId,
          checkpointId: conversation.checkpointId,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : '同步失败'
        setFormalError(`本轮教学需求尚未保存：${detail}`)
        finishTurn(conversationId, sheetId, mode, {
          role: 'system',
          retryableTutorError: true,
          content: `本轮教学需求尚未保存，暂未开始回答：${detail}。请重试。`,
        })
        return
      }
    }

    // Reconcile the optimistic browser projection with the formal IDs and
    // SkillRun state obtained above. This updates metadata only; the user
    // message was already inserted exactly once.
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(item => item.id === conversationId ? {
        ...item,
        formalSessionId,
        pluginIds: stickyConversationPluginIds(activeConversationPluginIds(item),visualPluginTurn ? ['educational_visuals'] : []),
        learningTasks,
        learningEvents,
        learningPlans,
        planningEvents,
        updatedAt: Date.now(),
      } : item),
    }))

    const contextMessages = buildTutorContextMessages(
      inheritedContextMessages(conversation),
      content,
      replayInterruptedTurn,
    )
    const turnStep = learningProjection ? currentLearningSkillStep(learningProjection) : undefined
    const directLearningTaskPluginTurn = Boolean(
      activeConversationPluginIds(conversation).includes('learning_task_conversion')
      && content.trim().length >= 2,
    )

    if (configurationIssue && !directLearningTaskPluginTurn) {
      finishTurn(conversationId, sheetId, mode, {
        role: 'system',
        content: `本轮已识别为“${TUTOR_MODE_LABELS[mode]}”，但模型连接还不能使用：${configurationIssue}`,
        learningSkillId: learningProjection?.skillId,
        learningSubstateId: turnStep?.substateId,
        learningSubstateLabel: turnStep?.substateLabel,
      })
      return
    }

    setLiveTurns(previous => previous[conversationId] ? {
      ...previous,
      [conversationId]: { ...previous[conversationId], phase: '正在装配观察空间' },
    } : previous)

    try {
      const formalTaskForTurn = learningProjection?.task.formalTaskId
        ? formalSnapshotForTurn?.learning_tasks.find(task => task.id === learningProjection.task.formalTaskId)
        : undefined
      const reply = await requestTutorReply({
        directUserText,
        clientTurnId,
        baseUrl: workspace.settings.baseUrl,
        model: workspace.settings.model,
        mode,
        messages: contextMessages,
        toolChoice: toolChoices[draftKey] || 'auto',
        selectionContext: activeSheet(conversation)?.quote,
        activeArtifactContext: activeSheet(conversation)?.artifact,
        learningTaskContext: learningProjection ? learningTaskTutorContext(learningProjection) : undefined,
        learningPlanContext: planningProjection ? {
          ...learningPlanTutorContext(planningProjection),
          ...(!isDesktopRuntime() ? {
            kindLabel: conversation.projectId ? '项目学习规划' : '方向与长期学习规划',
            nextQuestion: conversation.projectSources?.some(source => source.status === 'processed')
              ? '依据已选资料与已有目标设置关卡和长期安排；只澄清影响安排的基础或时间缺口'
              : '先读取项目或个人资料库；已有合适资料则规划关卡与时间，否则推荐教材和仓库并邀请选择或上传；不要先逼问工程产物',
          } : {}),
        } : undefined,
        learnerPathState: formalSnapshotForTurn
          ? learnerPathStateFromFormal(formalSnapshotForTurn.learning_path)
          : workspace.learningPath,
        taskQueue: (formalSnapshotForTurn?.learning_tasks || []).map(task => ({
          id: task.id,
          objective: task.objective,
          status: task.status,
          sourceType: task.origin_kind,
          sourceId: task.source_refs[0] ? JSON.stringify(task.source_refs[0]).slice(0, 160) : undefined,
          version: task.version,
          artifactRefs: taskLearningFiles(task),
          updatedAt: task.updated_at || undefined,
        })),
        knowledgeDomains: [],
        formalScope: {
          sessionId: formalSessionId,
          projectId: conversation.projectId || formalTaskForTurn?.project_id || undefined,
          checkpointId: conversation.checkpointId || formalTaskForTurn?.checkpoint_id || undefined,
          projectRole: conversation.projectRole,
        },
        domainSourceIds: conversation.projectId ? [] : conversation.domainSources.map(source => source.id),
        conversationId,
        sheetId,
        activePluginIds: stickyConversationPluginIds(activeConversationPluginIds(conversation),visualPluginTurn ? ['educational_visuals'] : []),
        referencedPluginObjects: options.referencedPluginObjects,
        onEvent: event => updateLiveTurn(conversationId, event),
      })
      const finishedMessage = finishTurn(conversationId, sheetId, mode, {
        role: 'assistant', content: reply.reply, reasoningContent: reply.reasoningContent, toolRuns: reply.toolRuns, agentTrace: reply.trace,
        persistedByTutor: isDesktopRuntime() && !visualPluginTurn,
        learningSkillId: learningProjection?.skillId,
        learningSubstateId: turnStep?.substateId,
        learningSubstateLabel: turnStep?.substateLabel,
        learningTaskId: learningProjection?.task.id,
        formalTaskId: learningProjection?.task.formalTaskId,
        learningGoal: learningProjection?.task.objective
          || (planningProjection ? planningGoalSummary(planningProjection) : content),
        learningGoalKind: learningProjection
          ? 'learning_task'
          : planningProjection ? 'planning_goal' : 'conversation_topic',
      }, formalSessionId)
      const generatedCandidateRun = reply.toolRuns.find(run => (
        run.status === 'completed'
        && run.plugin?.pluginId === 'learning_task_conversion'
        && run.plugin.result.objects?.some(object => object.objectType === 'learning_task_candidate')
      ))
      if (generatedCandidateRun) {
        openPluginResultPaper(conversationId, finishedMessage.id, generatedCandidateRun)
      }
      setToolChoices(previous => ({ ...previous, [draftKey]: 'auto' }))
    } catch (error) {
      finishTurn(conversationId, sheetId, mode, {
        role: 'system',
        content: `“${TUTOR_MODE_LABELS[mode]}”请求失败：${error instanceof Error ? error.message : '未知错误'}`,
        learningSkillId: learningProjection?.skillId,
        learningSubstateId: turnStep?.substateId,
        learningSubstateLabel: turnStep?.substateLabel,
      }, formalSessionId)
    }
  }

  const sendMessage = async (conversationId: string, event: FormEvent) => {
    event.preventDefault()
    const conversation = workspace.conversations.find(item => item.id === conversationId)
    if (!conversation) return
    const draftKey = surfaceKey(conversationId, conversation.activeSheetId)
    const references = pluginDraftReferences[draftKey] || []
    const message = (drafts[draftKey] || '').trim() || (references.length ? '请解释我引用的插件对象。' : '')
    const content = references.length
      ? `${message}\n\n引用插件对象（固定到产生它们的 ToolRun）：\n${references.map(pluginObjectReferenceText).join('\n')}`
      : message
    if (!content.trim()) return
    setPluginDraftReferences(previous => ({ ...previous, [draftKey]: [] }))
    await runTutorTurn(conversationId, content, { directUserText: message, referencedPluginObjects: references })
  }

  const updateLearningTask = async (
    conversationId: string,
    action: 'pause' | 'resume' | 'complete' | 'verify' | 'skill',
    skillId?: LearningSkillId,
  ) => {
    if (pendingTurns[conversationId] || learningActionLocks.current.has(conversationId)) return
    learningActionLocks.current.add(conversationId)
    try {
    await fileProgressSyncs.current.get(conversationId)
    const conversation = workspaceRef.current.conversations.find(item => item.id === conversationId)
    if (!conversation) return
    const projection = latestLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
    if (!projection || projection.status === 'completed') return
    let learningTasks = conversation.learningTasks
    let learningEvents = conversation.learningEvents
    let effectiveAction = action
    if (
      formalConnection.status === 'connected'
      && conversation.formalSessionId
      && projection.task.formalSkillRunId
      && projection.task.formalSkillRunVersion
    ) {
      try {
        let run: FormalLearningSkillRun | undefined
        if (action === 'skill' && isLearningSkillId(skillId)) {
          const started = await startFormalLearningSkillRun(
            conversation.formalSessionId,
            skillId,
            projection.task.objective,
            `vnext-skill-switch:${projection.task.id}:${projection.task.formalSkillRunVersion}:${skillId}`.slice(0, 120),
            [],
            projection.task.formalTaskId,
          )
          run = started.active_skill_run
        } else {
          const requestedAction = action === 'verify'
            ? 'start_verification'
            : action === 'complete' ? 'pause' : action
          if (requestedAction === 'pause' || requestedAction === 'resume' || requestedAction === 'start_verification') {
            const updated = await actOnFormalLearningSkillRun(
              conversation.formalSessionId,
              { id: projection.task.formalSkillRunId, version: projection.task.formalSkillRunVersion },
              requestedAction,
            )
            run = updated.active_skill_run
            if (action === 'complete') effectiveAction = 'pause'
          }
        }
        if (run) {
          learningTasks = learningTasks.map(task => task.id === projection.task.id
            ? bindFormalSkillRun(task, run!)
            : task)
          await refreshFormalSnapshot()
        }
      } catch (error) {
        setFormalError(error instanceof Error ? error.message : '正式 SkillRun 状态同步失败')
        return
      }
    } else if (action === 'verify') {
      setFormalError('正式 SkillRun 未连接，不能创建可验证学习附件。')
      return
    }
    if (effectiveAction === 'verify') {
      setVerificationConversationId(conversationId)
    } else if (effectiveAction === 'skill') {
      learningEvents = switchLearningSkill(learningEvents, projection, skillId || projection.skillId, Date.now())
    } else {
      const event = effectiveAction === 'pause'
        ? { type: 'vnext_learning_task_paused' as const, detail: '暂停学习任务' }
        : effectiveAction === 'resume'
          ? { type: 'vnext_learning_task_resumed' as const, detail: '恢复学习任务' }
          : { type: 'vnext_learning_task_completed' as const, detail: '结束本段 Skill 流程；不代表掌握，正式任务仍需可检查证据' }
      learningEvents = appendLearningEvents(learningEvents, projection.task.id, [event], Date.now())
    }
    const previousIds = new Set(conversation.learningEvents.map(item => item.id))
    const newEvents = learningEvents.filter(item => !previousIds.has(item.id))
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(item => item.id === conversationId ? {
        ...item,
        learningTasks,
        learningEvents,
        mode: effectiveAction === 'resume' || effectiveAction === 'skill' || effectiveAction === 'verify' ? 'guided_learning' : 'free',
        preferredSkillId: effectiveAction === 'complete' ? undefined : item.preferredSkillId,
        updatedAt: Date.now(),
      } : item),
    }))
    if (formalConnection.status === 'connected') {
      try {
        await syncFormalEvents(newEvents)
        const formalTask = formalSnapshot?.learning_tasks.find(item => item.id === projection.task.formalTaskId)
        if (!projection.task.formalSkillRunId && formalTask && (effectiveAction === 'pause' || effectiveAction === 'resume')) {
          const updated = await actOnFormalLearningTask(formalTask, effectiveAction)
          setFormalSnapshot(previous => previous ? {
            ...previous,
            learning_tasks: previous.learning_tasks.map(item => item.id === updated.id ? updated : item),
          } : previous)
        }
      } catch (error) {
        setFormalError(error instanceof Error ? error.message : '学习任务状态同步失败')
      }
    }
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '学习进度暂未同步，请重试。')
    } finally { learningActionLocks.current.delete(conversationId) }
  }

  const selectLearningSkill = (conversationId: string, value: string) => {
    if (pendingTurns[conversationId]) return
    const conversation = workspace.conversations.find(item => item.id === conversationId)
    if (!conversation) return
    const activeProjection = activeLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
    const latestProjection = latestLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
    if (latestProjection?.status === 'paused') return
    if (activeProjection && isLearningSkillId(value)) {
      updateLearningTask(conversationId, 'skill', value)
      return
    }
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(item => item.id === conversationId
        ? {
            ...item,
            mode: 'guided_learning',
            preferredSkillId: isLearningSkillId(value) ? value : undefined,
            updatedAt: Date.now(),
          }
        : item),
    }))
  }

  const calibrateFeynmanSkill = async (
    conversationId: string,
    patch: Record<string, string>,
  ) => {
    const conversation = workspace.conversations.find(item => item.id === conversationId)
    if (!conversation?.formalSessionId || formalConnection.status !== 'connected') return
    const projection = latestLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
    if (
      !projection
      || projection.skillId !== 'feynman_dialogue'
      || !projection.task.formalSkillRunId
      || !projection.task.formalSkillRunVersion
    ) return
    const busyKey = `skill-calibration:${projection.task.formalSkillRunId}`
    setFormalBusyKey(busyKey)
    try {
      const updated = await actOnFormalLearningSkillRun(
        conversation.formalSessionId,
        {
          id: projection.task.formalSkillRunId,
          version: projection.task.formalSkillRunVersion,
        },
        'calibrate',
        patch as Partial<{
          audience_level: string
          cognitive_demand: string
          scaffold_level: string
          representation_mode: string
        }>,
      )
      setWorkspace(previous => ({
        ...previous,
        conversations: previous.conversations.map(item => item.id === conversationId ? {
          ...item,
          learningTasks: item.learningTasks.map(task => task.id === projection.task.id
            ? bindFormalSkillRun(task, updated.active_skill_run)
            : task),
          updatedAt: Date.now(),
        } : item),
      }))
      await refreshFormalSnapshot()
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '费曼复述校准失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const updateValueProposal = async (
    conversationId: string,
    projection: LearningPlanProjection,
    decision: Exclude<ValueProposalDecision, 'proposed'>,
    draftKey?: string,
  ) => {
    if (pendingTurns[conversationId]) return
    const conversation = workspace.conversations.find(item => item.id === conversationId)
    if (!conversation || !projection.valueProposal) return
    let formalWriteCompleted = false
    if (decision === 'accepted' && formalConnection.status === 'connected') {
      setFormalBusyKey(`value:${projection.valueProposal.id}`)
      try {
        await confirmFormalValueClaim(projection.valueProposal, `value-confirm:${projection.valueProposal.id}`)
        formalWriteCompleted = true
        await refreshFormalSnapshot()
      } catch (error) {
        setFormalError(error instanceof Error ? error.message : '价值核确认写入失败')
      } finally {
        setFormalBusyKey('')
      }
    }
    const planningEvents = decideValueClaimProposal(
      conversation.planningEvents, projection, decision, Date.now(), formalWriteCompleted,
    )
    const newEvents = planningEvents.filter(item => !conversation.planningEvents.some(previous => previous.id === item.id))
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => conversation.id === conversationId
        ? {
            ...conversation,
            planningEvents,
            updatedAt: Date.now(),
          }
        : conversation),
    }))
    if (decision === 'revision_requested' && draftKey) {
      setDrafts(previous => ({ ...previous, [draftKey]: '我希望把价值核建议改成：' }))
    }
    if (decision !== 'accepted' && formalConnection.status === 'connected') {
      void syncFormalEvents(newEvents).catch(error => setFormalError(error instanceof Error ? error.message : '价值核决定事件同步失败'))
    }
  }

  const finishLearningPlan = (conversationId: string, projection: LearningPlanProjection) => {
    if (pendingTurns[conversationId]) return
    const current = workspace.conversations.find(item => item.id === conversationId)
    if (!current) return
    const planningEvents = closeLearningPlan(current.planningEvents, projection)
    const additions = planningEvents.filter(item => !current.planningEvents.some(previous => previous.id === item.id))
    setWorkspace(previous => ({
      ...previous,
      conversations: previous.conversations.map(conversation => conversation.id === conversationId
        ? {
            ...conversation,
            mode: 'free',
            planningEvents,
            updatedAt: Date.now(),
          }
        : conversation),
    }))
    if (formalConnection.status === 'connected') {
      void syncFormalEvents(additions).catch(error => setFormalError(error instanceof Error ? error.message : '规划结束事件同步失败'))
    }
  }

  const updateSettings = (patch: Partial<SettingsState>) => {
    setWorkspace(previous => ({ ...previous, settings: { ...previous.settings, ...patch } }))
  }

  const updatePathStatus = async (nodeId: string, status: LearnerPathStatus) => {
    const nodeTitle = projectLearnerPath(workspace.learningPath).nodes.find(node => node.id === nodeId)?.title || nodeId
    if (formalConnection.status !== 'connected') {
      setWorkspace(previous => ({ ...previous, learningPath: setLearnerPathStatus(previous.learningPath, nodeId, status) }))
      setFormalError('正式事件链离线：该标记目前只保存在本机，恢复连接后请重新确认。')
      return
    }
    setFormalBusyKey(`path:${nodeId}`)
    try {
      const result = await setFormalPathStatus(nodeId, nodeTitle, status, `path-status:${nodeId}:${status}:${Date.now()}`)
      setWorkspace(previous => ({ ...previous, learningPath: learnerPathStateFromFormal(result.learning_path) }))
      await refreshFormalSnapshot()
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '学习路径状态写入失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const acceptPersonalPathNode = async (proposal: PersonalPathNodeProposal) => {
    if (formalConnection.status !== 'connected') {
      setWorkspace(previous => ({ ...previous, learningPath: addPersonalPathNode(previous.learningPath, proposal) }))
      setFormalError('正式事件链离线：个人节点目前只保存在本机。')
      return
    }
    setFormalBusyKey(`path:${proposal.id}`)
    try {
      const result = await addFormalPersonalPathNode(proposal, `personal-path-add:${proposal.id}`)
      setWorkspace(previous => ({ ...previous, learningPath: learnerPathStateFromFormal(result.learning_path) }))
      await refreshFormalSnapshot()
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '个人路径节点写入失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const acceptLearningPathPlan = async (proposal: LearningPathPlanProposal) => {
    setPathPlanWriteErrors(previous => ({ ...previous, [proposal.id]: '' }))
    if (formalConnection.status !== 'connected') {
      setWorkspace(previous => ({ ...previous, learningPath: commitLearningPathPlan(previous.learningPath, proposal) }))
      const detail = '正式事件链离线：长期学习路径仅保存在本机，尚未进入五核上下文。'
      setFormalError(detail)
      setPathPlanWriteErrors(previous => ({ ...previous, [proposal.id]: detail }))
      return
    }
    setFormalBusyKey(`path-plan:${proposal.id}`)
    setFormalError('')
    try {
      const result = await commitFormalLearningPathPlan(proposal, `path-plan:${proposal.id}:confirm`)
      setWorkspace(previous => ({ ...previous, learningPath: learnerPathStateFromFormal(result.learning_path) }))
      await refreshFormalSnapshot(true)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '长期学习路径写入失败'
      setFormalError(detail)
      setPathPlanWriteErrors(previous => ({ ...previous, [proposal.id]: detail }))
    } finally {
      setFormalBusyKey('')
    }
  }

  const archivePathPlan = async (planId: string) => {
    if (formalConnection.status !== 'connected') {
      setWorkspace(previous => ({ ...previous, learningPath: archiveLearningPathPlan(previous.learningPath, planId) }))
      setFormalError('正式事件链离线：归档只保存在本机。')
      return
    }
    setFormalBusyKey(`path-plan:${planId}`)
    setFormalError('')
    try {
      const result = await archiveFormalLearningPathPlan(planId, `path-plan:${planId}:archive`)
      setWorkspace(previous => ({ ...previous, learningPath: learnerPathStateFromFormal(result.learning_path) }))
      await refreshFormalSnapshot(true)
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '长期学习路径归档失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const deletePersonalPathNode = async (nodeId: string) => {
    const nodeTitle = projectLearnerPath(workspace.learningPath).nodes.find(node => node.id === nodeId)?.title || nodeId
    if (formalConnection.status !== 'connected') {
      setWorkspace(previous => ({ ...previous, learningPath: removePersonalPathNode(previous.learningPath, nodeId) }))
      setFormalError('正式事件链离线：移除动作目前只保存在本机。')
      return
    }
    setFormalBusyKey(`path:${nodeId}`)
    try {
      const result = await removeFormalPersonalPathNode(nodeId, nodeTitle, `personal-path-remove:${nodeId}:${Date.now()}`)
      setWorkspace(previous => ({ ...previous, learningPath: learnerPathStateFromFormal(result.learning_path) }))
      await refreshFormalSnapshot()
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '个人路径节点移除失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const updateFormalMemoryArchive = async (memoryId: string, archived: boolean) => {
    setFormalBusyKey(`memory:${memoryId}`)
    setFormalError('')
    try {
      await setFormalMemoryArchived(memoryId, archived)
      await refreshFormalSnapshot(true)
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '记忆归档失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const updateFormalClaim = async (claimId: number, action: 'confirm' | 'correct' | 'retract', correction = '') => {
    setFormalBusyKey(`claim:${claimId}`)
    setFormalError('')
    try {
      await submitFormalClaimFeedback(claimId, action, correction, action === 'retract' ? '学习者明确撤回该 Claim' : '')
      await refreshFormalSnapshot(true)
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : 'Claim 更新失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const recordConceptSelfReport = async (rawText: string) => {
    setFormalBusyKey('concept-report')
    setFormalError('')
    try {
      const result = await recordFormalConceptStatement(
        rawText,
        `concept-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      )
      setFormalSnapshot(previous => previous ? { ...previous, concept_graph: result.concept_graph } : previous)
      await refreshFormalSnapshot(true)
      return true
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '概念自述写入失败')
      return false
    } finally {
      setFormalBusyKey('')
    }
  }

  const updateExplicitLearnerProfile = async (patch: FormalLearnerProfilePatch) => {
    setFormalBusyKey('profile-edit')
    setFormalError('')
    try {
      const result = await updateFormalLearnerProfile(patch)
      setFormalSnapshot(previous => previous ? { ...previous, profile: result.profile } : previous)
      await refreshFormalSnapshot(true)
      return true
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '五核明确资料更新失败')
      return false
    } finally {
      setFormalBusyKey('')
    }
  }

  const updateFormalTask = async (task: NonNullable<FormalLearnerSnapshot['learning_tasks'][number]>, action: FormalLearningTaskAction) => {
    setFormalBusyKey(`task:${task.id}`)
    setFormalError('')
    try {
      const updated = await actOnFormalLearningTask(task, action)
      setFormalSnapshot(previous => previous ? {
        ...previous,
        learning_tasks: previous.learning_tasks.map(item => item.id === updated.id ? updated : item),
      } : previous)
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '正式学习任务更新失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const learningScopeForFile = (conversationId: string | undefined, kind: 'lecture' | 'practice', ref: string) => {
    const conversation = workspace.conversations.find(item => item.id === conversationId)
    const projection = conversation && latestLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
    const task = formalSnapshot?.learning_tasks.find(item => item.id === projection?.task.formalTaskId)
    const belongs = taskLearningFiles(task).some(file => file.kind === kind && file.ref === ref)
    return belongs ? { formalSessionId: conversation?.formalSessionId, learningTaskId: task?.id } : {}
  }

  // File operations use persisted facts to reconcile the same run; no synthetic user turn.
  const syncLearningFileProgress = async (conversationId?: string) => {
    if (!conversationId) return
    const previousSync = fileProgressSyncs.current.get(conversationId) || Promise.resolve()
    const nextSync = previousSync.catch(() => undefined).then(async () => {
      const conversation = workspaceRef.current.conversations.find(item => item.id === conversationId)
      if (!conversation?.formalSessionId) return
      const session = await loadFormalTutorSession(conversation.formalSessionId)
      const previousRun = session.active_skill_run
      if (!previousRun) return
      let result = { active_skill_run: previousRun }
      if (previousRun.skill.id === 'learning_file_study' && previousRun.status === 'active') {
        try { result = await actOnFormalLearningSkillRun(conversation.formalSessionId, previousRun, 'sync_artifacts') }
        catch (error) {
          if (!(error instanceof Error) || !/version_conflict|版本|409/.test(error.message)) throw error
          const latest = (await loadFormalTutorSession(conversation.formalSessionId)).active_skill_run
          if (!latest || latest.id !== previousRun.id || latest.status !== 'active') return
          result = await actOnFormalLearningSkillRun(conversation.formalSessionId, latest, 'sync_artifacts')
        }
      }
      const run = result.active_skill_run
      if (!run) return
      setWorkspace(previous => ({
        ...previous,
        conversations: previous.conversations.map(item => {
          if (item.id !== conversationId) return item
          let tasks = item.learningTasks
          let events = item.learningEvents
          let projection = latestLearningTaskProjection(tasks, events)
          if (projection?.task.formalSkillRunId && projection.task.formalSkillRunId > run.id) return item
          if (!projection || projection.task.formalSkillRunId !== run.id) {
            const restored = restoreFormalSkillRunBinding(tasks, events, run)
            if (!restored) return item
            tasks = restored.tasks
            events = restored.events
            projection = restored.projection
          }
          if ((projection.task.formalSkillRunVersion || 0) > run.version) return item
          const messageId = `file-progress:${run.id}:${run.state}`
          const content = fileProgressMessage(run.state)
          const changed = projection.task.formalSkillState !== run.state
          return {
            ...item,
            mode: run.status === 'completed' ? 'free' as const : run.status === 'paused' ? item.mode : 'guided_learning' as const,
            preferredSkillId: run.skill.id,
            learningTasks: tasks.map(task => task.id === projection.task.id ? bindFormalSkillRun(task, run) : task),
            learningEvents: reconcileLearningEventsWithFormalSkillRun(events, projection, run, Date.now()),
            messages: changed && content && !item.messages.some(message => message.id === messageId)
              ? [...item.messages, { id: messageId, role: 'system' as const, content, createdAt: Date.now() }]
              : item.messages,
            updatedAt: Date.now(),
          }
        }),
      }))
      await refreshFormalSnapshot(true)
    })
    fileProgressSyncs.current.set(conversationId, nextSync)
    try { await nextSync } finally {
      if (fileProgressSyncs.current.get(conversationId) === nextSync) fileProgressSyncs.current.delete(conversationId)
    }
  }

  useEffect(() => {
    if (formalConnection.status !== 'connected' || !activeConversation?.formalSessionId) return
    void syncLearningFileProgress(activeConversation.id).catch(error => {
      setFormalError(error instanceof Error ? error.message : '学习进度恢复失败，请重试。')
    })
  }, [formalConnection.status, activeConversation?.id, activeConversation?.formalSessionId])

  useEffect(() => {
    const onProgress = (event: Event) => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId
      void syncLearningFileProgress(conversationId).catch(error => setFormalError(error instanceof Error ? error.message : '文件已保存，学习进度续接失败'))
    }
    window.addEventListener('learnflow-learning-file-progress', onProgress)
    return () => window.removeEventListener('learnflow-learning-file-progress', onProgress)
  }, [])

  const openTaskLearningFile = async (conversationId: string, kind?: 'lecture' | 'practice') => {
    try {
      await syncLearningFileProgress(conversationId)
      const conversation = workspaceRef.current.conversations.find(item => item.id === conversationId)
      if (!conversation) return
      const projection = latestLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
      const snapshot = await loadFormalLearnerSnapshot(true)
      const task = snapshot.learning_tasks.find(item => item.id === projection?.task.formalTaskId)
      const targetKind = kind || fileKindForStage(projection?.task.formalSkillState)
      const file = taskLearningFiles(task).find(item => item.kind === targetKind)
      if (!file) {
        if (task) {
          const proposal: ProjectLearningFileProposal = {
            schema_version: 'vnext.learning-file-proposal.v2', learning_task_id: task.id,
            checkpoint_title: task.title, file_kinds: projection?.task.formalSkillState === 'selecting_learning_artifact' ? ['lecture', 'practice'] : [targetKind], source_strategy: 'task_sources_first',
            confirmation_required: true, mastery_unchanged: true,
          }
          setWorkspace(previous => ({ ...previous, conversations: previous.conversations.map(item => {
            if (item.id !== conversationId) return item
            const alreadyProposed = item.messages.some(message => message.toolRuns?.some(run => run.projectLearningFileProposal?.learning_task_id === task.id
              && run.projectLearningFileProposal.file_kinds.includes(targetKind)))
            return { ...item, activeSheetId: 'main', messages: alreadyProposed ? item.messages : [...item.messages, {
              id: `file-proposal:${task.id}:${targetKind}`, role: 'system' as const, createdAt: Date.now(),
              content: '这份文件尚未生成。确认后会保存到当前任务，已有内容会保留。',
              toolRuns: [{ id: `file-proposal:${task.id}:${targetKind}`, kind: 'file' as const, status: 'completed' as const,
                title: '学习文件待确认', detail: '等待确认生成。', durationMs: 0, projectLearningFileProposal: proposal }],
            }] }
          }) }))
        }
        return
      }
      attachLearningFileToConversation(file, conversationId)
    } catch (error) { setFormalError(error instanceof Error ? error.message : '学习文件打开失败') }
  }

  const generateTaskFiles = async (task: NonNullable<FormalLearnerSnapshot['learning_tasks'][number]>) => {
    setFormalBusyKey(`task:${task.id}`)
    setFormalError('')
    try {
      const updated = await generateFormalLearningFiles(task)
      setFormalSnapshot(previous => previous ? {
        ...previous,
        learning_tasks: previous.learning_tasks.map(item => item.id === updated.id ? updated : item),
      } : previous)
      openTab(LEARNING_FILES_TAB)
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '讲义与练习生成失败')
    } finally {
      setFormalBusyKey('')
    }
  }

  const acceptProjectRoadmap = async (proposal: ProjectRoadmapProposal) => {
    setFormalBusyKey(`project-roadmap:${proposal.project_id}`)
    setFormalError('')
    try {
      const projectWorkspace = proposal.operation === 'revise'
        ? await reviseFormalProjectRoadmap(proposal.project_id, proposal)
        : await applyFormalProjectRoadmap(proposal.project_id, proposal)
      syncProjectWorkspace(projectWorkspace)
      await refreshFormalSnapshot(true)
      openTab({ id: `project:${proposal.project_id}`, kind: 'project', title: proposal.project_theme, projectId: proposal.project_id })
    } catch (error) {
      setFormalError(error instanceof Error ? error.message : '项目路线应用失败')
    } finally { setFormalBusyKey('') }
  }

  const acceptProjectLearningFileProposal = async (proposal: ProjectLearningFileProposal, conversationId?: string) => {
    if (fileGenerationLocks.current.has(proposal.learning_task_id)) return
    fileGenerationLocks.current.add(proposal.learning_task_id)
    setFormalBusyKey(`project-file:${proposal.learning_task_id}`)
    setLearningFileProposalErrors(previous => ({ ...previous, [proposal.learning_task_id]: '' }))
    try {
      const snapshot = await loadFormalLearnerSnapshot(true)
      const task = snapshot.learning_tasks.find(item => item.id === proposal.learning_task_id)
      if (!task) throw new Error('正式学习任务已经变化，请刷新项目后重试')
      const boundConversation = workspaceRef.current.conversations.find(item => item.id === conversationId)
      const boundTask = boundConversation && latestLearningTaskProjection(boundConversation.learningTasks, boundConversation.learningEvents)
      if (boundTask?.task.formalTaskId && boundTask.task.formalTaskId !== task.id) throw new Error('这是另一项学习任务的文件提案，请先从学习任务中返回该任务。')
      const updated = await generateFormalLearningFiles(task, proposal.file_kinds)
      const files = taskLearningFiles(updated)
      const gaps = updated.file_generation?.gaps || []
      const requestedReady = proposal.file_kinds.every(kind => files.some(file => file.kind === kind))
      if (!requestedReady) setLearningFileProposalErrors(previous => ({
        ...previous, [proposal.learning_task_id]: gaps.join('；') || '部分文件尚未准备好，可补充资料后重试。',
      }))
      setWorkspace(previous => ({
        ...previous,
        conversations: previous.conversations.map(item => {
          if (item.id !== conversationId) return item
          const updateMessages = (messages: Message[]) => messages.map(message => ({ ...message,
            toolRuns: message.toolRuns?.map(run => run.projectLearningFileProposal?.learning_task_id === updated.id
              ? { ...run, materializedLearningFiles: files, title: requestedReady ? '学习文件已准备好' : '学习文件部分就绪', detail: requestedReady ? '打开讲义阅读，或进入配对练习。' : gaps.join('；') }
              : run),
          }))
          return { ...item, messages: updateMessages(item.messages), sheets: item.sheets.map(sheet => ({ ...sheet, messages: updateMessages(sheet.messages) })) }
        }),
      }))
      await refreshFormalSnapshot(true)
      const preferred = files.find(file => file.kind === proposal.file_kinds[0]) || files[0]
      if (preferred) {
        if (conversationId) attachLearningFileToConversation(preferred, conversationId)
        else openTab(learningFileTab(preferred))
      }
      await syncLearningFileProgress(conversationId)
    } catch (error) {
      setLearningFileProposalErrors(previous => ({ ...previous,
        [proposal.learning_task_id]: error instanceof Error ? error.message : '学习文件生成失败',
      }))
    } finally { fileGenerationLocks.current.delete(proposal.learning_task_id); setFormalBusyKey('') }
  }

  const renderTab = (tab: WorkspaceTab | undefined) => {
    if (!tab) return null
    if (tab.kind === 'visual-hub') return <Suspense fallback={<p>正在载入图解库…</p>}><VisualHubPage/></Suspense>
    if (tab.kind === 'projects') {
      return <Suspense fallback={<div className="page-loading">正在载入学习项目…</div>}><ProjectsPage onOpen={project => { refreshFormalProjects(); void openProjectTutor(project.id) }} onProjectsChanged={refreshFormalProjects} /></Suspense>
    }
    if (tab.kind === 'project' && tab.projectId) {
      return (
        <Suspense fallback={<div className="page-loading">正在载入项目工作台…</div>}>
          <ProjectWorkspacePage
            projectId={tab.projectId}
            onOpenTutor={projectWorkspace => openProjectConversation(projectWorkspace, 'tutor')}
            onOpenCheckpoint={(projectWorkspace, checkpoint) => openProjectConversation(projectWorkspace, 'checkpoint', { checkpoint })}
            onOpenFree={(projectWorkspace, session) => openProjectConversation(projectWorkspace, 'free', { session })}
            onOpenFile={file => openTab(learningFileTab(file))}
            onGenerateFiles={generateTaskFiles}
          />
        </Suspense>
      )
    }
    if (tab.kind === 'ecosystem') return <Suspense fallback={<div className="page-loading">正在载入岗位图谱…</div>}><EcosystemPage /></Suspense>
    if (tab.kind === 'learning-path') {
      return (
        <Suspense fallback={<div className="page-loading">正在载入学习路径…</div>}>
          <LearningPathPage
            state={workspace.learningPath}
            onStatusChange={updatePathStatus}
            onAddPersonalNode={acceptPersonalPathNode}
            onRemovePersonalNode={deletePersonalPathNode}
            onArchivePlan={archivePathPlan}
          />
        </Suspense>
      )
    }
    if (tab.kind === 'profile') {
      return (
        <Suspense fallback={<div className="page-loading">正在载入正式五核画像…</div>}>
          <LearnerProfilePage
            connection={formalConnection}
            snapshot={formalSnapshot}
            busyKey={formalBusyKey}
            error={formalError}
            onRefresh={() => { void refreshFormalSnapshot(true) }}
            onOpenPath={() => openTab(LEARNING_PATH_TAB)}
            onMemoryArchive={(memoryId, archived) => { void updateFormalMemoryArchive(memoryId, archived) }}
            onClaimAction={(claimId, action, correction) => { void updateFormalClaim(claimId, action, correction) }}
            onRecordSelfReport={recordConceptSelfReport}
            onUpdateProfile={updateExplicitLearnerProfile}
            accountIdentity={{ displayName: auth.account.display_name, username: auth.account.username, avatar: auth.account.avatar }}
          />
        </Suspense>
      )
    }
    if (tab.kind === 'tasks') {
      return (
        <Suspense fallback={<div className="page-loading">正在载入学习任务队列…</div>}>
          <LearningTasksPage
            connection={formalConnection}
            tasks={formalSnapshot?.learning_tasks || []}
            busyTaskId={formalBusyKey.startsWith('task:') ? Number(formalBusyKey.slice(5)) : undefined}
            error={formalError}
            onRefresh={() => { void refreshFormalSnapshot(true) }}
            onAction={(task, action) => { void updateFormalTask(task, action) }}
            onGenerateFiles={task => { void generateTaskFiles(task) }}
            onOpenFiles={() => openTab(LEARNING_FILES_TAB)}
            onStartLearning={newConversation}
            onReturnToScene={returnToLearningScene}
          />
        </Suspense>
      )
    }
    if (tab.kind === 'review') {
      return (
        <Suspense fallback={<div className="page-loading">正在载入复习队列…</div>}>
          <ReviewWorkbenchPage connection={formalConnection} onOpenTasks={() => openTab(TASKS_TAB)} />
        </Suspense>
      )
    }
    if (tab.kind === 'learning-files') {
      return <Suspense fallback={<div className="page-loading">正在载入学习文件…</div>}><LearningFilesPage onOpen={file => openTab(learningFileTab(file))} onOpenTasks={() => openTab(TASKS_TAB)} /></Suspense>
    }
    if (tab.kind === 'lecture-file' && tab.fileRef) {
      return <Suspense fallback={<div className="page-loading">正在打开讲义…</div>}><LectureFilePage lectureId={Number(tab.fileRef)} conversationId={tab.originConversationId} {...learningScopeForFile(tab.originConversationId, 'lecture', String(tab.fileRef))} onProgress={() => syncLearningFileProgress(tab.originConversationId)} onContinue={tab.originConversationId && learningScopeForFile(tab.originConversationId, 'lecture', String(tab.fileRef)).learningTaskId ? () => { void openTaskLearningFile(tab.originConversationId!, 'practice') } : undefined} onAttach={file => attachLearningFileToConversation(file, tab.originConversationId, { parentSheetId: tab.originSheetId })} /></Suspense>
    }
    if (tab.kind === 'practice-file' && tab.fileRef) {
      return <Suspense fallback={<div className="page-loading">正在打开练习…</div>}><PracticeFilePage practiceRef={tab.fileRef} conversationId={tab.originConversationId} onProgress={() => syncLearningFileProgress(tab.originConversationId)} onRemediate={() => openTab(REVIEW_TAB)} onAttach={file => attachLearningFileToConversation(file, tab.originConversationId, { parentSheetId: tab.originSheetId })} /></Suspense>
    }
    if (tab.kind === 'settings') {
      return (
        <section className="settings-page">
          <div className="settings-intro page-hero">
            <h1>设置</h1>
            <p>管理账号、模型连接和学习记录。</p>
          </div>
          <AccountModelSettings
            account={auth.account}
            baseUrl={workspace.settings.baseUrl}
            model={workspace.settings.model}
            onConnectionChange={updateSettings}
            onSignOut={auth.signOut}
          />
          <section className="settings-card profile-settings-card" aria-labelledby="formal-profile-title">
            <div className="settings-card-heading">
              <span>{auth.account.role === 'admin' ? '04' : '03'}</span>
              <div>
                <h2 id="formal-profile-title">学习记录同步</h2>
                <p>{formalConnection.status === 'connected' ? `已连接 ${formalConnection.learner?.display_name || '当前学习者'}；所有写入经过 EvidenceEvent 与 reducer。` : formalConnection.detail}</p>
              </div>
              <i>{formalConnection.status === 'connected' ? '已连接' : '未连接'}</i>
            </div>
            <div className="settings-actions"><button type="button" onClick={() => { void refreshFormalSnapshot(true) }}>重新连接</button><button type="button" className="button-secondary" onClick={() => openTab(PROFILE_TAB)}>打开五核画像</button><button type="button" className="button-secondary" onClick={() => openTab(TASKS_TAB)}>打开任务队列</button></div>
          </section>
        </section>
      )
    }

    const conversation = workspace.conversations.find(item => item.id === tab.conversationId)
    if (!conversation) return null
    const pendingMode = pendingTurns[conversation.id]
    const taskProjection = latestLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
    const activeTaskProjection = activeLearningTaskProjection(conversation.learningTasks, conversation.learningEvents)
    const planProjection = activeLearningPlanProjection(conversation.learningPlans, conversation.planningEvents)
    const taskSkill = taskProjection ? LEARNING_SKILLS[taskProjection.skillId] : undefined
    const taskStep = taskProjection ? currentLearningSkillStep(taskProjection) : undefined
    const activeTaskStep = activeTaskProjection ? currentLearningSkillStep(activeTaskProjection) : undefined
    const taskCanAdvance = taskProjection ? canAdvanceLearningSkillStep(taskProjection) : false
    // An active task only fills in the state when the learner has not chosen one.
    // Forcing the chip to 带领学习 over their own pick made the selector look broken:
    // they picked 简单讲解 and the chip kept saying something else.
    const visibleMode = pendingMode
      || (activeTaskProjection && conversation.mode === 'free' ? 'guided_learning' : conversation.mode)
    const visibleSkillId = activeTaskProjection?.skillId
      || (conversation.mode === 'guided_learning' ? conversation.preferredSkillId : undefined)
    const visibleSkill = visibleSkillId ? LEARNING_SKILLS[visibleSkillId] : undefined
    const visibleSubstateLabel = activeTaskProjection?.task.formalSkillStageLabel || activeTaskStep?.substateLabel
      || (visibleMode === 'guided_learning' ? '准备' : '')
    const formalVerificationReady = taskProjection?.task.formalSkillState === 'verification_ready'
    const sheet = activeSheet(conversation)
    const pluginProjectionSheet = Boolean(sheet?.messages.some(message => message.pluginResultProjection))
    const sheetId = conversation.activeSheetId
    const draftKey = surfaceKey(conversation.id, sheetId)
    const draftPluginObjects = pluginDraftReferences[draftKey] || []
    const lockedPluginIds = lockedConversationPluginIds(conversation)
    const activePluginIds = activeConversationPluginIds(conversation)
    const pages = [
      { id: 'main', title: '主对话', quote: '', messages: conversation.messages, parentSheetId: '', sourceMessageId: '', artifact: undefined as PaperArtifact | undefined },
      ...conversation.sheets.map((item, index) => ({
        id: item.id,
        title: `${index + 1}. ${item.title}`,
        quote: item.quote,
        messages: item.messages,
        parentSheetId: item.parentSheetId,
        sourceMessageId: item.sourceMessageId,
        artifact: item.artifact,
      })),
    ]
    const pageIndex = Math.max(0, pages.findIndex(page => page.id === sheetId))
    const backPages = pages.filter(page => page.id !== sheetId).slice(-6)
    const persistedMessages = activeMessages(conversation)
    const liveTurn = liveTurns[conversation.id]
    const messages: Message[] = liveTurn?.sheetId === sheetId
      ? [...persistedMessages, {
          id: liveTurn.messageId,
          role: 'assistant',
          content: liveTurn.content,
          createdAt: liveTurn.startedAt,
          tutorMode: visibleMode,
          toolRuns: liveTurn.toolRuns,
          decisionSummaries: liveTurn.decisionSummaries,
          streaming: true,
          streamingPhase: liveTurn.phase,
        }]
      : persistedMessages
    const interruptedTurn = recoverableTutorTurn(persistedMessages.filter(message => !message.retryableTutorError), Boolean(pendingMode))
    const attachedSources = conversation.projectId ? conversation.projectSources : conversation.domainSources
    const hasWorkbench = conversation.sheets.length > 0
    const paperMode = paperDeskView?.conversationId === conversation.id ? paperDeskView.mode : 'stack'
    const renderPaperTreeNode = (page: typeof pages[number], ancestors: string[] = []): ReactNode => {
      const childPages = pages.filter(candidate => (
        candidate.parentSheetId === page.id && !ancestors.includes(candidate.id)
      ))
      return (
        <li key={page.id}>
          <div className={`paper-tree-card-wrap${page.id === sheetId ? ' paper-tree-card-active' : ''}`}>
            <button type="button" className="paper-tree-card" onClick={() => setActiveSheet(conversation.id, page.id)}>
              <span>{page.artifact ? page.artifact.kind === 'lecture' ? '讲义纸张' : page.artifact.kind === 'practice' ? '练习纸张' : '资料纸张' : page.parentSheetId === 'main' ? '来自主对话' : '来自另一张纸'}</span>
              <strong>{page.title}</strong>
              <p>{page.quote || paperPreview(page.messages)}</p>
              <small>{page.messages.length} 条内容{page.id === sheetId ? ' · 当前纸张' : ''}</small>
            </button>
            {page.id !== 'main' && (
              <button type="button" className="paper-tree-delete" onClick={() => requestSheetDelete(conversation, page.id)} disabled={Boolean(pendingMode)} aria-label={`删除纸张${page.title}`} title="删除这张纸">⌫</button>
            )}
          </div>
          {childPages.length > 0 && (
            <ul>{childPages.map(child => renderPaperTreeNode(child, [...ancestors, page.id]))}</ul>
          )}
        </li>
      )
    }
    const topLevelPages = pages.slice(1).filter(page => page.parentSheetId === 'main')
    const focusMainMessage = (messageId: string) => {
      setActiveSheet(conversation.id, 'main')
      window.setTimeout(() => {
        document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }, 30)
    }
    return (
      <section className={`chat-page${conversation.projectId ? ' project-chat-page' : ''}`}
        onDragOver={event => {
          if (!pendingMode && event.dataTransfer.types.includes(PLUGIN_OBJECT_DRAG_TYPE)) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={event => {
          const raw = event.dataTransfer.getData(PLUGIN_OBJECT_DRAG_TYPE)
          if (!raw) return
          event.preventDefault()
          event.stopPropagation()
          if (pendingMode) return
          const object = resolvePluginObjectDrop(raw, messages.flatMap(message => message.toolRuns || [])
            .flatMap(run => run.plugin?.result.objects || []))
          if (object) addPluginDraftReference(draftKey, object)
        }}
      >
        <header className="chat-heading page-hero">
          <h1>{conversation.title}</h1>
          <div className="chat-state-stack">
            {conversation.projectId && <button type="button" className="project-panel-toggle" aria-expanded={projectPanelConversationId === conversation.id} onClick={() => setProjectPanelConversationId(current => current === conversation.id ? '' : conversation.id)}>项目面板</button>}
            {visibleSkill && <span className="skill-badge">{visibleSkill.name}</span>}
          </div>
        </header>
        {verificationConversationId === conversation.id && taskProjection?.task.formalVerificationRunId && (
          <section className="learning-verification-host" aria-label="独立验证工作台">
            <header><strong>独立验证</strong><button type="button" onClick={() => setVerificationConversationId('')}>返回对话</button></header>
            <Suspense fallback={<div className="page-loading">正在恢复独立验证…</div>}>
              <LearningVerificationPanel runId={taskProjection.task.formalVerificationRunId} onProgress={() => syncLearningFileProgress(conversation.id)} />
            </Suspense>
          </section>
        )}
        <div className={hasWorkbench ? 'paper-workbench' : 'chat-thread'}>
          {hasWorkbench && (
            <div className="paper-toolbar">
              <div>
                <span className="paper-toolbar-label">选中追问工作台</span>
                <strong>{pages[pageIndex]?.title}</strong>
              </div>
              <div className="paper-navigation">
                <button type="button" onClick={() => setActiveSheet(conversation.id, pages[Math.max(0, pageIndex - 1)].id)} disabled={pageIndex === 0 || Boolean(pendingMode)} aria-label="上一张纸">←</button>
                <select value={sheetId} onChange={event => setActiveSheet(conversation.id, event.target.value)} disabled={Boolean(pendingMode)} aria-label="选择追问纸张">
                  {pages.map(page => <option key={page.id} value={page.id}>{page.title}</option>)}
                </select>
                <button type="button" onClick={() => setActiveSheet(conversation.id, pages[Math.min(pages.length - 1, pageIndex + 1)].id)} disabled={pageIndex === pages.length - 1 || Boolean(pendingMode)} aria-label="下一张纸">→</button>
                {sheet && <button type="button" className="paper-delete" onClick={() => requestSheetDelete(conversation, sheet.id)} disabled={Boolean(pendingMode)} aria-label={`删除纸张${sheet.title}`} title="删除当前纸张">⌫</button>}
                <button
                  type="button"
                  className="paper-overview-toggle"
                  onClick={() => setPaperDeskView(current => {
                    if (current?.conversationId !== conversation.id) return { conversationId: conversation.id, mode: 'overview' }
                    if (current.mode === 'overview') return { conversationId: conversation.id, mode: 'tree' }
                    return null
                  })}
                  disabled={Boolean(pendingMode)}
                  aria-label={paperMode === 'stack' ? '平铺所有纸张' : paperMode === 'overview' ? '展开纸张关系树' : '退出纸张关系树'}
                  aria-pressed={paperMode !== 'stack'}
                  title={paperMode === 'stack' ? '平铺所有纸张' : paperMode === 'overview' ? '查看纸张树' : '回到纸堆'}
                >{paperMode === 'tree' ? '□' : paperMode === 'overview' ? '树' : '▦'}</button>
              </div>
            </div>
          )}
          <div
            className={hasWorkbench ? `paper-stage${paperMode !== 'stack' ? ' paper-stage-overview' : ''}` : 'conversation-surface'}
            onDragOver={event => {
              if (event.dataTransfer.types.includes('application/x-learnflow-learning-file')) event.preventDefault()
            }}
            onDrop={event => {
              const raw = event.dataTransfer.getData('application/x-learnflow-learning-file')
              if (!raw) return
              event.preventDefault()
              try {
                const file = JSON.parse(raw) as { kind: 'lecture' | 'practice'; ref: string; title: string; sourceMessageId?: string }
                if ((file.kind === 'lecture' || file.kind === 'practice') && file.ref) {
                  attachLearningFileToConversation(file, conversation.id, {
                    sourceMessageId: file.sourceMessageId,
                    parentSheetId: conversation.activeSheetId,
                  })
                }
              } catch { /* Ignore foreign drag payloads. */ }
            }}
            onClick={hasWorkbench && paperMode === 'stack' && !pendingMode ? event => {
              if (event.target === event.currentTarget) setPaperDeskView({ conversationId: conversation.id, mode: 'overview' })
            } : undefined}
          >
            {hasWorkbench && paperMode === 'tree' ? (
              <div
                className="paper-tree"
                aria-label="纸张关系树"
                onClick={event => {
                  const target = event.target as Element
                  if (!target.closest('button')) setPaperDeskView(null)
                }}
              >
                <header>
                  <div><span>PAPER TREE</span><strong>追问关系</strong></div>
                  <p>从主对话沿选中原文向下展开 · 点击空白回到纸堆</p>
                </header>
                <div className="paper-tree-map">
                  <ol className="paper-tree-timeline" aria-label="主对话输入输出缩略">
                    {conversation.messages.filter(message => !message.hiddenFromTranscript).map((message, index) => (
                      <li key={message.id}>
                        <button type="button" onClick={() => focusMainMessage(message.id)}>
                          <span>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Tutor' : '系统'} · {String(index + 1).padStart(2, '0')}</span>
                          <p>{(message.displayContent || message.content).replace(/\s+/g, ' ').trim().slice(0, 150) || '空内容'}</p>
                          <small>{topLevelPages.filter(page => page.sourceMessageId === message.id).length} 个分支</small>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <div className="paper-tree-branches" aria-label="从对话消息或纸张展开的分支">
                    {conversation.messages.filter(message => !message.hiddenFromTranscript).map((message, index) => {
                      const roots = topLevelPages.filter(page => page.sourceMessageId === message.id)
                      if (!roots.length) return null
                      return (
                        <section key={message.id} style={{ gridRow: index + 1 }}>
                          <span>从第 {index + 1} 条展开</span>
                          <ul>{roots.map(page => renderPaperTreeNode(page, ['main']))}</ul>
                        </section>
                      )
                    })}
                    {topLevelPages.some(page => !page.sourceMessageId) && (
                      <section className="paper-tree-unanchored" style={{ gridRow: conversation.messages.filter(message => !message.hiddenFromTranscript).length + 1 }}>
                        <span>工作台文件与未定位纸张</span>
                        <ul>{topLevelPages.filter(page => !page.sourceMessageId).map(page => renderPaperTreeNode(page, ['main']))}</ul>
                      </section>
                    )}
                  </div>
                </div>
              </div>
            ) : hasWorkbench && paperMode === 'overview' ? (
              <div
                className="paper-overview"
                role="listbox"
                aria-label="全部追问纸张"
                onClick={event => {
                  const target = event.target as Element
                  if (!target.closest('button')) setPaperDeskView({ conversationId: conversation.id, mode: 'tree' })
                }}
              >
                <header>
                  <div><span>ALL SHEETS</span><strong>{pages.length} 张纸</strong></div>
                  <p>选择纸张，或再次点击空白展开关系树 · Esc 退出</p>
                </header>
                <div className="paper-overview-grid">
                  {pages.map((page, index) => (
                    <div className="paper-thumbnail-wrap" role="option" aria-selected={page.id === sheetId} key={page.id}>
                      <button
                        type="button"
                        className="paper-thumbnail"
                        onClick={() => setActiveSheet(conversation.id, page.id)}
                        aria-label={`打开${page.title}`}
                      >
                        <span className="paper-thumbnail-index">{String(index + 1).padStart(2, '0')}</span>
                        <strong>{page.title}</strong>
                        {page.quote && <blockquote>{page.quote}</blockquote>}
                        <p>{paperPreview(page.messages)}</p>
                        <small>{page.messages.length} 条内容{page.id === sheetId ? ' · 当前纸张' : ''}</small>
                      </button>
                      {page.id !== 'main' && (
                        <button
                          type="button"
                          className="paper-thumbnail-delete"
                          onClick={() => requestSheetDelete(conversation, page.id)}
                          disabled={Boolean(pendingMode)}
                          aria-label={`删除纸张${page.title}`}
                          title="删除这张纸"
                        >⌫</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className={hasWorkbench ? `paper-stack${pluginProjectionSheet ? ' paper-stack-plugin' : ''}` : 'conversation-paper'}>
                {hasWorkbench && backPages.length > 0 && (
                  <div className="paper-edge-deck" aria-label="其他纸张；悬停展开">
                    {backPages.map((page, index) => (
                      <button
                        type="button"
                        key={page.id}
                        className="paper-edge"
                        style={{
                          '--paper-y': `${index * 3}px`,
                          '--paper-x': `${index * 4}px`,
                          '--paper-open-x': `${index * -44}px`,
                          '--paper-background': `hsl(135 15% ${98 - index * .7}%)`,
                        } as CSSProperties}
                        onClick={() => setActiveSheet(conversation.id, page.id)}
                        aria-label={`打开${page.title}`}
                        title={page.title}
                      ><span>{page.title}</span></button>
                    ))}
                    {pages.length - 1 > backPages.length && <span className="paper-edge-more">+{pages.length - 1 - backPages.length}</span>}
                  </div>
                )}
                <div className={hasWorkbench ? `paper-sheet${sheet?.artifact ? ' paper-sheet-artifact' : ''}${pluginProjectionSheet ? ' paper-sheet-plugin' : ''}` : 'conversation-page-content'}>
                  {sheet?.artifact?.kind === 'lecture' && (
                    <Suspense fallback={<div className="page-loading">正在打开讲义纸张…</div>}>
                      <LectureFilePage lectureId={Number(sheet.artifact.ref)} embedded conversationId={conversation.id} sheetId={sheet.id} {...learningScopeForFile(conversation.id, 'lecture', sheet.artifact.ref)} onProgress={() => syncLearningFileProgress(conversation.id)} onContinue={learningScopeForFile(conversation.id, 'lecture', sheet.artifact.ref).learningTaskId ? () => { void openTaskLearningFile(conversation.id, 'practice') } : undefined} onFollowUp={() => {
                        const quote = globalThis.getSelection()?.toString().replace(/\s+/g, ' ').trim() || `继续追问讲义“${sheet.artifact?.title || '当前讲义'}”`
                        createFollowUpSheet(conversation.id, `artifact:lecture:${sheet.artifact?.ref}`, quote)
                        globalThis.getSelection()?.removeAllRanges()
                      }} />
                    </Suspense>
                  )}
                  {sheet?.artifact?.kind === 'practice' && (
                    <Suspense fallback={<div className="page-loading">正在打开练习纸张…</div>}>
                      <PracticeFilePage practiceRef={sheet.artifact.ref} embedded conversationId={conversation.id} sheetId={sheet.id} onProgress={() => syncLearningFileProgress(conversation.id)} onRemediate={() => openTab(REVIEW_TAB)} onFollowUp={() => {
                        const quote = globalThis.getSelection()?.toString().replace(/\s+/g, ' ').trim() || `继续追问练习“${sheet.artifact?.title || '当前练习'}”`
                        createFollowUpSheet(conversation.id, `artifact:practice:${sheet.artifact?.ref}`, quote)
                        globalThis.getSelection()?.removeAllRanges()
                      }} />
                    </Suspense>
                  )}
                  {sheet?.artifact?.kind === 'source' && (
                    <Suspense fallback={<div className="page-loading">正在打开资料纸张…</div>}>
                      <SourceFilePage sourceId={Number(sheet.artifact.ref)} embedded conversationId={conversation.id} sheetId={sheet.id} onFollowUp={() => {
                        const quote = globalThis.getSelection()?.toString().replace(/\s+/g, ' ').trim() || `继续追问资料“${sheet.artifact?.title || '当前资料'}”`
                        createFollowUpSheet(conversation.id, `artifact:source:${sheet.artifact?.ref}`, quote)
                        globalThis.getSelection()?.removeAllRanges()
                      }} />
                    </Suspense>
                  )}
                  {sheet && !sheet.artifact && (
                    <blockquote className="selected-quote">
                      <span>本页从这段原文展开</span>
                      <p>{sheet.quote}</p>
                    </blockquote>
                  )}
                  <MessageList
                    messages={messages}
                    learnerAvatar={auth.account.avatar}
                    learnerName={auth.account.display_name}
                    onPluginPrompt={prompt => { void runTutorTurn(conversation.id, prompt, { hideUserMessage: true }) }}
                    onPluginReference={(object, prompt) => {
                      addPluginDraftReference(draftKey, object)
                      if (prompt) setDrafts(previous => ({ ...previous, [draftKey]: [previous[draftKey]?.trim(), prompt].filter(Boolean).join('\n\n') }))
                    }}
                    onOpenProject={target => { void openProjectTutor(target.projectId) }}
                    onOpenLearningTask={taskId => {
                      void (async () => {
                        const snapshot = await refreshFormalSnapshot(true)
                        const task = snapshot?.learning_tasks.find(item => item.id === taskId)
                        if (task) await returnToLearningScene(task)
                        else setFormalError(`找不到正式学习任务 #${taskId}`)
                      })()
                    }}
                    onOpenPluginResult={(run, sourceMessageId) => openPluginResultPaper(conversation.id, sourceMessageId, run)}
                    onQuoteFollowUp={(messageId, quote) => createFollowUpSheet(conversation.id, messageId, quote)}
                    onAcceptPathProposal={acceptPersonalPathNode}
                    onAcceptPathPlan={acceptLearningPathPlan}
                    activePathPlanId={projectLearnerPath(workspace.learningPath).activePlan?.id}
                    pathPlanBusyId={formalBusyKey.startsWith('path-plan:') ? formalBusyKey.slice('path-plan:'.length) : undefined}
                    pathPlanWriteErrors={pathPlanWriteErrors}
                    onAcceptProjectRoadmap={proposal => { void acceptProjectRoadmap(proposal) }}
                    onAcceptProjectLearningFile={proposal => { void acceptProjectLearningFileProposal(proposal, conversation.id) }}
                    projectBusyKey={formalBusyKey}
                    projectError={formalError}
                    learningFileProposalErrors={learningFileProposalErrors}
                    conversationId={conversation.id}
                    onOpenLearningFile={file => openLearningFile(file, {
                      conversationId: conversation.id,
                      sheetId: conversation.activeSheetId,
                    })}
                    onAttachLearningFile={(file, sourceMessageId) => attachLearningFileToConversation(file, conversation.id, {
                      sourceMessageId,
                      parentSheetId: conversation.activeSheetId,
                    })}
                  />
                  {sheet && messages.length === 0 && !sheet.artifact && (
                    <div className="empty-sheet-hint">这张纸已经继承原对话。直接在下方追问选中的句子。</div>
                  )}
                </div>
              </div>
            )}
            {hasWorkbench && paperMode === 'stack' && <span className="paper-desktop-hint">点击桌面空白，平铺全部纸张</span>}
          </div>
        </div>
        {!isDesktopRuntime() && conversation.mode === 'learning_plan' && !activePluginIds.includes('learning_task_conversion') && <PlanningResourceWorkbench
          key={`${conversation.id}:${conversation.projectId || 'library'}`}
          projectId={conversation.projectId}
          topic={formalProjectWorkspaces[conversation.projectId || 0]?.project.name || planProjection?.plan.objective || conversation.title}
          runs={conversation.messages.flatMap(message => message.toolRuns || [])}
          pending={Boolean(pendingMode)}
          onProjectChange={syncProjectWorkspace}
          onRequest={prompt => { void runTutorTurn(conversation.id, prompt) }}
        />}
        <div className="composer-dock">
          <form className="composer" onSubmit={event => sendMessage(conversation.id, event)}>
            {planProjection && conversation.mode === 'learning_plan'
              && !activeConversationPluginIds(conversation).includes('learning_task_conversion') && (
              <>
                <section className="planning-anchor" aria-label="当前学习规划">
                  <span className="planning-mark">◇</span>
                  <div className="planning-anchor-main">
                    <strong>{planProjection.plan.objective}</strong>
                    <span>
                      学习规划 · {planningKindLabel(planProjection.plan.kind)} · 已确认 {planProjection.requirements.length - planProjection.missingRequirements.length}/{planProjection.requirements.length}
                      {planProjection.missingRequirements.length ? ` · 待确认 ${planProjection.missingRequirements.slice(0, 2).map(item => item.label).join('、')}` : ' · 草案信息已齐'}
                    </span>
                  </div>
                  {planProjection.plan.kind === 'project_seed' && <span className="project-stub-badge">{conversation.projectId ? '已绑定项目' : '学习计划草案'}</span>}
                  <details className="planning-menu">
                    <summary role="button" aria-label="学习规划详情">•••</summary>
                    <div className="planning-popover">
                      <header><strong>{planningKindLabel(planProjection.plan.kind)}</strong><span>信息来自当前对话，可继续补充和修订。</span></header>
                      <div className="planning-requirements">
                        {planProjection.requirements.map(requirement => (
                          <span key={requirement.id} className={planProjection.signals[requirement.id] ? 'confirmed' : ''}>
                            <i>{planProjection.signals[requirement.id] ? '✓' : '·'}</i>{requirement.label}
                          </span>
                        ))}
                      </div>
                      <p>{planProjection.plan.kind === 'project_seed'
                        ? '信息足够后只形成项目启动草案；当前版本不会创建项目、关卡或文件夹。'
                        : '先用项目、阅读或实践实验收集方向证据；不替你决定职业。'}</p>
                      <button type="button" onClick={() => finishLearningPlan(conversation.id, planProjection)} disabled={Boolean(pendingMode)}>结束规划</button>
                    </div>
                  </details>
                </section>
                {planProjection.valueProposal && (
                  <section className={`value-proposal-card value-proposal-${planProjection.valueProposal.decision}`} aria-label="价值核修改建议">
                    <header><span>VALUE CLAIM PROPOSAL</span><strong>价值核修改建议</strong></header>
                    <div className="value-proposal-change">
                      <div><span>当前内容</span><p>{planProjection.valueProposal.currentClaim}</p></div>
                      <i>→</i>
                      <div><span>建议内容</span><p>{planProjection.valueProposal.proposedClaim}</p></div>
                    </div>
                    <blockquote>依据：你说“{planProjection.valueProposal.evidenceQuote}”</blockquote>
                    <p>{planProjection.valueProposal.rationale} 接受时会先显示原文与建议，再通过正式事件入口写入价值核；你仍可在画像页纠正或撤回。</p>
                    {planProjection.valueProposal.decision === 'proposed' ? (
                      <div className="value-proposal-actions">
                        <button type="button" className="value-accept" onClick={() => { void updateValueProposal(conversation.id, planProjection, 'accepted') }} disabled={Boolean(pendingMode) || formalBusyKey.startsWith('value:')}>确认并写入价值核</button>
                        <button type="button" onClick={() => updateValueProposal(conversation.id, planProjection, 'revision_requested', draftKey)} disabled={Boolean(pendingMode)}>我要修改</button>
                        <button type="button" onClick={() => updateValueProposal(conversation.id, planProjection, 'rejected')} disabled={Boolean(pendingMode)}>不写入</button>
                      </div>
                    ) : (
                      <strong className="value-proposal-decision">
                        {planProjection.valueProposal.decision === 'accepted' && (planProjection.valueProposal.formalWriteCompleted ? '✓ 你已确认，正式价值核已记录' : '已确认但正式后端离线，当前只保留待同步状态')}
                        {planProjection.valueProposal.decision === 'rejected' && '已拒绝；不会写入'}
                        {planProjection.valueProposal.decision === 'revision_requested' && '等待你在输入框中写出修改版本'}
                      </strong>
                    )}
                  </section>
                )}
              </>
            )}
            {taskProjection && taskProjection.status !== 'completed' && (
              <section className={`learning-task-anchor learning-task-anchor-${taskProjection.status}`} aria-label="当前学习任务">
                <span className="learning-task-mark">◎</span>
                <div className="learning-task-anchor-main">
                  <strong>{taskProjection.task.objective}</strong>
                  <span>
                    {taskProjection.status === 'paused' ? '已暂停 · ' : ''}{taskSkill?.name} · {taskStep?.title}
                    {taskProjection.loopCount > 0 ? ` · 本步第 ${taskProjection.loopCount + 1} 轮` : ''}
                    {!taskProjection.task.formalSkillRunId ? ' · 离线回退' : ''}
                  </span>
                </div>
                <div className="learning-skill-dots" aria-label={`${taskSkill?.name}：第 ${taskProjection.stepIndex + 1}/${taskSkill?.steps.length} 步`}>
                  {taskSkill?.steps.map((step, index) => (
                    <i key={step.id} className={index < taskProjection.stepIndex ? 'done' : index === taskProjection.stepIndex ? 'current' : ''} />
                  ))}
                </div>
                {taskProjection.status === 'paused' ? (
                  <button type="button" className="learning-primary-action" onClick={() => updateLearningTask(conversation.id, 'resume')}>继续</button>
                ) : taskProjection.task.formalVerificationRunId ? (
                  <button type="button" className="learning-primary-action" onClick={() => setVerificationConversationId(conversation.id)}>继续独立验证</button>
                ) : formalVerificationReady ? (
                  <button type="button" className="learning-primary-action" onClick={() => updateLearningTask(conversation.id, 'verify')} disabled={Boolean(pendingMode)}>开始独立验证</button>
                ) : taskProjection.skillId === 'learning_file_study' && taskProjection.task.formalSkillRunId ? (
                  <button type="button" className="learning-primary-action" onClick={() => { void openTaskLearningFile(conversation.id) }} disabled={Boolean(pendingMode) || Boolean(formalBusyKey)}>
                    {fileKindForStage(taskProjection.task.formalSkillState) === 'practice' ? '打开配对练习' : taskProjection.task.formalSkillState === 'selecting_learning_artifact' ? '准备学习文件' : '打开讲义'}
                  </button>
                ) : taskProjection.task.formalSkillRunId ? (
                  <button
                    type="button"
                    className="learning-primary-action"
                    title="正式 SkillRun 只根据学习者在对话中的真实回答推进"
                    disabled
                  >
                    在对话中作答
                  </button>
                ) : nextLearningSkillStep(taskProjection) ? (
                  <span className="learning-agent-progress" title="SkillRun 会根据对话中的真实回答自动推进">
                    {taskCanAdvance ? 'Tutor 将自动继续' : '等待你的回答'}
                  </span>
                ) : (
                  <button type="button" className="learning-primary-action" onClick={() => updateLearningTask(conversation.id, 'complete')} disabled={Boolean(pendingMode) || !taskCanAdvance}>完成本轮</button>
                )}
                {taskProjection.task.formalSkillSupportExit && <div className="learning-support-exit">
                  <span>这一步先不继续追问。</span>
                  {taskProjection.skillId !== 'guided_explanation' && <button type="button" onClick={() => updateLearningTask(conversation.id, 'skill', 'guided_explanation')}>改为清晰讲解</button>}
                  <button type="button" onClick={() => updateLearningTask(conversation.id, 'pause')}>暂停，回到自由对话</button>
                </div>}
                <details className="learning-task-menu">
                  <summary role="button" aria-label="学习任务选项">•••</summary>
                  <div className="learning-task-popover">
                    <header><strong>带领学习 · {taskStep?.substateLabel} · {taskSkill?.name}</strong><span>{taskSkill?.description}</span></header>
                    <ol>
                      {taskSkill?.steps.map((step, index) => (
                        <li key={step.id} className={index === taskProjection.stepIndex ? 'current' : index < taskProjection.stepIndex ? 'done' : ''}>
                          <i>{index + 1}</i><span>{step.title}</span>
                        </li>
                      ))}
                    </ol>
                    {taskProjection.skillId === 'feynman_dialogue' && taskProjection.task.formalSkillRunId && (
                      <section className="feynman-calibration" aria-label="费曼复述校准">
                        <header>
                          <strong>复述校准</strong>
                          <span>调整难度不会改变流程位置或掌握状态</span>
                        </header>
                        <div className="feynman-calibration-grid">
                          {taskSkill?.calibrationAxes.map(axis => (
                            <label key={axis.id}>
                              <span>{axis.title}</span>
                              <select
                                value={taskProjection.task.formalSkillCalibration?.[axis.id as keyof typeof taskProjection.task.formalSkillCalibration] || axis.default}
                                disabled={Boolean(pendingMode) || formalBusyKey.startsWith('skill-calibration:')}
                                onChange={event => {
                                  void calibrateFeynmanSkill(conversation.id, {
                                    [axis.id]: event.target.value,
                                  })
                                }}
                              >
                                {axis.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                              </select>
                            </label>
                          ))}
                        </div>
                        {taskProjection.task.formalTeachBackDiagnostic?.candidate_gap_label && (
                          <p>
                            <span>本轮只修</span>
                            <strong>{taskProjection.task.formalTeachBackDiagnostic.candidate_gap_label}</strong>
                            <small>待独立验证</small>
                          </p>
                        )}
                      </section>
                    )}
                    <label>
                      <span>切换学习方法</span>
                      <select
                        value={taskProjection.skillId}
                        disabled={Boolean(pendingMode) || taskProjection.status === 'paused'}
                        onChange={event => {
                          updateLearningTask(conversation.id, 'skill', event.target.value as LearningSkillId)
                          event.currentTarget.closest('details')?.removeAttribute('open')
                        }}
                      >
                        {PRIMARY_LEARNING_SKILL_IDS.map(skillId => (
                          <option key={skillId} value={skillId}>{LEARNING_SKILLS[skillId].name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="learning-task-menu-actions">
                      {taskProjection.status === 'active' && <button type="button" onClick={event => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        updateLearningTask(conversation.id, 'pause')
                      }} disabled={Boolean(pendingMode)}>暂停</button>}
                      <button type="button" onClick={event => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        updateLearningTask(conversation.id, 'complete')
                      }} disabled={Boolean(pendingMode)}>{taskProjection.task.formalSkillRunId ? '暂停并退出' : '结束任务'}</button>
                    </div>
                    <details className="learning-event-queue">
                      <summary>运行记录 {taskProjection.eventCount}</summary>
                      <div>
                        {conversation.learningEvents
                          .filter(item => item.taskId === taskProjection.task.id)
                          .slice(-6)
                          .reverse()
                          .map(item => <span key={item.id}><i>{item.sequence}</i>{item.detail}</span>)}
                      </div>
                    </details>
                  </div>
                </details>
              </section>
            )}
            {interruptedTurn && (
              <div className="turn-recovery" role="status">
                <span><strong>上一轮没有完成</strong> 页面刷新或服务重载可能中断了回答。</span>
                <button type="button" onClick={() => { void runTutorTurn(conversation.id, interruptedTurn.content, { replayInterruptedTurn: true }) }}>重新回答</button>
              </div>
            )}
            {pendingMode && <div className="turn-progress" role="status"><i /> 正在判断工具并由{TUTOR_MODE_LABELS[pendingMode]}组织回复…</div>}
            {attachedSources.length > 0 && (
              <div className="conversation-source-chips" aria-label={conversation.projectId ? '项目来源' : '本对话资料'}>
                {attachedSources.map(source => (
                  <span key={source.id} title={`${source.name} · 点击作为纸张打开`}>
                    <i>{source.type === 'file' ? '文' : '链'}</i>
                    <button type="button" className="source-chip-open" onClick={() => attachSourceToConversation(conversation, source)}><strong>{source.name}</strong></button>
                    <button type="button" onClick={() => { void detachDomainSource(conversation.id, source.id) }} aria-label={`移除资料${source.name}`}>×</button>
                  </span>
                ))}
              </div>
            )}
            {draftPluginObjects.length > 0 && <div className="composer-plugin-references" aria-label="已引用的插件对象">
              {draftPluginObjects.map(object => <span key={pluginObjectContentKey(object)}>
                <i>↳</i>
                <strong>{object.label}</strong>
                <small>{object.objectType}</small>
                <button type="button" onClick={() => setPluginDraftReferences(previous => ({
                  ...previous,
                  [draftKey]: (previous[draftKey] || []).filter(item => pluginObjectContentKey(item) !== pluginObjectContentKey(object)),
                }))} aria-label={`移除插件对象引用${object.label}`}>×</button>
              </span>)}
            </div>}
            <textarea
              value={drafts[draftKey] || ''}
              onChange={event => setDrafts(previous => ({ ...previous, [draftKey]: event.target.value }))}
              disabled={Boolean(pendingMode)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="发送消息…"
              rows={2}
            />
            <div className="composer-footer">
              <div className="composer-tools composer-tools-capability">
                <div className="composer-lead">
                <details className="source-attachment-menu">
                  <summary role="button" aria-label="给当前对话添加资料" title="添加本地文件或 URL">
                    <svg className="plus-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3.4v9.2M3.4 8h9.2" /></svg>
                    {attachedSources.length > 0 ? <b>{attachedSources.length}</b> : null}
                  </summary>
                  <div className="source-attachment-popover">
                    <header><strong>{conversation.projectId ? '项目来源' : '本对话资料'}</strong><span>资料只是上下文，不代表已掌握。</span></header>
                    <label className="source-file-picker">
                      <input
                        type="file"
                        accept=".md,.txt,.pdf,.docx,.py,.json,.js,.ts,.tsx,.jsx,.c,.cpp,.h,.java,.go,.rs"
                        disabled={Boolean(sourceBusy[conversation.id]) || Boolean(pendingMode)}
                        onChange={event => {
                          const file = event.target.files?.[0]
                          event.currentTarget.value = ''
                          if (file) void importDomainFile(conversation.id, file)
                        }}
                      />
                      <span>上传本地文件</span>
                    </label>
                    <div className="source-url-row">
                      <input
                        type="url"
                        value={sourceUrls[conversation.id] || ''}
                        onChange={event => setSourceUrls(previous => ({ ...previous, [conversation.id]: event.target.value }))}
                        placeholder="https://…"
                        disabled={Boolean(sourceBusy[conversation.id]) || Boolean(pendingMode)}
                      />
                      <button type="button" onClick={() => { void importDomainUrl(conversation.id) }} disabled={Boolean(sourceBusy[conversation.id]) || !(sourceUrls[conversation.id] || '').trim()}>加入 URL</button>
                    </div>
                    {sourceBusy[conversation.id] && <p className="source-import-status">{sourceBusy[conversation.id]}</p>}
                    {sourceErrors[conversation.id] && <p className="source-import-error">{sourceErrors[conversation.id]}</p>}
                    <div className="composer-extra-controls">
                <ComposerCapabilityPicker
                  isGuidedLearning={Boolean(activeTaskProjection) || conversation.mode === 'guided_learning'}
                  skillChoice={activeTaskProjection?.skillId || (conversation.mode === 'guided_learning' ? conversation.preferredSkillId || 'auto' : 'auto')}
                  skillAutoDisabled={Boolean(activeTaskProjection)}
                  skillDisabled={Boolean(pendingMode) || taskProjection?.status === 'paused'}
                  formalSkillRunActive={Boolean(activeTaskProjection?.task.formalSkillRunId)}
                  toolChoice={toolChoices[draftKey] || 'auto'}
                  toolDisabled={Boolean(pendingMode)}
                  activePluginIds={activePluginIds}
                  sourceCount={attachedSources.length}
                  sourceKind={conversation.projectId ? 'project' : 'conversation'}
                  onSkillChange={choice => selectLearningSkill(conversation.id, choice)}
                  onToolChange={choice => setToolChoices(previous => ({ ...previous, [draftKey]: choice }))}
                />
                <PluginCapabilityPicker
                  activePluginIds={activePluginIds}
                  lockedPluginIds={lockedPluginIds}
                  disabled={Boolean(pendingMode)}
                  onChange={pluginIds => setWorkspace(previous => ({
                    ...previous,
                    conversations: previous.conversations.map(item => item.id === conversation.id
                      ? { ...item, pluginIds: stickyConversationPluginIds(pluginIds, lockedConversationPluginIds(item)) }
                      : item),
                  }))}
                />
                    </div>
                  </div>
                </details>
                <details className="mode-menu">
                  <summary role="button" title="切换学习状态" aria-label="选择 Tutor 状态">
                    <span>{TUTOR_MODE_LABELS[visibleMode]}</span>
                  </summary>
                  <div className="mode-popover">
                    <button type="button" title="自由讨论；解释请求仍可自动进入简单讲解" aria-pressed={!activeTaskProjection && conversation.mode === 'free'} disabled={Boolean(pendingMode) || Boolean(activeTaskProjection)} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setConversationMode(conversation.id, 'free') }}>自由状态</button>
                    <button type="button" title="下一轮使用简单讲解，完成后回到自由状态" aria-pressed={!activeTaskProjection && conversation.mode === 'simple_explain'} disabled={Boolean(pendingMode) || Boolean(activeTaskProjection)} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setConversationMode(conversation.id, 'simple_explain') }}>简单讲解</button>
                    <button
                      type="button"
                      title="围绕一个原子目标在当前对话中持续学习"
                      aria-pressed={Boolean(activeTaskProjection) || conversation.mode === 'guided_learning'}
                      disabled={Boolean(pendingMode)}
                      onClick={event => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        if (taskProjection?.status === 'paused') updateLearningTask(conversation.id, 'resume')
                        else setConversationMode(conversation.id, 'guided_learning')
                      }}
                    >带领学习</button>
                    <button
                      type="button"
                      title="规划较大的学习、真实产物项目或未来发展方向"
                      aria-pressed={!activeTaskProjection && conversation.mode === 'learning_plan'}
                      disabled={Boolean(pendingMode) || Boolean(activeTaskProjection)}
                      onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setConversationMode(conversation.id, 'learning_plan') }}
                    >学习规划</button>
                  </div>
                </details>
                </div>
              </div>
              <details className="composer-model-menu" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) void loadProviderModels() }}>
                <summary className="composer-model-chip" role="button" title="切换模型" aria-label="切换模型">
                  <strong>{workspace.settings.model || '待配置模型'}</strong>
                </summary>
                <div className="composer-model-popover">
                  <header>{providerModelsError || (providerModels.length ? '服务商可用模型' : '正在读取模型…')}</header>
                  {(providerModels.length ? providerModels : [workspace.settings.model].filter(Boolean)).map(name => (
                    <button
                      key={name}
                      type="button"
                      aria-pressed={workspace.settings.model === name}
                      onClick={event => {
                        event.currentTarget.closest('details')?.removeAttribute('open')
                        updateSettings({ ...workspace.settings, model: name })
                      }}
                    >
                      <i>{workspace.settings.model === name ? '✓' : ''}</i>{name}
                    </button>
                  ))}
                </div>
              </details>
              <button type="submit" disabled={Boolean(pendingMode) || (!(drafts[draftKey] || '').trim() && draftPluginObjects.length === 0)} aria-label={pendingMode ? 'Tutor 回复中' : '发送消息'}>{pendingMode ? '…' : '↑'}</button>
            </div>
          </form>
        </div>
        {conversation.projectId && projectPanelConversationId === conversation.id && (
          <Suspense fallback={<aside className="project-context-panel"><div className="page-loading">正在读取项目…</div></aside>}>
            <ProjectContextPanel
              projectId={conversation.projectId}
              onClose={() => setProjectPanelConversationId('')}
              onOpenCheckpoint={(projectWorkspace, checkpoint) => openProjectConversation(projectWorkspace, 'checkpoint', { checkpoint })}
              onOpenFree={(projectWorkspace, session) => openProjectConversation(projectWorkspace, 'free', { session })}
              onOpenFile={file => openTab(learningFileTab(file))}
              onGenerateFiles={generateTaskFiles}
              onWorkspaceChange={syncProjectWorkspace}
            />
          </Suspense>
        )}
      </section>
    )
  }

  return (
    <div className="app-shell">
      <div className="workspace" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
        <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <button className="sidebar-brand" type="button" onClick={newConversation} aria-label="新建 LearnFlow 对话">
            <img className="brand-mark" src="/brand-mark.png" alt="" width={36} height={36} /><span><strong>LearnFlow</strong><small>学习空间</small></span>
          </button>
          <nav className="sidebar-primary-nav" aria-label="学习工作台">
            <button type="button" onClick={() => openTab(LEARNING_FILES_TAB)}><UiIcon name="lecture" />讲义与练习</button>
            <button type="button" onClick={() => openTab(REVIEW_TAB)}><UiIcon name="review" />复习与错题</button>
            <button type="button" onClick={() => openTab(TASKS_TAB)}><UiIcon name="tasks" />学习任务</button>
            <button type="button" onClick={() => openTab(LEARNING_PATH_TAB)}><UiIcon name="path" />学习路径</button>
            <button type="button" onClick={() => openTab(VISUAL_HUB_TAB)}><UiIcon name="visual" />图解与动画</button>
            <button type="button" onClick={() => window.location.assign('https://graphs.learnflow.club/hub')}><span>◇</span>岗位图谱</button>
          </nav>
          <div className="sidebar-scroll-area">
            <section className="sidebar-section sidebar-projects">
              <header><strong>项目</strong><button type="button" onClick={() => openTab(PROJECTS_TAB)} aria-label="管理学习项目">＋</button></header>
              {formalProjects.map(project => {
                const projectWorkspace = formalProjectWorkspaces[project.id]
                const projectChats = projectSidebarChats(
                  projectWorkspace,
                  workspace.conversations.filter(item => item.projectId === project.id),
                )
                const expanded = expandedProjects[project.id] !== false
                return <div className="sidebar-project-folder" key={project.id}>
                  <div className="sidebar-project-row">
                    <button type="button" className="project-folder-toggle" onClick={() => setExpandedProjects(previous => ({ ...previous, [project.id]: !expanded }))} aria-label={`${expanded ? '收起' : '展开'}${project.name}`}>{expanded ? '⌄' : '›'}</button>
                    <button type="button" className="project-folder-open" onClick={() => void openProjectTutor(project.id)}><span>▱</span><strong>{project.name}</strong></button>
                    <button type="button" className="project-folder-add-chat" onClick={event => { event.stopPropagation(); void addProjectFreeConversation(project.id) }} disabled={formalBusyKey === `project-free:${project.id}`} aria-label={`在${project.name}中新建自由对话`} title="新建项目自由对话">＋</button>
                  </div>
                  {expanded && projectChats.length > 0 && <div className="project-chat-list">{projectChats.map(entry => <button
                    type="button"
                    key={entry.key}
                    className={entry.conversation && activeConversation?.id === entry.conversation.id ? 'active' : ''}
                    onClick={() => {
                      if (entry.conversation) {
                        openTab(chatTab(entry.conversation))
                      } else if (projectWorkspace) {
                        openProjectConversation(projectWorkspace, entry.role, {
                          checkpoint: entry.checkpoint,
                          session: entry.session,
                        })
                      }
                    }}
                  ><span>{entry.role === 'checkpoint' ? '◇' : '·'}</span>{entry.title.replace(`${project.name} · `, '')}</button>)}</div>}
                </div>
              })}
              {!formalProjects.length && <button type="button" className="sidebar-empty-project" onClick={() => openTab(PROJECTS_TAB)}>＋ 新建学习项目</button>}
            </section>
            <section className="sidebar-section sidebar-conversations">
              <header><strong>对话</strong><button type="button" onClick={newConversation} aria-label="新建对话">＋</button></header>
              <nav className="conversation-list" aria-label="对话列表">
            {recentConversations(workspace.conversations.filter(conversation => !conversation.projectId))
              .slice()
              .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)))
              .map(conversation => (
              <div
                key={conversation.id}
                className={`conversation-row ${activeConversation?.id === conversation.id ? 'conversation-active' : ''} ${splitConversation?.id === conversation.id ? 'conversation-secondary' : ''}`}
              >
                {renamingConversationId === conversation.id ? (
                  <form
                    className="conversation-rename"
                    onSubmit={event => {
                      event.preventDefault()
                      const title = renameDraft.trim()
                      if (title) renameConversation(conversation.id, title)
                      setRenamingConversationId('')
                    }}
                  >
                    <input
                      autoFocus
                      value={renameDraft}
                      maxLength={80}
                      onChange={event => setRenameDraft(event.target.value)}
                      onBlur={() => setRenamingConversationId('')}
                      onKeyDown={event => { if (event.key === 'Escape') setRenamingConversationId('') }}
                      aria-label="重命名对话"
                    />
                  </form>
                ) : (
                  <button type="button" className="conversation-open" onClick={() => openTab(chatTab(conversation))}>
                    <span className="conversation-glyph">{conversation.pinned ? '★' : '□'}</span>
                    <span><strong>{conversation.title}</strong><small>{conversation.messages.filter(message => message.role === 'user' && !message.hiddenFromTranscript).length} 条输入</small></span>
                  </button>
                )}
                <details className="conversation-menu">
                  <summary role="button" aria-label={`对话操作：${conversation.title}`} title="更多操作">⋯</summary>
                  <div className="conversation-popover">
                    <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); togglePinConversation(conversation.id) }}>
                      <i>{conversation.pinned ? '☆' : '★'}</i>{conversation.pinned ? '取消置顶' : '置顶'}
                    </button>
                    <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setRenameDraft(conversation.title); setRenamingConversationId(conversation.id) }}>
                      <i>✎</i>重命名
                    </button>
                    <button type="button" className="conversation-popover-danger" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setPendingDelete(conversation) }}>
                      <i>⌫</i>删除
                    </button>
                  </div>
                </details>
              </div>
            ))}
              </nav>
            </section>
          </div>
          <div className="sidebar-footer">
            <details className="sidebar-account-menu">
              <summary className="sidebar-user-button" role="button" aria-label="账号菜单">
                <UserIdentity
                  displayName={auth.account.display_name}
                  username={auth.account.username}
                  avatar={auth.account.avatar}
                  detail={formalConnection.status === 'connected' ? '画像已连接' : '画像离线'}
                />
              </summary>
              <div className="sidebar-account-popover">
                <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); openTab(PROFILE_TAB) }}>
                  <UiIcon name="profile" />个人画像
                </button>
                <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setShortcutsOpen(true) }}>
                  <UiIcon name="shortcuts" />快捷键
                </button>
                <label className="sidebar-account-avatar-picker">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={avatarBusy}
                    onChange={event => {
                      const file = event.target.files?.[0]
                      event.currentTarget.value = ''
                      event.currentTarget.closest('details')?.removeAttribute('open')
                      if (file) void changeAvatar(file)
                    }}
                  />
                  <UiIcon name="avatar" />{avatarBusy ? '正在处理…' : '更换头像'}
                </label>
                {auth.account.avatar && (
                  <button type="button" disabled={avatarBusy} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); void removeAvatar() }}>
                    <UiIcon name="avatar-off" />移除头像
                  </button>
                )}
                <button type="button" onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); openTab(SETTINGS_TAB) }}>
                  <UiIcon name="settings" />设置
                </button>
                {avatarError && <p className="sidebar-account-error" role="alert">{avatarError}</p>}
              </div>
            </details>
          </div>
        </aside>

        {!sidebarCollapsed && (
          <div
            className="sidebar-resize-handle desktop-only"
            role="separator"
            aria-label="调整侧栏宽度"
            aria-orientation="vertical"
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={Math.round(sidebarWidth)}
            tabIndex={0}
            onPointerDown={event => {
              event.currentTarget.setPointerCapture(event.pointerId)
              event.currentTarget.classList.add('sidebar-resize-active')
            }}
            onPointerMove={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) setSidebarWidth(boundedSidebarWidth(event.clientX))
            }}
            onPointerUp={event => {
              event.currentTarget.classList.remove('sidebar-resize-active')
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onKeyDown={event => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              setSidebarWidth(value => boundedSidebarWidth(value + (event.key === 'ArrowLeft' ? -12 : 12)))
            }}
          />
        )}

        {sidebarOpen && <button className="sidebar-scrim" type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭对话列表" />}

        <main className="main-stage">
          <nav className="tabs" aria-label="已打开页面">
            <button className="mobile-menu-trigger mobile-only" type="button" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏">☰</button>
            <button className="sidebar-collapse-trigger desktop-only" type="button" onClick={() => setSidebarCollapsed(value => !value)} aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}>{sidebarCollapsed ? '›' : '‹'}</button>
            {workspace.tabs.map(tab => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeTab?.id ? 'tab-active' : ''} ${tab.id === splitTab?.id ? 'tab-secondary' : ''} ${draggingTabId === tab.id ? 'tab-dragging' : ''}`}
                draggable
                onDragStart={event => { setDraggingTabId(tab.id); event.dataTransfer.effectAllowed = 'move' }}
                onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move' }}
                onDrop={event => { event.preventDefault(); moveTab(draggingTabId, tab.id); setDraggingTabId('') }}
                onDragEnd={() => setDraggingTabId('')}
              >
                <button type="button" className="tab-main" onClick={() => openTab(tab)}>
                  <WorkspaceIcon kind={tab.kind} />
                  <span>{tab.title}</span>
                </button>
                {tab.id !== activeTab?.id && (
                  <button
                    type="button"
                    className="tab-split"
                    onClick={() => toggleSplit(tab.id)}
                    aria-label={`${tab.id === splitTab?.id ? '取消并排' : '并排显示'}${tab.title}`}
                    title={tab.id === splitTab?.id ? '取消并排' : '并排显示'}
                  >▥</button>
                )}
                <button type="button" className="tab-close" onClick={() => closeTab(tab.id)} aria-label={`关闭${tab.title}`}>×</button>
              </div>
            ))}
          </nav>

          <div className={`pane-group ${splitTab ? 'pane-group-split' : ''}`}>
            <div className="page-pane">{renderTab(activeTab)}</div>
            {splitTab && (
              <div className="page-pane page-pane-secondary">
                <header className="split-pane-bar"><span>并排 · {splitTab.title}</span><button type="button" onClick={closeSplit} aria-label="关闭并排页面">×</button></header>
                {renderTab(splitTab)}
              </div>
            )}
          </div>
        </main>
      </div>

      {shortcutsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setShortcutsOpen(false) }}>
          <section className="confirm-dialog shortcut-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-dialog-title">
            <span className="dialog-eyebrow">KEYBOARD</span>
            <h2 id="shortcut-dialog-title">快捷键</h2>
            <dl className="shortcut-list">
              {Array.from(new Set(KEYBOARD_SHORTCUTS.map(item => item.group))).map(group => (
                <div key={group} className="shortcut-group">
                  <p className="shortcut-group-title">{group}</p>
                  {KEYBOARD_SHORTCUTS.filter(item => item.group === group).map(item => (
                    <div key={item.keys} className="shortcut-row">
                      <dt>{item.label}</dt>
                      <dd><kbd>{item.keys}</kbd></dd>
                    </div>
                  ))}
                </div>
              ))}
            </dl>
            <div className="dialog-actions">
              <button type="button" className="button-secondary" onClick={() => setShortcutsOpen(false)}>关闭</button>
            </div>
          </section>
        </div>
      )}
      {pendingDelete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPendingDelete(null) }}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
            <span className="dialog-eyebrow">DELETE CONVERSATION</span>
            <h2 id="delete-dialog-title">删除“{pendingDelete.title}”？</h2>
            <p>将从 LearnFlow 删除这段对话，并同步到其他浏览器；学习证据会保留。此操作无法撤销。</p>
            <div className="dialog-actions">
              <button type="button" className="button-secondary" onClick={() => setPendingDelete(null)}>取消</button>
              <button type="button" className="button-danger" onClick={() => deleteConversation(pendingDelete.id)}>删除对话</button>
            </div>
          </section>
        </div>
      )}
      {pendingSheetDelete && (
        <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPendingSheetDelete(null) }}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-sheet-dialog-title">
            <span className="dialog-eyebrow">DELETE SHEET</span>
            <h2 id="delete-sheet-dialog-title">删除“{pendingSheetDelete.title}”？</h2>
            <p>
              只删除这张追问纸，主对话不会受到影响。
              {pendingSheetDelete.childCount > 0
                ? ` 它下面的 ${pendingSheetDelete.childCount} 张子纸会保留并移动到上一层。`
                : ''}
              此操作无法撤销。
            </p>
            <div className="dialog-actions">
              <button type="button" className="button-secondary" onClick={() => setPendingSheetDelete(null)}>取消</button>
              <button type="button" className="button-danger" onClick={() => deleteSheet(pendingSheetDelete.conversationId, pendingSheetDelete.sheetId)}>删除纸张</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function ToolRunCard({ run, sourceMessageId, conversationId, compactPluginResult, onPluginPrompt, onPluginReference, onOpenLearningTask, onOpenProject, onOpenPluginResult, onOpenLearningFile, onAttachLearningFile, onAcceptPathProposal, onAcceptPathPlan, onAcceptProjectRoadmap, onAcceptProjectLearningFile, activePathPlanId, pathPlanBusyId, pathPlanWriteError, projectBusyKey, projectError, learningFileProposalError }: {
  run: TutorToolRun
  sourceMessageId: string
  conversationId: string
  compactPluginResult?: boolean
  onPluginPrompt: (prompt: string) => void
  onPluginReference: (object: LearnFlowPluginObject, prompt?: string) => void
  onOpenLearningTask: (taskId: number) => void
  onOpenProject: (target: { projectId: number; sessionId?: number }) => void
  onOpenPluginResult: (run: TutorToolRun, sourceMessageId: string) => void
  onOpenLearningFile: (file: { kind: 'lecture' | 'practice'; ref: string; title: string }) => void
  onAttachLearningFile: (file: { kind: 'lecture' | 'practice'; ref: string; title: string }, sourceMessageId: string) => void
  onAcceptPathProposal: (proposal: PersonalPathNodeProposal) => void
  onAcceptPathPlan: (proposal: LearningPathPlanProposal) => void
  activePathPlanId?: string
  pathPlanBusyId?: string
  pathPlanWriteError?: string
  onAcceptProjectRoadmap: (proposal: ProjectRoadmapProposal) => void
  onAcceptProjectLearningFile: (proposal: ProjectLearningFileProposal) => void
  projectBusyKey?: string
  projectError?: string
  learningFileProposalError?: string
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (run.status !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [run.status])
  const icon = run.kind === 'memory' ? '◇' : run.kind === 'domain' || run.kind === 'file' ? '▤' : run.kind === 'project' ? '◈' : run.kind === 'path' ? '⌁' : run.kind === 'search' ? '⌕' : run.kind === 'image' ? '▧' : '▶'
  const pathPlanConfirmed = Boolean(run.pathPlanProposal && run.pathPlanProposal.id === activePathPlanId)
  const pathPlanBusy = Boolean(run.pathPlanProposal && run.pathPlanProposal.id === pathPlanBusyId)
  const actionableLearningFile: { kind: 'lecture' | 'practice'; ref: string; title: string; questionCount?: number } | undefined =
    run.learningFile && (run.learningFile.kind === 'lecture' || run.learningFile.kind === 'practice')
      ? { kind: run.learningFile.kind, ref: run.learningFile.ref, title: run.learningFile.title, questionCount: run.learningFile.questionCount }
      : undefined
  const roleLabel: Record<NonNullable<TutorToolRun['sources']>[number]['role'], string> = {
    standard: '规范', reference: '参考', textbook: '教材', course: '课程',
    definition: '定义', research: '研究', example: '实例', discussion: '讨论',
  }
  return (
    <section
      className={`tool-run tool-run-${run.status}${run.learningFile ? ' tool-run-learning-file' : ''}`}
      aria-label={`${run.title}${run.status === 'running' ? '正在运行' : run.status === 'completed' ? '已完成' : '失败'}`}
      draggable={Boolean(run.learningFile)}
      onDragStart={run.learningFile ? event => event.dataTransfer.setData('application/x-learnflow-learning-file', JSON.stringify({ ...run.learningFile, sourceMessageId })) : undefined}
    >
      <header>
        <span className="tool-run-icon">{icon}</span>
        <div><strong>{run.title}</strong><small>{run.status === 'running' ? '正在使用工具' : run.status === 'completed' ? '调用完成' : '调用失败'} · {((run.status === 'running' ? Math.max(0, now - (run.startedAt || now)) : run.durationMs) / 1000).toFixed(1)}s</small></div>
        <i>{run.status === 'running' ? '…' : run.status === 'completed' ? '✓' : '!'}</i>
      </header>
      <p>{run.detail}</p>
      {actionableLearningFile && (
        <Suspense fallback={<div className="learning-file-preview-loading">正在展开文件开头…</div>}>
          <LearningFileMessagePreview
            file={actionableLearningFile}
            conversationId={conversationId}
            onOpen={() => onOpenLearningFile(actionableLearningFile)}
            onAttach={() => onAttachLearningFile(actionableLearningFile, sourceMessageId)}
          />
        </Suspense>
      )}
      {run.pathProposal && (
        <div className="path-proposal-card">
          <span>个人节点提案</span>
          <strong>{run.pathProposal.title}</strong>
          <p>{run.pathProposal.summary}</p>
          <small>{run.pathProposal.connections.length} 条建议关系 · {run.pathProposal.sourceUrls.length} 个联网来源</small>
          <button type="button" onClick={() => onAcceptPathProposal(run.pathProposal!)}>确认加入我的学习路径</button>
        </div>
      )}
      {run.pathPlanProposal && (
        <div className={`path-plan-proposal-card${pathPlanConfirmed ? ' path-plan-proposal-confirmed' : ''}`}>
          <span>{pathPlanConfirmed ? '长期路径 · 已写入当前规划' : '长期路径提案 · 尚未写入'}</span>
          <strong>{run.pathPlanProposal.title}</strong>
          <p>{run.pathPlanProposal.rationale}</p>
          <small>{run.pathPlanProposal.horizon} · {run.pathPlanProposal.routeNodeIds.length} 个路线节点 · {run.pathPlanProposal.milestoneNodeIds.length} 个里程碑</small>
          <button type="button" disabled={pathPlanConfirmed || pathPlanBusy} onClick={() => onAcceptPathPlan(run.pathPlanProposal!)}>
            {pathPlanConfirmed ? '已写入当前长期路径' : pathPlanBusy ? '正在写入五核…' : '确认目标与路线，写入五核'}
          </button>
          {pathPlanWriteError && <em className="path-plan-write-error">{pathPlanWriteError}</em>}
        </div>
      )}
      {run.projectRoadmapProposal && (
        <div className="project-tool-proposal">
          <span>{run.projectRoadmapProposal.operation === 'revise' ? `项目路线修订 · 第 ${(run.projectRoadmapProposal.expected_revision || 1) + 1} 版待确认` : '项目路线提案 · 尚未创建'}</span>
          <strong>{run.projectRoadmapProposal.project_theme}</strong>
          <p>{run.projectRoadmapProposal.rationale}</p>
          <ol>{run.projectRoadmapProposal.checkpoints.map(item => <li key={item.key}><b>{item.title}</b><small>{item.objective}</small></li>)}</ol>
          <button type="button" disabled={projectBusyKey === `project-roadmap:${run.projectRoadmapProposal.project_id}`} onClick={() => onAcceptProjectRoadmap(run.projectRoadmapProposal!)}>
            {projectBusyKey === `project-roadmap:${run.projectRoadmapProposal.project_id}`
              ? (run.projectRoadmapProposal.operation === 'revise' ? '正在应用路线修订…' : '正在创建关卡与任务…')
              : (run.projectRoadmapProposal.operation === 'revise' ? '确认调整未开始关卡' : '确认路线，创建关卡对话与学习任务')}
          </button>
          {projectError && <em>{projectError}</em>}
        </div>
      )}
      {run.projectLearningFileProposal && (
        <div className="project-tool-proposal project-file-proposal">
          <span>{run.materializedLearningFiles?.length ? '学习文件' : '学习文件提案 · 尚未生成'}</span>
          <strong>{run.projectLearningFileProposal.checkpoint_title}</strong>
          <p>{run.projectLearningFileProposal.file_kinds.map(kind => kind === 'lecture' ? '讲义' : '练习').join(' + ')} · {run.projectLearningFileProposal.source_strategy === 'project_sources_first' ? '优先使用当前项目来源' : '优先使用任务已有资料'} · 生成不等于掌握</p>
          {run.materializedLearningFiles?.map(file => <button key={`${file.kind}:${file.ref}`} type="button" onClick={() => onAttachLearningFile(file, sourceMessageId)}>{file.kind === 'lecture' ? '打开讲义' : '打开练习'}</button>)}
          {!run.projectLearningFileProposal.file_kinds.every(kind => run.materializedLearningFiles?.some(file => file.kind === kind)) && <button type="button" disabled={projectBusyKey === `project-file:${run.projectLearningFileProposal.learning_task_id}`} onClick={() => onAcceptProjectLearningFile(run.projectLearningFileProposal!)}>
            {projectBusyKey === `project-file:${run.projectLearningFileProposal.learning_task_id}` ? '正在生成并保存…' : '确认生成，并作为纸张加入对话'}
          </button>}
          {learningFileProposalError && <em>{learningFileProposalError}</em>}
        </div>
      )}
      {run.sources && run.sources.length > 0 && (
        <div className="tool-sources">
          {run.sources.map(source => (
            <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
              <span>{source.source} · {source.quality === 'official' ? '权威' : source.quality === 'academic' ? '论文' : source.quality === 'repository' ? '仓库' : '社区'} · {roleLabel[source.role]}</span>
              <strong>{source.title}</strong>
              {source.snippet && <small>{source.snippet}</small>}
              {source.reason && <em>{source.reason}</em>}
            </a>
          ))}
        </div>
      )}
      {run.artifact && <VisualArtifact artifact={run.artifact} onAsk={onPluginPrompt} storageScope={conversationId} />}
      {run.plugin && (compactPluginResult
        ? <button type="button" className="button-secondary" onClick={() => onOpenPluginResult(run, sourceMessageId)}>
            在独立页面查看完整学习型任务 →
          </button>
        : <PluginToolResultView
            run={run}
            onPrompt={onPluginPrompt}
            onReference={onPluginReference}
            onReferenceObject={onPluginReference}
            onOpenLearningTask={onOpenLearningTask}
            onOpenProject={onOpenProject}
            onOpenPaper={() => onOpenPluginResult(run, sourceMessageId)}
          />)}
    </section>
  )
}

function AgentTraceSummary({ trace }: { trace: AgentTurnTrace }) {
  const stopLabels: Record<AgentTurnTrace['stopReason'], string> = {
    final_answer: '形成回答',
    tool_budget: '工具预算收束',
    model_budget: '时间预算收束',
    forced_finalize: '强制收束',
    error: '异常收束',
  }
  const timing = trace.timings
    ? ` · ${trace.timings.firstTextDeltaMs === undefined ? '' : `首字 ${(trace.timings.firstTextDeltaMs / 1000).toFixed(1)}s · `}总计 ${(trace.timings.totalMs / 1000).toFixed(1)}s`
    : ''
  return (
    <details className="agent-trace-summary">
      <summary>
        <span>Agent 轨迹</span>
        <small>{trace.modelRounds} 轮判断 · {trace.toolCalls} 次工具 · {stopLabels[trace.stopReason]}{timing}</small>
      </summary>
      <ol>
        {trace.events.map(event => (
          <li key={`${event.sequence}-${event.at}`} className={event.status === 'failed' || event.status === 'blocked' ? 'trace-event-warning' : ''}>
            <i>{event.sequence}</i>
            <span>{event.detail}</span>
          </li>
        ))}
      </ol>
    </details>
  )
}

function ToolDecisionBridge({
  run,
  nextRun,
  summary,
}: {
  run: TutorToolRun
  nextRun?: TutorToolRun
  summary?: AgentDecisionSummary
}) {
  if (run.status === 'running') return null
  const reason = summary?.reason || `为完成当前学习动作，Tutor 选择了“${run.title}”取得结构化观察。`
  const observation = summary?.observation || run.observationSummary || run.detail
  const nextAction = nextRun
    ? `基于这条观察，继续使用“${nextRun.title}”。`
    : summary?.nextAction || (run.status === 'failed'
      ? '保留失败原因并调整路线，最终回答会说明仍存在的缺口。'
      : '把观察交回 Tutor，继续组织当前学习动作。')
  return (
    <section className={`tool-decision-bridge${run.status === 'failed' ? ' tool-decision-bridge-warning' : ''}`} aria-label="Tutor 工具决策摘要">
      <span>判断</span>
      <div>
        <strong>{reason}</strong>
        <p><i>观察</i>{observation}</p>
        <p><i>下一步</i>{nextAction}</p>
      </div>
    </section>
  )
}

function MessageList({ messages, learnerAvatar, learnerName, conversationId, onPluginPrompt, onPluginReference, onOpenLearningTask, onOpenProject, onOpenPluginResult, onQuoteFollowUp, onOpenLearningFile, onAttachLearningFile, onAcceptPathProposal, onAcceptPathPlan, onAcceptProjectRoadmap, onAcceptProjectLearningFile, activePathPlanId, pathPlanBusyId, pathPlanWriteErrors, projectBusyKey, projectError, learningFileProposalErrors }: {
  messages: Message[]
  learnerAvatar?: string | null
  learnerName: string
  conversationId: string
  onPluginPrompt: (prompt: string) => void
  onPluginReference: (object: LearnFlowPluginObject, prompt?: string) => void
  onOpenLearningTask: (taskId: number) => void
  onOpenProject: (target: { projectId: number; sessionId?: number }) => void
  onOpenPluginResult: (run: TutorToolRun, sourceMessageId: string) => void
  onQuoteFollowUp: (messageId: string, quote: string) => void
  onOpenLearningFile: (file: { kind: 'lecture' | 'practice'; ref: string; title: string }) => void
  onAttachLearningFile: (file: { kind: 'lecture' | 'practice'; ref: string; title: string }, sourceMessageId: string) => void
  onAcceptPathProposal: (proposal: PersonalPathNodeProposal) => void
  onAcceptPathPlan: (proposal: LearningPathPlanProposal) => void
  activePathPlanId?: string
  pathPlanBusyId?: string
  pathPlanWriteErrors: Record<string, string>
  onAcceptProjectRoadmap: (proposal: ProjectRoadmapProposal) => void
  onAcceptProjectLearningFile: (proposal: ProjectLearningFileProposal) => void
  projectBusyKey?: string
  projectError?: string
  learningFileProposalErrors: Record<number, string>
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [selectedText, setSelectedText] = useState<{ messageId: string; quote: string; left: number; top: number } | null>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])
  useEffect(() => { setSelectedText(null) }, [messages])
  useEffect(() => {
    const captureKeyboardSelection = () => {
      const selection = globalThis.getSelection()
      const quote = selection?.toString().replace(/\s+/g, ' ').trim() || ''
      if (!selection || selection.rangeCount === 0 || quote.length < 1 || quote.length > 1200) return
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
      const article = anchor?.closest<HTMLElement>('article[data-message-role="assistant"]')
      if (!article || !listRef.current?.contains(article)) return
      const rect = selection.getRangeAt(0).getBoundingClientRect()
      setSelectedText({
        messageId: article.dataset.messageId || '', quote,
        left: Math.min(globalThis.innerWidth - 126, Math.max(8, rect.left + rect.width / 2 - 58)),
        top: Math.max(8, rect.top - 42),
      })
    }
    document.addEventListener('selectionchange', captureKeyboardSelection)
    return () => document.removeEventListener('selectionchange', captureKeyboardSelection)
  }, [])
  const visibleMessages = useMemo(() => messages.filter(message => !message.hiddenFromTranscript), [messages])

  const captureSelection = (messageId: string, container: HTMLElement) => {
    const selection = globalThis.getSelection()
    const quote = selection?.toString().replace(/\s+/g, ' ').trim() || ''
    if (!selection || selection.rangeCount === 0 || quote.length < 1 || quote.length > 1200) {
      setSelectedText(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) {
      setSelectedText(null)
      return
    }
    const rect = range.getBoundingClientRect()
    setSelectedText({
      messageId,
      quote,
      left: Math.min(globalThis.innerWidth - 126, Math.max(8, rect.left + rect.width / 2 - 58)),
      top: Math.max(8, rect.top - 42),
    })
  }

  return (
    <div className="messages" aria-live="polite" ref={listRef}>
      <div className="message-column">
        {visibleMessages.map(message => (
          <article key={message.id} data-message-id={message.id} data-message-role={message.role} className={`message message-${message.role}${message.learningActionLabel ? ' message-learning-action' : ''}`}>
            {message.role === 'user'
              ? <UserAvatar className="message-avatar" displayName={learnerName} avatar={learnerAvatar} size="sm" />
              : message.role === 'assistant'
                ? <img className="message-avatar" src="/brand-mark.png" alt="" width={26} height={26} />
                : <span className="message-avatar">i</span>}
            <div className="message-content" onMouseUp={message.role === 'assistant' ? event => captureSelection(message.id, event.currentTarget) : undefined}>
              <div className="message-meta">
                {message.role === 'user' ? '你' : message.role === 'assistant' ? 'Tutor' : '系统'}
                {message.tutorMode && (
                  <em>
                    {TUTOR_MODE_LABELS[message.tutorMode]}
                    {message.tutorMode === 'guided_learning' && message.learningSubstateLabel ? ` · ${message.learningSubstateLabel}` : ''}
                  </em>
                )}
                {message.learningSkillId && <em className="message-skill">{LEARNING_SKILLS[message.learningSkillId]?.name}</em>}
                {message.role === 'assistant' && (
                  <button
                    type="button"
                    className="message-follow-up"
                    title="选中文字后追问；未选中时从本条回答开一张纸"
                    onMouseDown={event => event.preventDefault()}
                    onClick={event => {
                      const selection = globalThis.getSelection()
                      const selectedQuote = selection?.toString().replace(/\s+/g, ' ').trim() || ''
                      const article = event.currentTarget.closest('article')
                      const anchor = selection?.anchorNode
                      const quote = selectedQuote && anchor && article?.contains(anchor)
                        ? selectedQuote
                        : (message.displayContent || message.content).replace(/\s+/g, ' ').trim().slice(0, 600)
                      if (!quote) return
                      onQuoteFollowUp(message.id, quote)
                      selection?.removeAllRanges()
                      setSelectedText(null)
                    }}
                  >选中文字追问</button>
                )}
              </div>
              {message.toolRuns?.map((run, index, runs) => {
                const decisionSummary = (message.agentTrace?.decisionSummaries || message.decisionSummaries || [])
                  .find(item => item.toolCallId === run.toolCallId)
                return (
                  <Fragment key={run.id}>
                    <ToolRunCard
                      run={run}
                      sourceMessageId={message.id}
                      conversationId={conversationId}
                      compactPluginResult={!message.pluginResultProjection && Boolean(
                        run.plugin?.pluginId === 'learning_task_conversion'
                        && run.plugin.result.objects?.some(object => object.objectType === 'learning_task_candidate')
                      )}
                      onPluginPrompt={onPluginPrompt}
                      onPluginReference={onPluginReference}
                      onOpenLearningTask={onOpenLearningTask}
            onOpenProject={onOpenProject}
                      onOpenPluginResult={onOpenPluginResult}
                      onOpenLearningFile={onOpenLearningFile}
                      onAttachLearningFile={onAttachLearningFile}
                      onAcceptPathProposal={onAcceptPathProposal}
                      onAcceptPathPlan={onAcceptPathPlan}
                      activePathPlanId={activePathPlanId}
                      pathPlanBusyId={pathPlanBusyId}
                      pathPlanWriteError={run.pathPlanProposal ? pathPlanWriteErrors[run.pathPlanProposal.id] : undefined}
                      onAcceptProjectRoadmap={onAcceptProjectRoadmap}
                      onAcceptProjectLearningFile={onAcceptProjectLearningFile}
                      projectBusyKey={projectBusyKey}
                      projectError={projectError}
                      learningFileProposalError={run.projectLearningFileProposal
                        ? learningFileProposalErrors[run.projectLearningFileProposal.learning_task_id]
                        : undefined}
                    />
                    {!message.pluginResultProjection && <ToolDecisionBridge run={run} nextRun={runs[index + 1]} summary={decisionSummary} />}
                  </Fragment>
                )
              })}
              {!message.pluginResultProjection && message.agentTrace && <AgentTraceSummary trace={message.agentTrace} />}
              {message.streaming && <div className="streaming-phase"><i />{message.streamingPhase || '正在形成回答'}</div>}
              {message.pluginResultProjection ? null : message.learningActionLabel ? (
                <div className="learning-action-chip"><span>学习任务</span>{message.learningActionLabel}</div>
              ) : (
                <Suspense fallback={<div className="markdown-loading">正在排版…</div>}>
                  <MarkdownContent content={humanizeLearningFileReferences(
                    humanizeTutorMessageContent(message),
                    (message.toolRuns || []).flatMap(run => run.learningFile
                      && (run.learningFile.kind === 'lecture' || run.learningFile.kind === 'practice')
                      ? [{ kind: run.learningFile.kind, ref: run.learningFile.ref, title: run.learningFile.title }]
                      : []),
                  )} />
                </Suspense>
              )}
            </div>
          </article>
        ))}
        <div ref={endRef} />
      </div>
      {selectedText && (
        <button
          type="button"
          className="selection-follow-up"
          style={{ left: selectedText.left, top: selectedText.top }}
          onMouseDown={event => event.preventDefault()}
          onClick={() => {
            onQuoteFollowUp(selectedText.messageId, selectedText.quote)
            globalThis.getSelection()?.removeAllRanges()
            setSelectedText(null)
          }}
        >在新纸上追问</button>
      )}
    </div>
  )
}

const rootElement = document.getElementById('root')!
const rootScope = globalThis as typeof globalThis & { __learnflowRoot?: Root }
const root = rootScope.__learnflowRoot || createRoot(rootElement)
rootScope.__learnflowRoot = root
const ConversionPage = lazy(() => import('./WorkTaskConversionPage.tsx'))
const isConversionPage = window.location.pathname === '/convert' || window.location.hostname === 'w2ltask.learnflow.club'
void initializeRuntimeClient().then(() => root.render(
  <AuthGate>{auth => isIpAccountConsole(window.location)
    ? <main className="settings-page" style={{ maxWidth: 800, margin: '0 auto', padding: '36px 20px' }}>
      <div className="settings-intro page-hero">
        <h1>LearnFlow 个人设置</h1>
        <UserIdentity displayName={auth.account.display_name} username={auth.account.username} avatar={auth.account.avatar} size="lg" />
        <p>签发个人 API Key，复制到 LearnFlow 桌面端即可连接。</p>
      </div>
      <PersonalApiKeys key={auth.account.id} />
      <button type="button" className="button-secondary" style={{ marginTop: 20 }} onClick={() => { void auth.signOut() }}>退出账号</button>
    </main>
    : isConversionPage
    ? <Suspense fallback={<p>正在载入工作任务转换…</p>}><ConversionPage key={`conversion:${auth.account.learner_id}`} auth={auth}/></Suspense>
    : <App key={`learner:${auth.account.learner_id}`} auth={auth} />}</AuthGate>,
))
