import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'
import { LEARNING_SKILLS, type LearningSkillId } from './learning'
import { installedClientPlugins } from './PluginToolResultView.tsx'
import { visibleToolCapabilities } from './tool-capability-catalog.ts'
import { TOOL_CHOICE_LABELS, type TutorToolChoice } from './tooling'
import './ComposerCapabilityPicker.css'

export type ComposerLearningSkillChoice = LearningSkillId | 'auto'

type ComposerCapabilityPickerProps = {
  isGuidedLearning: boolean
  skillChoice: ComposerLearningSkillChoice
  skillAutoDisabled: boolean
  skillDisabled: boolean
  formalSkillRunActive: boolean
  toolChoice: TutorToolChoice
  toolDisabled: boolean
  activePluginIds: readonly string[]
  sourceCount: number
  sourceKind: 'conversation' | 'project'
  onSkillChange: (choice: ComposerLearningSkillChoice) => void
  onToolChange: (choice: TutorToolChoice) => void
}

type PickerMenu = 'skill' | 'tool'
type FocusTarget = 'selected' | 'first' | 'last'

type PickerOption<Value extends string> = {
  value: Value
  label: string
  purpose: string
  glyph: string
  disabled?: boolean
  status?: string
}

const LEARNING_SKILL_IDS = Object.keys(LEARNING_SKILLS) as LearningSkillId[]
const TOOL_CHOICE_IDS = Object.keys(TOOL_CHOICE_LABELS) as TutorToolChoice[]

const TOOL_META: Record<TutorToolChoice, { glyph: string; purpose: string }> = {
  auto: { glyph: '✦', purpose: '由 Tutor 根据问题与已有上下文选择' },
  domain: { glyph: '▤', purpose: '' },
  search: { glyph: '⌕', purpose: '用于检索公开网页资料' },
  image: { glyph: '◇', purpose: '用静态图解组织关系与步骤' },
  animation: { glyph: '▷', purpose: '用分步动画演示变化过程' },
}

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12">
      <path d="m3 4.75 3 3 3-3" />
    </svg>
  )
}

export default function ComposerCapabilityPicker({
  isGuidedLearning,
  skillChoice,
  skillAutoDisabled,
  skillDisabled,
  formalSkillRunActive,
  toolChoice,
  toolDisabled,
  activePluginIds,
  sourceCount,
  sourceKind,
  onSkillChange,
  onToolChange,
}: ComposerCapabilityPickerProps) {
  const [openMenu, setOpenMenu] = useState<PickerMenu | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const skillTriggerRef = useRef<HTMLButtonElement>(null)
  const toolTriggerRef = useRef<HTMLButtonElement>(null)
  const skillPanelRef = useRef<HTMLDivElement>(null)
  const toolPanelRef = useRef<HTMLDivElement>(null)
  const pendingFocusRef = useRef<{ menu: PickerMenu; target: FocusTarget } | null>(null)
  const id = useId().replace(/:/g, '')

  const sourceLabel = sourceKind === 'project' ? '项目来源' : '对话资料'
  const skillOptions: PickerOption<ComposerLearningSkillChoice>[] = [
    {
      value: 'auto',
      label: '自动选择',
      purpose: '开始学习任务时根据目标匹配方法',
      glyph: '◎',
      disabled: skillAutoDisabled,
      status: skillAutoDisabled ? '任务运行中' : undefined,
    },
    ...LEARNING_SKILL_IDS.map((skillId, index) => ({
      value: skillId,
      label: LEARNING_SKILLS[skillId].name,
      purpose: LEARNING_SKILLS[skillId].description,
      glyph: String(index + 1).padStart(2, '0'),
      status: formalSkillRunActive && skillChoice !== skillId ? '切换' : undefined,
    })),
  ]
  const toolOptions: PickerOption<TutorToolChoice>[] = TOOL_CHOICE_IDS.map(choice => ({
    value: choice,
    label: choice === 'domain' ? sourceLabel : TOOL_CHOICE_LABELS[choice],
    purpose: choice === 'domain'
      ? sourceCount > 0
        ? `使用已附加的 ${sourceCount} 项${sourceLabel}`
        : `尚无${sourceLabel}，请先通过“＋资料”添加`
      : TOOL_META[choice].purpose,
    glyph: TOOL_META[choice].glyph,
    disabled: choice === 'domain' && sourceCount === 0,
    status: choice === 'domain' && sourceCount === 0 ? '未附加' : undefined,
  }))
  const toolCapabilities = visibleToolCapabilities(activePluginIds, installedClientPlugins)
  const coreCapabilityCount = toolCapabilities.filter(item => item.source === 'core').length
  const pluginCapabilityCount = toolCapabilities.length - coreCapabilityCount

  const selectedSkill = skillOptions.find(option => option.value === skillChoice) || skillOptions[0]
  const selectedTool = toolOptions.find(option => option.value === toolChoice) || toolOptions[0]
  const methodUnavailable = skillDisabled || !isGuidedLearning

  const panelFor = (menu: PickerMenu) => menu === 'skill' ? skillPanelRef.current : toolPanelRef.current
  const triggerFor = (menu: PickerMenu) => menu === 'skill' ? skillTriggerRef.current : toolTriggerRef.current

  const enabledOptionButtons = (menu: PickerMenu) => (
    Array.from(panelFor(menu)?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || [])
  )

  const closePicker = (restoreFocus = false) => {
    const menu = openMenu
    pendingFocusRef.current = null
    setOpenMenu(null)
    if (restoreFocus && menu) {
      requestAnimationFrame(() => triggerFor(menu)?.focus())
    }
  }

  const openPicker = (menu: PickerMenu, target: FocusTarget = 'selected') => {
    if ((menu === 'skill' && methodUnavailable) || (menu === 'tool' && toolDisabled)) return
    pendingFocusRef.current = { menu, target }
    setOpenMenu(menu)
  }

  const togglePicker = (menu: PickerMenu) => {
    if (openMenu === menu) {
      closePicker()
      return
    }
    openPicker(menu)
  }

  const moveOptionFocus = (menu: PickerMenu, current: HTMLButtonElement, offset: number) => {
    const buttons = enabledOptionButtons(menu)
    if (buttons.length === 0) return
    const currentIndex = Math.max(0, buttons.indexOf(current))
    buttons[(currentIndex + offset + buttons.length) % buttons.length]?.focus()
  }

  const focusBoundaryOption = (menu: PickerMenu, edge: 'first' | 'last') => {
    const buttons = enabledOptionButtons(menu)
    buttons[edge === 'first' ? 0 : buttons.length - 1]?.focus()
  }

  const handleTriggerKeyDown = (menu: PickerMenu, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openPicker(menu, event.key === 'ArrowDown' ? 'selected' : 'last')
    } else if (event.key === 'Escape' && openMenu) {
      event.preventDefault()
      closePicker(true)
    }
  }

  const handleOptionKeyDown = (menu: PickerMenu, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveOptionFocus(menu, event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      focusBoundaryOption(menu, event.key === 'Home' ? 'first' : 'last')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePicker(true)
    }
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (openMenu && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
      closePicker()
    }
  }

  const chooseSkill = (choice: ComposerLearningSkillChoice) => {
    const option = skillOptions.find(candidate => candidate.value === choice)
    if (!option || option.disabled) return
    if (choice !== skillChoice) onSkillChange(choice)
    closePicker(true)
  }

  const chooseTool = (choice: TutorToolChoice) => {
    const option = toolOptions.find(candidate => candidate.value === choice)
    if (!option || option.disabled) return
    if (choice !== toolChoice) onToolChange(choice)
    closePicker(true)
  }

  useEffect(() => {
    if (!openMenu || pendingFocusRef.current?.menu !== openMenu) return
    const frame = requestAnimationFrame(() => {
      const buttons = enabledOptionButtons(openMenu)
      const target = pendingFocusRef.current?.target
      const selectedValue = openMenu === 'skill' ? skillChoice : toolChoice
      const selectedButton = buttons.find(button => button.dataset.value === selectedValue)
      const button = target === 'last'
        ? buttons[buttons.length - 1]
        : target === 'first' ? buttons[0] : selectedButton || buttons[0]
      button?.focus()
      pendingFocusRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [openMenu, skillChoice, toolChoice, sourceCount])

  useEffect(() => {
    if (!openMenu) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePicker()
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [openMenu])

  useEffect(() => {
    if ((openMenu === 'skill' && methodUnavailable) || (openMenu === 'tool' && toolDisabled)) {
      closePicker()
    }
  }, [methodUnavailable, openMenu, toolDisabled])

  return (
    <div className="composer-capability-picker" ref={rootRef} onBlur={handleBlur}>
      <div className="composer-capability-picker__field composer-capability-picker__field--method">
        <button
          ref={skillTriggerRef}
          type="button"
          className="composer-capability-picker__trigger composer-capability-picker__trigger--method"
          aria-label={`学习方法：${selectedSkill.label}${formalSkillRunActive ? '，正式 SkillRun 运行中' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={openMenu === 'skill'}
          aria-controls={`${id}-skill-listbox`}
          disabled={methodUnavailable}
          title={!isGuidedLearning ? '学习方法仅在带领学习态可设置' : skillDisabled ? '当前学习任务暂不可切换方法' : undefined}
          onClick={() => togglePicker('skill')}
          onKeyDown={event => handleTriggerKeyDown('skill', event)}
        >
          <span className="composer-capability-picker__trigger-icon" aria-hidden="true">方</span>
          <span className="composer-capability-picker__trigger-copy">
            <span className="composer-capability-picker__eyebrow">
              方法 · 仅带领学习
              {formalSkillRunActive && <i>运行中</i>}
            </span>
            <span className="composer-capability-picker__selection">
              <strong>{selectedSkill.label}</strong>
              <small>{isGuidedLearning ? selectedSkill.purpose : '进入带领学习后设置'}</small>
            </span>
          </span>
          <span className="composer-capability-picker__chevron"><Chevron /></span>
        </button>

        {openMenu === 'skill' && (
          <div
            ref={skillPanelRef}
            id={`${id}-skill-listbox`}
            className="composer-capability-picker__popover composer-capability-picker__popover--method"
            role="listbox"
            aria-label="选择学习方法"
          >
            <header className="composer-capability-picker__popover-header">
              <span>学习方法</span>
              <strong>选择带领学习的推进方式</strong>
              <p>{formalSkillRunActive
                ? '当前正式 SkillRun 正在运行；方向键只移动焦点，确认选择后才会切换。'
                : '方法只影响带领学习，不会改变当前 Tutor 状态。'}</p>
            </header>
            <div className="composer-capability-picker__options">
              {skillOptions.map(option => {
                const selected = option.value === skillChoice
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    data-value={option.value}
                    className={`composer-capability-picker__option${selected ? ' composer-capability-picker__option--selected' : ''}`}
                    disabled={option.disabled}
                    onClick={() => chooseSkill(option.value)}
                    onKeyDown={event => handleOptionKeyDown('skill', event)}
                  >
                    <span className="composer-capability-picker__option-icon composer-capability-picker__option-icon--method" aria-hidden="true">{option.glyph}</span>
                    <span className="composer-capability-picker__option-copy">
                      <strong>{option.label}</strong>
                      <small>{option.purpose}</small>
                    </span>
                    <span className="composer-capability-picker__option-status">
                      {selected ? formalSkillRunActive ? 'SkillRun' : '已选' : option.status || ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="composer-capability-picker__field composer-capability-picker__field--tool">
        <button
          ref={toolTriggerRef}
          type="button"
          className="composer-capability-picker__trigger composer-capability-picker__trigger--tool"
          aria-label={`工具能力：${coreCapabilityCount} 类系统能力${pluginCapabilityCount ? `，${pluginCapabilityCount} 项插件能力` : ''}；本轮偏好：${selectedTool.label}`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'tool'}
          aria-controls={`${id}-tool-listbox`}
          disabled={toolDisabled}
          title={toolDisabled ? 'Tutor 回复中，暂不能更换工具' : undefined}
          onClick={() => togglePicker('tool')}
          onKeyDown={event => handleTriggerKeyDown('tool', event)}
        >
          <span className="composer-capability-picker__trigger-icon composer-capability-picker__trigger-icon--tool" aria-hidden="true">{selectedTool.glyph}</span>
          <span className="composer-capability-picker__trigger-copy">
            <span className="composer-capability-picker__eyebrow">工具能力 · 可见</span>
            <span className="composer-capability-picker__selection">
              <strong>{selectedTool.label}</strong>
              <small>{coreCapabilityCount} 类{pluginCapabilityCount ? ` + ${pluginCapabilityCount} 插件` : ''}</small>
            </span>
          </span>
          <span className="composer-capability-picker__chevron"><Chevron /></span>
        </button>

        {openMenu === 'tool' && (
          <div
            ref={toolPanelRef}
            id={`${id}-tool-listbox`}
            className="composer-capability-picker__popover composer-capability-picker__popover--tool"
            role="dialog"
            aria-label="工具能力与本轮偏好"
          >
            <header className="composer-capability-picker__popover-header">
              <span>工具能力</span>
              <strong>Tutor 当前可使用的功能</strong>
              <p>这里按功能概括展示能力；底层接口会根据对话状态、任务范围和安全条件自动开放。</p>
            </header>
            <section className="composer-capability-picker__catalog" aria-label="可用工具能力">
              <div className="composer-capability-picker__section-heading">
                <strong>系统能力</strong>
                <span>始终可见 · 按条件调用</span>
              </div>
              <div className="composer-capability-picker__capabilities">
                {toolCapabilities.filter(item => item.source === 'core').map(capability => (
                  <article key={capability.id} className="composer-capability-picker__capability">
                    <span className="composer-capability-picker__capability-icon" aria-hidden="true">{capability.glyph}</span>
                    <span className="composer-capability-picker__capability-copy">
                      <strong>{capability.label}</strong>
                      <small>{capability.purpose}</small>
                    </span>
                    <b>{capability.status}</b>
                  </article>
                ))}
              </div>
              <div className="composer-capability-picker__section-heading composer-capability-picker__section-heading--plugin">
                <strong>插件能力</strong>
                <span>{pluginCapabilityCount ? `已启用 ${pluginCapabilityCount}` : '启用后显示在这里'}</span>
              </div>
              {pluginCapabilityCount ? (
                <div className="composer-capability-picker__capabilities">
                  {toolCapabilities.filter(item => item.source === 'plugin').map(capability => (
                    <article key={capability.id} className="composer-capability-picker__capability composer-capability-picker__capability--plugin">
                      <span className="composer-capability-picker__capability-icon" aria-hidden="true">{capability.glyph}</span>
                      <span className="composer-capability-picker__capability-copy">
                        <strong>{capability.label}</strong>
                        <small>{capability.purpose}</small>
                      </span>
                      <b>{capability.status}</b>
                    </article>
                  ))}
                </div>
              ) : <p className="composer-capability-picker__plugin-empty">通过旁边的“插件”入口启用后，这里会显示它提供的整体功能，不展开底层工具。</p>}
            </section>
            <div className="composer-capability-picker__preference-heading">
              <strong>本轮偏好</strong>
              <span>只影响下一条消息；自动模式仍可使用上面的全部能力</span>
            </div>
            <div className="composer-capability-picker__options" role="listbox" aria-label="选择本轮工具偏好">
              {toolOptions.map(option => {
                const selected = option.value === toolChoice
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    data-value={option.value}
                    className={`composer-capability-picker__option${selected ? ' composer-capability-picker__option--selected' : ''}`}
                    disabled={option.disabled}
                    onClick={() => chooseTool(option.value)}
                    onKeyDown={event => handleOptionKeyDown('tool', event)}
                  >
                    <span className="composer-capability-picker__option-icon" aria-hidden="true">{option.glyph}</span>
                    <span className="composer-capability-picker__option-copy">
                      <strong>{option.label}</strong>
                      <small>{option.purpose}</small>
                    </span>
                    <span className="composer-capability-picker__option-status">
                      {selected ? '已选' : option.status || ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
