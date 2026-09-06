import styles from './PetAvatar.module.css'

export type PetAvatarState = 'idle' | 'thinking' | 'review_due' | 'task_active' | 'error'

type PetAvatarProps = {
  state: PetAvatarState
  compact?: boolean
  onClick?: () => void
}

const stateLabel: Record<PetAvatarState, string> = {
  idle: '待命',
  thinking: '正在思考',
  review_due: '提醒复习',
  task_active: '陪伴学习中',
  error: '需要你的注意',
}

export default function PetAvatar({ state, compact = false, onClick }: PetAvatarProps) {
  return <button
    type="button"
    className={styles.avatar}
    data-state={state}
    data-compact={compact || undefined}
    onClick={onClick}
    aria-label={`Flow 桌宠，${stateLabel[state]}`}
  >
    <span className={styles.glow} aria-hidden="true" />
    <svg viewBox="0 0 120 120" role="presentation" aria-hidden="true">
      <path className={styles.tail} d="M99 64c12 2 17 12 12 20-7 10-22 5-25-7" />
      <path className={styles.body} d="M28 72c0-28 14-47 33-47 22 0 36 18 36 46 0 18-11 30-35 30S28 90 28 72Z" />
      <path className={styles.earLeft} d="M38 39 31 16c-1-5 5-7 9-3l17 14" />
      <path className={styles.earRight} d="m81 38 11-21c3-5 10-2 8 4l-5 23" />
      <ellipse className={styles.face} cx="62" cy="69" rx="25" ry="22" />
      <circle className={styles.eye} cx="53" cy="65" r="4" />
      <circle className={styles.eye} cx="72" cy="65" r="4" />
      <path className={styles.mouth} d="M57 76c4 4 9 4 13 0" />
      <circle className={styles.cheek} cx="43" cy="75" r="4" />
      <circle className={styles.cheek} cx="82" cy="75" r="4" />
    </svg>
    <span className={styles.stateDot} aria-hidden="true" />
  </button>
}
