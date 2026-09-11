/** Line icons for the sidebar and its menus.
 *
 *  These slots used to hold Unicode glyphs (☁ ▤ ↺ ☷ ⌁ ▷ ◌ ◎ ⚙ ⌘ ◔ ⊘). Each of
 *  those comes from a different block with its own weight, optical size and
 *  baseline, so no amount of CSS made a row of them line up. Drawing them here
 *  on one 24-unit grid at one stroke weight is the only way they match.
 */

export type UiIconName =
  | 'cloud'
  | 'lecture'
  | 'review'
  | 'tasks'
  | 'path'
  | 'visual'
  | 'pet'
  | 'profile'
  | 'settings'
  | 'shortcuts'
  | 'avatar'
  | 'avatar-off'

const PATHS: Record<UiIconName, JSX.Element> = {
  cloud: (
    <>
      <path d="M17.2 18.5H7.1a3.9 3.9 0 0 1-.6-7.75 5.4 5.4 0 0 1 10.4 1.42 3.17 3.17 0 0 1 .3 6.33Z" />
    </>
  ),
  lecture: (
    <>
      <path d="M12 7.2C10.6 6.1 8.8 5.5 6.6 5.5H4.2v12h2.4c2.2 0 4 .6 5.4 1.7 1.4-1.1 3.2-1.7 5.4-1.7h2.4v-12h-2.4c-2.2 0-4 .6-5.4 1.7Z" />
      <path d="M12 7.2v12" />
    </>
  ),
  review: (
    <>
      <path d="M4.2 12a7.8 7.8 0 1 0 2.4-5.6" />
      <path d="M4.2 4.6v4.6h4.6" />
    </>
  ),
  tasks: (
    <>
      <path d="M4.4 7.3 5.7 8.7 8.3 6" />
      <path d="M4.4 16.3 5.7 17.7 8.3 15" />
      <path d="M11.4 7.4h8.4M11.4 12h8.4M11.4 16.6h8.4" />
    </>
  ),
  path: (
    <>
      <circle cx="6.6" cy="17.6" r="2.3" />
      <circle cx="17.4" cy="6.4" r="2.3" />
      <path d="M8.6 15.9c4.1-1.2 6.6-3.8 7.2-7.4" />
    </>
  ),
  visual: (
    <>
      <rect x="4" y="4.6" width="16" height="14.8" rx="3.2" />
      <path d="M10.4 9.3v5.4l4.6-2.7Z" />
    </>
  ),
  pet: (
    <>
      <circle cx="12" cy="12" r="7.6" />
      <path d="M9.4 10.6v.9M14.6 10.6v.9" />
      <path d="M9.6 14.6c1.4 1.2 3.4 1.2 4.8 0" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8.6" r="3.8" />
      <path d="M4.8 19.8a7.4 7.4 0 0 1 14.4 0" />
    </>
  ),
  settings: (
    <>
      <path d="M4.2 7.2h8.1M16.4 7.2h3.4" />
      <path d="M4.2 12h3.4M11.7 12h8.1" />
      <path d="M4.2 16.8h8.1M16.4 16.8h3.4" />
      <circle cx="14.4" cy="7.2" r="2.1" />
      <circle cx="9.6" cy="12" r="2.1" />
      <circle cx="14.4" cy="16.8" r="2.1" />
    </>
  ),
  shortcuts: (
    <>
      <rect x="3" y="6.2" width="18" height="11.6" rx="2.6" />
      <path d="M7 9.9h.01M10.5 9.9h.01M14 9.9h.01M17 9.9h.01" />
      <path d="M8.6 14.1h6.8" />
    </>
  ),
  avatar: (
    <>
      <rect x="3.8" y="5" width="16.4" height="14" rx="3" />
      <circle cx="9.1" cy="10" r="1.5" />
      <path d="M4.4 16.4 9 11.9l3.9 3.8 2.7-2.2 3.9 3.4" />
    </>
  ),
  'avatar-off': (
    <>
      <path d="M4.6 6.9h14.8" />
      <path d="M9.6 6.9V4.8h4.8v2.1" />
      <path d="M6.7 6.9 7.7 19.2h8.6L17.3 6.9" />
    </>
  ),
}

/** Rendered at whatever size the surrounding rule sets; `currentColor` lets a
 *  hover state on the parent tint the icon along with its label. */
export function UiIcon({ name, className }: { name: UiIconName; className?: string }) {
  return (
    <svg
      className={className ? `ui-icon ${className}` : 'ui-icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
