import './UserIdentity.css'

/** One readable letter for an avatar fallback. CJK keeps its own character;
 *  latin names are uppercased so the tile reads as a monogram, not lowercase. */
export function userInitial(displayName: string) {
  const first = Array.from((displayName || '').trim())[0] || ''
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

/** The standard secondary line under a user name: handle first, then state. */
export function userHandleLine(username?: string | null, detail?: string | null) {
  const handle = username ? `@${username}` : ''
  return [handle, detail].filter(Boolean).join(' · ')
}

export type UserAvatarSize = 'sm' | 'md' | 'lg'

export function UserAvatar({ displayName, avatar, size = 'md', className = '' }: {
  displayName: string
  avatar?: string | null
  size?: UserAvatarSize
  className?: string
}) {
  return <span className={`user-avatar user-avatar-${size}${className ? ` ${className}` : ''}`} aria-hidden="true">
    {avatar ? <img src={avatar} alt="" /> : userInitial(displayName)}
  </span>
}

export function UserIdentity({ displayName, username, avatar, detail, size = 'md', className = '' }: {
  displayName: string
  username?: string | null
  avatar?: string | null
  detail?: string | null
  size?: UserAvatarSize
  className?: string
}) {
  const secondary = userHandleLine(username, detail)
  return <span className={`user-identity${className ? ` ${className}` : ''}`}>
    <UserAvatar displayName={displayName} avatar={avatar} size={size} />
    <span className="user-identity-copy">
      <strong>{displayName}</strong>
      {secondary ? <small>{secondary}</small> : null}
    </span>
  </span>
}
